import { NextRequest, NextResponse } from 'next/server';
import { stripe } from '@/lib/stripe/client';
import { paymentService } from '@/services/payment.service';
import { webhookDLQ } from '@/lib/webhook-dlq/dead-letter-queue';

const SUPPORTED_EVENTS = new Set([
    'checkout.session.completed',
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'invoice.payment_succeeded',
    'invoice.payment_failed',
]);

const MAX_ATTEMPTS = 3;

// Register a reprocessing handler so DLQ entries can be retried via the admin endpoint.
webhookDLQ.registerProcessor('stripe', async (entry) => {
    const parsed = JSON.parse(entry.payload);
    if (!SUPPORTED_EVENTS.has(parsed.type)) return;
    await paymentService.handleWebhook(parsed);
});

/**
 * POST /api/webhooks/stripe
 *
 * Receives Stripe webhook events, verifies the signature, and delegates
 * to the payment service. Returns 200 for all successfully verified events
 * (including unsupported types) so Stripe does not retry unnecessarily.
 *
 * Failed events that exceed MAX_ATTEMPTS are captured in the DLQ.
 */
export async function POST(req: NextRequest) {
    const body = await req.text();
    const signature = req.headers.get('stripe-signature');

    if (!signature) {
        return NextResponse.json(
            { error: 'Missing stripe-signature header' },
            { status: 400 }
        );
    }

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
        console.error('STRIPE_WEBHOOK_SECRET is not set');
        return NextResponse.json(
            { error: 'Webhook secret not configured' },
            { status: 500 }
        );
    }

    let event;

    try {
        event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
    } catch (err: any) {
        console.error('Webhook signature verification failed:', err.message);
        return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
    }

    if (!SUPPORTED_EVENTS.has(event.type)) {
        return NextResponse.json({ received: true });
    }

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            await paymentService.handleWebhook(event);
            return NextResponse.json({ received: true });
        } catch (error: any) {
            lastError = error;
            console.error(`Stripe webhook attempt ${attempt}/${MAX_ATTEMPTS} failed:`, error);
        }
    }

    webhookDLQ.capture('stripe', event.type, body, lastError?.message ?? 'Unknown error', MAX_ATTEMPTS);
    // Return 200 so Stripe stops retrying — the event is safely in the DLQ.
    return NextResponse.json({ received: true, dlq: true });
}
