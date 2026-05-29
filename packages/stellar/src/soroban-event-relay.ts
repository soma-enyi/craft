/**
 * Soroban Contract Event Subscription and WebSocket Relay (#619)
 *
 * Subscribes to Soroban contract events via the RPC `getEvents` polling loop
 * and relays matching events to connected WebSocket clients.
 *
 * ## Design
 * - Each subscriber registers a contract ID and optional event type filter.
 * - A per-subscriber polling loop queries `getEvents` from the last seen ledger.
 * - Events are filtered server-side before being sent to the client.
 * - Subscriptions are cleaned up when the WebSocket closes or on explicit unsubscribe.
 * - A per-client subscription limit prevents resource exhaustion.
 */

import { SorobanRpc } from 'stellar-sdk';

/** Maximum concurrent subscriptions allowed per client. */
export const MAX_SUBSCRIPTIONS_PER_CLIENT = 10;

/** Polling interval in milliseconds. */
const POLL_INTERVAL_MS = 5_000;

export interface SubscriptionFilter {
    /** Contract address (C...) to subscribe to. */
    contractId: string;
    /** Optional event type filter (e.g. "transfer"). Matches all types when omitted. */
    eventType?: string;
}

export interface SorobanEvent {
    contractId: string;
    type: string;
    ledger: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value: any;
}

/** Minimal WebSocket interface — compatible with the browser/Node ws API. */
export interface WebSocketLike {
    readyState: number;
    send(data: string): void;
    on(event: 'close', listener: () => void): void;
}

/** WebSocket readyState constant for an open connection. */
const WS_OPEN = 1;

interface Subscription {
    filter: SubscriptionFilter;
    lastLedger: number;
    timer: ReturnType<typeof setInterval>;
}

/**
 * Manages Soroban contract event subscriptions for a single WebSocket client.
 *
 * Usage:
 * ```ts
 * const relay = new SorobanEventRelay(ws, sorobanClient);
 * relay.subscribe({ contractId: 'C...', eventType: 'transfer' });
 * // Events are sent to `ws` as JSON strings.
 * // Cleanup happens automatically on ws close.
 * ```
 */
export class SorobanEventRelay {
    private readonly subscriptions = new Map<string, Subscription>();

    constructor(
        private readonly ws: WebSocketLike,
        private readonly client: Pick<SorobanRpc.Server, 'getEvents' | 'getLatestLedger'>,
    ) {
        ws.on('close', () => this.cleanup());
    }

    /**
     * Subscribe to events for a contract, optionally filtered by event type.
     * Returns an error string if the subscription limit is reached.
     */
    subscribe(filter: SubscriptionFilter): string | null {
        const key = subscriptionKey(filter);

        if (this.subscriptions.has(key)) return null; // already subscribed

        if (this.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_CLIENT) {
            return `Subscription limit reached (max ${MAX_SUBSCRIPTIONS_PER_CLIENT} per client)`;
        }

        const timer = setInterval(() => this.poll(key), POLL_INTERVAL_MS);

        this.subscriptions.set(key, {
            filter,
            lastLedger: 0,
            timer,
        });

        // Kick off an immediate first poll.
        this.poll(key);

        return null;
    }

    /** Unsubscribe from a specific contract/event-type combination. */
    unsubscribe(filter: SubscriptionFilter): void {
        const key = subscriptionKey(filter);
        const sub = this.subscriptions.get(key);
        if (sub) {
            clearInterval(sub.timer);
            this.subscriptions.delete(key);
        }
    }

    /** Number of active subscriptions for this client. */
    get subscriptionCount(): number {
        return this.subscriptions.size;
    }

    /** Clean up all subscriptions (called on WebSocket close). */
    cleanup(): void {
        for (const sub of this.subscriptions.values()) {
            clearInterval(sub.timer);
        }
        this.subscriptions.clear();
    }

    // -------------------------------------------------------------------------
    // Private
    // -------------------------------------------------------------------------

    private async poll(key: string): Promise<void> {
        const sub = this.subscriptions.get(key);
        if (!sub || this.ws.readyState !== WS_OPEN) return;

        try {
            const latestLedger = await this.client.getLatestLedger();
            const startLedger = sub.lastLedger > 0 ? sub.lastLedger + 1 : latestLedger.sequence;

            const response = await this.client.getEvents({
                startLedger,
                filters: [
                    {
                        type: 'contract',
                        contractIds: [sub.filter.contractId],
                    },
                ],
            });

            // Update the last seen ledger.
            if (response.latestLedger > sub.lastLedger) {
                sub.lastLedger = response.latestLedger;
            }

            for (const event of response.events) {
                // Server-side filter by event type when specified.
                if (sub.filter.eventType) {
                    const typeTopic = event.topic?.[0]?.value?.();
                    if (typeTopic !== sub.filter.eventType) continue;
                }

                if (this.ws.readyState !== WS_OPEN) break;

                const payload: SorobanEvent = {
                    contractId: event.contractId,
                    type: sub.filter.eventType ?? 'contract',
                    ledger: event.ledger,
                    value: event.value,
                };

                this.ws.send(JSON.stringify(payload));
            }
        } catch {
            // Polling errors are non-fatal; the next interval will retry.
        }
    }
}

function subscriptionKey(filter: SubscriptionFilter): string {
    return `${filter.contractId}:${filter.eventType ?? '*'}`;
}
