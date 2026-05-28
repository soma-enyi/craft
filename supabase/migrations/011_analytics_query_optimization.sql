-- Migration 011: Analytics Query Optimization
--
-- Adds composite indexes to accelerate the deployment analytics aggregation
-- queries and replaces the previous N+1 per-metric-type scan pattern with a
-- single GROUP BY aggregation via a SECURITY DEFINER function callable through
-- the Supabase RPC interface.

-- Composite index: covers the GROUP BY aggregation query (deployment_id, metric_type)
-- and the metric_value column used in uptime percentage calculation.
CREATE INDEX IF NOT EXISTS idx_analytics_deployment_metric
    ON deployment_analytics(deployment_id, metric_type, metric_value);

-- Index for time-range filtered queries (used by getAnalytics with date bounds).
CREATE INDEX IF NOT EXISTS idx_analytics_deployment_recorded_at
    ON deployment_analytics(deployment_id, recorded_at DESC);

-- Aggregate function: replaces the three per-metric-type SELECT queries in
-- getAnalyticsSummary with a single pass over the table.
CREATE OR REPLACE FUNCTION get_analytics_summary(p_deployment_id UUID)
RETURNS TABLE(
    metric_type      TEXT,
    total_value      NUMERIC,
    record_count     BIGINT,
    up_count         BIGINT,
    latest_recorded  TIMESTAMPTZ
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
AS $$
    SELECT
        metric_type,
        SUM(metric_value)                                    AS total_value,
        COUNT(*)                                             AS record_count,
        COUNT(*) FILTER (WHERE metric_value = 1)             AS up_count,
        MAX(recorded_at)                                     AS latest_recorded
    FROM deployment_analytics
    WHERE deployment_id = p_deployment_id
    GROUP BY metric_type;
$$;
