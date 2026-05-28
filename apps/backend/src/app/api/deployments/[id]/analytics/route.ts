import { NextRequest, NextResponse } from 'next/server';
import { withDeploymentAuth } from '@/lib/api/with-auth';
import { analyticsService } from '@/services/analytics.service';

export const GET = withDeploymentAuth(async (req: NextRequest, { params, log, correlationId }) => {
    try {
        const searchParams = req.nextUrl.searchParams;
        const metricType = searchParams.get('metricType') || undefined;
        const startDate = searchParams.get('startDate') ? new Date(searchParams.get('startDate')!) : undefined;
        const endDate = searchParams.get('endDate') ? new Date(searchParams.get('endDate')!) : undefined;

        const [analytics, summary] = await Promise.all([
            analyticsService.getAnalytics(params.id, metricType, startDate, endDate),
            analyticsService.getAnalyticsSummary(params.id),
        ]);

        return NextResponse.json({ analytics, summary });
    } catch (error: any) {
        log.error('Failed to get analytics', error, { deploymentId: params.id });
        return NextResponse.json(
            { error: error.message || 'Failed to get analytics', correlationId },
            { status: 500 }
        );
    }
});
