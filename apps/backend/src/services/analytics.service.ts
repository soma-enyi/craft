import { createClient } from '@/lib/supabase/server';

// ── In-memory summary cache (60-second TTL) ───────────────────────────────────
type CachedSummary = {
    value: Awaited<ReturnType<AnalyticsService['getAnalyticsSummary']>>;
    expiresAt: number;
};
const summaryCache = new Map<string, CachedSummary>();
const CACHE_TTL_MS = 60_000;

export class AnalyticsService {
    async recordPageView(deploymentId: string): Promise<void> {
        const supabase = createClient();
        await supabase.from('deployment_analytics').insert({
            deployment_id: deploymentId,
            metric_type: 'page_view',
            metric_value: 1,
        });
        summaryCache.delete(deploymentId);
    }

    async recordUptimeCheck(deploymentId: string, isUp: boolean): Promise<void> {
        const supabase = createClient();
        await supabase.from('deployment_analytics').insert({
            deployment_id: deploymentId,
            metric_type: 'uptime_check',
            metric_value: isUp ? 1 : 0,
        });
        summaryCache.delete(deploymentId);
    }

    async recordTransactionCount(deploymentId: string, count: number): Promise<void> {
        const supabase = createClient();
        await supabase.from('deployment_analytics').insert({
            deployment_id: deploymentId,
            metric_type: 'transaction_count',
            metric_value: count,
        });
        summaryCache.delete(deploymentId);
    }

    async getAnalytics(
        deploymentId: string,
        metricType?: string,
        startDate?: Date,
        endDate?: Date
    ): Promise<Array<{ id: string; metricType: string; metricValue: number; recordedAt: Date }>> {
        const supabase = createClient();

        let query = supabase
            .from('deployment_analytics')
            .select('*')
            .eq('deployment_id', deploymentId)
            .order('recorded_at', { ascending: false });

        if (metricType) query = query.eq('metric_type', metricType);
        if (startDate) query = query.gte('recorded_at', startDate.toISOString());
        if (endDate) query = query.lte('recorded_at', endDate.toISOString());

        const { data, error } = await query;
        if (error) throw new Error(`Failed to get analytics: ${error.message}`);

        return (data || []).map((row) => ({
            id: row.id,
            metricType: row.metric_type,
            metricValue: row.metric_value,
            recordedAt: new Date(row.recorded_at),
        }));
    }

    /**
     * Returns an aggregated summary using a single SQL GROUP BY pass via the
     * get_analytics_summary() database function (migration 011).  Results are
     * cached in-process for 60 seconds to reduce load for frequently-polled
     * deployments.
     */
    async getAnalyticsSummary(deploymentId: string): Promise<{
        totalPageViews: number;
        uptimePercentage: number;
        totalTransactions: number;
        lastChecked: Date | null;
    }> {
        const cached = summaryCache.get(deploymentId);
        if (cached && Date.now() < cached.expiresAt) {
            return cached.value;
        }

        const supabase = createClient();
        const { data, error } = await supabase.rpc('get_analytics_summary', {
            p_deployment_id: deploymentId,
        });

        if (error) throw new Error(`Failed to get analytics summary: ${error.message}`);

        const rows = (data ?? []) as Array<{
            metric_type: string;
            total_value: number;
            record_count: number;
            up_count: number;
            latest_recorded: string | null;
        }>;

        const byType = Object.fromEntries(rows.map((r) => [r.metric_type, r]));

        const pvRow = byType['page_view'];
        const utRow = byType['uptime_check'];
        const txRow = byType['transaction_count'];

        const totalPageViews = pvRow ? Number(pvRow.total_value) : 0;
        const totalTransactions = txRow ? Number(txRow.total_value) : 0;

        const uptimePercentage = utRow && utRow.record_count > 0
            ? Math.round((Number(utRow.up_count) / Number(utRow.record_count)) * 10_000) / 100
            : 100;

        const lastChecked = utRow?.latest_recorded ? new Date(utRow.latest_recorded) : null;

        const summary = { totalPageViews, uptimePercentage, totalTransactions, lastChecked };
        summaryCache.set(deploymentId, { value: summary, expiresAt: Date.now() + CACHE_TTL_MS });
        return summary;
    }

    async applyRetentionPolicy(retentionDays: number): Promise<number> {
        if (retentionDays === 0) return 0;

        const supabase = createClient();
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

        const { error, count } = await supabase
            .from('deployment_analytics')
            .delete()
            .lt('recorded_at', cutoff);

        if (error) throw new Error(`Failed to apply retention policy: ${error.message}`);
        return count ?? 0;
    }

    async exportAnalytics(deploymentId: string, startDate?: Date, endDate?: Date): Promise<string> {
        const analytics = await this.getAnalytics(deploymentId, undefined, startDate, endDate);

        const headers = ['Metric Type', 'Value', 'Recorded At'];
        const rows = analytics.map((row) => [
            row.metricType,
            row.metricValue.toString(),
            row.recordedAt.toISOString(),
        ]);

        return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    }
}

export const analyticsService = new AnalyticsService();
