/**
 * GitHubService
 *
 * Creates and manages GitHub repositories on behalf of deployments.
 *
 * Configuration (env vars):
 *   GITHUB_TOKEN — Personal Access Token or GitHub App installation token
 *   GITHUB_ORG   — Optional. When set, repos are created under this organisation.
 *                  When absent, repos are created under the token-owner's account.
 *
 * Naming collisions:
 *   If the requested name already exists the service appends a numeric suffix
 *   (-1, -2, …) and retries up to MAX_NAME_RETRIES times, then throws with
 *   code 'COLLISION' so the caller can surface a meaningful error message.
 *
 * Rate limiting:
 *   GitHub returns 403/429 with a `Retry-After` (seconds) header when rate-
 *   limited. The service retries up to 3 times with bounded exponential
 *   backoff, honouring the `Retry-After` value when present. If all retries
 *   are exhausted the last error is re-thrown so the caller can surface a
 *   meaningful message. Transient network errors (NETWORK_ERROR) are retried
 *   with the same strategy.
 *
 * Returns:
 *   { repository, resolvedName } — all identifiers needed for subsequent git
 *   push and Vercel deployment steps (url, cloneUrl, sshUrl, fullName,
 *   defaultBranch).
 */

import type { CreateRepoRequest, GitHubErrorCode, Repository } from '@craft/types';
import { githubAccessValidator, type GitHubAccessValidator } from './github-access-validator.service';

const GITHUB_API_BASE = 'https://api.github.com';
const MAX_NAME_RETRIES = 5;
const MAX_REPOSITORY_NAME_LENGTH = 100;
const DEFAULT_REPOSITORY_TOPICS = ['craft', 'stellar', 'defi'];

/** Maximum number of rate-limit / transient-error retries per API call. */
const MAX_RATE_LIMIT_RETRIES = 3;
/** Base delay (ms) for exponential backoff when no Retry-After header is present. */
const BACKOFF_BASE_MS = 1_000;
/** Hard cap on any single backoff delay (ms). */
const BACKOFF_MAX_MS = 32_000;

/**
 * Executes `fn`, retrying up to MAX_RATE_LIMIT_RETRIES (3) times on RATE_LIMITED
 * or NETWORK_ERROR responses, for a maximum of 4 total attempts.
 *
 * Retry strategy — delay per attempt:
 *   1. When GitHub returns a `Retry-After` header its value (in seconds) is used
 *      as-is (converted to milliseconds) — honouring the server's back-pressure.
 *   2. Otherwise full-jitter exponential backoff is applied:
 *        delay = Math.random() * min(BACKOFF_BASE_MS * 2^attempt, BACKOFF_MAX_MS)
 *      where BACKOFF_BASE_MS = 1_000 ms and BACKOFF_MAX_MS = 32_000 ms.
 *      Full jitter spreads retries across the window to avoid thundering-herd spikes.
 *
 * Non-retryable errors (AUTH_FAILED, COLLISION, UNKNOWN) are re-thrown
 * immediately without consuming a retry slot.
 *
 * @param fn    - Async operation to attempt.
 * @param sleep - Injected sleep function (override in tests to avoid real delays).
 */
export async function withGitHubRetry<T>(
    fn: () => Promise<T>,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
        try {
            return await fn();
        } catch (err: unknown) {
            lastError = err;

            const isGitHubError =
                err instanceof Error && (err as { code?: string }).code !== undefined;
            const code = isGitHubError ? (err as { code: string }).code : null;

            // Only retry on transient errors; surface terminal errors immediately.
            if (code !== 'RATE_LIMITED' && code !== 'NETWORK_ERROR') {
                throw err;
            }

            if (attempt === MAX_RATE_LIMIT_RETRIES) {
                break;
            }

            // Honour Retry-After when GitHub tells us how long to wait.
            const retryAfterMs = (err as { retryAfterMs?: number }).retryAfterMs ?? 0;
            const backoff = retryAfterMs > 0
                ? retryAfterMs
                : computeDelay(attempt, BACKOFF_BASE_MS, BACKOFF_MAX_MS);

            console.warn(
                `[GitHubService] ${code} — retrying in ${Math.round(backoff)}ms ` +
                `(attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})`,
            );

            await sleep(backoff);
        }
    }

    throw lastError;
}

/**
 * Sanitizes an arbitrary string into a valid GitHub repository name.
 *
 * Rules enforced:
 *   - Only alphanumerics, hyphens, underscores, and dots are kept.
 *   - Leading dots are stripped (GitHub forbids them).
 *   - Consecutive hyphens are collapsed to a single hyphen.
 *   - Trailing hyphens, underscores, and dots are stripped.
 *   - Names are truncated to 100 characters (GitHub limit).
 *   - Empty results fall back to the literal string "repo".
 */
