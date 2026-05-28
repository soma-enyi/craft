import { NextRequest, NextResponse } from 'next/server';
import { withRole } from '@/lib/api/with-role';
import { webhookDLQ } from '@/lib/webhook-dlq/dead-letter-queue';

/**
 * GET /api/admin/webhooks/dlq
 * List all dead-letter queue entries (admin only).
 */
export const GET = withRole('admin', async (_req: NextRequest) => {
    const entries = webhookDLQ.list();
    return NextResponse.json({ total: entries.length, entries });
});

/**
 * POST /api/admin/webhooks/dlq/:id/reprocess
 * Reprocess a single DLQ entry by id, passed in the request body.
 *
 * Body: { id: string }
 */
export const POST = withRole('admin', async (req: NextRequest) => {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const id = (body as Record<string, unknown>)?.id;
    if (!id || typeof id !== 'string') {
        return NextResponse.json({ error: 'Missing required field: id' }, { status: 400 });
    }

    const entry = webhookDLQ.get(id);
    if (!entry) {
        return NextResponse.json({ error: 'DLQ entry not found' }, { status: 404 });
    }

    const result = await webhookDLQ.reprocess(id);

    if (!result.success) {
        return NextResponse.json(
            { error: result.error, entry: webhookDLQ.get(id) },
            { status: 422 }
        );
    }

    return NextResponse.json({ success: true, entry: webhookDLQ.get(id) });
});
