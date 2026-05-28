/**
 * Unit tests for PaymentService
 *
 * Mocks:
 *   - @/lib/stripe/client  → stripe (customers, checkout.sessions, subscriptions)
 *   - @/lib/supabase/server → createClient (profiles table + auth.getUser)
 *   - @/lib/stripe/pricing  → getTierFromPriceId (keeps tests independent of env)
 *
 * Coverage:
 *   createCheckoutSession  – existing customer, new customer, missing email
 *   getSubscriptionStatus  – no subscription (free), active subscription
 *   cancelSubscription     – delegates to stripe.subscriptions.update
 *   handleWebhook          – checkout.session.completed (pro + enterprise tier mapping)
 *                          – customer.subscription.updated
 *                          – customer.subscription.deleted
 *                          – invoice.payment_failed
 *                          – missing user_id / unknown customer (no-ops)
 *                          – unhandled event type (no-op)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Stripe mock ───────────────────────────────────────────────────────────────

const mockCustomersCreate = vi.fn();
const mockCheckoutSessionsCreate = vi.fn();
const mockSubscriptionsRetrieve = vi.fn();
const mockSubscriptionsUpdate = vi.fn();
const mockBillingPortalSessionsCreate = vi.fn();

vi.mock('@/lib/stripe/client', () => ({
    stripe: {
        customers: { create: mockCustomersCreate },
        checkout: { sessions: { create: mockCheckoutSessionsCreate } },
        subscriptions: {
            retrieve: mockSubscriptionsRetrieve,
            update: mockSubscriptionsUpdate,
        },
        billingPortal: { sessions: { create: mockBillingPortalSessionsCreate } },
    },
}));

// ── Supabase mock ─────────────────────────────────────────────────────────────

const mockGetUser = vi.fn();
const mockFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
    createClient: () => ({
        auth: { getUser: mockGetUser },
        from: mockFrom,
    }),
}));

// ── Pricing mock ──────────────────────────────────────────────────────────────

const mockGetTierFromPriceId = vi.fn();

vi.mock('@/lib/stripe/pricing', () => ({
    getTierFromPriceId: (priceId: string) => mockGetTierFromPriceId(priceId),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Builds a chainable Supabase query mock.
 * Each method returns `this` so calls can be chained arbitrarily.
 * `single` resolves with the provided value.
 */
function makeQuery(singleResult: { data: unknown; error?: unknown }) {
    const q: any = {
        select: vi.fn().mockReturnThis(),
        insert: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue(singleResult),
    };
    // update().eq() should also resolve (no single needed for updates)
    q.update.mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    return q;
}

// ── Import service after mocks are registered ─────────────────────────────────

let service: InstanceType<typeof import('./payment.service').PaymentService>;

beforeEach(async () => {
    if (!service) {
        const { PaymentService } = await import('./payment.service');
        service = new PaymentService();
    }
    vi.clearAllMocks();
});

// ── createCheckoutSession ─────────────────────────────────────────────────────

describe('PaymentService.createCheckoutSession', () => {
    const userId = 'user-1';
    const priceId = 'price_pro';
    const fakeSession = { id: 'cs_123', url: 'https://checkout.stripe.com/cs_123' };

    beforeEach(() => vi.clearAllMocks());

    it('reuses an existing Stripe customer and returns sessionId + url', async () => {
        const query = makeQuery({ data: { stripe_customer_id: 'cus_existing' } });
        mockFrom.mockReturnValue(query);
        mockCheckoutSessionsCreate.mockResolvedValue(fakeSession);

        const result = await service.createCheckoutSession(userId, priceId);

        expect(mockCustomersCreate).not.toHaveBeenCalled();
        expect(mockCheckoutSessionsCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                customer: 'cus_existing',
                mode: 'subscription',
                line_items: [{ price: priceId, quantity: 1 }],
            })
        );
        expect(result).toEqual({ sessionId: 'cs_123', url: fakeSession.url });
    });

    it('creates a new Stripe customer when none exists, then creates session', async () => {
        // First from() call: profile lookup → no customer
        // Second from() call: profile update
        const profileQuery = makeQuery({ data: { stripe_customer_id: null } });
        const updateQuery = makeQuery({ data: null });
        mockFrom
            .mockReturnValueOnce(profileQuery)
            .mockReturnValueOnce(updateQuery);

        mockGetUser.mockResolvedValue({ data: { user: { email: 'a@b.com' } } });
        mockCustomersCreate.mockResolvedValue({ id: 'cus_new' });
        mockCheckoutSessionsCreate.mockResolvedValue(fakeSession);

        const result = await service.createCheckoutSession(userId, priceId);

        expect(mockCustomersCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                email: 'a@b.com',
                metadata: { supabase_user_id: userId },
            })
        );
        expect(mockCheckoutSessionsCreate).toHaveBeenCalledWith(
            expect.objectContaining({ customer: 'cus_new' })
        );
        expect(result.sessionId).toBe('cs_123');
    });

    it('throws when no customer exists and user email is missing', async () => {
        const profileQuery = makeQuery({ data: { stripe_customer_id: null } });
        mockFrom.mockReturnValue(profileQuery);
        mockGetUser.mockResolvedValue({ data: { user: null } });

        await expect(service.createCheckoutSession(userId, priceId)).rejects.toThrow(
            'User email not found'
        );
        expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
    });

    it('embeds user_id in checkout session metadata', async () => {
        const query = makeQuery({ data: { stripe_customer_id: 'cus_x' } });
        mockFrom.mockReturnValue(query);
        mockCheckoutSessionsCreate.mockResolvedValue(fakeSession);

        await service.createCheckoutSession(userId, priceId);

        expect(mockCheckoutSessionsCreate).toHaveBeenCalledWith(
            expect.objectContaining({ metadata: { user_id: userId } })
        );
    });

    it('passes custom successUrl and cancelUrl to Stripe', async () => {
        const query = makeQuery({ data: { stripe_customer_id: 'cus_x' } });
        mockFrom.mockReturnValue(query);
        mockCheckoutSessionsCreate.mockResolvedValue(fakeSession);

        await service.createCheckoutSession(
            userId,
            priceId,
            'https://app.example.com/success',
            'https://app.example.com/cancel'
        );

        expect(mockCheckoutSessionsCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                success_url: 'https://app.example.com/success',
                cancel_url: 'https://app.example.com/cancel',
            })
        );
    });
});

