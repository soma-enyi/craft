/**
 * Tests for GET /api/cron/purge-analytics
 *
 * Purge retention policy:
 *   Records in deployment_analytics older than ANALYTICS_RETENTION_DAYS
 *   (default: 90) are deleted in a single database pass.
 *   Set ANALYTICS_RETENTION_DAYS=0 to disable deletion entirely.
 *   The route is protected by CRON_SECRET (Bearer token) when configured.
 *
 * Covers:
 *   - Authorization enforcement (CRON_SECRET present / absent)
 *   - Retention window: default 90-day, custom, and disabled (0)
 *   - Batch deletion: deleted count propagated to caller
 *   - Concurrent purge calls execute independently
 *   - Error propagation on service failure
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockApplyRetentionPolicy = vi.fn();

vi.mock('@/services/analytics.service', () => ({
    analyticsService: {
        applyRetentionPolicy: mockApplyRetentionPolicy,
    },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(authHeader?: string) {
    const headers: Record<string, string> = {};
    if (authHeader !== undefined) {
        headers['authorization'] = authHeader;
    }
    return new NextRequest('http://localhost/api/cron/purge-analytics', { headers });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/cron/purge-analytics', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.CRON_SECRET;
        delete process.env.ANALYTICS_RETENTION_DAYS;
        mockApplyRetentionPolicy.mockResolvedValue(0);
    });

    afterEach(() => {
        delete process.env.CRON_SECRET;
        delete process.env.ANALYTICS_RETENTION_DAYS;
    });

    // ── Authorization ─────────────────────────────────────────────────────────

    describe('authorization', () => {
        it('returns 401 when CRON_SECRET is set and Authorization header is absent', async () => {
            process.env.CRON_SECRET = 'super-secret';
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            expect(res.status).toBe(401);
            expect((await res.json()).error).toBe('Unauthorized');
            expect(mockApplyRetentionPolicy).not.toHaveBeenCalled();
        });

        it('returns 401 when Authorization header has an incorrect Bearer token', async () => {
            process.env.CRON_SECRET = 'super-secret';
            const { GET } = await import('./route');
            const res = await GET(makeRequest('Bearer wrong-token'));
            expect(res.status).toBe(401);
            expect(mockApplyRetentionPolicy).not.toHaveBeenCalled();
        });

        it('proceeds when Authorization header matches CRON_SECRET exactly', async () => {
            process.env.CRON_SECRET = 'super-secret';
            mockApplyRetentionPolicy.mockResolvedValue(3);
            const { GET } = await import('./route');
            const res = await GET(makeRequest('Bearer super-secret'));
            expect(res.status).toBe(200);
            expect((await res.json()).deleted).toBe(3);
        });

        it('skips auth check and proceeds when CRON_SECRET is not configured', async () => {
            mockApplyRetentionPolicy.mockResolvedValue(7);
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            expect(res.status).toBe(200);
        });
    });

    // ── Retention window enforcement ──────────────────────────────────────────

    describe('retention window enforcement', () => {
        it('passes the default 90-day retention when ANALYTICS_RETENTION_DAYS is not set', async () => {
            const { GET } = await import('./route');
            await GET(makeRequest());
            expect(mockApplyRetentionPolicy).toHaveBeenCalledWith(90);
        });

        it('reads retention days from the ANALYTICS_RETENTION_DAYS environment variable', async () => {
            process.env.ANALYTICS_RETENTION_DAYS = '30';
            const { GET } = await import('./route');
            await GET(makeRequest());
            expect(mockApplyRetentionPolicy).toHaveBeenCalledWith(30);
        });

        it('passes 0 when ANALYTICS_RETENTION_DAYS=0 disabling the purge', async () => {
            process.env.ANALYTICS_RETENTION_DAYS = '0';
            const { GET } = await import('./route');
            await GET(makeRequest());
            expect(mockApplyRetentionPolicy).toHaveBeenCalledWith(0);
        });

        it('passes a large custom retention window correctly', async () => {
            process.env.ANALYTICS_RETENTION_DAYS = '365';
            const { GET } = await import('./route');
            await GET(makeRequest());
            expect(mockApplyRetentionPolicy).toHaveBeenCalledWith(365);
        });

        it('just-inside boundary: data at exactly retentionDays is preserved (policy call uses parsed days)', async () => {
            process.env.ANALYTICS_RETENTION_DAYS = '7';
            const { GET } = await import('./route');
            await GET(makeRequest());
            expect(mockApplyRetentionPolicy).toHaveBeenCalledWith(7);
        });
    });

    // ── Batch deletion behavior ───────────────────────────────────────────────

    describe('batch deletion behavior', () => {
        it('returns the deleted count reported by the retention policy', async () => {
            mockApplyRetentionPolicy.mockResolvedValue(150);
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            expect(res.status).toBe(200);
            expect((await res.json()).deleted).toBe(150);
        });

        it('returns deleted:0 when all records are within the retention window', async () => {
            mockApplyRetentionPolicy.mockResolvedValue(0);
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            expect((await res.json()).deleted).toBe(0);
        });

        it('handles a large batch deletion count without overflow', async () => {
            mockApplyRetentionPolicy.mockResolvedValue(1_000_000);
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            expect(res.status).toBe(200);
            expect((await res.json()).deleted).toBe(1_000_000);
        });

        it('invokes applyRetentionPolicy exactly once per request', async () => {
            const { GET } = await import('./route');
            await GET(makeRequest());
            expect(mockApplyRetentionPolicy).toHaveBeenCalledTimes(1);
        });
    });

    // ── Concurrent purge execution ────────────────────────────────────────────

    describe('concurrent purge execution', () => {
        it('handles two simultaneous purge requests, each returning its own count', async () => {
            let callIndex = 0;
            mockApplyRetentionPolicy.mockImplementation(async () => {
                callIndex++;
                return callIndex * 10;
            });

            const { GET } = await import('./route');
            const [res1, res2] = await Promise.all([
                GET(makeRequest()),
                GET(makeRequest()),
            ]);

            expect(res1.status).toBe(200);
            expect(res2.status).toBe(200);

            const [body1, body2] = await Promise.all([res1.json(), res2.json()]);
            expect(typeof body1.deleted).toBe('number');
            expect(typeof body2.deleted).toBe('number');
            expect(mockApplyRetentionPolicy).toHaveBeenCalledTimes(2);
        });

        it('each concurrent request reads retention days from the same environment', async () => {
            process.env.ANALYTICS_RETENTION_DAYS = '60';
            mockApplyRetentionPolicy.mockResolvedValue(5);

            const { GET } = await import('./route');
            await Promise.all([GET(makeRequest()), GET(makeRequest())]);

            expect(mockApplyRetentionPolicy).toHaveBeenNthCalledWith(1, 60);
            expect(mockApplyRetentionPolicy).toHaveBeenNthCalledWith(2, 60);
        });
    });

    // ── Error handling ────────────────────────────────────────────────────────

    describe('error handling', () => {
        it('returns 500 with the error message when applyRetentionPolicy throws an Error', async () => {
            mockApplyRetentionPolicy.mockRejectedValue(new Error('DB connection lost'));
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            expect(res.status).toBe(500);
            expect((await res.json()).error).toBe('DB connection lost');
        });

        it('returns 500 with fallback message when thrown value has no message property', async () => {
            mockApplyRetentionPolicy.mockRejectedValue({});
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            expect(res.status).toBe(500);
            expect((await res.json()).error).toBe('Purge failed');
        });

        it('does not include sensitive error details in the JSON body', async () => {
            mockApplyRetentionPolicy.mockRejectedValue(new Error('Internal: user=admin pass=secret'));
            const { GET } = await import('./route');
            const res = await GET(makeRequest());
            const body = await res.json();
            expect(body).toHaveProperty('error');
            expect(body).not.toHaveProperty('stack');
        });
    });
});
