import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuth } from '@/lib/api/with-auth';
import { paymentService } from '@/services/payment.service';

const portalSchema = z.object({
    returnUrl: z.string().url(),
});

/**
 * POST /api/payments/portal
 * Creates a Stripe Customer Portal session for the authenticated user.
 * Scoped to the user's Stripe customer ID.
 * Returns { url } on success.
 *
 * Auth: Required (401 if not authenticated)
 * Returns 404 if user has no Stripe customer record.
 */
export const POST = withAuth(async (req: NextRequest, { user }) => {
    const body = await req.json();
    const parsed = portalSchema.safeParse(body);

    if (!parsed.success) {
        return NextResponse.json(
            { error: 'Invalid input', details: parsed.error.flatten().fieldErrors },
            { status: 400 }
        );
    }

    try {
        const result = await paymentService.createCustomerPortalSession(
            user.id,
            parsed.data.returnUrl
        );
        return NextResponse.json(result);
    } catch (error: any) {
        console.error('Error creating portal session:', error);
        const isCustomerNotFound = error.message.includes('does not have a Stripe customer record');
        return NextResponse.json(
            { error: error.message || 'Failed to create portal session' },
            { status: isCustomerNotFound ? 404 : 500 }
        );
    }
});
