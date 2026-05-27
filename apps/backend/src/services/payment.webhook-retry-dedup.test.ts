/**
 * Tests for Stripe Webhook Retry Deduplication
 *
 * Deduplication Strategy (documented here per issue #565):
 * ─────────────────────────────────────────────────────────
 * Stripe delivers webhooks with at-least-once semantics. When a webhook
 * endpoint returns a non-2xx response (or times out), Stripe retries the
 * same event with the **same event ID** (e.g. `evt_1ABC...`).
 *
 * PaymentService.handleWebhook is designed to be idempotent:
 *   1. All DB writes use upsert / update-by-stable-key semantics so that
 *      re-processing the same event produces the same final state.
 *   2. The event ID is the natural deduplication key — callers (API route)
 *      are responsible for persisting processed event IDs when a stricter
 *      exactly-once guarantee is required (e.g. via a `processed_events`
 *      table). The service itself is stateless and relies on DB idempotency.
 *   3. Duplicate deliveries of the same event ID must not cause duplicate
 *      subscription state changes (e.g. double-downgrade, double-upgrade).
 *
 * These tests verify:
 *   - 1×, 2×, and 3× delivery of the same event ID all yield identical state
 *   - The DB update is called each time (idempotent, not skipped)
 *   - Subscription state is unchanged after duplicate delivery
 *   - All four webhook event types are covered
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PaymentService } from './payment.service';

// ── Stripe mock ───────────────────────────────────────────────────────────────

const mockSubscriptionsRetrieve = vi.fn();

vi.mock('@/lib/stripe/client', () => ({
    stripe: {
        customers: { create: vi.fn() },
        checkout: { sessions: { create: vi.fn() } },
        subscriptions: {
            retrieve: mockSubscriptionsRetrieve,
            update: vi.fn(),
        },
    },
}));

// ── Pricing mock ──────────────────────────────────────────────────────────────

vi.mock('@/lib/stripe/pricing', () => ({
    getTierFromPriceId: () => 'pro',
}));

// ── Supabase mock ─────────────────────────────────────────────────────────────

/** Tracks every update payload written to the profiles table. */
let profileUpdates: object[] = [];

const mockFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
    createClient: () => ({ from: mockFrom }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Real Stripe event ID format: evt_ + 24 alphanumeric chars */
function stripeEventId(suffix = 'ABCDEFGHIJKLMNOPQRSTUVWX'): string {
    return `evt_1${suffix}`;
}

function makeSelectQuery(profileData: object | null) {
    return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: profileData }),
    };
}

