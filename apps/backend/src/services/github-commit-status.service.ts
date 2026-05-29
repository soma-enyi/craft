/**
 * GitHubCommitStatusService
 *
 * Posts GitHub commit statuses at each deployment pipeline stage so that
 * developers can observe progress directly in pull-request and commit views
 * on GitHub.
 *
 * GitHub Statuses API reference:
 *   POST /repos/{owner}/{repo}/statuses/{sha}
 *   https://docs.github.com/en/rest/commits/statuses
 *
 * Status lifecycle wired by DeploymentPipelineService:
 *   pending  → immediately after a deployment record is created (pipeline starting)
 *   success  → after the deployment is marked `completed`
 *   failure  → after the deployment is marked `failed`
 *   error    → reserved for unexpected errors (network / API)
 *
 * Each status POST:
 *   - `state`       : 'pending' | 'success' | 'failure' | 'error'
 *   - `context`     : human-readable label (e.g. "craft/deployment")
 *   - `description` : concise summary (≤ 140 chars; GitHub truncates longer values)
 *   - `target_url`  : link to the deployment detail page in CRAFT
 *
 * Failure policy:
 *   Report errors are caught and logged but NEVER re-thrown. Status reporting
 *   is best-effort — it must never block or fail the deployment pipeline.
 *
 * Configuration (env vars):
 *   GITHUB_TOKEN     — Personal Access Token or GitHub App installation token.
 *                      Must have `repo:status` scope.
 *   NEXT_PUBLIC_APP_URL — Base URL of the CRAFT application (e.g. https://craft.app).
 *                         Used to build the `target_url` for each status.
 *
 * Issue: #651
 * Branch: feat/issue-115-github-commit-status-reporting
 */

const GITHUB_API_BASE = 'https://api.github.com';

/** Valid states accepted by the GitHub Statuses API. */
export type GitHubCommitState = 'pending' | 'success' | 'failure' | 'error';

export interface PostCommitStatusRequest {
    /** GitHub repository owner (user or organisation login). */
    owner: string;
    /** GitHub repository name. */
    repo: string;
    /** Full 40-character commit SHA to attach the status to. */
    sha: string;
    /** Status state. */
    state: GitHubCommitState;
    /**
     * Namespaced label that distinguishes this status from others on the same
     * commit (e.g. "craft/deployment" or "craft/deployment — generating").
     * GitHub groups statuses by context in the UI.
     */
    context: string;
    /**
     * Short human-readable description shown alongside the status badge.
     * GitHub truncates to 140 characters; keep descriptions concise.
     */
    description: string;
    /**
     * Optional URL the status badge links to (shown as "Details" on GitHub).
     * Should point to the CRAFT deployment detail page.
     */
    targetUrl?: string;
}

export interface PostCommitStatusResult {
    success: boolean;
    /** HTTP status code returned by the GitHub API (present even on failure). */
    statusCode?: number;
    /** Error message if the API call failed. */
    error?: string;
}

interface FetchLike {
    (input: string, init?: RequestInit): Promise<Response>;
}

/**
 * Builds the deployment detail page URL for a given deployment ID.
 *
 * @param deploymentId - The CRAFT deployment UUID.
 * @param appUrl       - Base URL of the CRAFT app (e.g. "https://craft.app").
 *                       Defaults to the NEXT_PUBLIC_APP_URL env var.
 */
export function buildDeploymentDetailUrl(
    deploymentId: string,
    appUrl: string = process.env.NEXT_PUBLIC_APP_URL ?? '',
): string {
    const base = appUrl.replace(/\/$/, '');
    return `${base}/app/deployments/${deploymentId}`;
}

export class GitHubCommitStatusService {
    constructor(private readonly _fetch: FetchLike = fetch) {}

    /**
     * Post a commit status to the GitHub Statuses API.
     *
     * This method NEVER throws. Any API or network failure is captured in the
     * returned result so the caller can log the error without breaking its own
     * control flow.
     *
     * @param request - Status payload.
     * @returns Result indicating whether the POST succeeded.
     */
    async postCommitStatus(request: PostCommitStatusRequest): Promise<PostCommitStatusResult> {
        const token = process.env.GITHUB_TOKEN ?? '';

        if (!token) {
            return {
                success: false,
                error: 'GITHUB_TOKEN is not configured — commit status not posted',
            };
        }

        const { owner, repo, sha, state, context, description, targetUrl } = request;

        const payload: Record<string, string | undefined> = {
            state,
            context,
            // GitHub hard-caps descriptions at 140 characters.
            description: description.length > 140 ? description.slice(0, 137) + '…' : description,
        };

        if (targetUrl) {
            payload.target_url = targetUrl;
        }

        const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/statuses/${sha}`;

        try {
            const response = await this._fetch(url, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const body = await response.json().catch(() => ({})) as Record<string, unknown>;
                const message = (body.message as string | undefined) ?? `GitHub API error: ${response.status}`;
                return { success: false, statusCode: response.status, error: message };
            }

            return { success: true, statusCode: response.status };
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Unknown network error';
            return { success: false, error: `Network error posting commit status: ${message}` };
        }
    }

    /**
     * Convenience wrapper that posts a `pending` status.
     *
     * Typically called at the start of the deployment pipeline before any
     * stage has executed.
     */
    async reportPending(
        owner: string,
        repo: string,
        sha: string,
        deploymentId: string,
        stageName: string = 'Deployment',
    ): Promise<PostCommitStatusResult> {
        return this.postCommitStatus({
            owner,
            repo,
            sha,
            state: 'pending',
            context: 'craft/deployment',
            description: `${stageName} is in progress…`,
            targetUrl: buildDeploymentDetailUrl(deploymentId),
        });
    }

    /**
     * Convenience wrapper that posts a `success` status.
     *
     * Called after the deployment has been marked `completed`.
     */
    async reportSuccess(
        owner: string,
        repo: string,
        sha: string,
        deploymentId: string,
        deploymentUrl?: string,
    ): Promise<PostCommitStatusResult> {
        const description = deploymentUrl
            ? `Deployed to ${deploymentUrl}`
            : 'Deployment completed successfully';

        return this.postCommitStatus({
            owner,
            repo,
            sha,
            state: 'success',
            context: 'craft/deployment',
            description,
            targetUrl: buildDeploymentDetailUrl(deploymentId),
        });
    }

    /**
     * Convenience wrapper that posts a `failure` status.
     *
     * Called after the deployment has been marked `failed`.
     */
    async reportFailure(
        owner: string,
        repo: string,
        sha: string,
        deploymentId: string,
        failedStage?: string,
    ): Promise<PostCommitStatusResult> {
        const description = failedStage
            ? `Deployment failed at stage: ${failedStage}`
            : 'Deployment failed';

        return this.postCommitStatus({
            owner,
            repo,
            sha,
            state: 'failure',
            context: 'craft/deployment',
            description,
            targetUrl: buildDeploymentDetailUrl(deploymentId),
        });
    }
}

export const githubCommitStatusService = new GitHubCommitStatusService();
