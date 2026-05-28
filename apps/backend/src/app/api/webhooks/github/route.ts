import { NextRequest, NextResponse } from 'next/server';
import { verifyGitHubWebhookSignature } from '@/lib/github/webhook-verification';
import { createLogger, resolveCorrelationId, CORRELATION_ID_HEADER } from '@/lib/api/logger';
import { webhookDLQ } from '@/lib/webhook-dlq/dead-letter-queue';

const SUPPORTED_EVENTS = new Set([
    'push',
    'ping',
]);

const MAX_ATTEMPTS = 3;

// Register a reprocessing handler so DLQ entries can be retried via the admin endpoint.
webhookDLQ.registerProcessor('github', async (entry) => {
    const payload = JSON.parse(entry.payload);
    if (entry.eventType === 'push') {
        const log = createLogger({ correlationId: 'dlq-reprocess', service: 'github-webhook' });
        await handlePushEvent(payload, log);
    }
});

/**
 * POST /api/webhooks/github
 *
 * Receives GitHub webhook events, verifies the signature, and triggers
 * Vercel deployments for push events to configured branches.
 *
 * Security:
 *   - Verifies x-hub-signature-256 header using HMAC-SHA256
 *   - Uses timing-safe comparison to prevent timing attacks
 *   - Returns 401 for invalid signatures
 *   - Returns 200 for all successfully verified events (including unsupported types)
 *
 * Supported events:
 *   - push: Triggers Vercel deployment for configured branch
 *   - ping: Acknowledges webhook configuration
 *
 * Returns 200 for all successfully verified events so GitHub does not retry unnecessarily.
 */
export async function POST(req: NextRequest) {
    const correlationId = resolveCorrelationId(req);
    const log = createLogger({ correlationId, service: 'github-webhook' });

    // 1. Extract signature and body
    const signature = req.headers.get('x-hub-signature-256');
    const eventType = req.headers.get('x-github-event');
    const deliveryId = req.headers.get('x-github-delivery');

    log.info('GitHub webhook received', { eventType, deliveryId });

    // 2. Get webhook secret
    const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

    if (!webhookSecret) {
        log.error('GITHUB_WEBHOOK_SECRET is not configured');
        return NextResponse.json(
            { error: 'Webhook secret not configured' },
            { status: 500 }
        );
    }

    // 3. Read raw body for signature verification
    const body = await req.text();

    // 4. Verify signature
    if (!verifyGitHubWebhookSignature(body, signature, webhookSecret)) {
        log.warn('Invalid webhook signature', { signature: signature?.substring(0, 20) + '...' });
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    log.info('Webhook signature verified', { eventType, deliveryId });

    // 5. Parse JSON body
    let payload: unknown;
    try {
        payload = JSON.parse(body);
    } catch (err) {
        log.error('Failed to parse webhook payload', err);
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    // 6. Route to handler based on event type
    if (!eventType) {
        log.warn('Missing x-github-event header');
        return NextResponse.json({ error: 'Missing x-github-event header' }, { status: 400 });
    }

    if (!SUPPORTED_EVENTS.has(eventType)) {
        log.info('Unsupported event type acknowledged', { eventType });
        const res = NextResponse.json({ received: true, processed: false });
        res.headers.set(CORRELATION_ID_HEADER, correlationId);
        return res;
    }

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            if (eventType === 'push') {
                await handlePushEvent(payload, log);
            } else if (eventType === 'ping') {
                log.info('Ping event received');
            }
            const res = NextResponse.json({ received: true, processed: true });
            res.headers.set(CORRELATION_ID_HEADER, correlationId);
            return res;
        } catch (error: any) {
            lastError = error;
            log.error(`Webhook attempt ${attempt}/${MAX_ATTEMPTS} failed`, error);
        }
    }

    webhookDLQ.capture('github', eventType, body, lastError?.message ?? 'Unknown error', MAX_ATTEMPTS);
    // Return 200 so GitHub stops retrying — the event is safely in the DLQ.
    const res = NextResponse.json({ received: true, processed: false, dlq: true });
    res.headers.set(CORRELATION_ID_HEADER, correlationId);
    return res;
}

/**
 * Handles GitHub push events and triggers Vercel deployment.
 *
 * @param payload - GitHub push event payload
 * @param log - Logger instance
 */
async function handlePushEvent(payload: unknown, log: ReturnType<typeof createLogger>) {
    const push = payload as {
        ref?: string;
        repository?: {
            full_name?: string;
            name?: string;
        };
        head_commit?: {
            id?: string;
            message?: string;
            timestamp?: string;
        };
        pusher?: {
            name?: string;
            email?: string;
        };
    };

    const branch = push.ref?.replace('refs/heads/', '');
    const repoFullName = push.repository?.full_name;
    const repoName = push.repository?.name;
    const commitSha = push.head_commit?.id;
    const commitMessage = push.head_commit?.message;
    const pusherName = push.pusher?.name;

    log.info('Push event details', {
        branch,
        repoFullName,
        repoName,
        commitSha: commitSha?.substring(0, 7),
        commitMessage,
        pusherName,
    });

    // Check if push is to configured branch (default: main)
    const configuredBranch = process.env.GITHUB_DEPLOYMENT_BRANCH || 'main';

    if (branch !== configuredBranch) {
        log.info('Push not to configured branch, skipping deployment', {
            branch,
            configuredBranch,
        });
        return;
    }

    // Import services dynamically to avoid circular dependencies
    const { githubToVercelDeploymentService } = await import('@/services/github-to-vercel-deployment.service');

    // Trigger Vercel deployment
    log.info('Triggering Vercel deployment', {
        repoFullName,
        commitSha: commitSha?.substring(0, 7),
    });

    const result = await githubToVercelDeploymentService.triggerDeployment({
        repoFullName: repoFullName || '',
        repoName: repoName || '',
        branch: branch || '',
        commitSha: commitSha || '',
        commitMessage: commitMessage || '',
        pusherName: pusherName || '',
    });

    if (result.success) {
        log.info('Vercel deployment triggered successfully', {
            deploymentId: result.deploymentId,
            deploymentUrl: result.deploymentUrl,
        });
    } else {
        log.error('Failed to trigger Vercel deployment', undefined, {
            error: result.errorMessage,
        });
        throw new Error(result.errorMessage || 'Failed to trigger deployment');
    }
}