export function sanitizeRepoName(raw: string): string {
    let name = raw.replace(/[^a-zA-Z0-9\-_.]/g, '-');
    name = name.replace(/^[.\-]+/, '');
    name = name.replace(/-{2,}/g, '-');
    name = name.replace(/_{2,}/g, '_');
    name = name.replace(/[-_.]+$/, '');
    name = name.slice(0, MAX_REPOSITORY_NAME_LENGTH);
    name = name.replace(/[-_.]+$/, '');
    return name || 'repo';
}

function sanitizeRepoTopics(topics?: string[]): string[] {
    const normalized = topics
        ?.map((topic) =>
            topic
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9-]/g, '-')
                .replace(/-{2,}/g, '-')
                .replace(/^-+|-+$/g, ''),
        )
        .filter((topic) => topic.length > 0) ?? [];

    return [...new Set([...DEFAULT_REPOSITORY_TOPICS, ...normalized])].slice(0, 20);
}

function buildCandidateName(baseName: string, attempt: number): string {
    if (attempt === 0) {
        return baseName;
    }

    const suffix = `-${attempt}`;
    const trimmedBase = baseName.slice(0, MAX_REPOSITORY_NAME_LENGTH - suffix.length);
    return `${trimmedBase}${suffix}`;
}

export interface CreateRepoResult {
    repository: Repository;
    /** Final repository name, which may carry a numeric suffix if a collision occurred. */
    resolvedName: string;
}

class GitHubApiError extends Error {
    constructor(
        message: string,
        public readonly code: GitHubErrorCode,
        public readonly retryAfterMs?: number,
    ) {
        super(message);
        this.name = 'GitHubApiError';
    }
}

export class GitHubService {
    constructor(
        private readonly _accessValidator: Pick<GitHubAccessValidator, 'validate'> = githubAccessValidator,
    ) {}
    private get token(): string {
        return process.env.GITHUB_TOKEN ?? '';
    }

    private get org(): string | null {
        return process.env.GITHUB_ORG || null;
    }

    private buildHeaders(): Record<string, string> {
        if (!this.token) {
            throw new GitHubApiError(
                'GITHUB_TOKEN is not configured',
                'AUTH_FAILED',
            );
        }
        return {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
        };
    }

    /**
     * Create a GitHub repository, retrying with `-1`, `-2`, … suffixes on
     * name collisions. Each attempt is wrapped in `withGitHubRetry` so
     * transient rate-limit and network errors are retried with bounded
     * exponential backoff before a collision suffix is tried.
     *
     * Throws a GitHubApiError on unrecoverable failures.
     */
    async createRepository(request: CreateRepoRequest): Promise<CreateRepoResult> {
        // ── Pre-flight: validate GitHub access before any write operation ─────
        const access = await this._accessValidator.validate();
        if (!access.valid) {
            const code: GitHubErrorCode =
                access.code === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'AUTH_FAILED';
            throw new GitHubApiError(access.message, code, access.retryAfterMs);
        }

        const baseName = sanitizeRepoName(request.name);
        let attempt = 0;

        while (attempt <= MAX_NAME_RETRIES) {
            const candidateName = buildCandidateName(baseName, attempt);

            try {
                const repository = await withGitHubRetry(
                    () => this.tryCreate(candidateName, request),
                    sleep,
                );
                return { repository, resolvedName: candidateName };
            } catch (err: unknown) {
                if (err instanceof GitHubApiError && err.code === 'COLLISION') {
                    attempt++;
                    continue;
                }
                throw err;
            }
        }

        throw new GitHubApiError(
            `Repository name "${baseName}" is still taken after ${MAX_NAME_RETRIES} retries`,
            'COLLISION',
        );
    }

    /**
     * Verify that the configured token can reach the GitHub API.
     * Returns false on any authentication failure or network error.
     */
    async validateAccess(): Promise<boolean> {
        try {
            const res = await fetch(`${GITHUB_API_BASE}/user`, {
                headers: this.buildHeaders(),
            });
            return res.ok;
        } catch {
            return false;
        }
    }

    // ── Branch protection rules (Issue #647) ──────────────────────────────────