function makeUpdateQuery(onUpdate: (payload: object) => void) {
    const eqFn = vi.fn().mockResolvedValue({ error: null });
    const updateFn = vi.fn().mockImplementation((payload: object) => {
        onUpdate(payload);
        return { eq: eqFn };
    });
    return { update: updateFn };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PaymentService – webhook retry deduplication', () => {
    let service: PaymentService;

    beforeEach(async () => {
        profileUpdates = [];
        vi.clearAllMocks();
        const { PaymentService: PS } = await import('./payment.service');
        service = new PS();
    });

    // ── checkout.session.completed ────────────────────────────────────────────

    describe('checkout.session.completed – 1×/2×/3× delivery', () => {
        const EVENT_ID = stripeEventId('CHECKOUT001ABCDEFGHIJKLM');

        function makeEvent() {
            return {
                id: EVENT_ID,
                type: 'checkout.session.completed',
                data: {
                    object: {
                        metadata: { user_id: 'user-checkout-1' },
                        subscription: 'sub_checkout1',
                    },
                },
            } as any;
        }

        beforeEach(() => {
            mockSubscriptionsRetrieve.mockResolvedValue({
                id: 'sub_checkout1',
                items: { data: [{ price: { id: 'price_pro' } }] },
            });

            mockFrom.mockImplementation(() =>
                makeUpdateQuery((p) => profileUpdates.push(p))
            );
        });

        it('applies the same subscription_tier on 1st delivery', async () => {
            await service.handleWebhook(makeEvent());
            expect(profileUpdates).toHaveLength(1);
            expect(profileUpdates[0]).toMatchObject({
                subscription_tier: 'pro',
                subscription_status: 'active',
                stripe_subscription_id: 'sub_checkout1',
            });
        });

        it('produces identical state on 2nd delivery (retry)', async () => {
            await service.handleWebhook(makeEvent());
            await service.handleWebhook(makeEvent());

            // Both calls write the same payload — idempotent
            expect(profileUpdates).toHaveLength(2);
            expect(profileUpdates[0]).toEqual(profileUpdates[1]);
        });

        it('produces identical state on 3rd delivery (retry)', async () => {
            await service.handleWebhook(makeEvent());
            await service.handleWebhook(makeEvent());
            await service.handleWebhook(makeEvent());

            expect(profileUpdates).toHaveLength(3);
            const [first, second, third] = profileUpdates;
            expect(first).toEqual(second);
            expect(second).toEqual(third);
        });

        it('subscription_tier is always "pro" regardless of delivery count', async () => {
            for (let i = 0; i < 3; i++) {
                await service.handleWebhook(makeEvent());
            }
            for (const update of profileUpdates) {
                expect(update).toMatchObject({ subscription_tier: 'pro' });
            }
        });
    });

    // ── customer.subscription.updated ────────────────────────────────────────

    describe('customer.subscription.updated – 1×/2×/3× delivery', () => {
        const EVENT_ID = stripeEventId('SUBUPDATE001ABCDEFGHIJKL');

        function makeEvent() {
            return {
                id: EVENT_ID,
                type: 'customer.subscription.updated',
                data: { object: { customer: 'cus_upd1', status: 'past_due' } },
            } as any;
        }

        beforeEach(() => {
            mockFrom
                .mockReturnValueOnce(makeSelectQuery({ id: 'user-upd-1' }))
                .mockReturnValue(makeUpdateQuery((p) => profileUpdates.push(p)));
        });

        it('sets subscription_status to past_due on 1st delivery', async () => {
            await service.handleWebhook(makeEvent());
            expect(profileUpdates[0]).toMatchObject({ subscription_status: 'past_due' });
        });

        it('duplicate delivery does not change final state', async () => {
            // Re-setup select mock for each call
            mockFrom
                .mockReset()
                .mockReturnValueOnce(makeSelectQuery({ id: 'user-upd-1' }))
                .mockReturnValueOnce(makeUpdateQuery((p) => profileUpdates.push(p)))
                .mockReturnValueOnce(makeSelectQuery({ id: 'user-upd-1' }))
                .mockReturnValueOnce(makeUpdateQuery((p) => profileUpdates.push(p)));

            await service.handleWebhook(makeEvent());
            await service.handleWebhook(makeEvent());

            expect(profileUpdates).toHaveLength(2);
            expect(profileUpdates[0]).toEqual(profileUpdates[1]);
        });
    });

    // ── customer.subscription.deleted ────────────────────────────────────────

    describe('customer.subscription.deleted – 1×/2×/3× delivery', () => {
        const EVENT_ID = stripeEventId('SUBDEL001ABCDEFGHIJKLMNO');

        function makeEvent() {
            return {
                id: EVENT_ID,
                type: 'customer.subscription.deleted',
                data: { object: { customer: 'cus_del1' } },
            } as any;
        }

        function setupMocks() {
            mockFrom
                .mockReturnValueOnce(makeSelectQuery({ id: 'user-del-1' }))
                .mockReturnValueOnce(makeUpdateQuery((p) => profileUpdates.push(p)));
        }

        it('downgrades to free tier on 1st delivery', async () => {
            setupMocks();
            await service.handleWebhook(makeEvent());
            expect(profileUpdates[0]).toMatchObject({
                subscription_tier: 'free',
                subscription_status: 'canceled',
                stripe_subscription_id: null,
            });
        });

        it('2nd delivery produces same downgrade — no double-cancel side-effect', async () => {
            setupMocks();
            await service.handleWebhook(makeEvent());
            const afterFirst = { ...profileUpdates[0] };

            setupMocks();
            await service.handleWebhook(makeEvent());

            expect(profileUpdates[1]).toEqual(afterFirst);
        });

        it('3rd delivery still yields free/canceled state', async () => {
            for (let i = 0; i < 3; i++) {
                setupMocks();
                await service.handleWebhook(makeEvent());
            }
            for (const update of profileUpdates) {
                expect(update).toMatchObject({
                    subscription_tier: 'free',
                    subscription_status: 'canceled',
                });
            }
        });
    });

    // ── invoice.payment_failed ────────────────────────────────────────────────

    describe('invoice.payment_failed – 1×/2×/3× delivery', () => {
        const EVENT_ID = stripeEventId('INVFAIL001ABCDEFGHIJKLMN');

        function makeEvent() {
            return {
                id: EVENT_ID,
                type: 'invoice.payment_failed',
                data: { object: { customer: 'cus_inv1' } },
            } as any;
        }

        function setupMocks() {
            mockFrom
                .mockReturnValueOnce(makeSelectQuery({ id: 'user-inv-1' }))
                .mockReturnValueOnce(makeUpdateQuery((p) => profileUpdates.push(p)));
        }

        it('marks subscription past_due on 1st delivery', async () => {
            setupMocks();
            await service.handleWebhook(makeEvent());
            expect(profileUpdates[0]).toMatchObject({ subscription_status: 'past_due' });
        });

        it('duplicate delivery does not escalate status beyond past_due', async () => {
            for (let i = 0; i < 3; i++) {
                setupMocks();
                await service.handleWebhook(makeEvent());
            }
            for (const update of profileUpdates) {
                expect(update).toMatchObject({ subscription_status: 'past_due' });
            }
        });

        it('all 3 deliveries write identical payloads', async () => {
            for (let i = 0; i < 3; i++) {
                setupMocks();
                await service.handleWebhook(makeEvent());
            }
            expect(profileUpdates[0]).toEqual(profileUpdates[1]);
            expect(profileUpdates[1]).toEqual(profileUpdates[2]);
        });
    });

    // ── Deduplication window / event ID uniqueness ────────────────────────────

    describe('event ID deduplication key semantics', () => {
        it('different event IDs for same event type are processed independently', async () => {
            const eventA = {
                id: stripeEventId('EVENTAAAAAAAAAAAAAAAAAAAAA'),
                type: 'customer.subscription.deleted',
                data: { object: { customer: 'cus_a' } },
            } as any;
            const eventB = {
                id: stripeEventId('EVENTBBBBBBBBBBBBBBBBBBBBB'),
                type: 'customer.subscription.deleted',
                data: { object: { customer: 'cus_b' } },
            } as any;

            mockFrom
                .mockReturnValueOnce(makeSelectQuery({ id: 'user-a' }))
                .mockReturnValueOnce(makeUpdateQuery((p) => profileUpdates.push(p)))
                .mockReturnValueOnce(makeSelectQuery({ id: 'user-b' }))
                .mockReturnValueOnce(makeUpdateQuery((p) => profileUpdates.push(p)));

            await service.handleWebhook(eventA);
            await service.handleWebhook(eventB);

            // Two distinct events → two distinct DB writes
            expect(profileUpdates).toHaveLength(2);
        });

        it('same event ID with same payload is idempotent across retries', async () => {
            const SHARED_ID = stripeEventId('SHAREDIDABCDEFGHIJKLMNOP');
            const makeRetry = () => ({
                id: SHARED_ID,
                type: 'invoice.payment_failed',
                data: { object: { customer: 'cus_retry' } },
            } as any);

            for (let i = 0; i < 3; i++) {
                mockFrom
                    .mockReturnValueOnce(makeSelectQuery({ id: 'user-retry' }))
                    .mockReturnValueOnce(makeUpdateQuery((p) => profileUpdates.push(p)));
                await service.handleWebhook(makeRetry());
            }

            // All writes are identical — idempotent
            const unique = new Set(profileUpdates.map((u) => JSON.stringify(u)));
            expect(unique.size).toBe(1);
        });
    });
});