// ── getSubscriptionStatus ─────────────────────────────────────────────────────

describe('PaymentService.getSubscriptionStatus', () => {
    const userId = 'user-1';

    beforeEach(() => vi.clearAllMocks());

    it('returns free/active defaults when no stripe_subscription_id is stored', async () => {
        const query = makeQuery({
            data: { subscription_tier: 'free', subscription_status: 'active', stripe_subscription_id: null },
        });
        mockFrom.mockReturnValue(query);

        const result = await service.getSubscriptionStatus(userId);

        expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
        expect(result.tier).toBe('free');
        expect(result.status).toBe('active');
        expect(result.cancelAtPeriodEnd).toBe(false);
    });

    it('returns free/active when profile is null', async () => {
        const query = makeQuery({ data: null });
        mockFrom.mockReturnValue(query);

        const result = await service.getSubscriptionStatus(userId);

        expect(result.tier).toBe('free');
        expect(result.status).toBe('active');
    });

    it('retrieves subscription from Stripe and maps fields correctly', async () => {
        const periodEnd = Math.floor(Date.now() / 1000) + 86400;
        const query = makeQuery({
            data: {
                subscription_tier: 'pro',
                subscription_status: 'active',
                stripe_subscription_id: 'sub_123',
            },
        });
        mockFrom.mockReturnValue(query);
        mockSubscriptionsRetrieve.mockResolvedValue({
            status: 'active',
            current_period_end: periodEnd,
            cancel_at_period_end: false,
        });

        const result = await service.getSubscriptionStatus(userId);

        expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith('sub_123');
        expect(result.tier).toBe('pro');
        expect(result.status).toBe('active');
        expect(result.cancelAtPeriodEnd).toBe(false);
        expect(result.currentPeriodEnd.getTime()).toBeCloseTo(periodEnd * 1000, -3);
    });

    it('reflects cancel_at_period_end=true from Stripe', async () => {
        const query = makeQuery({
            data: { subscription_tier: 'pro', subscription_status: 'active', stripe_subscription_id: 'sub_456' },
        });
        mockFrom.mockReturnValue(query);
        mockSubscriptionsRetrieve.mockResolvedValue({
            status: 'active',
            current_period_end: Math.floor(Date.now() / 1000),
            cancel_at_period_end: true,
        });

        const result = await service.getSubscriptionStatus(userId);

        expect(result.cancelAtPeriodEnd).toBe(true);
    });
});

// ── cancelSubscription ────────────────────────────────────────────────────────

describe('PaymentService.cancelSubscription', () => {
    beforeEach(() => vi.clearAllMocks());

    it('calls stripe.subscriptions.update with cancel_at_period_end=true', async () => {
        mockSubscriptionsUpdate.mockResolvedValue({});

        await service.cancelSubscription('sub_abc');

        expect(mockSubscriptionsUpdate).toHaveBeenCalledWith('sub_abc', {
            cancel_at_period_end: true,
        });
    });
});

// ── handleWebhook ─────────────────────────────────────────────────────────────

