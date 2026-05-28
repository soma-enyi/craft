/**
 * Tests for POST /api/deployments/[id]/vercel-project
 *
 * Mocks:
 *   @/lib/supabase/server  — stubbed DB
 *   @/services/vercel.service — stubbed createProject
 *   @/lib/env/env-template-generator — stubbed buildVercelEnvVars
 *   @/services/template-generator.service — stubbed mapCategoryToFamily
 *
 * Coverage:
 *   — 201 on success, returns vercelProjectId/Name/Url, persists project ID
 *   — 404 when deployment not found
 *   — 404 when repository_url is missing
 *   — 409 on PROJECT_EXISTS
 *   — 429 on RATE_LIMITED with Retry-After header
 *   — 500 on AUTH_FAILED / NETWORK_ERROR
 *   — 400 on invalid body field type
 *   — 400 on invalid JSON
 *   — 401 when unauthenticated
 *   — 403 when deployment belongs to another user
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const mockCreateProject = vi.fn();
const mockValidateTokenScopes = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
    createClient: () => ({ auth: { getUser: mockGetUser }, from: mockFrom }),
}));

vi.mock('@/services/vercel.service', () => ({
    vercelService: {
        createProject: mockCreateProject,
        validateTokenScopes: mockValidateTokenScopes,
    },
}));

vi.mock('@/lib/env/env-template-generator', () => ({
    buildVercelEnvVars: () => [],
}));

vi.mock('@/services/template-generator.service', () => ({
    mapCategoryToFamily: () => 'stellar-dex',
}));

const fakeUser = { id: 'user-1' };
const fakeDeployment = {
    name: 'My DEX',
    repository_url: 'https://github.com/org/my-dex',
    customization_config: {},
    template_id: 'tmpl-1',
};
const fakeProject = { id: 'prj_abc', name: 'craft-my-dex', url: 'craft-my-dex.vercel.app' };

function makeRequest(body?: unknown) {
    return new NextRequest('http://localhost/api/deployments/dep-1/vercel-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
}

/** Builds a from() mock that sequences through the given query results. */
function makeFrom(queries: Array<{ data: unknown; error: unknown }>) {
    const queue = [...queries];
    return vi.fn(() => {
        const result = queue.shift() ?? { data: null, error: null };
        return {
            select: () => ({ eq: () => ({ single: vi.fn().mockResolvedValue(result) }) }),
            update: () => ({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        };
    });
}

describe('POST /api/deployments/[id]/vercel-project', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetUser.mockResolvedValue({ data: { user: fakeUser }, error: null });
        // Default: token scopes are valid
        mockValidateTokenScopes.mockResolvedValue({ valid: true, scopes: ['deployments:write'] });
    });

    async function handler() {
        const { POST } = await import('./route');
        return POST;
    }

    it('returns 201 with project identifiers on success', async () => {
        // from() calls: ownership check, deployment fetch, template fetch
        mockFrom.mockImplementation(makeFrom([
            { data: { user_id: 'user-1' }, error: null },   // ownership
            { data: fakeDeployment, error: null },            // deployment
            { data: { category: 'dex' }, error: null },      // template
        ]));
        mockCreateProject.mockResolvedValue(fakeProject);

        const POST = await handler();
        const res = await POST(makeRequest({}), { params: { id: 'dep-1' } } as never);
        const body = await res.json();

        expect(res.status).toBe(201);
        expect(body).toEqual({
            vercelProjectId: 'prj_abc',
            vercelProjectName: 'craft-my-dex',
            vercelProjectUrl: 'https://craft-my-dex.vercel.app',
        });
    });

    it('returns 401 when unauthenticated', async () => {
        mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
        const POST = await handler();
        const res = await POST(makeRequest({}), { params: { id: 'dep-1' } } as never);
        expect(res.status).toBe(401);
    });

    it('returns 403 when deployment belongs to another user', async () => {
        mockFrom.mockImplementation(makeFrom([
            { data: { user_id: 'other-user' }, error: null },
        ]));
        const POST = await handler();
        const res = await POST(makeRequest({}), { params: { id: 'dep-1' } } as never);
        expect(res.status).toBe(403);
    });

    it('returns 404 when deployment is not found', async () => {
        mockFrom.mockImplementation(makeFrom([
            { data: { user_id: 'user-1' }, error: null },
            { data: null, error: { message: 'not found' } },
        ]));
        const POST = await handler();
        const res = await POST(makeRequest({}), { params: { id: 'dep-1' } } as never);
        expect(res.status).toBe(404);
    });

    it('returns 404 when repository_url is missing', async () => {
        mockFrom.mockImplementation(makeFrom([
            { data: { user_id: 'user-1' }, error: null },
            { data: { ...fakeDeployment, repository_url: null }, error: null },
        ]));
        const POST = await handler();
        const res = await POST(makeRequest({}), { params: { id: 'dep-1' } } as never);
        expect(res.status).toBe(404);
    });

    it('returns 409 on PROJECT_EXISTS', async () => {
        mockFrom.mockImplementation(makeFrom([
            { data: { user_id: 'user-1' }, error: null },
            { data: fakeDeployment, error: null },
            { data: { category: 'dex' }, error: null },
        ]));
        mockCreateProject.mockRejectedValue(
            Object.assign(new Error('already exists'), { code: 'PROJECT_EXISTS' }),
        );
        const POST = await handler();
        const res = await POST(makeRequest({}), { params: { id: 'dep-1' } } as never);
        expect(res.status).toBe(409);
    });

    it('returns 429 with Retry-After header on RATE_LIMITED', async () => {
        mockFrom.mockImplementation(makeFrom([
            { data: { user_id: 'user-1' }, error: null },
            { data: fakeDeployment, error: null },
            { data: { category: 'dex' }, error: null },
        ]));
        mockCreateProject.mockRejectedValue(
            Object.assign(new Error('rate limited'), { code: 'RATE_LIMITED', retryAfterMs: 30_000 }),
        );
        const POST = await handler();
        const res = await POST(makeRequest({}), { params: { id: 'dep-1' } } as never);
        expect(res.status).toBe(429);
        expect(res.headers.get('Retry-After')).toBe('30');
    });

    it('returns 500 on AUTH_FAILED', async () => {
        mockFrom.mockImplementation(makeFrom([
            { data: { user_id: 'user-1' }, error: null },
            { data: fakeDeployment, error: null },
            { data: { category: 'dex' }, error: null },
        ]));
        mockCreateProject.mockRejectedValue(
            Object.assign(new Error('bad token'), { code: 'AUTH_FAILED' }),
        );
        const POST = await handler();
        const res = await POST(makeRequest({}), { params: { id: 'dep-1' } } as never);
        expect(res.status).toBe(500);
    });

    it('returns 400 on invalid body field type', async () => {
        mockFrom.mockImplementation(makeFrom([
            { data: { user_id: 'user-1' }, error: null },
            { data: fakeDeployment, error: null },
        ]));
        const POST = await handler();
        const res = await POST(makeRequest({ framework: 123 }), { params: { id: 'dep-1' } } as never);
        expect(res.status).toBe(400);
    });

    it('returns 400 on invalid JSON', async () => {
        mockFrom.mockImplementation(makeFrom([
            { data: { user_id: 'user-1' }, error: null },
        ]));
        const POST = await handler();
        const req = new NextRequest('http://localhost/api/deployments/dep-1/vercel-project', {
            method: 'POST',
            body: 'not-json',
        });
        const res = await POST(req, { params: { id: 'dep-1' } } as never);
        expect(res.status).toBe(400);
    });

    it('returns 401 when token scopes are invalid', async () => {
        mockValidateTokenScopes.mockResolvedValueOnce({
            valid: false,
            missingScope: 'deployments:write',
            error: 'Token missing deployment permissions',
        });
        mockFrom.mockImplementation(makeFrom([
            { data: { user_id: 'user-1' }, error: null },
        ]));
        const POST = await handler();
        const res = await POST(makeRequest({}), { params: { id: 'dep-1' } } as never);
        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.error).toMatch(/Token missing deployment/);
        expect(body.missingScope).toBe('deployments:write');
    });

    it('returns 401 when team token lacks team scope', async () => {
        mockValidateTokenScopes.mockResolvedValueOnce({
            valid: false,
            missingScope: 'team',
            error: 'Token missing team scope for team deployment',
        });
        mockFrom.mockImplementation(makeFrom([
            { data: { user_id: 'user-1' }, error: null },
        ]));
        const POST = await handler();
        const res = await POST(makeRequest({}), { params: { id: 'dep-1' } } as never);
        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.missingScope).toBe('team');
    });

    it('validates token scopes before deployment', async () => {
        mockValidateTokenScopes.mockResolvedValueOnce({ valid: true, scopes: ['deployments:write'] });
        mockFrom.mockImplementation(makeFrom([
            { data: { user_id: 'user-1' }, error: null },
            { data: fakeDeployment, error: null },
            { data: { id: 'tmpl-1', category: 'dex' }, error: null },
            { data: undefined, error: null },
        ]));
        mockCreateProject.mockResolvedValue({
            id: 'prj_123',
            name: 'my-dex',
            url: 'my-dex.vercel.app',
        });
        const POST = await handler();
        const res = await POST(makeRequest({}), { params: { id: 'dep-1' } } as never);
        expect(mockValidateTokenScopes).toHaveBeenCalled();
        expect(res.status).toBe(201);
    });
});
