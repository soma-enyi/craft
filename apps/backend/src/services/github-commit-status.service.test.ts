/**
 * Tests for GitHubCommitStatusService
 *
 * Covers:
 *   - postCommitStatus: happy path (pending, success, failure, error states)
 *   - postCommitStatus: missing GITHUB_TOKEN → returns failure without throwing
 *   - postCommitStatus: GitHub API error response → returns failure without throwing
 *   - postCommitStatus: network error → returns failure without throwing
 *   - postCommitStatus: description truncated to 140 chars
 *   - postCommitStatus: targetUrl omitted when not provided
 *   - reportPending: delegates to postCommitStatus with correct payload
 *   - reportSuccess: includes deployment URL in description
 *   - reportFailure: includes failed stage in description
 *   - buildDeploymentDetailUrl: constructs correct URL
 *
 * Issue: #651
 * Branch: feat/issue-115-github-commit-status-reporting
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    GitHubCommitStatusService,
    buildDeploymentDetailUrl,
    type PostCommitStatusRequest,
} from './github-commit-status.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOkFetch(statusCode = 201): ReturnType<typeof vi.fn> {
    return vi.fn().mockResolvedValue({
        ok: true,
        status: statusCode,
        json: vi.fn().mockResolvedValue({ id: 1 }),
    });
}

function makeErrorFetch(statusCode: number, message = 'Not Found'): ReturnType<typeof vi.fn> {
    return vi.fn().mockResolvedValue({
        ok: false,
        status: statusCode,
        json: vi.fn().mockResolvedValue({ message }),
    });
}

function makeNetworkErrorFetch(message = 'Network failure'): ReturnType<typeof vi.fn> {
    return vi.fn().mockRejectedValue(new Error(message));
}

function makeBaseRequest(overrides?: Partial<PostCommitStatusRequest>): PostCommitStatusRequest {
    return {
        owner: 'org',
        repo: 'my-dex-app',
        sha: 'abc1234def5678abc1234def5678abc1234def56',
        state: 'pending',
        context: 'craft/deployment',
        description: 'Deployment is in progress…',
        targetUrl: 'https://craft.app/app/deployments/deploy-001',
        ...overrides,
    };
}

// ── buildDeploymentDetailUrl ──────────────────────────────────────────────────

describe('buildDeploymentDetailUrl', () => {
    it('constructs the correct URL from a base app URL', () => {
        const url = buildDeploymentDetailUrl('deploy-abc', 'https://craft.app');
        expect(url).toBe('https://craft.app/app/deployments/deploy-abc');
    });

    it('strips a trailing slash from the base URL', () => {
        const url = buildDeploymentDetailUrl('deploy-xyz', 'https://craft.app/');
        expect(url).toBe('https://craft.app/app/deployments/deploy-xyz');
    });

    it('falls back to NEXT_PUBLIC_APP_URL env var when no appUrl is provided', () => {
        const originalEnv = process.env.NEXT_PUBLIC_APP_URL;
        process.env.NEXT_PUBLIC_APP_URL = 'https://staging.craft.app';
        try {
            const url = buildDeploymentDetailUrl('deploy-123');
            expect(url).toBe('https://staging.craft.app/app/deployments/deploy-123');
        } finally {
            process.env.NEXT_PUBLIC_APP_URL = originalEnv;
        }
    });
});

// ── postCommitStatus ──────────────────────────────────────────────────────────

describe('GitHubCommitStatusService — postCommitStatus', () => {
    const originalToken = process.env.GITHUB_TOKEN;

    beforeEach(() => {
        process.env.GITHUB_TOKEN = 'ghp_test_token';
    });

    afterEach(() => {
        process.env.GITHUB_TOKEN = originalToken;
    });

    it('returns success when the GitHub API responds 201', async () => {
        const fetchMock = makeOkFetch(201);
        const svc = new GitHubCommitStatusService(fetchMock);

        const result = await svc.postCommitStatus(makeBaseRequest());

        expect(result.success).toBe(true);
        expect(result.statusCode).toBe(201);
        expect(result.error).toBeUndefined();
    });

    it('sends a POST to the correct GitHub Statuses API endpoint', async () => {
        const fetchMock = makeOkFetch();
        const svc = new GitHubCommitStatusService(fetchMock);
        const req = makeBaseRequest();

        await svc.postCommitStatus(req);

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`https://api.github.com/repos/${req.owner}/${req.repo}/statuses/${req.sha}`);
        expect((init as any).method).toBe('POST');
    });

    it('includes the correct Authorization header', async () => {
        const fetchMock = makeOkFetch();
        const svc = new GitHubCommitStatusService(fetchMock);

        await svc.postCommitStatus(makeBaseRequest());

        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer ghp_test_token');
    });

    it('sends the correct payload body', async () => {
        const fetchMock = makeOkFetch();
        const svc = new GitHubCommitStatusService(fetchMock);
        const req = makeBaseRequest({ state: 'success', context: 'craft/deployment', description: 'Done', targetUrl: 'https://craft.app' });

        await svc.postCommitStatus(req);

        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(init.body as string);
        expect(body.state).toBe('success');
        expect(body.context).toBe('craft/deployment');
        expect(body.description).toBe('Done');
        expect(body.target_url).toBe('https://craft.app');
    });

    it('omits target_url from the payload when targetUrl is not provided', async () => {
        const fetchMock = makeOkFetch();
        const svc = new GitHubCommitStatusService(fetchMock);
        const req = makeBaseRequest({ targetUrl: undefined });

        await svc.postCommitStatus(req);

        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(init.body as string);
        expect(body).not.toHaveProperty('target_url');
    });

    it('truncates description to 140 characters when it is too long', async () => {
        const fetchMock = makeOkFetch();
        const svc = new GitHubCommitStatusService(fetchMock);
        const longDesc = 'x'.repeat(200);
        const req = makeBaseRequest({ description: longDesc });

        await svc.postCommitStatus(req);

        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(init.body as string);
        expect(body.description.length).toBeLessThanOrEqual(140);
        expect(body.description).toMatch(/…$/);
    });

    it('does not truncate descriptions that are exactly 140 characters', async () => {
        const fetchMock = makeOkFetch();
        const svc = new GitHubCommitStatusService(fetchMock);
        const exactDesc = 'x'.repeat(140);

        await svc.postCommitStatus(makeBaseRequest({ description: exactDesc }));

        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(init.body as string);
        expect(body.description).toBe(exactDesc);
        expect(body.description.length).toBe(140);
    });

    it('returns failure (without throwing) when GITHUB_TOKEN is not set', async () => {
        delete process.env.GITHUB_TOKEN;
        const fetchMock = makeOkFetch();
        const svc = new GitHubCommitStatusService(fetchMock);

        const result = await svc.postCommitStatus(makeBaseRequest());

        expect(result.success).toBe(false);
        expect(result.error).toContain('GITHUB_TOKEN');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns failure when GitHub API responds with a non-ok status', async () => {
        const fetchMock = makeErrorFetch(422, 'Unprocessable Entity');
        const svc = new GitHubCommitStatusService(fetchMock);

        const result = await svc.postCommitStatus(makeBaseRequest());

        expect(result.success).toBe(false);
        expect(result.statusCode).toBe(422);
        expect(result.error).toContain('Unprocessable Entity');
    });

    it('returns failure when the network call throws (never re-throws)', async () => {
        const fetchMock = makeNetworkErrorFetch('ECONNREFUSED');
        const svc = new GitHubCommitStatusService(fetchMock);

        const result = await svc.postCommitStatus(makeBaseRequest());

        expect(result.success).toBe(false);
        expect(result.error).toContain('ECONNREFUSED');
    });

    it('does not throw even when fetch throws an unknown (non-Error) value', async () => {
        const fetchMock = vi.fn().mockRejectedValue('string error');
        const svc = new GitHubCommitStatusService(fetchMock);

        await expect(svc.postCommitStatus(makeBaseRequest())).resolves.not.toThrow();
    });

    it('returns failure with GitHub error message when API response body contains message', async () => {
        const fetchMock = makeErrorFetch(404, 'Not Found');
        const svc = new GitHubCommitStatusService(fetchMock);

        const result = await svc.postCommitStatus(makeBaseRequest());

        expect(result.success).toBe(false);
        expect(result.error).toBe('Not Found');
    });

    it('falls back to status code in error message when response body has no message', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            json: vi.fn().mockResolvedValue({}),
        });
        const svc = new GitHubCommitStatusService(fetchMock);

        const result = await svc.postCommitStatus(makeBaseRequest());

        expect(result.success).toBe(false);
        expect(result.error).toContain('500');
    });
});

// ── reportPending ─────────────────────────────────────────────────────────────

describe('GitHubCommitStatusService — reportPending', () => {
    const originalToken = process.env.GITHUB_TOKEN;

    beforeEach(() => {
        process.env.GITHUB_TOKEN = 'ghp_test_token';
    });

    afterEach(() => {
        process.env.GITHUB_TOKEN = originalToken;
    });

    it('posts a pending state with correct context', async () => {
        const fetchMock = makeOkFetch();
        const svc = new GitHubCommitStatusService(fetchMock);

        const result = await svc.reportPending('org', 'repo', 'sha123', 'deploy-001');

        expect(result.success).toBe(true);
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body.state).toBe('pending');
        expect(body.context).toBe('craft/deployment');
    });

    it('includes the deployment detail URL as target_url', async () => {
        const fetchMock = makeOkFetch();
        const svc = new GitHubCommitStatusService(fetchMock);

        process.env.NEXT_PUBLIC_APP_URL = 'https://craft.app';
        await svc.reportPending('org', 'repo', 'sha123', 'deploy-001');

        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body.target_url).toContain('deploy-001');
    });

    it('uses the stageName parameter in the description', async () => {
        const fetchMock = makeOkFetch();
        const svc = new GitHubCommitStatusService(fetchMock);

        await svc.reportPending('org', 'repo', 'sha123', 'deploy-001', 'Code Generation');

        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body.description).toContain('Code Generation');
    });
});

// ── reportSuccess ─────────────────────────────────────────────────────────────

describe('GitHubCommitStatusService — reportSuccess', () => {
    const originalToken = process.env.GITHUB_TOKEN;

    beforeEach(() => {
        process.env.GITHUB_TOKEN = 'ghp_test_token';
    });

    afterEach(() => {
        process.env.GITHUB_TOKEN = originalToken;
    });

    it('posts a success state', async () => {
        const fetchMock = makeOkFetch();
        const svc = new GitHubCommitStatusService(fetchMock);

        const result = await svc.reportSuccess('org', 'repo', 'sha123', 'deploy-001');

        expect(result.success).toBe(true);
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body.state).toBe('success');
    });

    it('includes the deployment URL in the description when provided', async () => {
        const fetchMock = makeOkFetch();
        const svc = new GitHubCommitStatusService(fetchMock);

        await svc.reportSuccess('org', 'repo', 'sha123', 'deploy-001', 'https://myapp.vercel.app');

        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body.description).toContain('https://myapp.vercel.app');
    });

    it('uses a generic success description when no deployment URL is provided', async () => {
        const fetchMock = makeOkFetch();
        const svc = new GitHubCommitStatusService(fetchMock);

        await svc.reportSuccess('org', 'repo', 'sha123', 'deploy-001');

        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body.description).toContain('successfully');
    });

    it('links to the deployment detail page', async () => {
        const fetchMock = makeOkFetch();
        const svc = new GitHubCommitStatusService(fetchMock);
        process.env.NEXT_PUBLIC_APP_URL = 'https://craft.app';

        await svc.reportSuccess('org', 'repo', 'sha123', 'deploy-xyz');

        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body.target_url).toContain('deploy-xyz');
    });
});

// ── reportFailure ─────────────────────────────────────────────────────────────

describe('GitHubCommitStatusService — reportFailure', () => {
    const originalToken = process.env.GITHUB_TOKEN;

    beforeEach(() => {
        process.env.GITHUB_TOKEN = 'ghp_test_token';
    });

    afterEach(() => {
        process.env.GITHUB_TOKEN = originalToken;
    });

    it('posts a failure state', async () => {
        const fetchMock = makeOkFetch();
        const svc = new GitHubCommitStatusService(fetchMock);

        const result = await svc.reportFailure('org', 'repo', 'sha123', 'deploy-001');

        expect(result.success).toBe(true);
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body.state).toBe('failure');
    });

    it('includes the failed stage in the description when provided', async () => {
        const fetchMock = makeOkFetch();
        const svc = new GitHubCommitStatusService(fetchMock);

        await svc.reportFailure('org', 'repo', 'sha123', 'deploy-001', 'deploying');

        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body.description).toContain('deploying');
    });

    it('uses a generic failure description when no stage is provided', async () => {
        const fetchMock = makeOkFetch();
        const svc = new GitHubCommitStatusService(fetchMock);

        await svc.reportFailure('org', 'repo', 'sha123', 'deploy-001');

        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body.description).toBe('Deployment failed');
    });

    it('links to the deployment detail page', async () => {
        const fetchMock = makeOkFetch();
        const svc = new GitHubCommitStatusService(fetchMock);
        process.env.NEXT_PUBLIC_APP_URL = 'https://craft.app';

        await svc.reportFailure('org', 'repo', 'sha123', 'dep-fail');

        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body.target_url).toContain('dep-fail');
    });
});

// ── API version header ────────────────────────────────────────────────────────

describe('GitHubCommitStatusService — request headers', () => {
    beforeEach(() => {
        process.env.GITHUB_TOKEN = 'ghp_test_token';
    });

    it('sends the required GitHub API version header', async () => {
        const fetchMock = makeOkFetch();
        const svc = new GitHubCommitStatusService(fetchMock);

        await svc.postCommitStatus(makeBaseRequest());

        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect((init.headers as Record<string, string>)['X-GitHub-Api-Version']).toBe('2022-11-28');
    });

    it('sends the correct Accept header', async () => {
        const fetchMock = makeOkFetch();
        const svc = new GitHubCommitStatusService(fetchMock);

        await svc.postCommitStatus(makeBaseRequest());

        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect((init.headers as Record<string, string>)['Accept']).toBe('application/vnd.github+json');
    });
});