describe('PaymentService.handleWebhook – checkout.session.completed', () => {
    beforeEach(() => vi.clearAllMocks());

    const makeEvent = (overrides: object = {}) => ({
        id: 'evt_1',
        type: 'checkout.session.completed',
        data: {
            object: {
                metadata: { user_id: 'user-1' },
                subscription: 'sub_new',
                ...overrides,
            },
        },
    });

    it('maps pro price ID to pro tier and updates profile', async () => {
        mockGetTierFromPriceId.mockReturnValue('pro');
        mockSubscriptionsRetrieve.mockResolvedValue({
            id: 'sub_new',
            items: { data: [{ price: { id: 'price_pro' } }] },
        });
        const updateEq = vi.fn().mockResolvedValue({ error: null });
        const updateFn = vi.fn().mockReturnValue({ eq: updateEq });
        mockFrom.mockReturnValue({ update: updateFn });

        await service.handleWebhook(makeEvent() as any);

        expect(mockGetTierFromPriceId).toHaveBeenCalledWith('price_pro');
        expect(updateFn).toHaveBeenCalledWith(
            expect.objectContaining({
                subscription_tier: 'pro',
                subscription_status: 'active',
                stripe_subscription_id: 'sub_new',
            })
        );
        expect(updateEq).toHaveBeenCalledWith('id', 'user-1');
    });

    it('maps enterprise price ID to enterprise tier', async () => {
        mockGetTierFromPriceId.mockReturnValue('enterprise');
        mockSubscriptionsRetrieve.mockResolvedValue({
            id: 'sub_ent',
            items: { data: [{ price: { id: 'price_ent' } }] },
        });
        const updateEq = vi.fn().mockResolvedValue({ error: null });
        mockFrom.mockReturnValue({ update: vi.fn().mockReturnValue({ eq: updateEq }) });

        await service.handleWebhook(makeEvent({ subscription: 'sub_ent' }) as any);

        expect(mockGetTierFromPriceId).toHaveBeenCalledWith('price_ent');
    });

    it('does nothing when user_id is missing from session metadata', async () => {
        const event = {
            id: 'evt_2',
            type: 'checkout.session.completed',
            data: { object: { metadata: {}, subscription: 'sub_x' } },
        };

        await service.handleWebhook(event as any);

        expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
        expect(mockFrom).not.toHaveBeenCalled();
    });
});

describe('PaymentService.handleWebhook – customer.subscription.updated', () => {
    beforeEach(() => vi.clearAllMocks());

    it('updates subscription_status for the matching profile', async () => {
        const selectQuery = makeQuery({ data: { id: 'user-1' } });
        const updateEq = vi.fn().mockResolvedValue({ error: null });
        const updateFn = vi.fn().mockReturnValue({ eq: updateEq });
        mockFrom
            .mockReturnValueOnce(selectQuery)
            .mockReturnValueOnce({ update: updateFn });

        await service.handleWebhook({
            id: 'evt_3',
            type: 'customer.subscription.updated',
            data: { object: { customer: 'cus_1', status: 'past_due' } },
        } as any);

        expect(updateFn).toHaveBeenCalledWith({ subscription_status: 'past_due' });
        expect(updateEq).toHaveBeenCalledWith('id', 'user-1');
    });

    it('does nothing when no profile matches the customer ID', async () => {
        const selectQuery = makeQuery({ data: null });
        mockFrom.mockReturnValue(selectQuery);

        await service.handleWebhook({
            id: 'evt_4',
            type: 'customer.subscription.updated',
            data: { object: { customer: 'cus_unknown', status: 'active' } },
        } as any);

        // from() called once for select, never for update
        expect(mockFrom).toHaveBeenCalledTimes(1);
    });
});

describe('PaymentService.handleWebhook – customer.subscription.deleted', () => {
    beforeEach(() => vi.clearAllMocks());

    it('downgrades to free tier and clears subscription ID', async () => {
        const selectQuery = makeQuery({ data: { id: 'user-1' } });
        const updateEq = vi.fn().mockResolvedValue({ error: null });
        const updateFn = vi.fn().mockReturnValue({ eq: updateEq });
        mockFrom
            .mockReturnValueOnce(selectQuery)
            .mockReturnValueOnce({ update: updateFn });

        await service.handleWebhook({
            id: 'evt_5',
            type: 'customer.subscription.deleted',
            data: { object: { customer: 'cus_1' } },
        } as any);

        expect(updateFn).toHaveBeenCalledWith({
            subscription_tier: 'free',
            subscription_status: 'canceled',
            stripe_subscription_id: null,
        });
    });

    it('does nothing when no profile matches the customer ID', async () => {
        mockFrom.mockReturnValue(makeQuery({ data: null }));

        await service.handleWebhook({
            id: 'evt_6',
            type: 'customer.subscription.deleted',
            data: { object: { customer: 'cus_ghost' } },
        } as any);

        expect(mockFrom).toHaveBeenCalledTimes(1);
    });
});

