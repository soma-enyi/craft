import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api/with-auth';
import { resolveIpAddress } from '@/lib/api/logger';

const RETENTION_DAYS = parseInt(process.env.DEPLOYMENT_TOMBSTONE_RETENTION_DAYS ?? '30', 10);

export const POST = withAuth(async (req: NextRequest, { params, user, supabase, log, correlationId }) => {
    const deploymentId = (params as { id: string }).id;
    const ipAddress = resolveIpAddress(req);

    // Fetch including tombstoned records so we can restore within the retention window.
    const { data: deployment, error: fetchError } = await supabase
        .from('deployments')
        .select('user_id, deleted_at')
        .eq('id', deploymentId)
        .not('deleted_at', 'is', null)
        .single();

    if (fetchError || !deployment) {
        return NextResponse.json({ error: 'Deployment not found or not deleted' }, { status: 404 });
    }

    if (deployment.user_id !== user.id) {
        return NextResponse.json({ error: 'Deployment not found or not deleted' }, { status: 404 });
    }

    // Enforce retention window — records past it are eligible only for purge.
    const deletedAt = new Date(deployment.deleted_at);
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    if (deletedAt < cutoff) {
        return NextResponse.json(
            { error: 'Deployment is outside the restore retention window', correlationId },
            { status: 410 }
        );
    }

    const { error: restoreError } = await supabase
        .from('deployments')
        .update({ deleted_at: null })
        .eq('id', deploymentId);

    if (restoreError) {
        log.error(`Restore failed for ${deploymentId}`, restoreError);
        return NextResponse.json(
            { error: 'Failed to restore deployment', correlationId },
            { status: 500 }
        );
    }

    log.audit({
        userId: user.id,
        action: 'deployment.restore',
        resourceId: deploymentId,
        resourceType: 'deployment',
        ipAddress,
        metadata: { deletedAt: deployment.deleted_at },
    });

    return NextResponse.json({ success: true, deploymentId });
});
