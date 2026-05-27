import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const mockAddDomain = vi.fn();
const mockGetCertificate = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
    createClient: () => ({
        auth: { getUser: mockGetUser },
        from: mockFrom,
    }),
}));

vi.mock('@/services/vercel.service', () => ({
    VercelService: vi.fn().mockImplementation(() => ({
        addDomain: mockAddDomain,
        getCertificate: mockGetCertificate,
    })),
    VercelApiError: class VercelApiError extends Error {
        constructor(message: string, public code: string, public retryAfterMs?: number) {
            super(message);
        }
    },
}));

vi.mock('@/lib/stripe/pricing', () => ({
    canConfigureCustomDomain: (tier: string) => tier === 'pro' || tier === 'enterprise',
}));

const fakeUser = { id: 'user-1' };
const params = { id: 'dep-1' };

function makeRequest(method: 'POST' | 'GET') {
    return new NextRequest(`http://localhost/api/deployments/dep-1/https`, { method });
}

type QueryResult = { data: Record<string, unknown> | null; error: { message: string } | null };

function makeSupabaseQuery(results: QueryResult[]) {
    return {
        select: vi.fn(() => ({
            eq: vi.fn(() => ({
                single: vi.fn().mockResolvedValue(results.shift() ?? { data: null, error: null }),
            })),
        })),
    };
}

const fullDeployment = {
    user_id: fakeUser.id,
    custom_domain: 'example.com',
    vercel_project_id: 'prj_1',
};

/** Ownership + pro-tier profile queries prepended automatically. */
function withProTier(extraResults: QueryResult[]) {
    return makeSupabaseQuery([
        { data: { user_id: fakeUser.id }, error: null },
        { data: { subscription_tier: 'pro' }, error: null },
        ...extraResults,
    ]);
}

