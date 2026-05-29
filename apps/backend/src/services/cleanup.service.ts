/**
 * CleanupService
 *
 * Provides programmatic access to database cleanup operations.
 * Wraps the pg_cron cleanup functions for manual triggering, testing,
 * and monitoring.
 *
 * All cleanup operations:
 *   - Respect retention windows (never delete recent records)
 *   - Are idempotent (safe to run multiple times)
 *   - Return structured results with counts
 *   - Log execution for observability
 *
 * Issue: #653 — Supabase pg_cron Extension Integration for Automated Deployment Cleanup
 */

import { createClient } from '@/lib/supabase/server';

// ── Result types ──────────────────────────────────────────────────────────────

export interface CleanupResult {
    /** Number of records deleted. */
    recordsDeleted: number;
    /** Human-readable description of what was cleaned. */
    description: string;
    /** Timestamp when cleanup was executed. */
    executedAt: Date;
}

export interface CleanupJobExecution {
    id: string;
    jobName: string;
    startedAt: Date;
    completedAt: Date | null;
    status: 'running' | 'succeeded' | 'failed';
    recordsDeleted: number | null;
    errorMessage: string | null;
}

export interface CleanupJobHealth {
    jobName: string;
    totalExecutions: number;
    successfulExecutions: number;
    failedExecutions: number;
    successRatePct: number;
    lastExecutionAt: Date | null;
    avgRecordsDeleted: number | null;
    maxRecordsDeleted: number | null;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class CleanupService {
    /**
     * Purge tombstoned deployments past the retention window.
     *
     * Soft-deleted deployments (deleted_at IS NOT NULL) are permanently removed
     * after 30 days. Cascades to deployment_logs and deployment_analytics.
     */
    async purgeTombstonedDeployments(): Promise<CleanupResult> {
        const supabase = createClient();

        const { data, error } = await supabase.rpc('cleanup_tombstoned_deployments');

        if (error) {
            throw new Error(`Failed to purge tombstoned deployments: ${error.message}`);
        }

        return {
            recordsDeleted: data ?? 0,
            description: 'Tombstoned deployments purged',
            executedAt: new Date(),
        };
    }

    /**
     * Purge stale GitHub Vercel deployments.
     *
     * Removes failed, canceled, or error deployments older than 90 days.
     * Successful deployments (ready) are never purged.
     */
    async purgeStaleGitHubDeployments(): Promise<CleanupResult> {
        const supabase = createClient();

        const { data, error } = await supabase.rpc('cleanup_stale_github_deployments');

        if (error) {
            throw new Error(`Failed to purge stale GitHub deployments: ${error.message}`);
        }

        return {
            recordsDeleted: data ?? 0,
            description: 'Stale GitHub Vercel deployments purged',
            executedAt: new Date(),
        };
    }

    /**
     * Purge old deployment analytics records.
     *
     * Removes analytics records older than 90 days.
     */
    async purgeOldAnalytics(): Promise<CleanupResult> {
        const supabase = createClient();

        const { data, error } = await supabase.rpc('cleanup_old_analytics');

        if (error) {
            throw new Error(`Failed to purge old analytics: ${error.message}`);
        }

        return {
            recordsDeleted: data ?? 0,
            description: 'Old deployment analytics purged',
            executedAt: new Date(),
        };
    }

    /**
     * Purge orphaned deployment logs.
     *
     * Removes logs for deployments that no longer exist. This should rarely
     * find records due to CASCADE constraints, but provides a safety net.
     */
    async purgeOrphanedLogs(): Promise<CleanupResult> {
        const supabase = createClient();

        const { data, error } = await supabase.rpc('cleanup_orphaned_logs');

        if (error) {
            throw new Error(`Failed to purge orphaned logs: ${error.message}`);
        }

        return {
            recordsDeleted: data ?? 0,
            description: 'Orphaned deployment logs purged',
            executedAt: new Date(),
        };
    }

    /**
     * Purge old usage records (metered billing).
     *
     * Removes usage records older than 365 days that have been reported to Stripe.
     * Unreported records are never deleted to prevent billing data loss.
     */
    async purgeOldUsageRecords(): Promise<CleanupResult> {
        const supabase = createClient();

        const { data, error } = await supabase.rpc('cleanup_old_usage_records');

        if (error) {
            throw new Error(`Failed to purge old usage records: ${error.message}`);
        }

        return {
            recordsDeleted: data ?? 0,
            description: 'Old usage records purged',
            executedAt: new Date(),
        };
    }

    /**
     * Run all cleanup jobs sequentially.
     *
     * Returns an array of results for each cleanup operation.
     * Continues execution even if individual jobs fail.
     */
    async runAllCleanupJobs(): Promise<Array<CleanupResult | { error: string }>> {
        const results: Array<CleanupResult | { error: string }> = [];

        // Tombstoned deployments
        try {
            results.push(await this.purgeTombstonedDeployments());
        } catch (err: unknown) {
            results.push({
                error: err instanceof Error ? err.message : 'Unknown error purging tombstoned deployments',
            });
        }

        // Stale GitHub deployments
        try {
            results.push(await this.purgeStaleGitHubDeployments());
        } catch (err: unknown) {
            results.push({
                error: err instanceof Error ? err.message : 'Unknown error purging stale GitHub deployments',
            });
        }

        // Old analytics
        try {
            results.push(await this.purgeOldAnalytics());
        } catch (err: unknown) {
            results.push({
                error: err instanceof Error ? err.message : 'Unknown error purging old analytics',
            });
        }

        // Orphaned logs
        try {
            results.push(await this.purgeOrphanedLogs());
        } catch (err: unknown) {
            results.push({
                error: err instanceof Error ? err.message : 'Unknown error purging orphaned logs',
            });
        }

        // Old usage records
        try {
            results.push(await this.purgeOldUsageRecords());
        } catch (err: unknown) {
            results.push({
                error: err instanceof Error ? err.message : 'Unknown error purging old usage records',
            });
        }

        return results;
    }

    /**
     * Get recent cleanup job executions.
     *
     * @param limit - Maximum number of executions to return (default: 50)
     * @param jobName - Optional filter by job name
     */
    async getRecentExecutions(
        limit: number = 50,
        jobName?: string,
    ): Promise<CleanupJobExecution[]> {
        const supabase = createClient();

        let query = supabase
            .from('cleanup_job_executions')
            .select('*')
            .order('started_at', { ascending: false })
            .limit(limit);

        if (jobName) {
            query = query.eq('job_name', jobName);
        }

        const { data, error } = await query;

        if (error) {
            throw new Error(`Failed to get cleanup job executions: ${error.message}`);
        }

        return (data ?? []).map((row) => ({
            id: row.id,
            jobName: row.job_name,
            startedAt: new Date(row.started_at),
            completedAt: row.completed_at ? new Date(row.completed_at) : null,
            status: row.status as 'running' | 'succeeded' | 'failed',
            recordsDeleted: row.records_deleted,
            errorMessage: row.error_message,
        }));
    }

    /**
     * Get cleanup job health metrics.
     *
     * Returns aggregated statistics for each cleanup job over the last 30 days.
     */
    async getJobHealth(): Promise<CleanupJobHealth[]> {
        const supabase = createClient();

        const { data, error } = await supabase
            .from('cleanup_job_health')
            .select('*');

        if (error) {
            throw new Error(`Failed to get cleanup job health: ${error.message}`);
        }

        return (data ?? []).map((row) => ({
            jobName: row.job_name,
            totalExecutions: row.total_executions,
            successfulExecutions: row.successful_executions,
            failedExecutions: row.failed_executions,
            successRatePct: row.success_rate_pct,
            lastExecutionAt: row.last_execution_at ? new Date(row.last_execution_at) : null,
            avgRecordsDeleted: row.avg_records_deleted,
            maxRecordsDeleted: row.max_records_deleted,
        }));
    }

    /**
     * Get failed cleanup job executions for alerting.
     *
     * @param since - Only return failures since this date (default: last 24 hours)
     */
    async getFailedExecutions(since?: Date): Promise<CleanupJobExecution[]> {
        const supabase = createClient();

        const cutoff = since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);

        const { data, error } = await supabase
            .from('cleanup_job_executions')
            .select('*')
            .eq('status', 'failed')
            .gte('started_at', cutoff.toISOString())
            .order('started_at', { ascending: false });

        if (error) {
            throw new Error(`Failed to get failed executions: ${error.message}`);
        }

        return (data ?? []).map((row) => ({
            id: row.id,
            jobName: row.job_name,
            startedAt: new Date(row.started_at),
            completedAt: row.completed_at ? new Date(row.completed_at) : null,
            status: 'failed' as const,
            recordsDeleted: row.records_deleted,
            errorMessage: row.error_message,
        }));
    }
}

// ── Singleton export ──────────────────────────────────────────────────────────

export const cleanupService = new CleanupService();