describe('PaymentService.handleWebhook – invoice.payment_failed', () => {
    beforeEach(() => vi.clearAllMocks());

    it('marks subscription as past_due', async () => {
        const selectQuery = makeQuery({ data: { id: 'user-1' } });
        const updateEq = vi.fn().mockResolvedValue({ error: null });
        const updateFn = vi.fn().mockReturnValue({ eq: updateEq });
        mockFrom
            .mockReturnValueOnce(selectQuery)
            .mockReturnValueOnce({ update: updateFn });

        await service.handleWebhook({
            id: 'evt_7',
            type: 'invoice.payment_failed',
            data: { object: { customer: 'cus_1' } },
        } as any);

        expect(updateFn).toHaveBeenCalledWith({ subscription_status: 'past_due' });
    });

    it('does nothing when no profile matches the customer ID', async () => {
        mockFrom.mockReturnValue(makeQuery({ data: null }));

        await service.handleWebhook({
            id: 'evt_8',
            type: 'invoice.payment_failed',
            data: { object: { customer: 'cus_ghost' } },
        } as any);

        expect(mockFrom).toHaveBeenCalledTimes(1);
    });
});

describe('PaymentService.handleWebhook – unhandled event type', () => {
    it('does nothing for unknown event types', async () => {
        await service.handleWebhook({
            id: 'evt_9',
            type: 'payment_intent.created',
            data: { object: {} },
        } as any);

        expect(mockFrom).not.toHaveBeenCalled();
        expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
    });
});

describe('PaymentService.createCustomerPortalSession', () => {
    beforeEach(() => vi.clearAllMocks());

    it('creates portal session for user with Stripe customer', async () => {
        const userId = 'user-1';
        const returnUrl = 'http://localhost:3000/billing';
        const portalUrl = 'https://billing.stripe.com/session/test-123';

        const selectQuery = makeQuery({ data: { stripe_customer_id: 'cus_1' } });
        mockFrom.mockReturnValue(selectQuery);
        mockBillingPortalSessionsCreate.mockResolvedValue({ url: portalUrl });

        const result = await service.createCustomerPortalSession(userId, returnUrl);

        expect(result).toEqual({ url: portalUrl });
        expect(mockBillingPortalSessionsCreate).toHaveBeenCalledWith({
            customer: 'cus_1',
            return_url: returnUrl,
        });
    });

    it('throws error when user has no Stripe customer record', async () => {
        const userId = 'user-no-customer';
        const returnUrl = 'http://localhost:3000/billing';

        const selectQuery = makeQuery({ data: { stripe_customer_id: null } });
        mockFrom.mockReturnValue(selectQuery);

        await expect(
            service.createCustomerPortalSession(userId, returnUrl)
        ).rejects.toThrow('does not have a Stripe customer record');
        expect(mockBillingPortalSessionsCreate).not.toHaveBeenCalled();
    });

    it('throws error when profile is null', async () => {
        const userId = 'user-unknown';
        const returnUrl = 'http://localhost:3000/billing';

        const selectQuery = makeQuery({ data: null });
        mockFrom.mockReturnValue(selectQuery);

        await expect(
            service.createCustomerPortalSession(userId, returnUrl)
        ).rejects.toThrow('does not have a Stripe customer record');
    });

    it('passes correct customer ID and return URL to Stripe', async () => {
        const userId = 'user-2';
        const returnUrl = 'http://example.com/settings/billing';
        const customerId = 'cus_abc123';

        const selectQuery = makeQuery({ data: { stripe_customer_id: customerId } });
        mockFrom.mockReturnValue(selectQuery);
        mockBillingPortalSessionsCreate.mockResolvedValue({
            url: 'https://billing.stripe.com/session/123',
        });

        await service.createCustomerPortalSession(userId, returnUrl);

        expect(mockBillingPortalSessionsCreate).toHaveBeenCalledWith({
            customer: customerId,
            return_url: returnUrl,
        });
    });

    it('returns portal URL from Stripe response', async () => {
        const userId = 'user-3';
        const returnUrl = 'http://localhost:3000/billing';
        const expectedUrl = 'https://billing.stripe.com/session/abc-123-def';

        const selectQuery = makeQuery({ data: { stripe_customer_id: 'cus_3' } });
        mockFrom.mockReturnValue(selectQuery);
        mockBillingPortalSessionsCreate.mockResolvedValue({
            url: expectedUrl,
        });

        const result = await service.createCustomerPortalSession(userId, returnUrl);

        expect(result.url).toBe(expectedUrl);
    });
});
