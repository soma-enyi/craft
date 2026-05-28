/**
 * StripeSubscriptionReconciler
 *
 * Reconciles out-of-order webhook events using timestamp-based ordering.
 * Ignores stale events and reconciles conflicts by fetching from Stripe API.
 *
 * State reconciliation strategy:
 *   1. Track event_timestamp for each subscription state update
 *   2. Before applying webhook event, compare timestamps
 *   3. Ignore events with older timestamps (stale)
 *   4. On conflict detection, fetch from Stripe API and use as source of truth
 *   5. Update local state with Stripe data
 */

export interface SubscriptionStateRecord {
    subscriptionId: string;
    status: 'active' | 'past_due' | 'canceled' | 'trialing';
    event_timestamp: number; // Unix ms when this state was last updated
}

export interface StripeWebhookEvent {
    id: string;
    type: string;
    created: number; // Unix seconds from Stripe
    data: {
        object: {
            id: string;
            status: string;
        };
    };
}

interface StripeApiClient {
    getSubscription(subscriptionId: string): Promise<{ status: string; updated: number }>;
}

export class StripeSubscriptionReconciler {
    constructor(private readonly stripeApi: StripeApiClient) {}

    /**
     * Apply a webhook event to the subscription state.
     * Returns true if state was updated, false if event was ignored.
     */
    async applyWebhookEvent(
        current: SubscriptionStateRecord,
        event: StripeWebhookEvent,
    ): Promise<{ updated: boolean; state: SubscriptionStateRecord }> {
        // Convert Stripe timestamp (seconds) to milliseconds
        const eventTimestampMs = event.created * 1000;

        // Ignore stale events (older than current state)
        if (eventTimestampMs < current.event_timestamp) {
            return { updated: false, state: current };
        }

        // Extract new status from event
        const newStatus = event.data.object.status as SubscriptionStateRecord['status'];

        // Check if state actually changed
        if (newStatus === current.status && eventTimestampMs === current.event_timestamp) {
            return { updated: false, state: current };
        }

        // If timestamp is equal but status differs, it's a conflict — fetch from Stripe
        if (eventTimestampMs === current.event_timestamp && newStatus !== current.status) {
            return this.reconcileFromStripe(event.data.object.id, current);
        }

        // Normal case: newer timestamp, apply the event
        const updated: SubscriptionStateRecord = {
            subscriptionId: current.subscriptionId,
            status: newStatus,
            event_timestamp: eventTimestampMs,
        };

        return { updated: true, state: updated };
    }

    /**
     * Reconcile state by fetching from Stripe API.
     * Stripe is the source of truth when conflicts occur.
     */
    private async reconcileFromStripe(
        subscriptionId: string,
        current: SubscriptionStateRecord,
    ): Promise<{ updated: boolean; state: SubscriptionStateRecord }> {
        try {
            const stripeData = await this.stripeApi.getSubscription(subscriptionId);
            const stripeTimestampMs = stripeData.updated * 1000;

            const reconciled: SubscriptionStateRecord = {
                subscriptionId,
                status: stripeData.status as SubscriptionStateRecord['status'],
                event_timestamp: stripeTimestampMs,
            };

            return { updated: true, state: reconciled };
        } catch {
            // If fetch fails, keep current state
            return { updated: false, state: current };
        }
    }
}
