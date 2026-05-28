/**
 * Next.js instrumentation hook — runs once when the server starts.
 *
 * Registers SIGTERM and SIGINT handlers that initiate a graceful drain so
 * in-flight deployment operations can checkpoint their state before the
 * process exits.  The drain timeout is controlled via
 * SHUTDOWN_DRAIN_TIMEOUT_MS (default 30 000 ms).
 *
 * Shutdown sequence:
 *  1. Signal received → draining flag set via shutdown-manager.
 *  2. New deployment POST requests receive 503 Service Unavailable.
 *  3. Manager polls in-flight set until empty or timeout expires.
 *  4. Process exits with code 0 (or 1 on timeout).
 */
export async function register() {
    if (process.env.NEXT_RUNTIME !== 'nodejs') return;

    const { drain } = await import('@/lib/shutdown-manager');

    async function handleSignal(signal: string) {
        console.log(
            JSON.stringify({
                level: 'info',
                message: `Received ${signal} — initiating graceful drain`,
                timestamp: new Date().toISOString(),
            })
        );

        await drain();

        console.log(
            JSON.stringify({
                level: 'info',
                message: 'Drain complete — exiting',
                timestamp: new Date().toISOString(),
            })
        );

        process.exit(0);
    }

    process.once('SIGTERM', () => handleSignal('SIGTERM'));
    process.once('SIGINT', () => handleSignal('SIGINT'));
}