describe('POST /api/deployments/[id]/https', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetUser.mockResolvedValue({ data: { user: fakeUser }, error: null });
    });

    it('returns 401 when unauthenticated', async () => {
        mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
        const { POST } = await import('./route');
        expect((await POST(makeRequest('POST'), { params })).status).toBe(401);
    });

    it('returns 403 when deployment belongs to another user', async () => {
        mockFrom.mockReturnValue(
            makeSupabaseQuery([{ data: { user_id: 'other' }, error: null }]),
        );
        const { POST } = await import('./route');
        expect((await POST(makeRequest('POST'), { params })).status).toBe(403);
    });

    it('returns 403 with upgradeUrl for free-tier users', async () => {
        mockFrom.mockReturnValue(
            makeSupabaseQuery([
                { data: { user_id: fakeUser.id }, error: null },
                { data: { subscription_tier: 'free' }, error: null },
            ]),
        );
        const { POST } = await import('./route');
        const res = await POST(makeRequest('POST'), { params });
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.upgradeUrl).toBe('/pricing');
    });

    it('returns 404 when no custom_domain configured', async () => {
        mockFrom.mockReturnValue(
            withProTier([{ data: { custom_domain: null, vercel_project_id: 'prj_1' }, error: null }]),
        );
        const { POST } = await import('./route');
        expect((await POST(makeRequest('POST'), { params })).status).toBe(404);
    });

    it('returns 404 when no vercel_project_id configured', async () => {
        mockFrom.mockReturnValue(
            withProTier([{ data: { custom_domain: 'example.com', vercel_project_id: null }, error: null }]),
        );
        const { POST } = await import('./route');
        expect((await POST(makeRequest('POST'), { params })).status).toBe(404);
    });

    it('returns 409 when domain already added', async () => {
        mockFrom.mockReturnValue(withProTier([{ data: fullDeployment, error: null }]));
        const { VercelApiError } = await import('@/services/vercel.service');
        mockAddDomain.mockRejectedValue(new VercelApiError('exists', 'DOMAIN_EXISTS'));
        const { POST } = await import('./route');
        expect((await POST(makeRequest('POST'), { params })).status).toBe(409);
    });

    it('returns 429 with Retry-After when rate limited', async () => {
        mockFrom.mockReturnValue(withProTier([{ data: fullDeployment, error: null }]));
        const { VercelApiError } = await import('@/services/vercel.service');
        mockAddDomain.mockRejectedValue(new VercelApiError('rate limited', 'RATE_LIMITED', 30_000));
        const { POST } = await import('./route');
        const res = await POST(makeRequest('POST'), { params });
        expect(res.status).toBe(429);
        expect(res.headers.get('Retry-After')).toBe('30');
    });

    it('returns 200 with cert state on success', async () => {
        mockFrom.mockReturnValue(withProTier([{ data: fullDeployment, error: null }]));
        mockAddDomain.mockResolvedValue(undefined);
        mockGetCertificate.mockResolvedValue({ domain: 'example.com', state: 'pending' });
        const { POST } = await import('./route');
        const res = await POST(makeRequest('POST'), { params });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.state).toBe('pending');
        expect(body.domain).toBe('example.com');
    });

    // Certificate provisioning begins in 'pending' state immediately after domain is added
    it('returns pending cert state immediately after domain add', async () => {
        mockFrom.mockReturnValue(withProTier([{ data: fullDeployment, error: null }]));
        mockAddDomain.mockResolvedValue(undefined);
        mockGetCertificate.mockResolvedValue({ domain: 'example.com', state: 'pending', expiresAt: null });

        const { POST } = await import('./route');
        const res = await POST(makeRequest('POST'), { params });
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.state).toBe('pending');
        expect(body.expiresAt).toBeNull();
    });

    // AUTH_FAILED from Vercel API maps to 500
    it('returns 500 when Vercel authentication fails (AUTH_FAILED)', async () => {
        mockFrom.mockReturnValue(withProTier([{ data: fullDeployment, error: null }]));
        const { VercelApiError } = await import('@/services/vercel.service');
        mockAddDomain.mockRejectedValue(new VercelApiError('Invalid Vercel token', 'AUTH_FAILED'));

        const { POST } = await import('./route');
        expect((await POST(makeRequest('POST'), { params })).status).toBe(500);
    });

    // Generic unexpected error from addDomain
    it('returns 500 on unexpected addDomain error', async () => {
        mockFrom.mockReturnValue(withProTier([{ data: fullDeployment, error: null }]));
        mockAddDomain.mockRejectedValue(new Error('Unexpected Vercel error'));

        const { POST } = await import('./route');
        const res = await POST(makeRequest('POST'), { params });
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error).toMatch(/Unexpected Vercel error/);
    });

    // getCertificate fails after domain successfully added
    it('propagates error when getCertificate throws after successful domain add', async () => {
        mockFrom.mockReturnValue(withProTier([{ data: fullDeployment, error: null }]));
        mockAddDomain.mockResolvedValue(undefined);
        mockGetCertificate.mockRejectedValue(new Error('Certificate fetch failed'));

        const { POST } = await import('./route');
        // The route has no try/catch around getCertificate after addDomain — unhandled throw
        await expect(POST(makeRequest('POST'), { params })).rejects.toThrow('Certificate fetch failed');
    });

    // Retry-After header is rounded up to nearest second
    it('rounds Retry-After up to nearest second for fractional retryAfterMs', async () => {
        mockFrom.mockReturnValue(withProTier([{ data: fullDeployment, error: null }]));
        const { VercelApiError } = await import('@/services/vercel.service');
        mockAddDomain.mockRejectedValue(new VercelApiError('rate limited', 'RATE_LIMITED', 1500));

        const { POST } = await import('./route');
        const res = await POST(makeRequest('POST'), { params });
        expect(res.status).toBe(429);
        expect(res.headers.get('Retry-After')).toBe('2');
    });

    // Rate limit with no retryAfterMs — header should not be set
    it('omits Retry-After header when retryAfterMs is undefined', async () => {
        mockFrom.mockReturnValue(withProTier([{ data: fullDeployment, error: null }]));
        const { VercelApiError } = await import('@/services/vercel.service');
        mockAddDomain.mockRejectedValue(new VercelApiError('rate limited', 'RATE_LIMITED'));

        const { POST } = await import('./route');
        const res = await POST(makeRequest('POST'), { params });
        expect(res.status).toBe(429);
        expect(res.headers.get('Retry-After')).toBeNull();
    });
});

