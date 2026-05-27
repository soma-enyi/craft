import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseRepoIdentity,
  GitHubRepositoryUpdateService,
} from './github-repository-update.service';
import {
  GitHubPushAuthError,
  GitHubPushApiError,
  GitHubPushNetworkError,
} from './github-push.service';

// ---------------------------------------------------------------------------
// Supabase mock
// ---------------------------------------------------------------------------

const mockSingle = vi.fn();
const mockEqUpdate = vi.fn();
const mockEqSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockSelect = vi.fn();
const mockFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ from: mockFrom }),
}));

// ---------------------------------------------------------------------------
// Push service / code generator mocks
// ---------------------------------------------------------------------------

const mockPushGeneratedCode = vi.fn();
const mockGenerate = vi.fn();
const mockPushService = { pushGeneratedCode: mockPushGeneratedCode };
const mockCodeGenerator = { generate: mockGenerate };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEPLOYMENT_ID = 'deploy-123';
const USER_ID = 'user-abc';
const REPO_URL = 'https://github.com/acme/my-app';

const makeDeployment = (overrides: Record<string, unknown> = {}) => ({
  id: DEPLOYMENT_ID,
  user_id: USER_ID,
  status: 'completed',
  repository_url: REPO_URL,
  full_name: 'acme/my-app',
  customization_config: { theme: 'dark' },
  ...overrides,
});

const makeCommitRef = () => ({
  owner: 'acme',
  repo: 'my-app',
  branch: 'main',
  commitSha: 'abc123',
  treeSha: 'tree456',
  commitUrl: 'https://github.com/acme/my-app/commit/abc123',
  previousCommitSha: 'prev789',
  createdBranch: false,
  fileCount: 2,
});

const makeFiles = () => [
  { path: 'src/index.ts', content: 'export {}', type: 'code' },
  { path: 'README.md', content: '# Hello', type: 'config' },
];

/**
 * Sets up the Supabase mock chain for a deployment fetch.
 * .from('deployments').select(...).eq(...).eq(...).single()
 */
function setupDeploymentFetch(data: unknown, error: unknown = null) {
  mockSingle.mockResolvedValueOnce({ data, error });
  mockEqSelect.mockReturnValueOnce({ single: mockSingle });
  const mockEqFirst = vi.fn().mockReturnValueOnce({ eq: mockEqSelect });
  mockSelect.mockReturnValueOnce({ eq: mockEqFirst });
  mockFrom.mockReturnValueOnce({ select: mockSelect });
}

/**
 * Sets up the Supabase mock chain for an insert.
 * .from('deployment_updates').insert(...)
 */
function setupInsert() {
  mockInsert.mockResolvedValueOnce({ error: null });
  mockFrom.mockReturnValueOnce({ insert: mockInsert });
}

/**
 * Sets up the Supabase mock chain for an update.
 * .from(table).update(...).eq(...)
 */
function setupUpdate() {
  mockEqUpdate.mockResolvedValueOnce({ error: null });
  mockUpdate.mockReturnValueOnce({ eq: mockEqUpdate });
  mockFrom.mockReturnValueOnce({ update: mockUpdate });
}

// ---------------------------------------------------------------------------
// parseRepoIdentity
// ---------------------------------------------------------------------------

describe('parseRepoIdentity', () => {
  it('returns correct owner/repo for a standard URL', () => {
    expect(parseRepoIdentity('https://github.com/acme/my-app')).toEqual({
      owner: 'acme',
      repo: 'my-app',
    });
  });

  it('strips .git suffix', () => {
    expect(parseRepoIdentity('https://github.com/acme/my-app.git')).toEqual({
      owner: 'acme',
      repo: 'my-app',
    });
  });

  it('strips trailing slash', () => {
    expect(parseRepoIdentity('https://github.com/acme/my-app/')).toEqual({
      owner: 'acme',
      repo: 'my-app',
    });
  });

  it('strips both .git and trailing slash', () => {
    expect(parseRepoIdentity('https://github.com/acme/my-app.git/')).toEqual({
      owner: 'acme',
      repo: 'my-app',
    });
  });

  it('throws INVALID_REPO_IDENTITY for non-GitHub URLs', () => {
    expect(() => parseRepoIdentity('https://gitlab.com/acme/my-app')).toThrow(
      expect.objectContaining({ code: 'INVALID_REPO_IDENTITY' }),
    );
  });

  it('throws INVALID_REPO_IDENTITY for URLs missing the repo segment', () => {
    expect(() => parseRepoIdentity('https://github.com/acme')).toThrow(
      expect.objectContaining({ code: 'INVALID_REPO_IDENTITY' }),
    );
  });

  it('throws INVALID_REPO_IDENTITY for empty string', () => {
    expect(() => parseRepoIdentity('')).toThrow(
      expect.objectContaining({ code: 'INVALID_REPO_IDENTITY' }),
    );
  });
});

