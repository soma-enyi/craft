/**
 * TemplateCloningService
 *
 * Copies template source files into an isolated, per-run workspace directory
 * before CodeGeneratorService applies customizations. Acts as a security and
 * isolation boundary between the orchestration layer and the filesystem.
 *
 * After cloning, performs dynamic placeholder injection. All text files are scanned
 * for placeholders matching the syntax {{PLACEHOLDER_NAME}} and replaced with
 * corresponding user-provided values.
 *
 * Placeholder Syntax:
 *   {{PLACEHOLDER_NAME}} - Case-sensitive. Replaced with the value from the
 *   placeholders map. If not found, the placeholder remains unreplaced and
 *   an error is returned.
 *
 * Security guarantees:
 *   - All paths are resolved to canonical absolute form before any FS operation
 *   - Source and workspace paths are validated against configured allowed roots
 *   - Per-file paths are checked to stay within the source root (symlink/traversal guard)
 *   - runId is validated to prevent directory escape via path separators or ..
 *
 * Feature: template-cloning-logic
 * Issue branch: issue-062-implement-template-cloning-logic
 */

import * as nodePath from 'path';
import * as nodeFs from 'fs/promises';

// ── FileSystemAdapter ─────────────────────────────────────────────────────────

/**
 * Injectable abstraction over fs/promises.
 * The default implementation delegates to Node's fs/promises.
 * Tests inject an in-memory implementation.
 */
