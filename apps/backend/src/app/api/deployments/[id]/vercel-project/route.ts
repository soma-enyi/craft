/**
 * POST /api/deployments/[id]/vercel-project
 *
 * Creates a Vercel project linked to the deployment's GitHub repository.
 * Reads `repository_url` and `name` from the deployment record, maps them
 * into a CreateVercelProjectRequest, and persists the resulting project ID.
 *
 * Authentication & ownership:
 *   Requires a valid session (401) and ownership of the deployment (403).
 *
 * Request body (all optional):
 *   {
 *     "framework":       string   — default "nextjs"
 *     "buildCommand":    string   — Turborepo build command override
 *     "outputDirectory": string   — output directory override
 *   }
 *
 * Responses:
 *   201 — Project created: { vercelProjectId, vercelProjectName, vercelProjectUrl }
 *   400 — Invalid JSON or request body
 *   401 — Not authenticated
 *   403 — Not authorized for this deployment
 *   404 — Deployment not found or missing repository_url
 *   409 — Vercel project name collision
 *   429 — Vercel rate limit exceeded (Retry-After header set)
 *   500 — Auth failure, network error, or unexpected error
 *
 * Issue: #088
 */

import { NextRequest, NextResponse } from 'next/server';
import { withDeploymentAuth } from '@/lib/api/with-auth';
import { vercelService } from '@/services/vercel.service';
import { buildVercelEnvVars } from '@/lib/env/env-template-generator';
import { mapCategoryToFamily } from '@/services/template-generator.service';
import type { TemplateCategory } from '@craft/types';

interface RequestBody {
    framework?: string;
    buildCommand?: string;
    outputDirectory?: string;
}

function normalizeBody(raw: unknown): RequestBody | null {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const b = raw as Record<string, unknown>;
    if ('framework' in b && typeof b.framework !== 'string') return null;
    if ('buildCommand' in b && typeof b.buildCommand !== 'string') return null;
    if ('outputDirectory' in b && typeof b.outputDirectory !== 'string') return null;
    return b as RequestBody;
}

export const POST = withDeploymentAuth(async (req: NextRequest, { params, supabase }) => {
    const deploymentId = params.id;

    // Validate Vercel token scopes before attempting deployment
    const tokenValidation = await vercelService.validateTokenScopes();
    if (!tokenValidation.valid) {
        return NextResponse.json(
            {
                error: tokenValidation.error ?? 'Vercel token validation failed',
                missingScope: tokenValidation.missingScope,
            },
            { status: 401 },
        );
    }

    let body: RequestBody = {};
    try {
        const raw = await req.json();
        const normalized = normalizeBody(raw);
        if (normalized === null) {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
        }
        body = normalized;
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    // Load deployment + template category for env var generation
    const { data: deployment, error: fetchError } = await supabase
        .from('deployments')
        .select('name, repository_url, customization_config, template_id')
        .eq('id', deploymentId)
        .single();

    if (fetchError || !deployment) {
        return NextResponse.json({ error: 'Deployment not found' }, { status: 404 });
    }

    if (!deployment.repository_url) {
        return NextResponse.json(
            { error: 'Deployment has no repository — create the GitHub repository first' },
            { status: 404 },
        );
    }

    // Derive the repo slug ("owner/repo") from the stored URL
    const repoUrl = deployment.repository_url as string;
    const repoFullName = repoUrl.replace('https://github.com/', '');

    // Resolve template family for env var generation (best-effort)
    let envVars: ReturnType<typeof buildVercelEnvVars> = [];
    try {
        const { data: tmpl } = await supabase
            .from('templates')
            .select('category')
            .eq('id', deployment.template_id as string)
            .single();

        if (tmpl?.category) {
            const family = mapCategoryToFamily(tmpl.category as TemplateCategory);
            envVars = buildVercelEnvVars(family, deployment.customization_config as never);
        }
    } catch {
        // Non-fatal — deploy without env vars rather than blocking
    }

    try {
        const project = await vercelService.createProject({
            name: `craft-${(deployment.name as string).toLowerCase().replace(/[^a-z0-9-]/g, '-')}`,
            gitRepo: repoFullName,
            envVars,
            framework: body.framework ?? 'nextjs',
            buildCommand: body.buildCommand,
            outputDirectory: body.outputDirectory,
        });

        // Persist the Vercel project ID and advance status
        await supabase
            .from('deployments')
            .update({
                vercel_project_id: project.id,
                status: 'deploying',
                updated_at: new Date().toISOString(),
            })
            .eq('id', deploymentId);

        return NextResponse.json(
            {
                vercelProjectId: project.id,
                vercelProjectName: project.name,
                vercelProjectUrl: `https://${project.url}`,
            },
            { status: 201 },
        );
    } catch (err: unknown) {
        const svcErr = err as { code?: string; message?: string; retryAfterMs?: number };

        await supabase
            .from('deployments')
            .update({
                status: 'failed',
                error_message: svcErr.message ?? 'Vercel project creation failed',
                updated_at: new Date().toISOString(),
            })
            .eq('id', deploymentId);

        if (svcErr.code === 'PROJECT_EXISTS') {
            return NextResponse.json({ error: svcErr.message }, { status: 409 });
        }

        if (svcErr.code === 'RATE_LIMITED') {
            const res = NextResponse.json(
                { error: 'Vercel API rate limit exceeded — check Retry-After header' },
                { status: 429 },
            );
            if (svcErr.retryAfterMs) {
                res.headers.set('Retry-After', String(Math.ceil(svcErr.retryAfterMs / 1000)));
            }
            return res;
        }

        return NextResponse.json(
            { error: svcErr.message ?? 'Vercel project creation failed' },
            { status: 500 },
        );
    }
});
