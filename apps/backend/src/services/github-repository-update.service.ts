/**
 * GitHubRepositoryUpdateService
 *
 * Handles updating an already-deployed GitHub repository when a user modifies
 * a deployment's customization configuration. Resolves repository identity from
 * the stored deployment record, regenerates files via CodeGeneratorService, and
 * commits them using GitHubPushService.
 *
 * Feature: github-repository-update-flow
 */

import { createClient } from '@/lib/supabase/server';
import { retryWithBackoff, isRetryableError, type RetryOptions } from '@/lib/retry/exponential-backoff';
import type { CustomizationConfig, GeneratedFile, DeploymentStatusType } from '@craft/types';
import {
  githubPushService,
  type GitHubCommitReference,
  type GitHubPushService,
  GitHubPushAuthError,
  GitHubPushApiError,
  GitHubPushNetworkError,
} from './github-push.service';
import { codeGeneratorService, type CodeGeneratorService } from './code-generator.service';
import { githubAccessValidator, type GitHubAccessValidator } from './github-access-validator.service';

// ---------------------------------------------------------------------------
// parseRepoIdentity — pure function
// ---------------------------------------------------------------------------

/**
 * Parses a GitHub HTTPS repository URL into its owner and repo components.
 *
 * Accepts URLs of the form `https://github.com/<owner>/<repo>` with optional
 * trailing slashes or `.git` suffixes, which are normalized before extraction.
 *
 * @param repositoryUrl - A GitHub HTTPS repository URL
 * @returns `{ owner, repo }` extracted from the URL
 * @throws `{ code: 'INVALID_REPO_IDENTITY', message: string }` for any non-matching input
 */
export function parseRepoIdentity(repositoryUrl: string): { owner: string; repo: string } {
  // Normalize: strip trailing slashes and .git suffix
  let normalized = repositoryUrl.trim();
  normalized = normalized.replace(/\/+$/, '');
  if (normalized.endsWith('.git')) {
    normalized = normalized.slice(0, -4);
    normalized = normalized.replace(/\/+$/, '');
  }

  // Validate: must match https://github.com/<owner>/<repo> exactly
  const match = normalized.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/);

  if (!match || !match[1] || !match[2]) {
    throw { code: 'INVALID_REPO_IDENTITY', message: 'Invalid GitHub repository URL' };
  }

  return { owner: match[1], repo: match[2] };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UpdateErrorCode =
  | 'REPO_NOT_FOUND'
  | 'INVALID_REPO_IDENTITY'
  | 'INVALID_STATE'
  | 'NO_FILES_GENERATED'
  | 'AUTH_FAILED'
  | 'RATE_LIMITED'
  | 'NETWORK_ERROR';

export interface ServiceError {
  code: UpdateErrorCode;
  message: string;
  retryAfterMs?: number;
}

export interface UpdateRepositoryParams {
  deploymentId: string;
  userId: string;
  customizationConfig: CustomizationConfig;
  branch?: string;
  commitMessage?: string;
}

export interface UpdateRepositoryResult {
  commitRef: GitHubCommitReference;
  deploymentId: string;
}

// ---------------------------------------------------------------------------
// GitHubRepositoryUpdateService
// ---------------------------------------------------------------------------

export class GitHubRepositoryUpdateService {
  // Retry configuration for GitHub API calls
  private readonly retryOptions: RetryOptions = {
    maxAttempts: 5,
    initialDelayMs: 200,
    maxDelayMs: 30000, // 30 seconds
    maxTotalDurationMs: 5 * 60 * 1000, // 5 minutes
    backoffMultiplier: 2,
  };

  constructor(
    private readonly _githubPushService: Pick<GitHubPushService, 'pushGeneratedCode'> = githubPushService,
    private readonly _codeGenerator: Pick<CodeGeneratorService, 'generate'> = codeGeneratorService,
    private readonly _accessValidator: Pick<GitHubAccessValidator, 'validate'> = githubAccessValidator,
  ) {}

