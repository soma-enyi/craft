/**
 * Unit tests for GitHubService and sanitizeRepoName.
 *
 * Mocks:
 *   global.fetch — stubbed with vi.stubGlobal so no real HTTP calls are made.
 *   GITHUB_TOKEN  — set via process.env in each suite, cleaned up after.
 *   GITHUB_ORG    — set/unset per test where org behaviour is under test.
 *
 * Coverage:
 *   sanitizeRepoName       — valid pass-through, invalid chars, leading dots,
 *                            consecutive hyphens, trailing punctuation, length
 *                            truncation, empty / all-invalid fallback.
 *
 *   createRepository       — success (user account), success (org account),
 *                            auth headers present, name sanitized before API
 *                            call, private flag forwarded, collision retry
 *                            (errors array), collision retry (message field),
 *                            exhausted retries → COLLISION error, 429 rate-
 *                            limit, 403 rate-limit, 401 auth failure, 5xx
 *                            network error, missing token → AUTH_FAILED.
 *
 *   validateAccess         — valid token → true, invalid token → false,
 *                            network throw → false, missing token → false.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sanitizeRepoName, GitHubService } from './github.service';

// ── fetch mock ────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Validator mock (always passes — tests for the validator itself live in
//    github-access-validator.service.test.ts) ──────────────────────────────────

const passingValidator = {
    validate: vi.fn().mockResolvedValue({ valid: true, code: 'OK', message: 'ok' }),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeJsonResponse(
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k: string) => headers[k] ?? null },
        json: async () => body,
    };
}

const REPO_RESPONSE = {
    id: 12345,
    html_url: 'https://github.com/craft-templates/my-dex',
    clone_url: 'https://github.com/craft-templates/my-dex.git',
    ssh_url: 'git@github.com:craft-templates/my-dex.git',
    full_name: 'craft-templates/my-dex',
    default_branch: 'main',
    private: true,
};

const BASE_REQUEST = {
    name: 'my-dex',
    description: 'My DApp',
    private: true,
    userId: 'user-1',
};

// ── sanitizeRepoName ──────────────────────────────────────────────────────────

describe('sanitizeRepoName', () => {
    it('passes valid names through unchanged', () => {
        expect(sanitizeRepoName('stellar-dex')).toBe('stellar-dex');
        expect(sanitizeRepoName('My_App.v2')).toBe('My_App.v2');
    });

    it('replaces spaces and special characters with hyphens', () => {
        expect(sanitizeRepoName('My App!')).toBe('My-App');
    });

    it('strips leading dots', () => {
        expect(sanitizeRepoName('...hidden-repo')).toBe('hidden-repo');
    });

    it('collapses consecutive hyphens into a single hyphen', () => {
        expect(sanitizeRepoName('foo--bar')).toBe('foo-bar');
    });

    it('strips trailing hyphens', () => {
        expect(sanitizeRepoName('my-repo-')).toBe('my-repo');
    });

    it('strips trailing dots', () => {
        expect(sanitizeRepoName('my-repo.')).toBe('my-repo');
    });

    it('truncates to 100 characters', () => {
        const long = 'a'.repeat(150);
        expect(sanitizeRepoName(long)).toHaveLength(100);
    });

    it('returns "repo" for an empty string', () => {
        expect(sanitizeRepoName('')).toBe('repo');
    });

    it('returns "repo" when all characters are invalid', () => {
        expect(sanitizeRepoName('...')).toBe('repo');
    });
});

// ── GitHubService ─────────────────────────────────────────────────────────────

describe('GitHubService', () => {
    let service: GitHubService;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.GITHUB_TOKEN = 'ghp_test_token';
        delete process.env.GITHUB_ORG;
        passingValidator.validate.mockResolvedValue({ valid: true, code: 'OK', message: 'ok' });
        service = new GitHubService(passingValidator);
    });

    afterEach(() => {
        delete process.env.GITHUB_TOKEN;
        delete process.env.GITHUB_ORG;
    });

    // ── createRepository ────────────────────────────────────────────────────────

    describe('createRepository', () => {
        it('creates a repository under the token-owner account', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(201, REPO_RESPONSE));

            const result = await service.createRepository(BASE_REQUEST);

            expect(result.repository).toStrictEqual({
                id: 12345,
                url: 'https://github.com/craft-templates/my-dex',
                cloneUrl: 'https://github.com/craft-templates/my-dex.git',
                sshUrl: 'git@github.com:craft-templates/my-dex.git',
                fullName: 'craft-templates/my-dex',
                defaultBranch: 'main',
                private: true,
            });
            expect(result.resolvedName).toBe('my-dex');
            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.github.com/user/repos',
                expect.objectContaining({ method: 'POST' }),
            );
        });

        it('creates a repository under the org when GITHUB_ORG is set', async () => {
            process.env.GITHUB_ORG = 'craft-templates';
            service = new GitHubService(passingValidator);
            mockFetch.mockResolvedValueOnce(makeJsonResponse(201, REPO_RESPONSE));

            await service.createRepository(BASE_REQUEST);

            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.github.com/orgs/craft-templates/repos',
                expect.objectContaining({ method: 'POST' }),
            );
        });

        it('includes a Bearer token in the Authorization header', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(201, REPO_RESPONSE));

            await service.createRepository(BASE_REQUEST);

            const [, options] = mockFetch.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
            expect(options.headers['Authorization']).toBe('Bearer ghp_test_token');
            expect(options.headers['Accept']).toBe('application/vnd.github+json');
        });

        it('forwards the private flag to the request body', async () => {
            mockFetch.mockResolvedValueOnce(
                makeJsonResponse(201, { ...REPO_RESPONSE, private: false }),
            );

            await service.createRepository({ ...BASE_REQUEST, private: false });

            const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            const body = JSON.parse(options.body as string);
            expect(body.private).toBe(false);
        });

        it('includes repository metadata in the request body', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(201, REPO_RESPONSE));

            await service.createRepository({
                ...BASE_REQUEST,
                homepage: 'https://craft.example.com',
                topics: ['DEX', 'stellar', ' custom topic '],
            });

            const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            const body = JSON.parse(options.body as string);
            expect(body.homepage).toBe('https://craft.example.com');
            expect(body.topics).toEqual([
                'craft',
                'stellar',
                'defi',
                'dex',
                'custom-topic',
            ]);
        });

        it('applies default repository topics when none are provided', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(201, REPO_RESPONSE));

            await service.createRepository(BASE_REQUEST);

            const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            const body = JSON.parse(options.body as string);
            expect(body.topics).toEqual(['craft', 'stellar', 'defi']);
        });

        it('sanitizes the repository name before sending it to the API', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(201, REPO_RESPONSE));

            await service.createRepository({ ...BASE_REQUEST, name: 'My App!!' });

            const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            const body = JSON.parse(options.body as string);
            expect(body.name).toBe('My-App');
        });

        it('falls back to "main" when default_branch is absent in the response', async () => {
            const { default_branch: _, ...withoutBranch } = REPO_RESPONSE;
            mockFetch.mockResolvedValueOnce(makeJsonResponse(201, withoutBranch));

            const result = await service.createRepository(BASE_REQUEST);
            expect(result.repository.defaultBranch).toBe('main');
        });

        it('retries with a numeric suffix when the errors array signals a collision', async () => {
            const collisionBody = {
                errors: [{ message: 'name already exists on this account' }],
            };
            mockFetch
                .mockResolvedValueOnce(makeJsonResponse(422, collisionBody))
                .mockResolvedValueOnce(
                    makeJsonResponse(201, { ...REPO_RESPONSE, full_name: 'craft-templates/my-dex-1' }),
                );

            const result = await service.createRepository(BASE_REQUEST);

            expect(result.resolvedName).toBe('my-dex-1');
            expect(mockFetch).toHaveBeenCalledTimes(2);
            const [, secondOptions] = mockFetch.mock.calls[1] as [string, RequestInit];
            expect(JSON.parse(secondOptions.body as string).name).toBe('my-dex-1');
        });

        it('retries when the top-level message field signals a collision', async () => {
            const collisionBody = { message: 'Repository already exists' };
            mockFetch
                .mockResolvedValueOnce(makeJsonResponse(422, collisionBody))
                .mockResolvedValueOnce(makeJsonResponse(201, REPO_RESPONSE));

            const result = await service.createRepository(BASE_REQUEST);
            expect(result.resolvedName).toBe('my-dex-1');
        });

        it('throws a COLLISION error after exhausting all retry attempts', async () => {
            const collisionBody = {
                errors: [{ message: 'name already exists on this account' }],
            };
            // base + 5 suffixed attempts = 6 total
            for (let i = 0; i <= 5; i++) {
                mockFetch.mockResolvedValueOnce(makeJsonResponse(422, collisionBody));
            }

            await expect(service.createRepository(BASE_REQUEST)).rejects.toMatchObject({
                code: 'COLLISION',
            });
            expect(mockFetch).toHaveBeenCalledTimes(6);
        });

        it('truncates long names before adding a retry suffix', async () => {
            const longName = 'a'.repeat(100);
            const collisionBody = {
                errors: [{ message: 'name already exists on this account' }],
            };
            mockFetch
                .mockResolvedValueOnce(makeJsonResponse(422, collisionBody))
                .mockResolvedValueOnce(makeJsonResponse(201, REPO_RESPONSE));

            const result = await service.createRepository({
                ...BASE_REQUEST,
                name: longName,
            });

            expect(result.resolvedName).toHaveLength(100);
            const [, secondOptions] = mockFetch.mock.calls[1] as [string, RequestInit];
            expect(JSON.parse(secondOptions.body as string).name).toBe(`${'a'.repeat(98)}-1`);
        });

        it('throws a RATE_LIMITED error with retryAfterMs on HTTP 429', async () => {
            const response = makeJsonResponse(429, { message: 'rate limited' }, { 'Retry-After': '60' });
            // 1 initial + 3 retries, all rate-limited
            mockFetch.mockResolvedValue(response);

            await expect(service.createRepository(BASE_REQUEST, noSleep)).rejects.toMatchObject({
                code: 'RATE_LIMITED',
                retryAfterMs: 60_000,
            });
        });

        it('throws a RATE_LIMITED error with retryAfterMs on HTTP 403', async () => {
            const response = makeJsonResponse(403, { message: 'rate limited' }, { 'Retry-After': '30' });
            mockFetch.mockResolvedValue(response);

            await expect(service.createRepository(BASE_REQUEST, noSleep)).rejects.toMatchObject({
                code: 'RATE_LIMITED',
                retryAfterMs: 30_000,
            });
        });

        it('throws AUTH_FAILED on HTTP 403 when permissions are insufficient', async () => {
            mockFetch.mockResolvedValueOnce(
                makeJsonResponse(403, { message: 'Resource not accessible by integration' }),
            );

            await expect(service.createRepository(BASE_REQUEST)).rejects.toMatchObject({
                code: 'AUTH_FAILED',
                message: 'Resource not accessible by integration',
            });
        });

        it('throws an AUTH_FAILED error on HTTP 401', async () => {
            mockFetch.mockResolvedValueOnce(
                makeJsonResponse(401, { message: 'Bad credentials' }),
            );

            await expect(service.createRepository(BASE_REQUEST)).rejects.toMatchObject({
                code: 'AUTH_FAILED',
            });
        });

        it('throws a NETWORK_ERROR for unexpected server errors', async () => {
            // 1 initial + 3 retries, all 500
            mockFetch.mockResolvedValue(
                makeJsonResponse(500, { message: 'Internal Server Error' }),
            );

            await expect(service.createRepository(BASE_REQUEST, noSleep)).rejects.toMatchObject({
                code: 'NETWORK_ERROR',
                message: 'Internal Server Error',
            });
        });

        it('throws NETWORK_ERROR when fetch itself fails', async () => {
            // 1 initial + 3 retries, all throw
            mockFetch.mockRejectedValue(new Error('socket hang up'));

            await expect(service.createRepository(BASE_REQUEST, noSleep)).rejects.toMatchObject({
                code: 'NETWORK_ERROR',
                message: 'socket hang up',
            });
        });

        it('throws a 422 non-collision as UNKNOWN', async () => {
            mockFetch.mockResolvedValueOnce(
                makeJsonResponse(422, { message: 'Validation Failed', errors: [] }),
            );

            await expect(service.createRepository(BASE_REQUEST)).rejects.toMatchObject({
                code: 'UNKNOWN',
            });
        });

        it('throws AUTH_FAILED immediately when GITHUB_TOKEN is not configured', async () => {
            delete process.env.GITHUB_TOKEN;
            service = new GitHubService(passingValidator);

            await expect(service.createRepository(BASE_REQUEST)).rejects.toMatchObject({
                code: 'AUTH_FAILED',
            });
            expect(mockFetch).not.toHaveBeenCalled();
        });
    });

    // ── validateAccess ──────────────────────────────────────────────────────────

    describe('validateAccess', () => {
        it('returns true when the token is valid', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(200, { login: 'octocat' }));

            expect(await service.validateAccess()).toBe(true);
            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.github.com/user',
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer ghp_test_token',
                    }),
                }),
            );
        });

        it('returns false when the API returns an error status', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(401, { message: 'Bad credentials' }));
            expect(await service.validateAccess()).toBe(false);
        });

        it('returns false when the network call throws', async () => {
            mockFetch.mockRejectedValueOnce(new Error('network error'));
            expect(await service.validateAccess()).toBe(false);
        });

        it('returns false when GITHUB_TOKEN is not configured', async () => {
            delete process.env.GITHUB_TOKEN;
            service = new GitHubService();
            expect(await service.validateAccess()).toBe(false);
            expect(mockFetch).not.toHaveBeenCalled();
        });
    });

    // ── Branch protection rules (Issue #647) ────────────────────────────────────

    describe('protectBranch', () => {
        beforeEach(() => {
            process.env.GITHUB_PROTECTED_BRANCH = 'main';
            delete process.env.GITHUB_REQUIRED_STATUS_CHECKS;
            vi.clearAllMocks();
        });

        it('applies branch protection rules with default main branch', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(200, { protected: true }));

            const result = await service.protectBranch('myorg', 'my-repo');

            expect(result.success).toBe(true);
            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.github.com/repos/myorg/my-repo/branches/main/protection',
                expect.objectContaining({
                    method: 'PUT',
                    body: expect.stringContaining('"required_status_checks"'),
                }),
            );
        });

        it('uses custom protected branch from env var', async () => {
            process.env.GITHUB_PROTECTED_BRANCH = 'develop';
            mockFetch.mockResolvedValueOnce(makeJsonResponse(200, { protected: true }));

            const result = await service.protectBranch('myorg', 'my-repo');

            expect(result.success).toBe(true);
            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.github.com/repos/myorg/my-repo/branches/develop/protection',
                expect.any(Object),
            );
        });

        it('uses custom required status checks from env var', async () => {
            process.env.GITHUB_REQUIRED_STATUS_CHECKS = 'test, lint, build';
            mockFetch.mockResolvedValueOnce(makeJsonResponse(200, { protected: true }));

            const result = await service.protectBranch('myorg', 'my-repo');

            expect(result.success).toBe(true);
            const body = JSON.parse(
                (mockFetch.mock.calls[0][1] as any).body as string,
            ) as Record<string, unknown>;
            expect(body.required_status_checks).toEqual({
                strict: true,
                contexts: ['test', 'lint', 'build'],
            });
        });

        it('returns error when branch does not exist (404)', async () => {
            mockFetch.mockResolvedValueOnce(
                makeJsonResponse(404, { message: 'Not Found' }),
            );

            const result = await service.protectBranch('myorg', 'my-repo');

            expect(result.success).toBe(false);
            expect(result.error).toMatch(/not found/i);
        });

        it('returns error when protection fails (403 Forbidden)', async () => {
            mockFetch.mockResolvedValueOnce(
                makeJsonResponse(403, { message: 'Insufficient permissions' }),
            );

            const result = await service.protectBranch('myorg', 'my-repo');

            expect(result.success).toBe(false);
            expect(result.error).toMatch(/Insufficient permissions/);
        });

        it('handles network errors gracefully', async () => {
            mockFetch.mockRejectedValueOnce(new Error('Network timeout'));

            const result = await service.protectBranch('myorg', 'my-repo');

            expect(result.success).toBe(false);
            expect(result.error).toMatch(/Network timeout/);
        });

        it('prevents force pushes and branch deletion', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(200, { protected: true }));

            await service.protectBranch('myorg', 'my-repo');

            const body = JSON.parse(
                (mockFetch.mock.calls[0][1] as any).body as string,
            ) as Record<string, unknown>;
            expect(body.allow_force_pushes).toBe(false);
            expect(body.allow_deletions).toBe(false);
            expect(body.enforce_admins).toBe(true);
        });
    });
});
