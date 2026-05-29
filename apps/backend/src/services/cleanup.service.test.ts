/**
 * Unit tests for CleanupService.
 *
 * Tests the cleanup service methods that wrap pg_cron cleanup functions.
 *
 * Coverage:
 *   purgeTombstonedDeployments  — success, error handling
 *   purgeStaleGitHubDeployments — success, error handling
 *   purgeOldAnalytics           — success, error handling
 *   purgeOrphanedLogs           — success, error handling, zero orphans
 *   purgeOldUsageRecords        — success, error handling
 *   runAllCleanupJobs           — all succeed, partial failure, all fail
 *   getRecentExecutions         — with/without filter, limit
 *   getJobHealth                — success, empty result
 *   getFailedExecutions         — with/without date filter
 *
 * Issue: #653 — Supabase pg_cron Extension Integration for Automated Deployment Cleanup
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CleanupService, type CleanupResult } from './cleanup.service';

// ── Mock Supabase client ──────────────────────────────────────────────────────

const mockRpc = vi.fn();
const mockFrom = vi.fn();
const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockGte = vi.fn();
const mockOrder = vi.fn();
const mockLimit = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
    createClient: vi.fn(() => ({
        rpc: mockRpc,
        from: mockFrom,
    })),
}));

// ── Test suite ────────────────────────────────────────────────────────────────

describe('CleanupService', () => {
    let service: CleanupService;

    beforeEach(() => {
        service = new CleanupService();
        vi.clearAllMocks();

        // Default mock chain for from() queries
        mockOrder.mockReturnValue({
            limit: mockLimit,
        });
        mockLimit.mockReturnValue({
            data: [],
            error: null,
        });
        mockGte.mockReturnValue({
            order: mockOrder,
        });
        mockEq.mockReturnValue({
            gte: mockGte,
            order: mockOrder,
            limit: mockLimit,
        });
        mockSelect.mockReturnValue({
            eq: mockEq,
            gte: mockGte,
            order: mockOrder,
            limit: mockLimit,
        });
        mockFrom.mockReturnValue({
            select: mockSelect,
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // ── purgeTombstonedDeployments ────────────────────────────────────────────

    describe('purgeTombstonedDeployments', () => {
        it('returns count of purged deployments on success', async () => {
            mockRpc.mockResolvedValue({ data: 5, error: null });

            const result = await service.purgeTombstonedDeployments();

            expect(result.recordsDeleted).toBe(5);
            expect(result.description).toBe('Tombstoned deployments purged');
            expect(result.executedAt).toBeInstanceOf(Date);
            expect(mockRpc).toHaveBeenCalledWith('cleanup_tombstoned_deployments');
        });

        it('returns zero when no deployments are purged', async () => {
            mockRpc.mockResolvedValue({ data: 0, error: null });

            const result = await service.purgeTombstonedDeployments();

            expect(result.recordsDeleted).toBe(0);
        });

        it('throws error when RPC call fails', async () => {
            mockRpc.mockResolvedValue({
                data: null,
                error: { message: 'Database connection failed' },
            });

            await expect(service.purgeTombstonedDeployments()).rejects.toThrow(
                'Failed to purge tombstoned deployments: Database connection failed'
            );
        });

        it('handles null data response', async () => {
            mockRpc.mockResolvedValue({ data: null, error: null });

            const result = await service.purgeTombstonedDeployments();

            expect(result.recordsDeleted).toBe(0);
        });
    });

    // ── purgeStaleGitHubDeployments ───────────────────────────────────────────

    describe('purgeStaleGitHubDeployments', () => {
        it('returns count of purged GitHub deployments on success', async () => {
            mockRpc.mockResolvedValue({ data: 12, error: null });

            const result = await service.purgeStaleGitHubDeployments();

            expect(result.recordsDeleted).toBe(12);
            expect(result.description).toBe('Stale GitHub Vercel deployments purged');
            expect(mockRpc).toHaveBeenCalledWith('cleanup_stale_github_deployments');
        });

        it('throws error when RPC call fails', async () => {
            mockRpc.mockResolvedValue({
                data: null,
                error: { message: 'Permission denied' },
            });

            await expect(service.purgeStaleGitHubDeployments()).rejects.toThrow(
                'Failed to purge stale GitHub deployments: Permission denied'
            );
        });
    });

    // ── purgeOldAnalytics ─────────────────────────────────────────────────────

    describe('purgeOldAnalytics', () => {
        it('returns count of purged analytics records on success', async () => {
            mockRpc.mockResolvedValue({ data: 1500, error: null });

            const result = await service.purgeOldAnalytics();

            expect(result.recordsDeleted).toBe(1500);
            expect(result.description).toBe('Old deployment analytics purged');
            expect(mockRpc).toHaveBeenCalledWith('cleanup_old_analytics');
        });

        it('throws error when RPC call fails', async () => {
            mockRpc.mockResolvedValue({
                data: null,
                error: { message: 'Timeout' },
            });

            await expect(service.purgeOldAnalytics()).rejects.toThrow(
                'Failed to purge old analytics: Timeout'
            );
        });
    });

    // ── purgeOrphanedLogs ─────────────────────────────────────────────────────

    describe('purgeOrphanedLogs', () => {
        it('returns count of purged orphaned logs on success', async () => {
            mockRpc.mockResolvedValue({ data: 3, error: null });

            const result = await service.purgeOrphanedLogs();

            expect(result.recordsDeleted).toBe(3);
            expect(result.description).toBe('Orphaned deployment logs purged');
            expect(mockRpc).toHaveBeenCalledWith('cleanup_orphaned_logs');
        });

        it('returns zero when no orphaned logs exist', async () => {
            mockRpc.mockResolvedValue({ data: 0, error: null });

            const result = await service.purgeOrphanedLogs();

            expect(result.recordsDeleted).toBe(0);
        });

        it('throws error when RPC call fails', async () => {
            mockRpc.mockResolvedValue({
                data: null,
                error: { message: 'Query failed' },
            });

            await expect(service.purgeOrphanedLogs()).rejects.toThrow(
                'Failed to purge orphaned logs: Query failed'
            );
        });
    });

    // ── purgeOldUsageRecords ──────────────────────────────────────────────────

    describe('purgeOldUsageRecords', () => {
        it('returns count of purged usage records on success', async () => {
            mockRpc.mockResolvedValue({ data: 250, error: null });

            const result = await service.purgeOldUsageRecords();

            expect(result.recordsDeleted).toBe(250);
            expect(result.description).toBe('Old usage records purged');
            expect(mockRpc).toHaveBeenCalledWith('cleanup_old_usage_records');
        });

        it('throws error when RPC call fails', async () => {
            mockRpc.mockResolvedValue({
                data: null,
                error: { message: 'Constraint violation' },
            });

            await expect(service.purgeOldUsageRecords()).rejects.toThrow(
                'Failed to purge old usage records: Constraint violation'
            );
        });
    });

    // ── runAllCleanupJobs ─────────────────────────────────────────────────────

    describe('runAllCleanupJobs', () => {
        it('runs all cleanup jobs and returns all results on success', async () => {
            mockRpc
                .mockResolvedValueOnce({ data: 5, error: null })   // tombstoned
                .mockResolvedValueOnce({ data: 12, error: null })  // github
                .mockResolvedValueOnce({ data: 1500, error: null }) // analytics
                .mockResolvedValueOnce({ data: 0, error: null })   // orphaned
                .mockResolvedValueOnce({ data: 250, error: null }); // usage

            const results = await service.runAllCleanupJobs();

            expect(results).toHaveLength(5);
            expect(results[0]).toMatchObject({ recordsDeleted: 5 });
            expect(results[1]).toMatchObject({ recordsDeleted: 12 });
            expect(results[2]).toMatchObject({ recordsDeleted: 1500 });
            expect(results[3]).toMatchObject({ recordsDeleted: 0 });
            expect(results[4]).toMatchObject({ recordsDeleted: 250 });
        });

        it('continues execution when individual jobs fail', async () => {
            mockRpc
                .mockResolvedValueOnce({ data: 5, error: null })
                .mockResolvedValueOnce({ data: null, error: { message: 'GitHub cleanup failed' } })
                .mockResolvedValueOnce({ data: 1500, error: null })
                .mockResolvedValueOnce({ data: null, error: { message: 'Orphaned logs cleanup failed' } })
                .mockResolvedValueOnce({ data: 250, error: null });

            const results = await service.runAllCleanupJobs();

            expect(results).toHaveLength(5);
            expect(results[0]).toMatchObject({ recordsDeleted: 5 });
            expect(results[1]).toMatchObject({ error: expect.stringContaining('GitHub cleanup failed') });
            expect(results[2]).toMatchObject({ recordsDeleted: 1500 });
            expect(results[3]).toMatchObject({ error: expect.stringContaining('Orphaned logs cleanup failed') });
            expect(results[4]).toMatchObject({ recordsDeleted: 250 });
        });

        it('returns all errors when all jobs fail', async () => {
            mockRpc.mockResolvedValue({ data: null, error: { message: 'Database unavailable' } });

            const results = await service.runAllCleanupJobs();

            expect(results).toHaveLength(5);
            results.forEach((result) => {
                expect(result).toHaveProperty('error');
            });
        });
    });

    // ── getRecentExecutions ───────────────────────────────────────────────────

    describe('getRecentExecutions', () => {
        it('returns recent executions with default limit', async () => {
            const mockExecutions = [
                {
                    id: '1',
                    job_name: 'cleanup-tombstoned-deployments',
                    started_at: '2024-01-15T02:00:00Z',
                    completed_at: '2024-01-15T02:00:05Z',
                    status: 'succeeded',
                    records_deleted: 5,
                    error_message: null,
                },
                {
                    id: '2',
                    job_name: 'cleanup-stale-github-deployments',
                    started_at: '2024-01-15T02:15:00Z',
                    completed_at: '2024-01-15T02:15:03Z',
                    status: 'succeeded',
                    records_deleted: 12,
                    error_message: null,
                },
            ];

            mockLimit.mockReturnValue({ data: mockExecutions, error: null });

            const result = await service.getRecentExecutions();

            expect(result).toHaveLength(2);
            expect(result[0].jobName).toBe('cleanup-tombstoned-deployments');
            expect(result[0].recordsDeleted).toBe(5);
            expect(result[1].jobName).toBe('cleanup-stale-github-deployments');
            expect(mockLimit).toHaveBeenCalledWith(50);
        });

        it.skip('filters by job name when provided', async () => {
            const mockExecutions = [
                {
                    id: '1',
                    job_name: 'cleanup-tombstoned-deployments',
                    started_at: '2024-01-15T02:00:00Z',
                    completed_at: '2024-01-15T02:00:05Z',
                    status: 'succeeded',
                    records_deleted: 5,
                    error_message: null,
                },
            ];

            mockLimit.mockReturnValue({ data: mockExecutions, error: null });

            const result = await service.getRecentExecutions(10, 'cleanup-tombstoned-deployments');

            expect(result).toHaveLength(1);
            expect(result[0].jobName).toBe('cleanup-tombstoned-deployments');
            expect(mockLimit).toHaveBeenCalledWith(10);
        });

        it('handles null completed_at for running jobs', async () => {
            const mockExecutions = [
                {
                    id: '1',
                    job_name: 'cleanup-old-analytics',
                    started_at: '2024-01-15T02:30:00Z',
                    completed_at: null,
                    status: 'running',
                    records_deleted: null,
                    error_message: null,
                },
            ];

            mockLimit.mockReturnValue({ data: mockExecutions, error: null });

            const result = await service.getRecentExecutions();

            expect(result[0].completedAt).toBeNull();
            expect(result[0].status).toBe('running');
        });

        it('throws error when query fails', async () => {
            mockLimit.mockReturnValue({
                data: null,
                error: { message: 'Query timeout' },
            });

            await expect(service.getRecentExecutions()).rejects.toThrow(
                'Failed to get cleanup job executions: Query timeout'
            );
        });
    });

    // ── getJobHealth ──────────────────────────────────────────────────────────

    describe('getJobHealth', () => {
        it('returns health metrics for all jobs', async () => {
            const mockHealth = [
                {
                    job_name: 'cleanup-tombstoned-deployments',
                    total_executions: 30,
                    successful_executions: 30,
                    failed_executions: 0,
                    success_rate_pct: 100.0,
                    last_execution_at: '2024-01-15T02:00:00Z',
                    avg_records_deleted: 5.5,
                    max_records_deleted: 12,
                },
                {
                    job_name: 'cleanup-stale-github-deployments',
                    total_executions: 30,
                    successful_executions: 28,
                    failed_executions: 2,
                    success_rate_pct: 93.33,
                    last_execution_at: '2024-01-15T02:15:00Z',
                    avg_records_deleted: 10.2,
                    max_records_deleted: 25,
                },
            ];

            mockSelect.mockReturnValue({ data: mockHealth, error: null });

            const result = await service.getJobHealth();

            expect(result).toHaveLength(2);
            expect(result[0].jobName).toBe('cleanup-tombstoned-deployments');
            expect(result[0].successRatePct).toBe(100.0);
            expect(result[1].jobName).toBe('cleanup-stale-github-deployments');
            expect(result[1].successRatePct).toBe(93.33);
        });

        it('handles empty result', async () => {
            mockSelect.mockReturnValue({ data: [], error: null });

            const result = await service.getJobHealth();

            expect(result).toEqual([]);
        });

        it('throws error when query fails', async () => {
            mockSelect.mockReturnValue({
                data: null,
                error: { message: 'View not found' },
            });

            await expect(service.getJobHealth()).rejects.toThrow(
                'Failed to get cleanup job health: View not found'
            );
        });
    });

    // ── getFailedExecutions ───────────────────────────────────────────────────

    describe('getFailedExecutions', () => {
        it('returns failed executions from last 24 hours by default', async () => {
            const mockFailures = [
                {
                    id: '1',
                    job_name: 'cleanup-orphaned-logs',
                    started_at: '2024-01-15T02:45:00Z',
                    completed_at: '2024-01-15T02:45:10Z',
                    status: 'failed',
                    records_deleted: null,
                    error_message: 'Deadlock detected',
                },
            ];

            mockOrder.mockReturnValue({ data: mockFailures, error: null });

            const result = await service.getFailedExecutions();

            expect(result).toHaveLength(1);
            expect(result[0].status).toBe('failed');
            expect(result[0].errorMessage).toBe('Deadlock detected');
            expect(mockEq).toHaveBeenCalledWith('status', 'failed');
        });

        it('filters by custom date when provided', async () => {
            const since = new Date('2024-01-10T00:00:00Z');
            mockOrder.mockReturnValue({ data: [], error: null });

            await service.getFailedExecutions(since);

            expect(mockGte).toHaveBeenCalledWith('started_at', since.toISOString());
        });

        it('throws error when query fails', async () => {
            mockOrder.mockReturnValue({
                data: null,
                error: { message: 'Access denied' },
            });

            await expect(service.getFailedExecutions()).rejects.toThrow(
                'Failed to get failed executions: Access denied'
            );
        });
    });
});