  async updateRepository(params: UpdateRepositoryParams): Promise<UpdateRepositoryResult> {
    const supabase = createClient();
    const { deploymentId, userId, customizationConfig } = params;

    // ── Pre-flight: fetch deployment and validate state ──────────────────────
    const { data: deployment, error: fetchError } = await supabase
      .from('deployments')
      .select('id, user_id, status, repository_url, full_name, customization_config')
      .eq('id', deploymentId)
      .eq('user_id', userId)
      .single();

    if (fetchError || !deployment) {
      throw { code: 'REPO_NOT_FOUND', message: 'Repository not found for this deployment' } satisfies ServiceError;
    }

    if ((deployment.status as DeploymentStatusType) !== 'completed') {
      throw {
        code: 'INVALID_STATE',
        message: `Cannot update deployment in '${deployment.status}' state`,
      } satisfies ServiceError;
    }

    if (!deployment.repository_url) {
      throw { code: 'REPO_NOT_FOUND', message: 'Repository not found for this deployment' } satisfies ServiceError;
    }

    // Parse owner/repo from stored URL — throws INVALID_REPO_IDENTITY if malformed
    const { owner, repo } = parseRepoIdentity(deployment.repository_url as string);

    // ── Pre-flight: validate GitHub access before any write operation ────────
    const access = await this._accessValidator.validate();
    if (!access.valid) {
      const code: UpdateErrorCode =
        access.code === 'RATE_LIMITED' ? 'RATE_LIMITED' :
        access.code === 'NETWORK_ERROR' ? 'NETWORK_ERROR' : 'AUTH_FAILED';
      throw { code, message: access.message, retryAfterMs: access.retryAfterMs } satisfies ServiceError;
    }

    // ── Code generation ──────────────────────────────────────────────────────
    const generationResult = this._codeGenerator.generate({
      templateFamily: 'stellar-dex',
      customization: customizationConfig,
    });

    const files: GeneratedFile[] = generationResult.generatedFiles;

    if (!files || files.length === 0) {
      throw { code: 'NO_FILES_GENERATED', message: 'Code generation produced no files' } satisfies ServiceError;
    }

    // ── Create Update_Record (pending) before any GitHub calls ───────────────
    const updateId = crypto.randomUUID();
    const previousState = {
      customizationConfig: deployment.customization_config,
      status: deployment.status,
    };

    await supabase.from('deployment_updates').insert({
      id: updateId,
      deployment_id: deploymentId,
      user_id: userId,
      new_customization_config: customizationConfig,
      previous_state: previousState,
      status: 'pending',
      created_at: new Date().toISOString(),
    });

    // ── GitHub push with retry ───────────────────────────────────────────────
    const branch = params.branch ?? 'main';
    const commitMessage =
      params.commitMessage ?? `chore: update generated workspace (${new Date().toISOString()})`;

    const token = process.env.GITHUB_TOKEN ?? '';

    let commitRef: GitHubCommitReference;
    try {
      // Retry on transient failures (5xx, network, rate limit)
      // Don't retry on auth errors (4xx except 429) to fail fast
      const retryResult = await retryWithBackoff(
        () =>
          this._githubPushService.pushGeneratedCode({
            owner,
            repo,
            token,
            files,
            branch,
            commitMessage,
          }),
        this.retryOptions,
      );

      if (!retryResult.success) {
        throw retryResult.error;
      }

      commitRef = retryResult.data;
      const attempts = retryResult.attempts;
      if (attempts > 1) {
        console.log(`[github-repository-update] GitHub push succeeded after ${attempts} attempts`);
      }
    } catch (err: unknown) {
      // Map push errors to service error codes, then rollback
      let serviceError: ServiceError;

      if (err instanceof GitHubPushAuthError) {
        serviceError = { code: 'AUTH_FAILED', message: err.message };
      } else if (err instanceof GitHubPushApiError && err.status === 429) {
        const retryAfterMs = (err as any).retryAfterMs as number | undefined;
        serviceError = { code: 'RATE_LIMITED', message: err.message, retryAfterMs };
      } else if (err instanceof GitHubPushNetworkError) {
        serviceError = { code: 'NETWORK_ERROR', message: err.message };
      } else {
        serviceError = {
          code: 'NETWORK_ERROR',
          message: err instanceof Error ? err.message : 'Unknown error during GitHub push',
        };
      }

      console.error('[github-repository-update] Push failed after retries:', serviceError);
      await this._rollback(updateId, deploymentId, previousState);
      throw serviceError;
    }

    // ── Success: persist state ───────────────────────────────────────────────
    await supabase
      .from('deployments')
      .update({
        customization_config: customizationConfig,
        status: 'completed',
        updated_at: new Date().toISOString(),
      })
      .eq('id', deploymentId);

    await supabase
      .from('deployment_updates')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', updateId);

    return { commitRef, deploymentId };
  }

  // ── Private: rollback ──────────────────────────────────────────────────────

  private async _rollback(
    updateId: string,
    deploymentId: string,
    previousState: { customizationConfig: unknown; status: unknown },
  ): Promise<void> {
    const supabase = createClient();
    try {
      await supabase
        .from('deployments')
        .update({
          customization_config: previousState.customizationConfig,
          status: 'completed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', deploymentId);

      await supabase
        .from('deployment_updates')
        .update({ status: 'rolled_back', updated_at: new Date().toISOString() })
        .eq('id', updateId);
    } catch (rollbackErr: unknown) {
      console.error('Rollback failed:', rollbackErr);
      await supabase
        .from('deployment_updates')
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', updateId)
        .catch(() => {/* best-effort */});
    }
  }
}

// Export singleton instance
export const githubRepositoryUpdateService = new GitHubRepositoryUpdateService(
  githubPushService,
  codeGeneratorService,
  githubAccessValidator,
);
