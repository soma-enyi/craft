/**
 * Tracks in-flight deployment operations and manages graceful drain state.
 *
 * On SIGTERM/SIGINT the drain flag is set.  New deployment requests check
 * isDraining() and respond with 503.  Existing operations call
 * trackOperation() so the process can wait for them to finish before exiting.
 *
 * Drain timeout: SHUTDOWN_DRAIN_TIMEOUT_MS (default 30 000 ms).
 */

const DRAIN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_DRAIN_TIMEOUT_MS ?? '30000', 10);

let draining = false;
const inFlight = new Set<string>();

export function isDraining(): boolean {
    return draining;
}

/**
 * Register an in-flight operation.  Call the returned `done` callback when
 * the operation finishes (success or failure).
 */
export function trackOperation(id: string): () => void {
    inFlight.add(id);
    return () => inFlight.delete(id);
}

export function inFlightCount(): number {
    return inFlight.size;
}

/**
 * Initiate graceful drain.  Sets the draining flag and waits up to
 * DRAIN_TIMEOUT_MS for in-flight operations to finish before resolving.
 */
export async function drain(): Promise<void> {
    draining = true;

    if (inFlight.size === 0) return;

    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (inFlight.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
    }

    if (inFlight.size > 0) {
        // Log remaining operations that could not be checkpointed.
        console.warn(
            JSON.stringify({
                level: 'warn',
                message: 'Drain timeout: forcing exit with in-flight operations',
                inFlight: [...inFlight],
                timestamp: new Date().toISOString(),
            })
        );
    }
}
