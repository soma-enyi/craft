/**
 * POST /api/preview/access
 *
 * Issues a time-limited Vercel protection bypass token for a preview deployment.
 * Only authenticated users may request a token.
 *
 * Request body:
 *   { "deploymentId": "<vercel-deployment-id>" }
 *
 * Response (200):
 *   {
 *     "token": "<bypass-token>",
 *     "expiresAt": <unix-seconds>,
 *     "previewUrl": "<deployment-url>?x-vercel-protection-bypass=<token>"
 *   }
 *
 * Error responses:
 *   400 — missing or invalid deploymentId
 *   401 — not authenticated
 *   503 — bypass secret not configured
 *
 * Feature: vercel-preview-protection-rules
 * Issue: #656
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api/with-auth';
import { issueBypassToken } from '@/lib/vercel/preview-protection';

export const POST = withAuth(async (req: NextRequest) => {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const { deploymentId, deploymentUrl } = (body ?? {}) as {
        deploymentId?: string;
        deploymentUrl?: string;
    };

    if (!deploymentId || typeof deploymentId !== 'string') {
        return NextResponse.json(
            { error: 'deploymentId is required' },
            { status: 400 },
        );
    }

    try {
        const result = issueBypassToken(deploymentId);

        const previewUrl = deploymentUrl
            ? `${deploymentUrl}?${result.queryParam}`
            : undefined;

        return NextResponse.json({
            token: result.token,
            expiresAt: result.expiresAt,
            ...(previewUrl ? { previewUrl } : {}),
        });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Internal error';
        if (message.includes('VERCEL_PROTECTION_BYPASS_SECRET')) {
            return NextResponse.json(
                { error: 'Preview protection is not configured on this environment' },
                { status: 503 },
            );
        }
        return NextResponse.json({ error: message }, { status: 500 });
    }
});
