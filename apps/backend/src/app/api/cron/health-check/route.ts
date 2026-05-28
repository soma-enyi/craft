import { NextRequest, NextResponse } from 'next/server';
import { healthMonitorService } from '@/services/health-monitor.service';
import { VercelService } from '@/services/vercel.service';
import { createClient } from '@/lib/supabase/server';

const DEPENDENCY_TIMEOUT_MS = 5000;

type DependencyStatus = 'healthy' | 'degraded' | 'down';

interface DependencyResult {
    status: DependencyStatus;
    responseTimeMs: number;
    error?: string;
}

interface HealthGraph {
    overall: DependencyStatus;
    checkedAt: string;
    dependencies: {
        database: DependencyResult;
        stellar: DependencyResult;
        vercel: DependencyResult;
        stripe: DependencyResult;
    };
}

async function timed<T>(
    fn: () => Promise<T>,
    timeoutMs: number
): Promise<{ result?: T; responseTimeMs: number; error?: string }> {
    const start = Date.now();
    try {
        const result = await Promise.race([
            fn(),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Dependency check timed out')), timeoutMs)
            ),
        ]);
        return { result, responseTimeMs: Date.now() - start };
    } catch (err: any) {
        return { responseTimeMs: Date.now() - start, error: err?.message ?? 'Unknown error' };
    }
}

async function checkDatabase(): Promise<DependencyResult> {
    const { responseTimeMs, error } = await timed(async () => {
        const supabase = createClient();
        const { error: dbError } = await supabase.from('profiles').select('id').limit(1);
        if (dbError) throw new Error(dbError.message);
    }, DEPENDENCY_TIMEOUT_MS);

    return {
        status: error ? 'down' : 'healthy',
        responseTimeMs,
        ...(error ? { error } : {}),
    };
}

async function checkStellar(): Promise<DependencyResult> {
    const horizonUrl = process.env.NEXT_PUBLIC_HORIZON_URL || 'https://horizon-testnet.stellar.org';
    const { responseTimeMs, error } = await timed(async () => {
        const res = await fetch(`${horizonUrl}`, {
            method: 'HEAD',
            signal: AbortSignal.timeout(DEPENDENCY_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`Stellar Horizon returned ${res.status}`);
    }, DEPENDENCY_TIMEOUT_MS);

    return {
        status: error ? 'down' : 'healthy',
        responseTimeMs,
        ...(error ? { error } : {}),
    };
}

async function checkVercel(): Promise<DependencyResult> {
    const token = process.env.VERCEL_TOKEN;
    const { responseTimeMs, error } = await timed(async () => {
        if (!token) throw new Error('VERCEL_TOKEN not configured');
        const res = await fetch('https://api.vercel.com/v2/user', {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(DEPENDENCY_TIMEOUT_MS),
        });
        if (res.status === 401) throw new Error('Vercel token invalid');
        if (!res.ok) throw new Error(`Vercel API returned ${res.status}`);
    }, DEPENDENCY_TIMEOUT_MS);

    return {
        status: error
            ? error.includes('not configured')
                ? 'degraded'
                : 'down'
            : 'healthy',
        responseTimeMs,
        ...(error ? { error } : {}),
    };
}

async function checkStripe(): Promise<DependencyResult> {
    const { responseTimeMs, error } = await timed(async () => {
        const { stripe } = await import('@/lib/stripe/client');
        await stripe.balance.retrieve();
    }, DEPENDENCY_TIMEOUT_MS);

    return {
        status: error ? 'down' : 'healthy',
        responseTimeMs,
        ...(error ? { error } : {}),
    };
}

function aggregateStatus(results: DependencyResult[]): DependencyStatus {
    if (results.some((r) => r.status === 'down')) return 'down';
    if (results.some((r) => r.status === 'degraded')) return 'degraded';
    return 'healthy';
}

/**
 * GET /api/cron/health-check
 *
 * Reports health of all system dependencies as a structured dependency graph.
 * Returns 503 when critical dependencies (database) are down.
 */
export async function GET(req: NextRequest) {
    const authHeader = req.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const [database, stellar, vercel, stripe] = await Promise.all([
        checkDatabase(),
        checkStellar(),
        checkVercel(),
        checkStripe(),
    ]);

    const graph: HealthGraph = {
        overall: aggregateStatus([database, stellar, vercel, stripe]),
        checkedAt: new Date().toISOString(),
        dependencies: { database, stellar, vercel, stripe },
    };

    // Also run the existing per-deployment health checks.
    let deploymentResults: Awaited<ReturnType<typeof healthMonitorService.checkAllDeployments>> = [];
    try {
        deploymentResults = await healthMonitorService.checkAllDeployments();
    } catch {
        // Non-critical; don't let it block the dependency graph response.
    }

    const unhealthyCount = deploymentResults.filter((r) => !r.isHealthy).length;

    const isCriticalDown = database.status === 'down';
    const httpStatus = isCriticalDown ? 503 : 200;

    return NextResponse.json(
        {
            ...graph,
            vercelCircuitState: new VercelService().breaker.currentState,
            deployments: {
                totalChecked: deploymentResults.length,
                unhealthyCount,
                results: deploymentResults,
            },
        },
        { status: httpStatus }
    );
}