describe('GET /api/deployments/[id]/https', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetUser.mockResolvedValue({ data: { user: fakeUser }, error: null });
    });

    it('returns 404 when no custom domain configured', async () => {
        mockFrom.mockReturnValue(
            withProTier([{ data: { custom_domain: null, vercel_project_id: 'prj_1' }, error: null }]),
        );
        const { GET } = await import('./route');
        expect((await GET(makeRequest('GET'), { params })).status).toBe(404);
    });

    it('returns 200 with active cert state', async () => {
        mockFrom.mockReturnValue(withProTier([{ data: fullDeployment, error: null }]));
        mockGetCertificate.mockResolvedValue({
            domain: 'example.com',
            state: 'active',
            expiresAt: '2027-01-01T00:00:00Z',
        });
        const { GET } = await import('./route');
        const res = await GET(makeRequest('GET'), { params });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.state).toBe('active');
        expect(body.expiresAt).toBe('2027-01-01T00:00:00Z');
    });

    it('returns 403 with upgrade prompt for free-tier users', async () => {
        const { requireDomainTier } = await import('@/lib/api/require-domain-tier');
        vi.mocked(requireDomainTier).mockResolvedValueOnce(
            new Response(
                JSON.stringify({ error: 'Custom domains require a Pro or Enterprise subscription.', requiredTier: 'pro', upgradeUrl: '/pricing' }),
                { status: 403, headers: { 'Content-Type': 'application/json' } },
            ) as unknown as import('next/server').NextResponse,
        );
        mockFrom.mockReturnValue(
            makeSupabaseQuery([{ data: { user_id: fakeUser.id, ...fullDeployment }, error: null }]),
        );
        const { GET } = await import('./route');
        const res = await GET(makeRequest('GET'), { params });

        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.requiredTier).toBe('pro');
        expect(body.upgradeUrl).toBe('/pricing');
    });

    // Certificate provisioning state polling — pending → issued → active
    // Callers poll GET to track provisioning progress after the initial POST
    it('returns issued cert state during provisioning (polling cycle 1)', async () => {
        mockFrom.mockReturnValue(withProTier([{ data: fullDeployment, error: null }]));
        mockGetCertificate.mockResolvedValue({ domain: 'example.com', state: 'issued' });

        const { GET } = await import('./route');
        const res = await GET(makeRequest('GET'), { params });
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.state).toBe('issued');
    });

    it('returns active cert state with expiresAt once provisioning completes', async () => {
        mockFrom.mockReturnValue(withProTier([{ data: fullDeployment, error: null }]));
        mockGetCertificate.mockResolvedValue({
            domain: 'example.com',
            state: 'active',
            expiresAt: '2027-06-01T00:00:00Z',
        });

        const { GET } = await import('./route');
        const res = await GET(makeRequest('GET'), { params });
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.state).toBe('active');
        expect(body.expiresAt).toBe('2027-06-01T00:00:00Z');
    });

    // Provisioning stalled — Vercel returns an error state
    it('returns error state when certificate provisioning fails on Vercel side', async () => {
        mockFrom.mockReturnValue(withProTier([{ data: fullDeployment, error: null }]));
        mockGetCertificate.mockResolvedValue({
            domain: 'example.com',
            state: 'error',
            error: 'CAA record mismatch',
        });

        const { GET } = await import('./route');
        const res = await GET(makeRequest('GET'), { params });
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.state).toBe('error');
        expect(body.error).toMatch(/CAA record mismatch/);
    });

    // getCertificate throws — Vercel API unavailable during polling
    it('returns 500 when getCertificate throws during polling', async () => {
        mockFrom.mockReturnValue(withProTier([{ data: fullDeployment, error: null }]));
        mockGetCertificate.mockRejectedValue(new Error('Vercel API unreachable'));

        const { GET } = await import('./route');
        const res = await GET(makeRequest('GET'), { params });

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error).toMatch(/Vercel API unreachable/);
    });

    // GET 404 when vercel_project_id is missing
    it('returns 404 when vercel_project_id is missing on GET', async () => {
        mockFrom.mockReturnValue(
            withProTier([{ data: { custom_domain: 'example.com', vercel_project_id: null }, error: null }]),
        );
        const { GET } = await import('./route');
        expect((await GET(makeRequest('GET'), { params })).status).toBe(404);
    });
});
