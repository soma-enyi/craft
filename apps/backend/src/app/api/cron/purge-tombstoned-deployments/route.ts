import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * Cron: permanently purge tombstoned deployments past the retention window.
 *
 * Soft-deleted (tombstoned) deployments are archived with a deleted_at timestamp.
 * After DEPLOYMENT_TOMBSTONE_RETENTION_DAYS (default: 30) they are permanently
 * removed by this job, along with their cascaded deployment_logs and
 * deployment_analytics rows.
 *
 * Scheduled daily via vercel.json.  Protected by CRON_SECRET.
 */
export async function GET(req: NextRequest) {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && req.headers.get('authorization') !== `Bearer ${cronSecret}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const retentionDays = parseInt(process.env.DEPLOYMENT_TOMBSTONE_RETENTION_DAYS ?? '30', 10);
    if (retentionDays === 0) {
        return NextResponse.json({ purged: 0, message: 'Retention disabled' });
    }

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const supabase = createClient();

    const { error, count } = await supabase
        .from('deployments')
        .delete({ count: 'exact' })
        .not('deleted_at', 'is', null)
        .lt('deleted_at', cutoff);

    if (error) {
        console.error('Tombstone purge failed:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ purged: count ?? 0 });
}
