import { NextRequest, NextResponse } from 'next/server';
import { withRole } from '@/lib/api/with-role';
import { createClient } from '@/lib/supabase/server';

/**
 * GET /api/admin/analytics
 *
 * Aggregate platform analytics across all deployments. Admin role required.
 *
 * Query params:
 *   startDate  ISO 8601 date (optional)
 *   endDate    ISO 8601 date (optional)
 *   metricType string (optional)
 */
export const GET = withRole('admin', async (req: NextRequest) => {
    const { searchParams } = req.nextUrl;
    const metricType = searchParams.get('metricType') ?? undefined;
    const startDate = searchParams.get('startDate') ?? undefined;
    const endDate = searchParams.get('endDate') ?? undefined;

    const supabase = createClient();

    let query = supabase
        .from('deployment_analytics')
        .select('metric_type, metric_value, recorded_at, deployment_id');

    if (metricType) query = query.eq('metric_type', metricType);
    if (startDate) query = query.gte('recorded_at', new Date(startDate).toISOString());
    if (endDate) query = query.lte('recorded_at', new Date(endDate).toISOString());

    const { data, error } = await query.order('recorded_at', { ascending: false }).limit(1000);

    if (error) {
        return NextResponse.json(
            { error: 'Failed to fetch analytics', detail: error.message },
            { status: 500 }
        );
    }

    const totals: Record<string, number> = {};
    for (const row of data ?? []) {
        totals[row.metric_type] = (totals[row.metric_type] ?? 0) + row.metric_value;
    }

    return NextResponse.json({
        total: data?.length ?? 0,
        aggregates: totals,
        rows: data ?? [],
    });
});