    /**
     * Apply branch protection rules to a repository's production branch.
     *
     * Configuration (env vars):
     *   GITHUB_PROTECTED_BRANCH — Branch name to protect (default: main)
     *   GITHUB_REQUIRED_STATUS_CHECKS — Comma-separated list of required status checks
     *
     * Rules enforced:
     *   - Require status checks to pass before merging
     *   - Prevent force pushes
     *   - Prevent branch deletion
     *
     * @param owner - Repository owner (e.g., "myorg")
     * @param repo - Repository name
     * @returns Success status and error details if the operation fails
     */
    async protectBranch(owner: string, repo: string): Promise<{ success: boolean; error?: string }> {
        const protectedBranch = process.env.GITHUB_PROTECTED_BRANCH ?? 'main';
        const statusChecks = (process.env.GITHUB_REQUIRED_STATUS_CHECKS ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);

        const protectionPayload: Record<string, unknown> = {
            required_status_checks: {
                strict: true,
                contexts: statusChecks.length > 0 ? statusChecks : ['ci/build'],
            },
            enforce_admins: true,
            required_pull_request_reviews: null,
            restrictions: null,
            allow_force_pushes: false,
            allow_deletions: false,
            required_linear_history: false,
            require_conversation_resolution: false,
        };

        try {
            const res = await fetch(
                `${GITHUB_API_BASE}/repos/${owner}/${repo}/branches/${protectedBranch}/protection`,
                {
                    method: 'PUT',
                    headers: this.buildHeaders(),
                    body: JSON.stringify(protectionPayload),
                },
            );

            if (!res.ok) {
                const body = await res.json().catch(() => ({})) as Record<string, unknown>;
                const message = (body.message as string) ?? `Branch protection failed: ${res.status}`;

                // 404 means branch doesn't exist yet (expected after repo creation)
                if (res.status === 404) {
                    return {
                        success: false,
                        error: `Branch "${protectedBranch}" not found — create the branch before protecting it`,
                    };
                }

                return { success: false, error: message };
            }

            return { success: true };
        } catch (err: unknown) {
            return {
                success: false,
                error: err instanceof Error ? err.message : 'Unknown error applying branch protection',
            };
        }
    }

    /**
     * Delete a GitHub repository by owner and repo name (Issue #110).
     * Uses the shared request helper for consistent error handling.
     * Logs errors but does not throw - best effort cleanup.
     */
    async deleteRepository(owner: string, repo: string): Promise<void> {
        try {
            const headers = this.buildHeaders();
            const res = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}`, {
                method: 'DELETE',
                headers,
            });
            
            if (!res.ok && res.status !== 404) {
                const data = await res.json().catch(() => ({}));
                const message = (data as { message?: string }).message ?? `GitHub API error: ${res.status}`;
                console.error(`GitHub repo delete failed for ${owner}/${repo}:`, message);
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Network request failed';
            console.error(`GitHub repo delete failed for ${owner}/${repo}:`, message);
            // Continue - DB deletion should succeed regardless
        }
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private async tryCreate(
        name: string,
        request: CreateRepoRequest,
    ): Promise<Repository> {
        const endpoint = this.org
            ? `${GITHUB_API_BASE}/orgs/${this.org}/repos`
            : `${GITHUB_API_BASE}/user/repos`;

        const payload = {
            name,
            description: request.description ?? '',
            homepage: request.homepage ?? '',
            topics: sanitizeRepoTopics(request.topics),
            private: request.private,
            auto_init: true,
        };
        const headers = this.buildHeaders();

        let res: Response;
        try {
            res = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
            });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Network request failed';
            throw new GitHubApiError(message, 'NETWORK_ERROR');
        }

        const data = await res.json().catch(() => ({}));
        const body = data as { message?: string; errors?: { message?: string }[] };

        if (res.status === 422) {
            const isNameCollision =
                (body.errors ?? []).some((e) =>
                    e.message?.toLowerCase().includes('already exists'),
                ) || body.message?.toLowerCase().includes('already exists');

            if (isNameCollision) {
                throw new GitHubApiError(
                    `Repository "${name}" already exists`,
                    'COLLISION',
                );
            }
            throw new GitHubApiError(
                body.message ?? 'Unprocessable entity from GitHub API',
                'UNKNOWN',
            );
        }

        if (res.status === 401) {
            throw new GitHubApiError(
                'GitHub token is invalid or expired',
                'AUTH_FAILED',
            );
        }

        if (res.status === 429) {
            const retryAfterSec = parseInt(res.headers.get('Retry-After') ?? '0', 10);
            throw new GitHubApiError(
                'GitHub API rate limit exceeded',
                'RATE_LIMITED',
                retryAfterSec * 1000,
            );
        }

        if (res.status === 403) {
            const retryAfterSec = parseInt(res.headers.get('Retry-After') ?? '0', 10);
            const isRateLimited =
                retryAfterSec > 0 ||
                res.headers.get('X-RateLimit-Remaining') === '0' ||
                body.message?.toLowerCase().includes('rate limit') === true;

            if (isRateLimited) {
                throw new GitHubApiError(
                    'GitHub API rate limit exceeded',
                    'RATE_LIMITED',
                    retryAfterSec * 1000,
                );
            }

            throw new GitHubApiError(
                body.message ?? 'GitHub token does not have permission to create repositories',
                'AUTH_FAILED',
            );
        }

        if (!res.ok) {
            throw new GitHubApiError(
                body.message ?? `GitHub API error: ${res.status}`,
                'NETWORK_ERROR',
            );
        }

        return this.mapRepository(data as Record<string, unknown>);
    }

    private mapRepository(raw: Record<string, unknown>): Repository {
        return {
            id: raw.id as number,
            url: raw.html_url as string,
            cloneUrl: raw.clone_url as string,
            sshUrl: raw.ssh_url as string,
            fullName: raw.full_name as string,
            defaultBranch: (raw.default_branch as string | undefined) ?? 'main',
            private: raw.private as boolean,
        };
    }
}

export const githubService = new GitHubService(githubAccessValidator);
