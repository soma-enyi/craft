/**
 * Exponential backoff retry with jitter for transient failures.
 * Distinguishes retryable (5xx, network, rate limit) from non-retryable (4xx) errors.
 */

export interface RetryOptions {
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    maxTotalDurationMs?: number;
    backoffMultiplier?: number;
}

export type RetryResult<T> =
    | {
          success: true;
          data: T;
          attempts: number;
      }
    | {
          success: false;
          error: Error;
          attempts: number;
          totalDurationMs: number;
      };

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_INITIAL_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 30000; // 30 seconds
const DEFAULT_MAX_TOTAL_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_BACKOFF_MULTIPLIER = 2;

/**
 * Check if an error is retryable
 * Retryable errors: 5xx, 429 (rate limit), network errors, timeout
 * Non-retryable: 4xx (except 429), auth errors, validation errors
 */
export function isRetryableError(error: unknown): boolean {
    if (!error) return false;

    // Check for HTTP status codes
    if (typeof (error as any).status === 'number') {
        const status = (error as any).status;
        // Retry on 5xx and 429 (rate limit)
        if (status >= 500 || status === 429) return true;
        // Don't retry on 4xx (except 429)
        if (status >= 400 && status < 500) return false;
    }

    // Check for network/timeout errors
    const message = (error as any).message as string;
    if (!message) return false;

    const networkPatterns = [
        /network/i,
        /timeout/i,
        /econnrefused/i,
        /econnreset/i,
        /enotfound/i,
        /eai_again/i,
        /socket hang up/i,
        /ETIMEDOUT/i,
        /EHOSTUNREACH/i,
    ];

    return networkPatterns.some((p) => p.test(message));
}

/**
 * Calculate backoff delay with jitter
 * Prevents thundering herd by adding random jitter (±10%)
 */
export function calculateBackoffDelay(
    attempt: number,
    initialDelayMs: number,
    maxDelayMs: number,
    multiplier: number,
): number {
    // Exponential backoff: initial * (multiplier ^ attempt)
    let delay = initialDelayMs * Math.pow(multiplier, attempt);

    // Cap at max delay
    delay = Math.min(delay, maxDelayMs);

    // Add jitter: ±10% of the delay
    const jitter = delay * 0.1 * (Math.random() - 0.5) * 2;
    return Math.max(0, delay + jitter);
}

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 *
 * @param fn - Async function to retry
 * @param options - Retry configuration
 * @returns Result with data on success or error on failure
 */
export async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    options: RetryOptions = {},
): Promise<RetryResult<T>> {
    const {
        maxAttempts = DEFAULT_MAX_ATTEMPTS,
        initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
        maxDelayMs = DEFAULT_MAX_DELAY_MS,
        maxTotalDurationMs = DEFAULT_MAX_TOTAL_DURATION_MS,
        backoffMultiplier = DEFAULT_BACKOFF_MULTIPLIER,
    } = options;

    let lastError: Error | undefined;
    const startTime = Date.now();

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const data = await fn();
            return { success: true, data, attempts: attempt + 1 };
        } catch (err: unknown) {
            lastError = err instanceof Error ? err : new Error(String(err));

            // Check if error is retryable
            if (!isRetryableError(err)) {
                return {
                    success: false,
                    error: lastError,
                    attempts: attempt + 1,
                    totalDurationMs: Date.now() - startTime,
                };
            }

            // Check if we've exceeded total duration
            const elapsedMs = Date.now() - startTime;
            if (elapsedMs >= maxTotalDurationMs) {
                return {
                    success: false,
                    error: new Error(
                        `Retry exhausted: max total duration of ${maxTotalDurationMs}ms exceeded`,
                    ),
                    attempts: attempt + 1,
                    totalDurationMs: elapsedMs,
                };
            }

            // Calculate delay for next attempt
            if (attempt < maxAttempts - 1) {
                const delayMs = calculateBackoffDelay(attempt, initialDelayMs, maxDelayMs, backoffMultiplier);
                await sleep(delayMs);
            }
        }
    }

    return {
        success: false,
        error: lastError || new Error('Unknown error'),
        attempts: maxAttempts,
        totalDurationMs: Date.now() - startTime,
    };
}

/**
 * Helper to create a retryable function that tracks retry state
 */
export class RetryableOperation<T> {
    constructor(
        private fn: () => Promise<T>,
        private options: RetryOptions = {},
    ) {}

    async execute(): Promise<T> {
        const result = await retryWithBackoff(this.fn, this.options);
        if (!result.success) {
            throw result.error;
        }
        return result.data;
    }
}
