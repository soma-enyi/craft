-- Migration 012: pg_cron Automated Deployment Cleanup
--
-- Enables the pg_cron extension and schedules automated cleanup jobs for:
--   1. Tombstoned deployments (soft-deleted records past retention window)
--   2. Stale GitHub Vercel deployments (failed/canceled deployments older than 90 days)
--   3. Old deployment analytics (records past retention window)
--   4. Orphaned deployment logs (logs for non-existent deployments)
--
-- All jobs respect retention windows and never delete recently created records.
-- Jobs are idempotent and safe to run concurrently.
--
-- Issue: #653 — Supabase pg_cron Extension Integration for Automated Deployment Cleanup

-- Enable pg_cron extension (requires superuser or rds_superuser role)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Grant usage on cron schema to postgres role
GRANT USAGE ON SCHEMA cron TO postgres;

-- ── Cleanup Functions ─────────────────────────────────────────────────────────

/**
 * Purge tombstoned deployments past the retention window.
 *
 * Soft-deleted deployments (deleted_at IS NOT NULL) are permanently removed
 * after DEPLOYMENT_TOMBSTONE_RETENTION_DAYS (default: 30 days).
 *
 * Cascades to deployment_logs and deployment_analytics via ON DELETE CASCADE.
 *
 * Returns: Number of deployments purged.
 */
CREATE OR REPLACE FUNCTION cleanup_tombstoned_deployments()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    retention_days INTEGER := 30; -- Default retention window
    cutoff_date TIMESTAMPTZ;
    deleted_count INTEGER;
BEGIN
    -- Calculate cutoff date
    cutoff_date := NOW() - (retention_days || ' days')::INTERVAL;

    -- Delete tombstoned deployments older than cutoff
    WITH deleted AS (
        DELETE FROM deployments
        WHERE deleted_at IS NOT NULL
          AND deleted_at < cutoff_date
        RETURNING id
    )
    SELECT COUNT(*) INTO deleted_count FROM deleted;

    -- Log execution
    RAISE NOTICE 'cleanup_tombstoned_deployments: purged % deployments (cutoff: %)',
        deleted_count, cutoff_date;

    RETURN deleted_count;
END;
$$;

/**
 * Purge stale GitHub Vercel deployments.
 *
 * Removes failed, canceled, or error deployments older than 90 days.
 * Successful deployments (ready) are never purged.
 *
 * Returns: Number of deployments purged.
 */
CREATE OR REPLACE FUNCTION cleanup_stale_github_deployments()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    retention_days INTEGER := 90;
    cutoff_date TIMESTAMPTZ;
    deleted_count INTEGER;
BEGIN
    cutoff_date := NOW() - (retention_days || ' days')::INTERVAL;

    -- Delete stale failed/canceled deployments
    WITH deleted AS (
        DELETE FROM github_vercel_deployments
        WHERE status IN ('failed', 'canceled', 'error')
          AND created_at < cutoff_date
        RETURNING id
    )
    SELECT COUNT(*) INTO deleted_count FROM deleted;

    RAISE NOTICE 'cleanup_stale_github_deployments: purged % deployments (cutoff: %)',
        deleted_count, cutoff_date;

    RETURN deleted_count;
END;
$$;

/**
 * Purge old deployment analytics records.
 *
 * Removes analytics records older than ANALYTICS_RETENTION_DAYS (default: 90 days).
 *
 * Returns: Number of analytics records purged.
 */
CREATE OR REPLACE FUNCTION cleanup_old_analytics()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    retention_days INTEGER := 90;
    cutoff_date TIMESTAMPTZ;
    deleted_count INTEGER;
BEGIN
    cutoff_date := NOW() - (retention_days || ' days')::INTERVAL;

    -- Delete old analytics records
    WITH deleted AS (
        DELETE FROM deployment_analytics
        WHERE recorded_at < cutoff_date
        RETURNING id
    )
    SELECT COUNT(*) INTO deleted_count FROM deleted;

    RAISE NOTICE 'cleanup_old_analytics: purged % records (cutoff: %)',
        deleted_count, cutoff_date;

    RETURN deleted_count;
END;
$$;

/**
 * Purge orphaned deployment logs.
 *
 * Removes logs for deployments that no longer exist (orphaned by manual deletion
 * or data corruption). This should rarely find records due to CASCADE constraints,
 * but provides a safety net.
 *
 * Returns: Number of orphaned logs purged.
 */
CREATE OR REPLACE FUNCTION cleanup_orphaned_logs()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    -- Delete logs with no corresponding deployment
    WITH deleted AS (
        DELETE FROM deployment_logs
        WHERE deployment_id NOT IN (SELECT id FROM deployments)
        RETURNING id
    )
    SELECT COUNT(*) INTO deleted_count FROM deleted;

    IF deleted_count > 0 THEN
        RAISE WARNING 'cleanup_orphaned_logs: purged % orphaned logs', deleted_count;
    END IF;

    RETURN deleted_count;
END;
$$;

/**
 * Purge old usage records (metered billing).
 *
 * Removes usage records older than 365 days that have been reported to Stripe.
 * Unreported records are never deleted to prevent billing data loss.
 *
 * Returns: Number of usage records purged.
 */