export interface FileSystemAdapter {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string, options: { recursive: true }): Promise<string[]>;
  copyFile(src: string, dest: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

/** Real filesystem adapter wrapping fs/promises. */
export const realFsAdapter: FileSystemAdapter = {
  async mkdir(path, options) {
    await nodeFs.mkdir(path, options);
  },
  async readdir(path, options) {
    const entries = await nodeFs.readdir(path, options);
    return entries as string[];
  },
  async copyFile(src, dest) {
    // Ensure parent directory exists before copying
    await nodeFs.mkdir(nodePath.dirname(dest), { recursive: true });
    await nodeFs.copyFile(src, dest);
  },
  async exists(path) {
    try {
      await nodeFs.access(path);
      return true;
    } catch {
      return false;
    }
  },
  async readFile(path, encoding) {
    return await nodeFs.readFile(path, encoding);
  },
  async writeFile(path, content) {
    await nodeFs.writeFile(path, content);
  },
};

// ── TemplateSource discriminated union ────────────────────────────────────────

export interface LocalTemplateSource {
  type: 'local';
  /** Absolute path to the template directory on the local filesystem. */
  path: string;
}

/**
 * Discriminated union for template sources.
 * Currently supports 'local' only; extensible to 'git', 's3', etc.
 */
export type TemplateSource = LocalTemplateSource;

// ── CloneRequest / CloneResult / CloneError ───────────────────────────────────

export interface CloneRequest {
  source: TemplateSource;
  /** Absolute path to the root directory where workspaces are created. */
  workspaceRoot: string;
  /** Caller-supplied unique identifier (e.g. UUID). Must not contain / \ or .. */
  runId: string;
  /** Optional map of placeholder names to values. All required placeholders must be present. */
  placeholders?: Record<string, string>;
}

export interface CloneError {
  /** The filesystem path involved, or 'unknown'. */
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface CloneResult {
  success: boolean;
  /** Absolute, normalized workspace path. Present only when success: true. */
  workspacePath?: string;
  errors: CloneError[];
}

// ── CloningConfig ─────────────────────────────────────────────────────────────

export interface CloningConfig {
  /** Absolute paths under which source templates may reside. */
  allowedSourceRoots: string[];
  /** Absolute paths under which workspaces may be created. */
  allowedWorkspaceRoots: string[];
}

function parseRootsFromEnv(envVar: string, fallback: string[]): string[] {
  const val = process.env[envVar];
  if (!val) return fallback;
  return val.split(':').map((p) => nodePath.resolve(p)).filter(Boolean);
}

export const defaultCloningConfig: CloningConfig = {
  allowedSourceRoots: parseRootsFromEnv('CRAFT_TEMPLATE_ROOTS', [
    nodePath.resolve(process.cwd(), 'templates'),
    nodePath.resolve(process.cwd(), 'src/templates'),
  ]),
  allowedWorkspaceRoots: parseRootsFromEnv('CRAFT_WORKSPACE_ROOTS', [
    nodePath.resolve(process.cwd(), '.workspaces'),
    nodePath.resolve('/tmp', 'craft-workspaces'),
  ]),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns true if `child` is at or under `parent`. */
function isUnder(child: string, parent: string): boolean {
  const rel = nodePath.relative(parent, child);
  return !rel.startsWith('..') && !nodePath.isAbsolute(rel);
}

/** Returns true if `p` is under at least one of the given roots. */
function isUnderAnyRoot(p: string, roots: string[]): boolean {
  return roots.some((root) => isUnder(p, root));
}

/** Returns true if the file extension indicates a text file. */
function isTextFile(filePath: string): boolean {
  const textExtensions = new Set([
    '.txt', '.md', '.json', '.js', '.ts', '.tsx', '.jsx', '.css', '.scss',
    '.html', '.xml', '.yaml', '.yml', '.toml', '.env', '.sh', '.bash',
    '.ts', '.tsx', '.java', '.py', '.go', '.rs', '.cpp', '.c', '.h',
    '.vue', '.svelte', '.astro', '.config', '.properties', '.gradle',
    '.makefile', '.dockerfile', '.gitignore', '.eslintrc', '.prettierrc'
  ]);
  const ext = nodePath.extname(filePath).toLowerCase();
  return textExtensions.has(ext) || filePath.match(/^\.[\w-]+$/) || !nodePath.extname(filePath);
}

// ── TemplateCloningService ────────────────────────────────────────────────────

export class TemplateCloningService {
  constructor(
    private readonly fs: FileSystemAdapter = realFsAdapter,
    private readonly config: CloningConfig = defaultCloningConfig
  ) {}

  /**
   * Clone template sources into an isolated workspace directory.
   *
   * Steps:
   *   1. Validate runId (no path separators or .. segments)
   *   2. Resolve and validate source path and workspaceRoot against allowed roots
   *   3. Create workspace directory (fail on collision)
   *   4. Enumerate and copy files with per-file traversal guard
   *
   * Never throws — all error paths return a resolved Promise<CloneResult>.
   */
  async clone(request: unknown): Promise<CloneResult> {
    try {
      const req = request as CloneRequest | null | undefined;

      // ── Step 1: Validate runId ───────────────────────────────────────────────
      const runId = typeof req?.runId === 'string' ? req.runId : '';
      const runIdError = this.validateRunId(runId);
      if (runIdError) return { success: false, errors: [runIdError] };

      const workspaceRoot = typeof req?.workspaceRoot === 'string' ? req.workspaceRoot : '';
      const source = req?.source;

      // ── Step 2: Validate source type ─────────────────────────────────────────
      if (!source || typeof (source as any).type !== 'string') {
        return {
          success: false,
          errors: [{ path: 'source.type', message: 'source is required', severity: 'error' }],
        };
      }

      switch ((source as TemplateSource).type) {
        case 'local':
          return await this.cloneLocal(
            source as LocalTemplateSource,
            workspaceRoot,
            runId,
            req?.placeholders
          );
        default:
          return {
            success: false,
            errors: [
              {
                path: 'source.type',
                message: `source type not supported: ${(source as any).type}`,
                severity: 'error',
              },
            ],
          };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        errors: [{ path: 'unknown', message: msg, severity: 'error' }],
      };
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private validateRunId(runId: string): CloneError | null {
    if (!runId) {
      return { path: 'runId', message: 'runId is required', severity: 'error' };
    }
    if (runId.includes('/') || runId.includes('\\') || runId.includes('..')) {
      return {
        path: 'runId',
        message: `runId must not contain path separators or ".." segments: "${runId}"`,
        severity: 'error',
      };
    }
    return null;
  }

  private async cloneLocal(
    source: LocalTemplateSource,
    workspaceRoot: string,
    runId: string,
    placeholders?: Record<string, string>
  ): Promise<CloneResult> {
    // ── Resolve paths ──────────────────────────────────────────────────────────
    const resolvedSource = nodePath.resolve(source.path);
    const resolvedWorkspaceRoot = nodePath.resolve(workspaceRoot);
    const workspacePath = nodePath.join(resolvedWorkspaceRoot, runId);

    // ── Validate against allowed roots ────────────────────────────────────────
    if (!isUnderAnyRoot(resolvedSource, this.config.allowedSourceRoots)) {
      return {
        success: false,
        errors: [
          {
            path: resolvedSource,
            message: `source path is outside allowed source roots: ${resolvedSource}`,
            severity: 'error',
          },
        ],
      };
    }

    if (!isUnderAnyRoot(resolvedWorkspaceRoot, this.config.allowedWorkspaceRoots)) {
      return {
        success: false,
        errors: [
          {
            path: resolvedWorkspaceRoot,
            message: `workspaceRoot is outside allowed workspace roots: ${resolvedWorkspaceRoot}`,
            severity: 'error',
          },
        ],
      };
    }

    // ── Create workspace directory (detect collisions) ────────────────────────
    const alreadyExists = await this.fs.exists(workspacePath);
    if (alreadyExists) {
      return {
        success: false,
        errors: [
          {
            path: workspacePath,
            message: `workspace already exists (collision): ${workspacePath}`,
            severity: 'error',
          },
        ],
      };
    }

    try {
      await this.fs.mkdir(workspacePath, { recursive: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        errors: [{ path: workspacePath, message: `failed to create workspace: ${msg}`, severity: 'error' }],
      };
    }

    // ── Enumerate and copy files ──────────────────────────────────────────────
    const warnings: CloneError[] = [];
    let entries: string[] = [];

    try {
      entries = await this.fs.readdir(resolvedSource, { recursive: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        errors: [{ path: resolvedSource, message: `failed to read source directory: ${msg}`, severity: 'error' }],
      };
    }

    for (const entry of entries) {
      const srcFile = nodePath.join(resolvedSource, entry);
      const resolvedSrcFile = nodePath.resolve(srcFile);

      // Per-file traversal guard
      if (!isUnder(resolvedSrcFile, resolvedSource)) {
        warnings.push({
          path: resolvedSrcFile,
          message: `skipped: file path escapes source root: ${resolvedSrcFile}`,
          severity: 'warning',
        });
        continue;
      }

      const destFile = nodePath.join(workspacePath, entry);

      try {
        await this.fs.copyFile(resolvedSrcFile, destFile);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push({
          path: resolvedSrcFile,
          message: `failed to copy file: ${msg}`,
          severity: 'warning',
        });
      }
    }

    // ── Placeholder injection ──────────────────────────────────────────────────
    if (placeholders && Object.keys(placeholders).length > 0) {
      const injectionResult = await this.injectPlaceholders(workspacePath, placeholders);
      if (!injectionResult.success) {
        return injectionResult;
      }
      warnings.push(...injectionResult.errors);
    }

    return {
      success: true,
      workspacePath,
      errors: warnings,
    };
  }

  private async injectPlaceholders(
    workspacePath: string,
    placeholders: Record<string, string>
  ): Promise<CloneResult> {
    const errors: CloneError[] = [];
    let entries: string[] = [];

    try {
      entries = await this.fs.readdir(workspacePath, { recursive: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        errors: [{ path: workspacePath, message: `failed to read workspace for placeholder injection: ${msg}`, severity: 'error' }],
      };
    }

    const placeholderRegex = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

    for (const entry of entries) {
      const filePath = nodePath.join(workspacePath, entry);

      // Only process text files
      if (!isTextFile(filePath)) {
        continue;
      }

      try {
        let content = await this.fs.readFile(filePath, 'utf-8');
        const originalContent = content;

        // Replace all placeholders
        for (const [name, value] of Object.entries(placeholders)) {
          content = content.replace(new RegExp(`\\{\\{${name}\\}\\}`, 'g'), value);
        }

        // Check for unreplaced placeholders
        const unreplacedMatches = content.match(placeholderRegex);
        if (unreplacedMatches) {
          unreplacedMatches.forEach((match) => {
            errors.push({
              path: filePath,
              message: `unreplaced placeholder found: ${match}`,
              severity: 'error',
            });
          });
        }

        if (content !== originalContent) {
          await this.fs.writeFile(filePath, content);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({
          path: filePath,
          message: `failed to inject placeholders: ${msg}`,
          severity: 'warning',
        });
      }
    }

    // Return error if any unreplaced placeholders were found
    if (errors.some((e) => e.severity === 'error')) {
      return {
        success: false,
        errors,
      };
    }

    return {
      success: true,
      errors,
    };
  }
}

export const templateCloningService = new TemplateCloningService();
