import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';

// Mock dependencies
vi.mock('@/lib/api/with-auth', () => ({
    withAuth: (handler: Function) => async (req: NextRequest, context: any) => {
        const user = (req as any).user;
        if (!user) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
        }
        return handler(req, { user });
    },
}));

vi.mock('@/services/payment.service', () => ({
    paymentService: {
        createCustomerPortalSession: vi.fn(),
    },
}));

vi.mock('@/lib/supabase/server', () => ({
    createClient: vi.fn(),
}));

import { paymentService } from '@/services/payment.service';

describe('POST /api/payments/portal', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns 401 for unauthenticated request', async () => {
        const req = new NextRequest('http://localhost:3000/api/payments/portal', {
            method: 'POST',
            body: JSON.stringify({ returnUrl: 'http://localhost:3000/billing' }),
        });

        const res = await POST(req);
        expect(res.status).toBe(401);
    });

    it('creates portal session for authenticated user with Stripe customer', async () => {
        const userId = 'user-123';
        const returnUrl = 'http://localhost:3000/dashboard/billing';
        const portalUrl = 'https://billing.stripe.com/session/test-session-123';

        vi.mocked(paymentService.createCustomerPortalSession).mockResolvedValue({
            url: portalUrl,
        });

        const req = new NextRequest('http://localhost:3000/api/payments/portal', {
            method: 'POST',
            body: JSON.stringify({ returnUrl }),
        });
        (req as any).user = { id: userId };

        const res = await POST(req, {});
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data).toEqual({ url: portalUrl });
        expect(paymentService.createCustomerPortalSession).toHaveBeenCalledWith(
            userId,
            returnUrl
        );
    });

    it('returns 404 when user has no Stripe customer record', async () => {
        const userId = 'user-no-customer';
        const returnUrl = 'http://localhost:3000/billing';

        vi.mocked(paymentService.createCustomerPortalSession).mockRejectedValue(
            new Error('User does not have a Stripe customer record')
        );

        const req = new NextRequest('http://localhost:3000/api/payments/portal', {
            method: 'POST',
            body: JSON.stringify({ returnUrl }),
        });
        (req as any).user = { id: userId };

        const res = await POST(req, {});
        expect(res.status).toBe(404);

        const data = await res.json();
        expect(data.error).toContain('Stripe customer record');
    });

    it('returns 400 for invalid return URL', async () => {
        const userId = 'user-123';

        const req = new NextRequest('http://localhost:3000/api/payments/portal', {
            method: 'POST',
            body: JSON.stringify({ returnUrl: 'not-a-valid-url' }),
        });
        (req as any).user = { id: userId };

        const res = await POST(req, {});
        expect(res.status).toBe(400);

        const data = await res.json();
        expect(data.error).toBe('Invalid input');
    });

    it('returns 400 when returnUrl is missing', async () => {
        const userId = 'user-123';

        const req = new NextRequest('http://localhost:3000/api/payments/portal', {
            method: 'POST',
            body: JSON.stringify({}),
        });
        (req as any).user = { id: userId };

        const res = await POST(req, {});
        expect(res.status).toBe(400);

        const data = await res.json();
        expect(data.error).toBe('Invalid input');
    });

    it('passes correct returnUrl to service', async () => {
        const userId = 'user-123';
        const returnUrl = 'http://example.com/settings/billing';

        vi.mocked(paymentService.createCustomerPortalSession).mockResolvedValue({
            url: 'https://billing.stripe.com/session/123',
        });

        const req = new NextRequest('http://localhost:3000/api/payments/portal', {
            method: 'POST',
            body: JSON.stringify({ returnUrl }),
        });
        (req as any).user = { id: userId };

        await POST(req, {});

        expect(paymentService.createCustomerPortalSession).toHaveBeenCalledWith(
            userId,
            returnUrl
        );
    });

    it('scopes portal session to authenticated user', async () => {
        const userId = 'user-456';
        const returnUrl = 'http://localhost:3000/billing';

        vi.mocked(paymentService.createCustomerPortalSession).mockResolvedValue({
            url: 'https://billing.stripe.com/session/456',
        });

        const req = new NextRequest('http://localhost:3000/api/payments/portal', {
            method: 'POST',
            body: JSON.stringify({ returnUrl }),
        });
        (req as any).user = { id: userId };

        const res = await POST(req, {});
        expect(res.status).toBe(200);

        expect(paymentService.createCustomerPortalSession).toHaveBeenCalledWith(
            userId,
            expect.anything()
        );
    });
});
