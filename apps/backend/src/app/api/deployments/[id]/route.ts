import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api/with-auth';
import { githubService } from '@/services/github.service';
import { vercelService } from '@/services/vercel.service';
import { resolveIpAddress } from '@/lib/api/logger';

export const GET = withAuth(async (req: NextRequest, { params, user, supabase, log }) => {
    const deploymentId = (params as { id: string }).id;
    const ipAddress = resolveIpAddress(req);

    const { data: deployment, error: fetchError } = await supabase
        .from('deployments')
        .select('*')
        .eq('id', deploymentId)
        .is('deleted_at', null)
        .single();

    if (fetchError || !deployment) {
        return NextResponse.json({ error: 'Deployment not found' }, { status: 404 });
    }

    if (deployment.user_id !== user.id) {
        return NextResponse.json({ error: 'Deployment not found' }, { status: 404 });
    }

    log.audit({
        userId: user.id,
        action: 'deployment.read',
        resourceId: deploymentId,
        resourceType: 'deployment',
        ipAddress,
        metadata: { fields: ['customization_config'] },
    });

    const response = {
        id: deployment.id,
        name: deployment.name,
        status: deployment.status,
        templateId: deployment.template_id,
        vercelProjectId: deployment.vercel_project_id,
        deploymentUrl: deployment.deployment_url,
        repositoryUrl: deployment.repository_url,
        customizationConfig: deployment.customization_config,
        errorMessage: deployment.error_message,
        timestamps: {
            created: deployment.created_at,
            updated: deployment.updated_at,
            deployed: deployment.deployed_at,
        },
    };

    return NextResponse.json(response);
});

export const DELETE = withAuth(async (req: NextRequest, { params, user, supabase, log, correlationId }) => {
    const deploymentId = (params as { id: string }).id;
    const ipAddress = resolveIpAddress(req);

    const { data: deployment, error: fetchError } = await supabase
        .from('deployments')
        .select('user_id, repository_url, vercel_project_id')
        .eq('id', deploymentId)
        .is('deleted_at', null)
        .single();

    if (fetchError || !deployment) {
        return NextResponse.json({ error: 'Deployment not found' }, { status: 404 });
    }

    if (deployment.user_id !== user.id) {
        return NextResponse.json({ error: 'Deployment not found' }, { status: 404 });
    }

    log.audit({
        userId: user.id,
        action: 'deployment.delete',
        resourceId: deploymentId,
        resourceType: 'deployment',
        ipAddress,
        metadata: {
            repository_url: deployment.repository_url,
            vercel_project_id: deployment.vercel_project_id,
        },
    });

    // Best-effort cleanup of external resources.  Errors are non-fatal.
    if (deployment.repository_url) {
        try {
            const urlMatch = deployment.repository_url.match(/github\.com\/([^/]+)\/([^/]+)/);
            if (urlMatch) {
                const [, owner, repo] = urlMatch;
                await githubService.deleteRepository(owner, repo);
            }
        } catch (error: unknown) {
            log.error(`GitHub cleanup failed for ${deploymentId}`, error);
        }
    }

    if (deployment.vercel_project_id) {
        try {
            await vercelService.deleteProject(deployment.vercel_project_id);
        } catch (error: unknown) {
            log.error(`Vercel cleanup failed for ${deploymentId}`, error);
        }
    }

    // Soft-delete: stamp the tombstone timestamp rather than hard-deleting.
    const { error: deleteError } = await supabase
        .from('deployments')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', deploymentId);

    if (deleteError) {
        log.error(`Soft-delete failed for ${deploymentId}`, deleteError);
        return NextResponse.json(
            { error: 'Failed to delete deployment', correlationId },
            { status: 500 }
        );
    }

    return NextResponse.json({ success: true, deploymentId });
});
