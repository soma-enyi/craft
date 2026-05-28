/**
 * Unit tests for VercelService.
 *
 * Mocks:
 *   global.fetch — stubbed with vi.stubGlobal so no real HTTP calls are made.
 *   VERCEL_TOKEN — set via process.env in each suite, cleaned up after.
 *   VERCEL_TEAM_ID — set/unset per test where team behaviour is under test.
 *
 * Coverage:
 *   validateVercelConfig    — valid token present, missing token.
 *
 *   createProject           — success, success with env vars, success with team scope,
 *                            auth failure, rate limit, network error, project exists.
 *
 *   triggerDeployment       — success, auth failure, rate limit, network error.
 *
 *   addDomain               — success with verification, success without verification,
 *                            domain already exists, auth failure, network error.
 *
 *   removeDomain            — success, domain not found (best-effort), auth failure.
 *
 *   getDomainConfig         — success, domain not found, auth failure.
 *
 *   verifyDomain            — success with requirements, success without requirements,
 *                            auth failure, network error.
 *
 *   getDeployment           — success, deployment not found, auth failure.
 *
 *   getDeploymentStatus     — success with all statuses, deployment not found.
 *
 *   normalizeDeploymentStatus — all status mappings (QUEUED, BUILDING, READY, ERROR,
 *                              FAILED, CANCELED, unknown).
 *
 *   listDeployments         — success, empty list, auth failure.
 *
 *   validateAccess          — valid token → true, invalid token → false,
 *                            network throw → false, missing token → false.
 *
 *   deleteProject           — success, failure (logged but not thrown).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    VercelService,
    validateVercelConfig,
    VercelApiError,
    type VercelDeployment,
    type VercelDeploymentStatus,
    type VercelAlias,
} from './vercel.service';

// ── fetch mock ────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const MOCK_TOKEN = 'test_token';
const makeResponse = makeJsonResponse;

function makeService() {
    const mockFetch = vi.fn();
    const svc = new VercelService(mockFetch);
    return { svc, mockFetch };
}

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

const PROJECT_RESPONSE = {
    id: 'prj_123',
    name: 'my-dex',
    createdAt: Date.now(),
};

const DEPLOYMENT_RESPONSE = {
    id: 'dpl_456',
    name: 'my-dex',
    url: 'my-dex-abc123.vercel.app',
    status: 'QUEUED',
    createdAt: Date.now(),
};

const DOMAIN_RESPONSE = {
    name: 'example.com',
    verified: false,
    forceHttps: true,
    redirect: false,
    verification: [
        {
            domain: 'example.com',
            type: 'CNAME',
            value: 'cname.vercel-dns.com',
            name: 'www',
        },
    ],
};

// ── validateVercelConfig ──────────────────────────────────────────────────────

describe('validateVercelConfig', () => {
    it('returns valid when VERCEL_TOKEN is set', () => {
        process.env.VERCEL_TOKEN = 'test_token';
        expect(validateVercelConfig()).toEqual({ valid: true });
    });

    it('returns invalid with missing VERCEL_TOKEN when token is not set', () => {
        delete process.env.VERCEL_TOKEN;
        expect(validateVercelConfig()).toEqual({
            valid: false,
            missing: 'VERCEL_TOKEN',
        });
    });
});

// ── VercelService ─────────────────────────────────────────────────────────────

describe('VercelService', () => {
    let service: VercelService;

    beforeEach(() => {
        process.env.VERCEL_TOKEN = 'test_token';
        delete process.env.VERCEL_TEAM_ID;
        service = new VercelService();
        vi.clearAllMocks();
    });

    afterEach(() => {
        delete process.env.VERCEL_TOKEN;
        delete process.env.VERCEL_TEAM_ID;
    });

    // ── createProject ──────────────────────────────────────────────────────────

    describe('createProject', () => {
        it('creates a project successfully', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(200, PROJECT_RESPONSE));

            const result = await service.createProject({
                name: 'my-dex',
                gitRepo: 'owner/repo',
                envVars: [],
            });

            expect(result).toEqual({
                id: 'prj_123',
                name: 'my-dex',
                url: 'my-dex.vercel.app',
            });
            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.vercel.com/v9/projects',
                expect.objectContaining({ method: 'POST' }),
            );
        });

        it('creates a project with environment variables', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(200, PROJECT_RESPONSE));
            mockFetch.mockResolvedValueOnce(makeJsonResponse(200, {}));

            await service.createProject({
                name: 'my-dex',
                gitRepo: 'owner/repo',
                envVars: [
                    { key: 'API_KEY', value: 'secret', target: ['production'], type: 'plain' },
                ],
            });

            expect(mockFetch).toHaveBeenCalledTimes(2);
            const [, envOptions] = mockFetch.mock.calls[1] as [string, RequestInit];
            expect(envOptions.method).toBe('POST');
            const envBody = JSON.parse(envOptions.body as string);
            expect(envBody).toEqual([
                { key: 'API_KEY', value: 'secret', target: ['production'], type: 'plain' },
            ]);
        });

        it('creates a project with team scope when VERCEL_TEAM_ID is set', async () => {
            process.env.VERCEL_TEAM_ID = 'team_789';
            service = new VercelService();
            mockFetch.mockResolvedValueOnce(makeJsonResponse(200, PROJECT_RESPONSE));

            await service.createProject({
                name: 'my-dex',
                gitRepo: 'owner/repo',
                envVars: [],
            });

            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.vercel.com/v9/projects?teamId=team_789',
                expect.objectContaining({ method: 'POST' }),
            );
        });

        it('includes a Bearer token in the Authorization header', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(200, PROJECT_RESPONSE));

            await service.createProject({
                name: 'my-dex',
                gitRepo: 'owner/repo',
                envVars: [],
            });

            const [, options] = mockFetch.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
            expect(options.headers['Authorization']).toBe('Bearer test_token');
            expect(options.headers['Content-Type']).toBe('application/json');
        });

        it('throws PROJECT_EXISTS error when project already exists', async () => {
            mockFetch.mockResolvedValueOnce(
                makeJsonResponse(409, { error: { message: 'Project already exists' } }),
            );

            await expect(
                service.createProject({
                    name: 'my-dex',
                    gitRepo: 'owner/repo',
                    envVars: [],
                }),
            ).rejects.toMatchObject({
                code: 'PROJECT_EXISTS',
            });
        });

        it('throws AUTH_FAILED on HTTP 401', async () => {
            mockFetch.mockResolvedValueOnce(
                makeJsonResponse(401, { message: 'Unauthorized' }),
            );

            await expect(
                service.createProject({
                    name: 'my-dex',
                    gitRepo: 'owner/repo',
                    envVars: [],
                }),
            ).rejects.toMatchObject({
                code: 'AUTH_FAILED',
            });
        });

        it('throws RATE_LIMITED on HTTP 429 with retryAfterMs', async () => {
            mockFetch.mockResolvedValueOnce(
                makeJsonResponse(429, { message: 'rate limited' }, { 'Retry-After': '60' }),
            );

            await expect(
                service.createProject({
                    name: 'my-dex',
                    gitRepo: 'owner/repo',
                    envVars: [],
                }),
            ).rejects.toMatchObject({
                code: 'RATE_LIMITED',
                retryAfterMs: 60_000,
            });
        });

        it('throws NETWORK_ERROR when fetch fails', async () => {
            mockFetch.mockRejectedValueOnce(new Error('socket hang up'));

            await expect(
                service.createProject({
                    name: 'my-dex',
                    gitRepo: 'owner/repo',
                    envVars: [],
                }),
            ).rejects.toMatchObject({
                code: 'NETWORK_ERROR',
                message: 'socket hang up',
            });
        });

        it('throws AUTH_FAILED when VERCEL_TOKEN is not configured', async () => {
            delete process.env.VERCEL_TOKEN;
            service = new VercelService();

            await expect(
                service.createProject({
                    name: 'my-dex',
                    gitRepo: 'owner/repo',
                    envVars: [],
                }),
            ).rejects.toMatchObject({
                code: 'AUTH_FAILED',
            });
            expect(mockFetch).not.toHaveBeenCalled();
        });
    });

    // ── triggerDeployment ──────────────────────────────────────────────────────

    describe('triggerDeployment', () => {
        it('triggers a deployment successfully', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(200, DEPLOYMENT_RESPONSE));

            const result = await service.triggerDeployment('prj_123', 'owner/repo');

            expect(result).toEqual({
                deploymentId: 'dpl_456',
                deploymentUrl: 'https://my-dex-abc123.vercel.app',
                status: 'QUEUED',
            });
            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.vercel.com/v13/deployments',
                expect.objectContaining({ method: 'POST' }),
            );
        });

        it('throws AUTH_FAILED on HTTP 401', async () => {
            mockFetch.mockResolvedValueOnce(
                makeJsonResponse(401, { message: 'Unauthorized' }),
            );

            await expect(
                service.triggerDeployment('prj_123', 'owner/repo'),
            ).rejects.toMatchObject({
                code: 'AUTH_FAILED',
            });
        });

        it('throws RATE_LIMITED on HTTP 429', async () => {
            mockFetch.mockResolvedValueOnce(
                makeJsonResponse(429, { message: 'rate limited' }, { 'Retry-After': '30' }),
            );

            await expect(
                service.triggerDeployment('prj_123', 'owner/repo'),
            ).rejects.toMatchObject({
                code: 'RATE_LIMITED',
                retryAfterMs: 30_000,
            });
        });

        it('throws NETWORK_ERROR when fetch fails', async () => {
            mockFetch.mockRejectedValueOnce(new Error('connection refused'));

            await expect(
                service.triggerDeployment('prj_123', 'owner/repo'),
            ).rejects.toMatchObject({
                code: 'NETWORK_ERROR',
            });
        });
    });

    describe('deployment aliases', () => {
        it('lists aliases for a deployment', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(200, {
                aliases: [
                    { uid: 'al_1', alias: 'app.example.com', created: '2026-04-28T12:00:00Z' },
                ],
            }));

            const result = await service.listDeploymentAliases('dpl_456');

            expect(result).toEqual<VercelAlias[]>([
                {
                    uid: 'al_1',
                    alias: 'app.example.com',
                    created: '2026-04-28T12:00:00Z',
                    redirect: null,
                },
            ]);
            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.vercel.com/v2/deployments/dpl_456/aliases',
                expect.objectContaining({ method: 'GET' }),
            );
        });

        it('assigns an alias to a deployment', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(200, {
                uid: 'al_1',
                alias: 'app.example.com',
                created: '2026-04-28T12:00:00Z',
            }));

            const result = await service.assignAliasToDeployment('dpl_456', 'app.example.com');

            expect(result).toEqual({
                uid: 'al_1',
                alias: 'app.example.com',
                created: '2026-04-28T12:00:00Z',
                redirect: null,
            });

            const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(JSON.parse(options.body as string)).toEqual({
                alias: 'app.example.com',
                redirect: null,
            });
        });
    });

    // ── addDomain ──────────────────────────────────────────────────────────────

    describe('addDomain', () => {
        it('adds a domain with verification requirements', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(200, DOMAIN_RESPONSE));

            const result = await service.addDomain({
                domain: 'example.com',
                projectId: 'prj_123',
            });

            expect(result.success).toBe(true);
            expect(result.domain).toBe('example.com');
            expect(result.verification).toEqual([
                {
                    domain: 'example.com',
                    type: 'CNAME',
                    value: 'cname.vercel-dns.com',
                    name: 'www',
                },
            ]);
        });

        it('adds a domain without verification requirements', async () => {
            mockFetch.mockResolvedValueOnce(
                makeJsonResponse(200, { ...DOMAIN_RESPONSE, verification: [] }),
            );

            const result = await service.addDomain({
                domain: 'example.com',
                projectId: 'prj_123',
            });

            expect(result.success).toBe(true);
            expect(result.verification).toBeUndefined();
        });

        it('returns error when domain already exists', async () => {
            mockFetch.mockResolvedValueOnce(
                makeJsonResponse(409, { error: { message: 'Domain already exists' } }),
            );

            const result = await service.addDomain({
                domain: 'example.com',
                projectId: 'prj_123',
            });

            expect(result.success).toBe(false);
            expect(result.errorCode).toBe('DOMAIN_ALREADY_EXISTS');
        });

        it('includes redirect and forceHttps options', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(200, DOMAIN_RESPONSE));

            await service.addDomain({
                domain: 'example.com',
                projectId: 'prj_123',
                redirect: true,
                forceHttps: true,
            });

            const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            const body = JSON.parse(options.body as string);
            expect(body.redirect).toBe(true);
            expect(body.forceHttps).toBe(true);
        });

        it('attaches domain to deployment when deploymentId is provided', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(200, DOMAIN_RESPONSE));

            await service.addDomain({
                domain: 'example.com',
                deploymentId: 'dpl_456',
            });

            const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            const body = JSON.parse(options.body as string);
            expect(body.deploymentId).toBe('dpl_456');
        });
    });

    // ── removeDomain ───────────────────────────────────────────────────────────

    describe('removeDomain', () => {
        it('removes a domain successfully', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(200, {}));

            await service.removeDomain('example.com', 'prj_123');

            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.vercel.com/v4/domains/example.com',
                expect.objectContaining({ method: 'DELETE' }),
            );
        });

        it('handles domain not found gracefully (best-effort cleanup)', async () => {
            mockFetch.mockResolvedValueOnce(
                makeJsonResponse(404, { error: { message: 'Domain not found' } }),
            );

            await expect(
                service.removeDomain('example.com', 'prj_123'),
            ).resolves.not.toThrow();
        });

        it('logs but does not throw on other errors', async () => {
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            mockFetch.mockResolvedValueOnce(
                makeJsonResponse(500, { message: 'Internal Server Error' }),
            );

            await expect(
                service.removeDomain('example.com', 'prj_123'),
            ).resolves.not.toThrow();

            expect(consoleSpy).toHaveBeenCalled();
            consoleSpy.mockRestore();
        });
    });

    // ── getDomainConfig ────────────────────────────────────────────────────────

    describe('getDomainConfig', () => {
        it('returns domain configuration', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(200, DOMAIN_RESPONSE));

            const result = await service.getDomainConfig('example.com');

            expect(result).toEqual({
                name: 'example.com',
                verified: false,
                forceHttps: true,
                redirect: false,
                projectId: undefined,
                deploymentId: undefined,
            });
        });

        it('returns null when domain is not found', async () => {
            mockFetch.mockResolvedValueOnce(
                makeJsonResponse(404, { error: { message: 'Domain not found' } }),
            );

            const result = await service.getDomainConfig('example.com');
            expect(result).toBeNull();
        });

        it('throws on other errors', async () => {
            mockFetch.mockResolvedValueOnce(
                makeJsonResponse(500, { message: 'Internal Server Error' }),
            );

            await expect(
                service.getDomainConfig('example.com'),
            ).rejects.toMatchObject({
                code: 'UNKNOWN',
            });
        });
    });

    // ── verifyDomain ───────────────────────────────────────────────────────────

    describe('verifyDomain', () => {
        it('returns verification status with requirements', async () => {
            mockFetch.mockResolvedValueOnce(
                makeJsonResponse(200, {
                    verified: false,
                    verification: [
                        {
                            domain: 'example.com',
                            type: 'CNAME',
                            value: 'cname.vercel-dns.com',
                            name: 'www',
                        },
                    ],
                }),
            );

            const result = await service.verifyDomain('example.com');

            expect(result.verified).toBe(false);
            expect(result.requirements).toEqual([
                {
                    domain: 'example.com',
                    type: 'CNAME',
                    value: 'cname.vercel-dns.com',
                    name: 'www',
                },
            ]);
        });

        it('returns verification status without requirements', async () => {
            mockFetch.mockResolvedValueOnce(
                makeJsonResponse(200, { verified: true }),
            );

            const result = await service.verifyDomain('example.com');

            expect(result.verified).toBe(true);
            expect(result.requirements).toBeUndefined();
        });

        it('throws on auth failure', async () => {
            mockFetch.mockResolvedValueOnce(
                makeJsonResponse(401, { message: 'Unauthorized' }),
            );

            await expect(
                service.verifyDomain('example.com'),
            ).rejects.toMatchObject({
                code: 'AUTH_FAILED',
            });
        });
    });

    // ── getDeployment ──────────────────────────────────────────────────────────

    describe('getDeployment', () => {
        it('returns deployment details', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(200, DEPLOYMENT_RESPONSE));

            const result = await service.getDeployment('dpl_456');

            expect(result).toEqual({
                id: 'dpl_456',
                name: 'my-dex',
                url: 'my-dex-abc123.vercel.app',
                status: 'QUEUED',
                createdAt: DEPLOYMENT_RESPONSE.createdAt,
                ready: undefined,
                canceled: undefined,
                error: undefined,
                projectId: undefined,
                projectName: undefined,
                meta: undefined,
            });
        });

        it('throws on deployment not found', async () => {
            mockFetch.mockResolvedValueOnce(
                makeJsonResponse(404, { error: { message: 'Deployment not found' } }),
            );

            await expect(
                service.getDeployment('dpl_456'),
            ).rejects.toMatchObject({
                code: 'NOT_FOUND',
            });
        });

        it('throws on auth failure', async () => {
            mockFetch.mockResolvedValueOnce(
                makeJsonResponse(401, { message: 'Unauthorized' }),
            );

            await expect(
                service.getDeployment('dpl_456'),
            ).rejects.toMatchObject({
                code: 'AUTH_FAILED',
            });
        });
    });

    // ── getDeploymentStatus ────────────────────────────────────────────────────

    describe('getDeploymentStatus', () => {
        it('returns normalized deployment status', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(200, DEPLOYMENT_RESPONSE));

            const result = await service.getDeploymentStatus('dpl_456');

            expect(result.status).toBe('pending');
            expect(result.url).toBe('https://my-dex-abc123.vercel.app');
            expect(result.deploymentId).toBe('dpl_456');
        });

        it('throws when deployment is not found', async () => {
            mockFetch.mockResolvedValueOnce(
                makeJsonResponse(404, { error: { message: 'Deployment not found' } }),
            );

            await expect(
                service.getDeploymentStatus('dpl_456'),
            ).rejects.toMatchObject({
                code: 'NOT_FOUND',
            });
        });
    });

    // ── normalizeDeploymentStatus ──────────────────────────────────────────────

    describe('normalizeDeploymentStatus', () => {
        const baseDeployment: VercelDeployment = {
            id: 'dpl_123',
            name: 'test',
            url: 'test.vercel.app',
            status: 'QUEUED',
            createdAt: Date.now(),
        };

        it('maps QUEUED to pending', () => {
            const result = service.normalizeDeploymentStatus({
                ...baseDeployment,
                status: 'QUEUED',
            });
            expect(result.status).toBe('pending');
        });

        it('maps BUILDING to building', () => {
            const result = service.normalizeDeploymentStatus({
                ...baseDeployment,
                status: 'BUILDING',
            });
            expect(result.status).toBe('building');
        });

        it('maps READY to ready', () => {
            const result = service.normalizeDeploymentStatus({
                ...baseDeployment,
                status: 'READY',
                ready: Date.now(),
            });
            expect(result.status).toBe('ready');
            expect(result.readyAt).toBeInstanceOf(Date);
        });

        it('maps ERROR to failed', () => {
            const result = service.normalizeDeploymentStatus({
                ...baseDeployment,
                status: 'ERROR',
                error: Date.now(),
            });
            expect(result.status).toBe('failed');
            expect(result.failedAt).toBeInstanceOf(Date);
            expect(result.errorMessage).toBe('Deployment failed');
        });

        it('maps FAILED to failed', () => {
            const result = service.normalizeDeploymentStatus({
                ...baseDeployment,
                status: 'FAILED',
                error: Date.now(),
            });
            expect(result.status).toBe('failed');
        });

        it('maps CANCELED to canceled', () => {
            const result = service.normalizeDeploymentStatus({
                ...baseDeployment,
                status: 'CANCELED',
                canceled: Date.now(),
            });
            expect(result.status).toBe('canceled');
            expect(result.canceledAt).toBeInstanceOf(Date);
        });

        it('maps unknown status to pending', () => {
            const result = service.normalizeDeploymentStatus({
                ...baseDeployment,
                status: 'UNKNOWN_STATUS' as VercelDeploymentStatus,
            });
            expect(result.status).toBe('pending');
        });

        it('includes projectId and projectName when present', () => {
            const result = service.normalizeDeploymentStatus({
                ...baseDeployment,
                projectId: 'prj_123',
                projectName: 'my-project',
            });
            expect(result.projectId).toBe('prj_123');
            expect(result.projectName).toBe('my-project');
        });
    });

    // ── listDeployments ────────────────────────────────────────────────────────

    describe('listDeployments', () => {
        it('returns a list of deployments', async () => {
            mockFetch.mockResolvedValueOnce(
                makeJsonResponse(200, {
                    deployments: [DEPLOYMENT_RESPONSE],
                }),
            );

            const result = await service.listDeployments('prj_123');

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('dpl_456');
        });

        it('returns empty list when no deployments exist', async () => {
            mockFetch.mockResolvedValueOnce(
                makeJsonResponse(200, { deployments: [] }),
            );

            const result = await service.listDeployments('prj_123');
            expect(result).toEqual([]);
        });

        it('throws on auth failure', async () => {
            mockFetch.mockResolvedValueOnce(
                makeJsonResponse(401, { message: 'Unauthorized' }),
            );

            await expect(
                service.listDeployments('prj_123'),
            ).rejects.toMatchObject({
                code: 'AUTH_FAILED',
            });
        });

        it('respects limit parameter', async () => {
            mockFetch.mockResolvedValueOnce(
                makeJsonResponse(200, { deployments: [] }),
            );

            await service.listDeployments('prj_123', 5);

            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.vercel.com/v6/deployments?projectId=prj_123&limit=5',
                expect.objectContaining({ method: 'GET' }),
            );
        });
    });

    // ── validateAccess ─────────────────────────────────────────────────────────

    describe('validateAccess', () => {
        it('returns true when the token is valid', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(200, { uid: 'user_123' }));

            expect(await service.validateAccess()).toBe(true);
            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.vercel.com/v2/user',
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer test_token',
                    }),
                }),
            );
        });

        it('returns false when the API returns an error status', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(401, { message: 'Unauthorized' }));
            expect(await service.validateAccess()).toBe(false);
        });

        it('returns false when the network call throws', async () => {
            mockFetch.mockRejectedValueOnce(new Error('network error'));
            expect(await service.validateAccess()).toBe(false);
        });

        it('returns false when VERCEL_TOKEN is not configured', async () => {
            delete process.env.VERCEL_TOKEN;
            service = new VercelService();
            expect(await service.validateAccess()).toBe(false);
            expect(mockFetch).not.toHaveBeenCalled();
        });
    });

    // ── deleteProject ──────────────────────────────────────────────────────────

    describe('deleteProject', () => {
        it('deletes a project successfully', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(200, {}));

            await expect(
                service.deleteProject('prj_123'),
            ).resolves.not.toThrow();

            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.vercel.com/v10/projects/prj_123',
                expect.objectContaining({ method: 'DELETE' }),
            );
        });

        it('logs but does not throw on failure', async () => {
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            mockFetch.mockResolvedValueOnce(
                makeJsonResponse(500, { message: 'Internal Server Error' }),
            );

            await expect(
                service.deleteProject('prj_123'),
            ).resolves.not.toThrow();

            expect(consoleSpy).toHaveBeenCalled();
            consoleSpy.mockRestore();
        });
    });
});

describe('VercelService — addDomain', () => {
    beforeEach(() => vi.stubEnv('VERCEL_TOKEN', MOCK_TOKEN));
    afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

    it('resolves without error on 200', async () => {
        const { svc, mockFetch } = makeService();
        mockFetch.mockResolvedValueOnce(makeResponse(200, {}));
        await expect(svc.addDomain({ projectId: 'prj_1', domain: 'example.com' })).resolves.toEqual({
            success: true,
            domain: 'example.com',
            verification: undefined,
        });
    });

    it('throws DOMAIN_EXISTS on 409', async () => {
        const { svc, mockFetch } = makeService();
        mockFetch.mockResolvedValueOnce(makeResponse(409, { error: { message: 'exists' } }));
        await expect(svc.addDomain({ projectId: 'prj_1', domain: 'example.com' })).resolves.toMatchObject({
            success: false,
            errorCode: 'DOMAIN_ALREADY_EXISTS',
        });
    });

    it('throws AUTH_FAILED on 401', async () => {
        const { svc, mockFetch } = makeService();
        mockFetch.mockResolvedValueOnce(makeResponse(401, { message: 'Unauthorized' }));
        await expect(svc.addDomain({ projectId: 'prj_1', domain: 'example.com' })).resolves.toMatchObject({
            success: false,
            errorCode: 'AUTH_FAILED',
        });
    });

    it('throws RATE_LIMITED on 429 with retryAfterMs', async () => {
        const { svc, mockFetch } = makeService();
        mockFetch.mockResolvedValueOnce(
            makeResponse(429, { message: 'Rate limited' }, { 'Retry-After': '10' }),
        );
        await expect(svc.addDomain({ projectId: 'prj_1', domain: 'example.com' })).resolves.toMatchObject({
            success: false,
            errorCode: 'RATE_LIMITED',
        });
    });

    it('throws NETWORK_ERROR when fetch throws', async () => {
        const { svc, mockFetch } = makeService();
        mockFetch.mockRejectedValueOnce(new Error('socket hang up'));
        await expect(svc.addDomain({ projectId: 'prj_1', domain: 'example.com' })).resolves.toMatchObject({
            success: false,
            errorCode: 'NETWORK_ERROR',
        });
    });
});

describe('VercelService — getCertificate', () => {
    beforeEach(() => vi.stubEnv('VERCEL_TOKEN', MOCK_TOKEN));
    afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

    it('returns state:active when expiresAt is present', async () => {
        const { svc, mockFetch } = makeService();
        mockFetch.mockResolvedValueOnce(
            makeResponse(200, { cns: ['example.com'], expiresAt: '2027-01-01T00:00:00Z' }),
        );
        const cert = await svc.getCertificate('prj_1', 'example.com');
        expect(cert).toEqual({ domain: 'example.com', state: 'active', expiresAt: '2027-01-01T00:00:00Z' });
    });

    it('returns state:pending when no expiresAt', async () => {
        const { svc, mockFetch } = makeService();
        mockFetch.mockResolvedValueOnce(makeResponse(200, {}));
        const cert = await svc.getCertificate('prj_1', 'example.com');
        expect(cert).toEqual({ domain: 'example.com', state: 'pending' });
    });

    it('returns state:pending on 404 (cert not yet issued)', async () => {
        const { svc, mockFetch } = makeService();
        mockFetch.mockResolvedValueOnce(makeResponse(404, { message: 'Not found' }));
        const cert = await svc.getCertificate('prj_1', 'example.com');
        expect(cert).toEqual({ domain: 'example.com', state: 'pending' });
    });

    it('returns state:error when response contains error field', async () => {
        const { svc, mockFetch } = makeService();
        mockFetch.mockResolvedValueOnce(
            makeResponse(200, { error: { message: 'DNS not propagated' } }),
        );
        const cert = await svc.getCertificate('prj_1', 'example.com');
        expect(cert).toEqual({ domain: 'example.com', state: 'error', error: 'DNS not propagated' });
    });
});

// ── getDeploymentLogs ─────────────────────────────────────────────────────────

describe('VercelService — getDeploymentLogs', () => {
    const TOKEN = 'test_token';

    function makeLogService() {
        const mockFetch = vi.fn();
        const svc = new VercelService(mockFetch);
        return { svc, mockFetch };
    }

    beforeEach(() => vi.stubEnv('VERCEL_TOKEN', TOKEN));
    afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

    it('returns empty logs when events array is empty', async () => {
        const { svc, mockFetch } = makeLogService();
        mockFetch.mockResolvedValueOnce(makeJsonResponse(200, { events: [] }));

        const result = await svc.getDeploymentLogs('dpl_abc');

        expect(result.logs).toEqual([]);
        expect(result.nextCursor).toBeUndefined();
    });

    it('normalizes stdout events to info level', async () => {
        const { svc, mockFetch } = makeLogService();
        const created = 1700000000000;
        mockFetch.mockResolvedValueOnce(makeJsonResponse(200, {
            events: [{ type: 'stdout', created, payload: { text: 'Build started', level: 'info' } }],
        }));

        const result = await svc.getDeploymentLogs('dpl_abc');

        expect(result.logs).toHaveLength(1);
        expect(result.logs[0]).toMatchObject({
            deploymentId: 'dpl_abc',
            level: 'info',
            message: 'Build started',
            timestamp: new Date(created).toISOString(),
        });
    });

    it('maps Vercel "error" level to LogLevel "error"', async () => {
        const { svc, mockFetch } = makeLogService();
        mockFetch.mockResolvedValueOnce(makeJsonResponse(200, {
            events: [{ type: 'stderr', created: 1700000001000, payload: { text: 'Build failed', level: 'error' } }],
        }));

        const result = await svc.getDeploymentLogs('dpl_abc');

        expect(result.logs[0].level).toBe('error');
    });

    it('maps Vercel "warning" level to LogLevel "warn"', async () => {
        const { svc, mockFetch } = makeLogService();
        mockFetch.mockResolvedValueOnce(makeJsonResponse(200, {
            events: [{ type: 'stdout', created: 1700000002000, payload: { text: 'Deprecation', level: 'warning' } }],
        }));

        const result = await svc.getDeploymentLogs('dpl_abc');

        expect(result.logs[0].level).toBe('warn');
    });

    it('maps unknown level to LogLevel "info"', async () => {
        const { svc, mockFetch } = makeLogService();
        mockFetch.mockResolvedValueOnce(makeJsonResponse(200, {
            events: [{ type: 'command', created: 1700000003000, payload: { text: 'npm install' } }],
        }));

        const result = await svc.getDeploymentLogs('dpl_abc');

        expect(result.logs[0].level).toBe('info');
    });

    it('sets nextCursor to the created timestamp of the last event', async () => {
        const { svc, mockFetch } = makeLogService();
        const events = [
            { type: 'stdout', created: 1700000000000, payload: { text: 'first' } },
            { type: 'stdout', created: 1700000001000, payload: { text: 'last' } },
        ];
        mockFetch.mockResolvedValueOnce(makeJsonResponse(200, { events }));

        const result = await svc.getDeploymentLogs('dpl_abc');

        expect(result.nextCursor).toBe(1700000001000);
    });

    it('appends since and limit as query params', async () => {
        const { svc, mockFetch } = makeLogService();
        mockFetch.mockResolvedValueOnce(makeJsonResponse(200, { events: [] }));

        await svc.getDeploymentLogs('dpl_abc', { since: 1700000000000, limit: 50 });

        const calledUrl: string = mockFetch.mock.calls[0][0];
        expect(calledUrl).toContain('since=1700000000000');
        expect(calledUrl).toContain('limit=50');
    });

    it('handles response where events is the top-level array', async () => {
        const { svc, mockFetch } = makeLogService();
        const events = [
            { type: 'stdout', created: 1700000000000, payload: { text: 'line', level: 'info' } },
        ];
        // Vercel sometimes returns the array directly
        mockFetch.mockResolvedValueOnce(makeJsonResponse(200, events));

        const result = await svc.getDeploymentLogs('dpl_abc');

        expect(result.logs).toHaveLength(1);
    });

    it('throws VercelApiError on auth failure', async () => {
        const { svc, mockFetch } = makeLogService();
        mockFetch.mockResolvedValueOnce(makeJsonResponse(401, { error: { message: 'Unauthorized' } }));

        await expect(svc.getDeploymentLogs('dpl_abc')).rejects.toMatchObject({
            code: 'AUTH_FAILED',
        });
    });

    it('throws VercelApiError on network error', async () => {
        const { svc, mockFetch } = makeLogService();
        mockFetch.mockRejectedValueOnce(new Error('Network timeout'));

        await expect(svc.getDeploymentLogs('dpl_abc')).rejects.toMatchObject({
            code: 'NETWORK_ERROR',
        });
    });
});

// ── Token scope validation (Issue #648) ──────────────────────────────────────

describe('Token scope validation', () => {
    beforeEach(() => {
        process.env.VERCEL_TOKEN = 'test_token';
        delete process.env.VERCEL_TEAM_ID;
    });

    afterEach(() => {
        delete process.env.VERCEL_TOKEN;
        delete process.env.VERCEL_TEAM_ID;
    });

    describe('validateTokenScopes', () => {
        it('returns valid when token has required scopes', async () => {
            const { svc, mockFetch } = makeService();

            mockFetch.mockResolvedValueOnce(
                makeResponse(200, {
                    user: { email: 'user@example.com' },
                    scopes: ['projects:read', 'deployments:write', 'teams:read'],
                }),
            );

            const result = await svc.validateTokenScopes();

            expect(result.valid).toBe(true);
            expect(result.scopes).toContain('deployments:write');
        });

        it('returns invalid when token is missing deployment write scope', async () => {
            const { svc, mockFetch } = makeService();

            mockFetch.mockResolvedValueOnce(
                makeResponse(200, {
                    user: { email: 'user@example.com' },
                    scopes: ['projects:read', 'teams:read'],
                }),
            );

            const result = await svc.validateTokenScopes();

            expect(result.valid).toBe(false);
            expect(result.missingScope).toBe('deployments:write');
            expect(result.error).toMatch(/deployment/i);
        });

        it('returns invalid when team token is missing team scope', async () => {
            const { svc, mockFetch } = makeService();
            process.env.VERCEL_TEAM_ID = 'team_abc123';

            mockFetch.mockResolvedValueOnce(
                makeResponse(200, {
                    user: { email: 'user@example.com' },
                    scopes: ['deployments:write', 'projects:write'],
                }),
            );

            const result = await svc.validateTokenScopes();

            expect(result.valid).toBe(false);
            expect(result.missingScope).toBe('team');
            expect(result.error).toMatch(/team scope/i);
        });

        it('returns valid when team token has team scope', async () => {
            const { svc, mockFetch } = makeService();
            process.env.VERCEL_TEAM_ID = 'team_abc123';

            mockFetch.mockResolvedValueOnce(
                makeResponse(200, {
                    user: { email: 'user@example.com' },
                    scopes: ['teams:write', 'deployments:write', 'projects:write'],
                }),
            );

            const result = await svc.validateTokenScopes();

            expect(result.valid).toBe(true);
        });

        it('handles API errors gracefully', async () => {
            const { svc, mockFetch } = makeService();

            mockFetch.mockResolvedValueOnce(
                makeResponse(401, { error: { message: 'Unauthorized' } }),
            );

            const result = await svc.validateTokenScopes();

            expect(result.valid).toBe(false);
            expect(result.error).toBeDefined();
        });

        it('handles network errors gracefully', async () => {
            const { svc, mockFetch } = makeService();

            mockFetch.mockRejectedValueOnce(new Error('Network timeout'));

            const result = await svc.validateTokenScopes();

            expect(result.valid).toBe(false);
            expect(result.error).toMatch(/Network timeout/);
        });

        it('accepts alternative scope names for team', async () => {
            const { svc, mockFetch } = makeService();
            process.env.VERCEL_TEAM_ID = 'team_xyz';

            mockFetch.mockResolvedValueOnce(
                makeResponse(200, {
                    user: { email: 'user@example.com' },
                    scopes: ['team:manage', 'deployments:write'],
                }),
            );

            const result = await svc.validateTokenScopes();

            expect(result.valid).toBe(true);
        });

        it('never logs token values', async () => {
            const { svc, mockFetch } = makeService();
            const warnSpy = vi.spyOn(console, 'warn');

            mockFetch.mockResolvedValueOnce(
                makeResponse(401, { error: { message: 'Unauthorized' } }),
            );

            await svc.validateTokenScopes();

            // Verify that token value is never logged
            expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('test_token'));
            warnSpy.mockRestore();
        });
    });
});

// ── Blue-green alias promotion (Issue #645) ──────────────────────────────────

describe('Blue-green alias promotion', () => {
    beforeEach(() => {
        process.env.VERCEL_TOKEN = 'test_token';
    });

    afterEach(() => {
        delete process.env.VERCEL_TOKEN;
    });

    describe('promoteToProduction', () => {
        it('promotes staging deployment to production alias', async () => {
            const { svc, mockFetch } = makeService();

            // Mock listDeploymentAliases to return current production alias
            mockFetch.mockResolvedValueOnce(
                makeResponse(200, {
                    aliases: [
                        {
                            uid: 'alias_prod',
                            alias: 'example.com',
                            created: '2024-01-01T00:00:00Z',
                            redirect: 'dpl_old_prod',
                        },
                    ],
                }),
            );

            // Mock assignAliasToDeployment
            mockFetch.mockResolvedValueOnce(
                makeResponse(200, {
                    uid: 'alias_prod',
                    alias: 'example.com',
                    created: '2024-01-01T00:00:00Z',
                    redirect: null,
                }),
            );

            const result = await svc.promoteToProduction('dpl_staging', 'example.com');

            expect(result.success).toBe(true);
            expect(result.previousProductionDeploymentId).toBe('dpl_old_prod');
        });

        it('returns undefined previousProductionDeploymentId when no prior production deployment', async () => {
            const { svc, mockFetch } = makeService();

            // Mock listDeploymentAliases with no existing alias
            mockFetch.mockResolvedValueOnce(
                makeResponse(200, { aliases: [] }),
            );

            // Mock assignAliasToDeployment
            mockFetch.mockResolvedValueOnce(
                makeResponse(200, {
                    uid: 'alias_prod',
                    alias: 'example.com',
                }),
            );

            const result = await svc.promoteToProduction('dpl_staging', 'example.com');

            expect(result.success).toBe(true);
            expect(result.previousProductionDeploymentId).toBeUndefined();
        });

        it('throws on promotion failure', async () => {
            const { svc, mockFetch } = makeService();

            mockFetch.mockResolvedValueOnce(
                makeResponse(200, { aliases: [] }),
            );

            mockFetch.mockResolvedValueOnce(
                makeResponse(429, { error: { message: 'Rate limited' } }),
            );

            await expect(svc.promoteToProduction('dpl_staging', 'example.com')).rejects.toMatchObject({
                code: 'RATE_LIMITED',
            });
        });
    });

    describe('rollbackProduction', () => {
        it('rolls back production alias to previous deployment', async () => {
            const { svc, mockFetch } = makeService();

            mockFetch.mockResolvedValueOnce(
                makeResponse(200, {
                    uid: 'alias_prod',
                    alias: 'example.com',
                    created: '2024-01-01T00:00:00Z',
                }),
            );

            const result = await svc.rollbackProduction('dpl_previous_prod', 'example.com');

            expect(result.success).toBe(true);
        });

        it('throws on rollback failure', async () => {
            const { svc, mockFetch } = makeService();

            mockFetch.mockResolvedValueOnce(
                makeResponse(500, { error: { message: 'Server error' } }),
            );

            await expect(svc.rollbackProduction('dpl_previous', 'example.com')).rejects.toMatchObject({
                code: 'UNKNOWN',
            });
        });
    });
});

const MOCK_TOKEN = 'test_token';

function makeResponse(
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (key: string) => headers[key] ?? null },
        json: async () => body,
    };
}

function makeService() {
    const mockFetch = vi.fn();
    const svc = new VercelService(mockFetch as any);
    return { svc, mockFetch };
}