// ---------------------------------------------------------------------------
// GitHubRepositoryUpdateService.updateRepository
// ---------------------------------------------------------------------------

describe('GitHubRepositoryUpdateService.updateRepository', () => {
  let service: GitHubRepositoryUpdateService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new GitHubRepositoryUpdateService(mockPushService as any, mockCodeGenerator as any);
  });

  const baseParams = {
    deploymentId: DEPLOYMENT_ID,
    userId: USER_ID,
    customizationConfig: { theme: 'light' } as any,
  };

  // ── Pre-flight errors ────────────────────────────────────────────────────

  it('throws REPO_NOT_FOUND when deployment not found', async () => {
    setupDeploymentFetch(null, { message: 'not found' });

    await expect(service.updateRepository(baseParams)).rejects.toMatchObject({
      code: 'REPO_NOT_FOUND',
    });
  });

  it('throws INVALID_STATE when deployment status is not completed', async () => {
    setupDeploymentFetch(makeDeployment({ status: 'pending' }));

    await expect(service.updateRepository(baseParams)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });

  it('throws REPO_NOT_FOUND when repository_url is null', async () => {
    setupDeploymentFetch(makeDeployment({ repository_url: null }));

    await expect(service.updateRepository(baseParams)).rejects.toMatchObject({
      code: 'REPO_NOT_FOUND',
    });
  });

  it('throws INVALID_REPO_IDENTITY when repository_url is malformed', async () => {
    setupDeploymentFetch(makeDeployment({ repository_url: 'not-a-url' }));

    await expect(service.updateRepository(baseParams)).rejects.toMatchObject({
      code: 'INVALID_REPO_IDENTITY',
    });
  });

  it('throws NO_FILES_GENERATED when code generator returns empty array', async () => {
    setupDeploymentFetch(makeDeployment());
    mockGenerate.mockReturnValueOnce({ generatedFiles: [] });

    await expect(service.updateRepository(baseParams)).rejects.toMatchObject({
      code: 'NO_FILES_GENERATED',
    });
  });

  // ── Push error mapping ───────────────────────────────────────────────────

  it('maps GitHubPushAuthError to AUTH_FAILED', async () => {
    setupDeploymentFetch(makeDeployment());
    mockGenerate.mockReturnValueOnce({ generatedFiles: makeFiles() });
    setupInsert();
    mockPushGeneratedCode.mockRejectedValueOnce(new GitHubPushAuthError('bad credentials'));
    // rollback: update deployments + update deployment_updates
    setupUpdate();
    setupUpdate();

    await expect(service.updateRepository(baseParams)).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
  });

  it('maps GitHubPushApiError with status 429 to RATE_LIMITED', async () => {
    setupDeploymentFetch(makeDeployment());
    mockGenerate.mockReturnValueOnce({ generatedFiles: makeFiles() });
    setupInsert();
    const apiErr = new GitHubPushApiError('rate limited', 429);
    (apiErr as any).retryAfterMs = 60000;
    mockPushGeneratedCode.mockRejectedValueOnce(apiErr);
    setupUpdate();
    setupUpdate();

    await expect(service.updateRepository(baseParams)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('maps GitHubPushNetworkError to NETWORK_ERROR', async () => {
    setupDeploymentFetch(makeDeployment());
    mockGenerate.mockReturnValueOnce({ generatedFiles: makeFiles() });
    setupInsert();
    mockPushGeneratedCode.mockRejectedValueOnce(new GitHubPushNetworkError('timeout'));
    setupUpdate();
    setupUpdate();

    await expect(service.updateRepository(baseParams)).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
  });

  // ── Success path ─────────────────────────────────────────────────────────

  it('returns { commitRef, deploymentId } on success', async () => {
    const commitRef = makeCommitRef();
    setupDeploymentFetch(makeDeployment());
    mockGenerate.mockReturnValueOnce({ generatedFiles: makeFiles() });
    setupInsert();
    mockPushGeneratedCode.mockResolvedValueOnce(commitRef);
    setupUpdate(); // deployments update
    setupUpdate(); // deployment_updates update

    const result = await service.updateRepository(baseParams);

    expect(result).toEqual({ commitRef, deploymentId: DEPLOYMENT_ID });
  });

  it('updates deployment record with new customization_config on success', async () => {
    const commitRef = makeCommitRef();
    const newConfig = { theme: 'light' };
    setupDeploymentFetch(makeDeployment());
    mockGenerate.mockReturnValueOnce({ generatedFiles: makeFiles() });
    setupInsert();
    mockPushGeneratedCode.mockResolvedValueOnce(commitRef);
    setupUpdate();
    setupUpdate();

    await service.updateRepository({ ...baseParams, customizationConfig: newConfig as any });

    // The first update call should be on 'deployments' with the new config
    const deploymentsUpdateCall = mockUpdate.mock.calls[0][0];
    expect(deploymentsUpdateCall).toMatchObject({ customization_config: newConfig });
  });

  it('marks update record as completed on success', async () => {
    const commitRef = makeCommitRef();
    setupDeploymentFetch(makeDeployment());
    mockGenerate.mockReturnValueOnce({ generatedFiles: makeFiles() });
    setupInsert();
    mockPushGeneratedCode.mockResolvedValueOnce(commitRef);
    setupUpdate();
    setupUpdate();

    await service.updateRepository(baseParams);

    // The second update call should mark the update record as completed
    const updateRecordCall = mockUpdate.mock.calls[1][0];
    expect(updateRecordCall).toMatchObject({ status: 'completed' });
    expect(updateRecordCall.completed_at).toBeDefined();
  });

  it('invokes rollback (marks update record as rolled_back) on push failure', async () => {
    setupDeploymentFetch(makeDeployment());
    mockGenerate.mockReturnValueOnce({ generatedFiles: makeFiles() });
    setupInsert();
    mockPushGeneratedCode.mockRejectedValueOnce(new GitHubPushNetworkError('timeout'));
    setupUpdate(); // rollback: restore deployments
    setupUpdate(); // rollback: mark deployment_updates as rolled_back

    await expect(service.updateRepository(baseParams)).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });

    // Second update call should set status to rolled_back
    const rollbackUpdateCall = mockUpdate.mock.calls[1][0];
    expect(rollbackUpdateCall).toMatchObject({ status: 'rolled_back' });
  });

  it('retries on transient errors (5xx, network) and succeeds after retry', async () => {
    setupDeploymentFetch(makeDeployment());
    mockGenerate.mockReturnValueOnce({ generatedFiles: makeFiles() });
    setupInsert();
    // First call fails with 503, second succeeds
    mockPushGeneratedCode
      .mockRejectedValueOnce(new GitHubPushApiError('Service unavailable', 503))
      .mockResolvedValueOnce(makeCommitRef());
    setupUpdate(); // persist state update

    const result = await service.updateRepository(baseParams);

    expect(result).toMatchObject({ deploymentId: DEPLOYMENT_ID });
    // Should have retried after the 503 error
    expect(mockPushGeneratedCode).toHaveBeenCalledTimes(2);
  });

  it('does not retry on non-retryable errors (4xx)', async () => {
    setupDeploymentFetch(makeDeployment());
    mockGenerate.mockReturnValueOnce({ generatedFiles: makeFiles() });
    setupInsert();
    // 401 auth error should not be retried
    mockPushGeneratedCode.mockRejectedValueOnce(new GitHubPushAuthError('Invalid token'));
    setupUpdate(); // rollback

    await expect(service.updateRepository(baseParams)).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });

    // Should only be called once (no retry)
    expect(mockPushGeneratedCode).toHaveBeenCalledTimes(1);
  });

  it('retries on rate limit (429) with backoff', async () => {
    setupDeploymentFetch(makeDeployment());
    mockGenerate.mockReturnValueOnce({ generatedFiles: makeFiles() });
    setupInsert();
    // Rate limit should be retried
    mockPushGeneratedCode
      .mockRejectedValueOnce(new GitHubPushApiError('Rate limited', 429))
      .mockResolvedValueOnce(makeCommitRef());
    setupUpdate(); // persist state update

    const result = await service.updateRepository(baseParams);

    expect(result).toMatchObject({ deploymentId: DEPLOYMENT_ID });
    // Should have retried after rate limit
    expect(mockPushGeneratedCode).toHaveBeenCalledTimes(2);
  });

  it('retries on network errors and succeeds after multiple retries', async () => {
    setupDeploymentFetch(makeDeployment());
    mockGenerate.mockReturnValueOnce({ generatedFiles: makeFiles() });
    setupInsert();
    // Network error should be retried
    mockPushGeneratedCode
      .mockRejectedValueOnce(new GitHubPushNetworkError('ECONNREFUSED'))
      .mockRejectedValueOnce(new GitHubPushNetworkError('timeout'))
      .mockResolvedValueOnce(makeCommitRef());
    setupUpdate(); // persist state update

    const result = await service.updateRepository(baseParams);

    expect(result).toMatchObject({ deploymentId: DEPLOYMENT_ID });
    // Should have retried twice
    expect(mockPushGeneratedCode).toHaveBeenCalledTimes(3);
  });

  it('fails after max retries exceeded for transient errors', async () => {
    setupDeploymentFetch(makeDeployment());
    mockGenerate.mockReturnValueOnce({ generatedFiles: makeFiles() });
    setupInsert();
    // Always fail with retryable error
    mockPushGeneratedCode.mockRejectedValue(new GitHubPushApiError('Service unavailable', 503));
    setupUpdate(); // rollback

    await expect(service.updateRepository(baseParams)).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });

    // Should have retried multiple times
    expect(mockPushGeneratedCode.mock.calls.length).toBeGreaterThan(1);
  });
});
