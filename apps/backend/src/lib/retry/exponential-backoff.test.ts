import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    isRetryableError,
    calculateBackoffDelay,
    retryWithBackoff,
    sleep,
} from './exponential-backoff';

describe('exponential-backoff', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('isRetryableError', () => {
        it('should return true for 5xx errors', () => {
            expect(isRetryableError({ status: 500 })).toBe(true);
            expect(isRetryableError({ status: 502 })).toBe(true);
            expect(isRetryableError({ status: 503 })).toBe(true);
        });

        it('should return true for 429 rate limit', () => {
            expect(isRetryableError({ status: 429 })).toBe(true);
        });

        it('should return false for 4xx errors (except 429)', () => {
            expect(isRetryableError({ status: 400 })).toBe(false);
            expect(isRetryableError({ status: 401 })).toBe(false);
            expect(isRetryableError({ status: 403 })).toBe(false);
            expect(isRetryableError({ status: 404 })).toBe(false);
        });

        it('should return true for network errors', () => {
            expect(isRetryableError({ message: 'network error' })).toBe(true);
            expect(isRetryableError({ message: 'ECONNREFUSED' })).toBe(true);
            expect(isRetryableError({ message: 'timeout' })).toBe(true);
            expect(isRetryableError({ message: 'ETIMEDOUT' })).toBe(true);
        });

        it('should return false for non-network errors', () => {
            expect(isRetryableError({ message: 'validation error' })).toBe(false);
            expect(isRetryableError({ message: 'invalid payload' })).toBe(false);
        });

        it('should return false for null/undefined', () => {
            expect(isRetryableError(null)).toBe(false);
            expect(isRetryableError(undefined)).toBe(false);
        });
    });

    describe('calculateBackoffDelay', () => {
        it('should increase exponentially', () => {
            const delay0 = calculateBackoffDelay(0, 100, 10000, 2);
            const delay1 = calculateBackoffDelay(1, 100, 10000, 2);
            const delay2 = calculateBackoffDelay(2, 100, 10000, 2);

            // With jitter, we can only check approximate values
            expect(delay1).toBeGreaterThan(delay0);
            expect(delay2).toBeGreaterThan(delay1);
        });

        it('should respect max delay', () => {
            const delay = calculateBackoffDelay(10, 100, 500, 2);
            expect(delay).toBeLessThanOrEqual(550); // 500 + 10% jitter
        });

        it('should add jitter', () => {
            // Run multiple times to verify jitter is applied
            const delays = Array.from({ length: 10 }, () =>
                calculateBackoffDelay(1, 100, 1000, 2),
            );

            // Check that not all delays are identical (jitter applied)
            const uniqueDelays = new Set(delays);
            expect(uniqueDelays.size).toBeGreaterThan(1);
        });

        it('should return non-negative delay', () => {
            const delay = calculateBackoffDelay(5, 100, 1000, 2);
            expect(delay).toBeGreaterThanOrEqual(0);
        });
    });

    describe('retryWithBackoff', () => {
        it('should return success on first attempt', async () => {
            const fn = vi.fn().mockResolvedValue('success');
            const result = await retryWithBackoff(fn);

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data).toBe('success');
                expect(result.attempts).toBe(1);
            }
            expect(fn).toHaveBeenCalledOnce();
        });

        it('should retry on retryable errors', async () => {
            const fn = vi
                .fn()
                .mockRejectedValueOnce({ status: 503 })
                .mockRejectedValueOnce({ status: 503 })
                .mockResolvedValueOnce('success');

            const result = await retryWithBackoff(fn, {
                maxAttempts: 5,
                initialDelayMs: 10,
                maxDelayMs: 100,
            });

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data).toBe('success');
                expect(result.attempts).toBe(3);
            }
            expect(fn).toHaveBeenCalledTimes(3);
        });

        it('should not retry on non-retryable errors', async () => {
            const fn = vi.fn().mockRejectedValue({ status: 400 });

            const result = await retryWithBackoff(fn, { maxAttempts: 5 });

            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.attempts).toBe(1);
            }
            expect(fn).toHaveBeenCalledOnce();
        });

        it('should respect max attempts', async () => {
            const fn = vi.fn().mockRejectedValue({ status: 503 });

            const result = await retryWithBackoff(fn, { maxAttempts: 3, initialDelayMs: 10 });

            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.attempts).toBe(3);
            }
            expect(fn).toHaveBeenCalledTimes(3);
        });

        it('should respect max total duration', async () => {
            const fn = vi.fn().mockRejectedValue({ status: 503 });

            const result = await retryWithBackoff(fn, {
                maxAttempts: 10,
                initialDelayMs: 100,
                maxDelayMs: 100,
                maxTotalDurationMs: 250,
            });

            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.totalDurationMs).toBeLessThan(500);
            }
        });

        it('should handle async errors', async () => {
            const fn = vi
                .fn()
                .mockRejectedValueOnce(new Error('network timeout'))
                .mockResolvedValueOnce('success');

            const result = await retryWithBackoff(fn, { maxAttempts: 3, initialDelayMs: 10 });

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.attempts).toBe(2);
            }
        });

        it('should track total duration', async () => {
            const fn = vi.fn().mockResolvedValue('success');

            const result = await retryWithBackoff(fn, { initialDelayMs: 10 });

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.totalDurationMs).toBeDefined();
            }
        });
    });

    describe('sleep', () => {
        it('should resolve after delay', async () => {
            const start = Date.now();
            await sleep(100);
            vi.runAllTimers();
            const elapsed = Date.now() - start;
            expect(elapsed).toBeGreaterThanOrEqual(100);
        });
    });
});
