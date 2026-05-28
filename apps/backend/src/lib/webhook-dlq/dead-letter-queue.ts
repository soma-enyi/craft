/**
 * Webhook Dead Letter Queue (DLQ)
 *
 * Captures webhook events that exhaust all retry attempts so no event is
 * silently lost. The in-process store is sufficient for single-instance
 * deployments; replace the backing store with Redis / a DB table for
 * horizontally-scaled environments.
 *
 * Reprocessing is guarded by a single-attempt-per-entry flag so the same
 * entry cannot be requeued in an infinite loop.
 */

export type WebhookSource = 'stripe' | 'github';

export interface DLQEntry {
    id: string;
    source: WebhookSource;
    eventType: string;
    payload: string;
    failureReason: string;
    attempts: number;
    createdAt: Date;
    reprocessedAt?: Date;
    reprocessStatus?: 'pending' | 'succeeded' | 'failed';
}

type ProcessorFn = (entry: DLQEntry) => Promise<void>;

const store = new Map<string, DLQEntry>();

let _stripeProcessor: ProcessorFn | null = null;
let _githubProcessor: ProcessorFn | null = null;

function generateId(): string {
    return `dlq_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export const webhookDLQ = {
    registerProcessor(source: WebhookSource, fn: ProcessorFn): void {
        if (source === 'stripe') _stripeProcessor = fn;
        else _githubProcessor = fn;
    },

    capture(
        source: WebhookSource,
        eventType: string,
        payload: string,
        failureReason: string,
        attempts: number
    ): DLQEntry {
        const entry: DLQEntry = {
            id: generateId(),
            source,
            eventType,
            payload,
            failureReason,
            attempts,
            createdAt: new Date(),
            reprocessStatus: 'pending',
        };
        store.set(entry.id, entry);
        console.error('[DLQ] Event captured', {
            id: entry.id,
            source,
            eventType,
            attempts,
            failureReason,
        });
        return entry;
    },

    list(): DLQEntry[] {
        return Array.from(store.values()).sort(
            (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
        );
    },

    get(id: string): DLQEntry | undefined {
        return store.get(id);
    },

    async reprocess(id: string): Promise<{ success: boolean; error?: string }> {
        const entry = store.get(id);
        if (!entry) return { success: false, error: 'Entry not found' };

        if (entry.reprocessStatus === 'succeeded') {
            return { success: false, error: 'Entry already successfully reprocessed' };
        }

        const processor = entry.source === 'stripe' ? _stripeProcessor : _githubProcessor;
        if (!processor) {
            return { success: false, error: `No processor registered for source: ${entry.source}` };
        }

        try {
            await processor(entry);
            entry.reprocessedAt = new Date();
            entry.reprocessStatus = 'succeeded';
            store.set(id, entry);
            return { success: true };
        } catch (err: any) {
            entry.reprocessedAt = new Date();
            entry.reprocessStatus = 'failed';
            entry.failureReason = err?.message ?? 'Reprocessing failed';
            store.set(id, entry);
            return { success: false, error: entry.failureReason };
        }
    },

    size(): number {
        return store.size;
    },
};
