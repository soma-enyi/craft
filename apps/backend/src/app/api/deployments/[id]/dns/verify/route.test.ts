import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const mockVerifyViaTxt = vi.fn();
const mockVerifyViaCname = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
    createClient: () => ({
        auth: { getUser: mockGetUser },
        from: mockFrom,
    }),
}));

vi.mock('@/lib/dns/domain-verification', () => ({
    verifyViaTxt: mockVerifyViaTxt,
    verifyViaCname: mockVerifyViaCname,
}));

vi.mock('@/lib/stripe/pricing', () => ({
    canConfigureCustomDomain: (tier: string) => tier === 'pro' || tier === 'enterprise',
}));

const fakeUser = { id: 'user-1', email: 'user@example.com' };
const params = { id: 'dep-1' };

function makeRequest(body: unknown) {
    return new NextRequest('http://localhost/api/deployments/dep-1/dns/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
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

/** Ownership + pro-tier profile queries prepended automatically. */
function withProTier(extraResults: QueryResult[]) {
    return makeSupabaseQuery([
        { data: { user_id: fakeUser.id }, error: null },
        { data: { subscription_tier: 'pro' }, error: null },
        ...extraResults,
    ]);
}

describe('POST /api/deployments/[id]/dns/verify', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetUser.mockResolvedValue({ data: { user: fakeUser }, error: null });
    });

    it('returns 401 when unauthenticated', async () => {
        mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
        const { POST } = await import('./route');
        const res = await POST(makeRequest({ method: 'txt', token: 'tok' }), { params });
        expect(res.status).toBe(401);
    });

    it('returns 403 when deployment belongs to another user', async () => {
        mockFrom.mockReturnValue(
            makeSupabaseQuery([{ data: { user_id: 'other' }, error: null }]),
        );
        const { POST } = await import('./route');
        const res = await POST(makeRequest({ method: 'txt', token: 'tok' }), { params });
        expect(res.status).toBe(403);
    });

    it('returns 403 with upgradeUrl for free-tier users', async () => {
        mockFrom.mockReturnValue(
            makeSupabaseQuery([
                { data: { user_id: fakeUser.id }, error: null },
                { data: { subscription_tier: 'free' }, error: null },
            ]),
        );
        const { POST } = await import('./route');
        const res = await POST(makeRequest({ method: 'txt', token: 'tok' }), { params });
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.upgradeUrl).toBe('/pricing');
    });

    it('returns 400 for invalid method value', async () => {
        mockFrom.mockReturnValue(withProTier([]));
        const { POST } = await import('./route');
        const res = await POST(makeRequest({ method: 'invalid' }), { params });
        expect(res.status).toBe(400);
    });

    it('returns 400 when method is txt but token is missing', async () => {
        mockFrom.mockReturnValue(withProTier([]));
        const { POST } = await import('./route');
        const res = await POST(makeRequest({ method: 'txt' }), { params });
        expect(res.status).toBe(400);
    });

    it('returns 404 when deployment has no custom domain', async () => {
        mockFrom.mockReturnValue(
            withProTier([{ data: { custom_domain: null }, error: null }]),
        );
        const { POST } = await import('./route');
        const res = await POST(makeRequest({ method: 'txt', token: 'tok' }), { params });
        expect(res.status).toBe(404);
    });

    it('calls verifyViaTxt and returns result for method=txt', async () => {
        mockFrom.mockReturnValue(
            withProTier([{ data: { custom_domain: 'example.com' }, error: null }]),
        );
        mockVerifyViaTxt.mockResolvedValue({ verified: true, method: 'txt', domain: 'example.com' });

        const { POST } = await import('./route');
        const res = await POST(makeRequest({ method: 'txt', token: 'craft-abc' }), { params });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.verified).toBe(true);
        expect(mockVerifyViaTxt).toHaveBeenCalledWith('example.com', 'craft-abc');
    });

    it('calls verifyViaCname and returns result for method=cname', async () => {
        mockFrom.mockReturnValue(
            withProTier([{ data: { custom_domain: 'www.example.com' }, error: null }]),
        );
        mockVerifyViaCname.mockResolvedValue({ verified: false, method: 'cname', domain: 'www.example.com', errorCode: 'NOT_FOUND' });

        const { POST } = await import('./route');
        const res = await POST(makeRequest({ method: 'cname' }), { params });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.verified).toBe(false);
        expect(body.errorCode).toBe('NOT_FOUND');
        expect(mockVerifyViaCname).toHaveBeenCalledWith('www.example.com');
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
            makeSupabaseQuery([{ data: { user_id: fakeUser.id }, error: null }]),
        );
        const { POST } = await import('./route');
        const res = await POST(makeRequest({ method: 'txt', token: 'tok' }), { params });

        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.requiredTier).toBe('pro');
        expect(body.upgradeUrl).toBe('/pricing');
    });

    // DNS record validation — A record is not a supported method; only TXT and CNAME are valid
    // WCAG SC 3.3.1: invalid input should produce a clear error response (400)
    it('returns 400 when method is an unsupported DNS record type (A record)', async () => {
        mockFrom.mockReturnValue(withProTier([]));
        const { POST } = await import('./route');
        const res = await POST(makeRequest({ method: 'a-record', token: '1.2.3.4' }), { params });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBeTruthy();
    });

    it('returns 400 when request body is not valid JSON', async () => {
        mockFrom.mockReturnValue(withProTier([]));
        const { POST } = await import('./route');
        const req = new NextRequest('http://localhost/api/deployments/dep-1/dns/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: 'not-json{{',
        });
        const res = await POST(req, { params });
        expect(res.status).toBe(400);
    });

    it('returns 400 when token is not a string for txt method', async () => {
        mockFrom.mockReturnValue(withProTier([]));
        const { POST } = await import('./route');
        const res = await POST(makeRequest({ method: 'txt', token: 12345 }), { params });
        expect(res.status).toBe(400);
    });

    // DNS verification failure — TXT record present but value does not match
    it('returns 200 with verified=false when TXT record value does not match', async () => {
        mockFrom.mockReturnValue(
            withProTier([{ data: { custom_domain: 'example.com' }, error: null }]),
        );
        mockVerifyViaTxt.mockResolvedValue({
            verified: false,
            method: 'txt',
            domain: 'example.com',
            errorCode: 'TOKEN_MISMATCH',
        });

        const { POST } = await import('./route');
        const res = await POST(makeRequest({ method: 'txt', token: 'wrong-token' }), { params });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.verified).toBe(false);
        expect(body.errorCode).toBe('TOKEN_MISMATCH');
    });

    // DNS verification failure — CNAME points to wrong target
    it('returns 200 with verified=false when CNAME does not point to expected target', async () => {
        mockFrom.mockReturnValue(
            withProTier([{ data: { custom_domain: 'www.example.com' }, error: null }]),
        );
        mockVerifyViaCname.mockResolvedValue({
            verified: false,
            method: 'cname',
            domain: 'www.example.com',
            errorCode: 'WRONG_TARGET',
        });

        const { POST } = await import('./route');
        const res = await POST(makeRequest({ method: 'cname' }), { params });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.verified).toBe(false);
        expect(body.errorCode).toBe('WRONG_TARGET');
    });

    // DNS verification throws — upstream DNS resolver unavailable
    it('returns 500 when DNS verification throws an unexpected error', async () => {
        mockFrom.mockReturnValue(
            withProTier([{ data: { custom_domain: 'example.com' }, error: null }]),
        );
        mockVerifyViaTxt.mockRejectedValue(new Error('DNS resolver unavailable'));

        const { POST } = await import('./route');
        const res = await POST(makeRequest({ method: 'txt', token: 'tok' }), { params });

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error).toMatch(/DNS resolver unavailable/);
    });

    // CNAME verification throws — network timeout during DNS lookup
    it('returns 500 when CNAME lookup times out', async () => {
        mockFrom.mockReturnValue(
            withProTier([{ data: { custom_domain: 'www.example.com' }, error: null }]),
        );
        mockVerifyViaCname.mockRejectedValue(new Error('DNS lookup timed out'));

        const { POST } = await import('./route');
        const res = await POST(makeRequest({ method: 'cname' }), { params });

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error).toMatch(/timed out/);
    });

    // Deployment not found in DB
    it('returns 404 when deployment row does not exist in database', async () => {
        mockFrom.mockReturnValue(
            withProTier([{ data: null, error: { message: 'No rows found' } }]),
        );
        const { POST } = await import('./route');
        const res = await POST(makeRequest({ method: 'txt', token: 'tok' }), { params });
        expect(res.status).toBe(404);
    });

    // Enterprise tier is also allowed (not just pro)
    it('allows enterprise-tier users to verify DNS', async () => {
        mockFrom.mockReturnValue(
            makeSupabaseQuery([
                { data: { user_id: fakeUser.id }, error: null },
                { data: { subscription_tier: 'enterprise' }, error: null },
                { data: { custom_domain: 'corp.example.com' }, error: null },
            ]),
        );
        mockVerifyViaTxt.mockResolvedValue({ verified: true, method: 'txt', domain: 'corp.example.com' });

        const { POST } = await import('./route');
        const res = await POST(makeRequest({ method: 'txt', token: 'ent-token' }), { params });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.verified).toBe(true);
    });
});