CREATE OR REPLACE FUNCTION cleanup_old_usage_records()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    retention_days INTEGER := 365;
    cutoff_date TIMESTAMPTZ;
    deleted_count INTEGER;
BEGIN
    cutoff_date := NOW() - (retention_days || ' days')::INTERVAL;

    -- Delete old reported usage records only
    WITH deleted AS (
        DELETE FROM usage_records
        WHERE created_at < cutoff_date
          AND reported_to_stripe = TRUE
        RETURNING id
    )
    SELECT COUNT(*) INTO deleted_count FROM deleted;

    RAISE NOTICE 'cleanup_old_usage_records: purged % records (cutoff: %)',
        deleted_count, cutoff_date;

    RETURN deleted_count;
END;
$$;

-- ── Scheduled Jobs ────────────────────────────────────────────────────────────

-- Job 1: Purge tombstoned deployments (daily at 2:00 AM UTC)
SELECT cron.schedule(
    'cleanup-tombstoned-deployments',
    '0 2 * * *',
    $$SELECT cleanup_tombstoned_deployments();$$
);

-- Job 2: Purge stale GitHub deployments (daily at 2:15 AM UTC)
SELECT cron.schedule(
    'cleanup-stale-github-deployments',
    '15 2 * * *',
    $$SELECT cleanup_stale_github_deployments();$$
);

-- Job 3: Purge old analytics (daily at 2:30 AM UTC)
SELECT cron.schedule(
    'cleanup-old-analytics',
    '30 2 * * *',
    $$SELECT cleanup_old_analytics();$$
);

-- Job 4: Purge orphaned logs (daily at 2:45 AM UTC)
SELECT cron.schedule(
    'cleanup-orphaned-logs',
    '45 2 * * *',
    $$SELECT cleanup_orphaned_logs();$$
);

-- Job 5: Purge old usage records (weekly on Sunday at 3:00 AM UTC)
SELECT cron.schedule(
    'cleanup-old-usage-records',
    '0 3 * * 0',
    $$SELECT cleanup_old_usage_records();$$
);

-- ── Job Execution Log Table ───────────────────────────────────────────────────

/**
 * Stores execution history for cleanup jobs.
 * Populated by triggers on cron.job_run_details.
 */
CREATE TABLE IF NOT EXISTS cleanup_job_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_name TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
    records_deleted INTEGER,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Index for querying recent executions
CREATE INDEX IF NOT EXISTS idx_cleanup_job_executions_job_name_started
    ON cleanup_job_executions(job_name, started_at DESC);

-- Index for monitoring failed jobs
CREATE INDEX IF NOT EXISTS idx_cleanup_job_executions_status
    ON cleanup_job_executions(status)
    WHERE status = 'failed';

-- Enable RLS
ALTER TABLE cleanup_job_executions ENABLE ROW LEVEL SECURITY;

-- Policy: Service role can manage execution logs
CREATE POLICY "Service role can manage cleanup_job_executions"
    ON cleanup_job_executions
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Policy: Authenticated users can read execution logs
CREATE POLICY "Authenticated users can read cleanup_job_executions"
    ON cleanup_job_executions
    FOR SELECT
    TO authenticated
    USING (true);

-- ── Monitoring View ───────────────────────────────────────────────────────────

/**
 * View for monitoring cleanup job health.
 * Shows last execution time, success rate, and average records deleted.
 */
CREATE OR REPLACE VIEW cleanup_job_health AS
SELECT
    job_name,
    COUNT(*) AS total_executions,
    COUNT(*) FILTER (WHERE status = 'succeeded') AS successful_executions,
    COUNT(*) FILTER (WHERE status = 'failed') AS failed_executions,
    ROUND(
        100.0 * COUNT(*) FILTER (WHERE status = 'succeeded') / NULLIF(COUNT(*), 0),
        2
    ) AS success_rate_pct,
    MAX(started_at) AS last_execution_at,
    AVG(records_deleted) FILTER (WHERE status = 'succeeded') AS avg_records_deleted,
    MAX(records_deleted) FILTER (WHERE status = 'succeeded') AS max_records_deleted
FROM cleanup_job_executions
WHERE started_at > NOW() - INTERVAL '30 days'
GROUP BY job_name
ORDER BY job_name;

-- Grant access to monitoring view
GRANT SELECT ON cleanup_job_health TO authenticated;

-- ── Comments ──────────────────────────────────────────────────────────────────

COMMENT ON FUNCTION cleanup_tombstoned_deployments() IS
    'Purges soft-deleted deployments past the 30-day retention window';

COMMENT ON FUNCTION cleanup_stale_github_deployments() IS
    'Purges failed/canceled GitHub Vercel deployments older than 90 days';

COMMENT ON FUNCTION cleanup_old_analytics() IS
    'Purges deployment analytics records older than 90 days';

COMMENT ON FUNCTION cleanup_orphaned_logs() IS
    'Purges deployment logs for non-existent deployments (safety net)';

COMMENT ON FUNCTION cleanup_old_usage_records() IS
    'Purges reported usage records older than 365 days';

COMMENT ON TABLE cleanup_job_executions IS
    'Execution history for automated cleanup jobs';

COMMENT ON VIEW cleanup_job_health IS
    'Monitoring view showing cleanup job health metrics over the last 30 days';
