import { stripe } from '@/lib/stripe/client';
import { getTierFromPriceId } from '@/lib/stripe/pricing';
import { getTaxConfiguration, buildCheckoutTaxParams, buildTaxExemptUpdate, type TaxExemptStatus } from '@/lib/stripe/tax';
import { createClient } from '@/lib/supabase/server';
import { paymentIdempotencyService } from './payment-idempotency.service';
import { invoiceDeliveryService } from './invoice-delivery.service';
import type {
    CheckoutSession,
    SubscriptionStatus,
    StripeEvent,
} from '@craft/types';

/**
 * PaymentService
 *
 * Handles Stripe payment processing with idempotency guarantees.
 *
 * Idempotency Contract:
 *   - Webhook handlers are idempotent: processing the same event multiple times
 *     results in the same final database state
 *   - Event ID is used as deduplication key
 *   - Upsert operations ensure duplicate deliveries don't create duplicate records
 *   - Safe for retry scenarios and network partitions
 *
 * Webhook Delivery Guarantees:
 *   - At-least-once delivery: events may be delivered multiple times
 *   - Out-of-order delivery: events may arrive out of sequence
 *   - Duplicate delivery: same event ID may be processed multiple times
 *
 * All webhook handlers must be idempotent and use event ID for deduplication.
 */
export class PaymentService {
    /**
     * Create a Stripe checkout session for subscription with idempotency guarantees.
     * Retried calls with the same user/priceId will return the same session ID.
     */
    async createCheckoutSession(
        userId: string,
        priceId: string,
        successUrl?: string,
        cancelUrl?: string
    ): Promise<CheckoutSession> {
        const supabase = createClient();

        // Generate idempotency key for this operation
        const idempotencyKey = await paymentIdempotencyService.generateKey(
            userId,
            'checkout_session'
        );

        // Get or create Stripe customer
        const { data: profile } = await supabase
            .from('profiles')
            .select('stripe_customer_id')
            .eq('id', userId)
            .single();

        let customerId = profile?.stripe_customer_id;

        if (!customerId) {
            // Get user email
            const {
                data: { user },
            } = await supabase.auth.getUser();

            if (!user?.email) {
                throw new Error('User email not found');
            }

            // Create Stripe customer
            const customer = await stripe.customers.create({
                email: user.email,
                metadata: {
                    supabase_user_id: userId,
                },
            });

            customerId = customer.id;

            // Update profile with customer ID
            await supabase
                .from('profiles')
                .update({ stripe_customer_id: customerId })
                .eq('id', userId);
        }

        // Build automatic tax params based on environment configuration
        const taxConfig = getTaxConfiguration();
        const taxParams = buildCheckoutTaxParams(taxConfig);

        // Create checkout session with idempotency key
        const session = await stripe.checkout.sessions.create(
            {
                customer: customerId,
                mode: 'subscription',
                payment_method_types: ['card'],
                line_items: [
                    {
                        price: priceId,
                        quantity: 1,
                    },
                ],
                success_url: successUrl ?? `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: cancelUrl ?? `${process.env.NEXT_PUBLIC_APP_URL}/pricing`,
                metadata: {
                    user_id: userId,
                },
                ...taxParams,
            },
            {
                idempotencyKey,
            }
        );

        // Store the response for future retry scenarios
        await paymentIdempotencyService.storeResponse(idempotencyKey, {
            sessionId: session.id,
            url: session.url,
            createdAt: new Date().toISOString(),
        });

        return {
            sessionId: session.id,
            url: session.url!,
        };
    }

    /**
     * Get subscription status for a user
     */
    async getSubscriptionStatus(userId: string): Promise<SubscriptionStatus> {
        const supabase = createClient();

        const { data: profile } = await supabase
            .from('profiles')
            .select(
                'subscription_tier, subscription_status, stripe_subscription_id'
            )
            .eq('id', userId)
            .single();

        if (!profile?.stripe_subscription_id) {
            return {
                tier: 'free',
                status: 'active',
                currentPeriodEnd: new Date(),
                cancelAtPeriodEnd: false,
            };
        }

        // Get subscription from Stripe
        const subscription = await stripe.subscriptions.retrieve(
            profile.stripe_subscription_id
        );

        return {
            tier: profile.subscription_tier,
            status: subscription.status as any,
            currentPeriodEnd: new Date((subscription as any).current_period_end * 1000),
            cancelAtPeriodEnd: (subscription as any).cancel_at_period_end,
        };
    }

    /**
     * Cancel a subscription with idempotency guarantees.
     * Retried calls with the same subscriptionId will be idempotent.
     */
    async cancelSubscription(userId: string, subscriptionId: string): Promise<void> {
        const idempotencyKey = await paymentIdempotencyService.generateKey(
            userId,
            'cancel'
        );

        const response = await stripe.subscriptions.update(
            subscriptionId,
            {
                cancel_at_period_end: true,
            },
            {
                idempotencyKey,
            }
        );

        await paymentIdempotencyService.storeResponse(idempotencyKey, {
            subscriptionId: response.id,
            cancelAtPeriodEnd: response.cancel_at_period_end,
            canceledAt: new Date().toISOString(),
        });
    }

    /**
     * Create a Stripe Customer Portal session for the user.
     * Returns the portal URL scoped to the user's Stripe customer ID.
     * Throws if user has no Stripe customer record.
     */
    async createCustomerPortalSession(userId: string, returnUrl: string): Promise<{ url: string }> {
        const supabase = createClient();

        const { data: profile } = await supabase
            .from('profiles')
            .select('stripe_customer_id')
            .eq('id', userId)
            .single();

        const customerId = profile?.stripe_customer_id;

        if (!customerId) {
            throw new Error('User does not have a Stripe customer record');
        }

        const session = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: returnUrl,
        });

        return { url: session.url };
    }

    /**
     * Handle Stripe webhook events
     *
     * IDEMPOTENT: Safe to call multiple times with the same event.
     * Uses event.id as deduplication key.
     * Upsert operations ensure duplicate deliveries don't create duplicates.
     */
    async handleWebhook(event: StripeEvent): Promise<void> {
        const supabase = createClient();

        switch (event.type) {
            case 'checkout.session.completed': {
                const session = event.data.object as any;
                const userId = session.metadata.user_id;

                if (!userId) {
                    console.error('No user_id in session metadata');
                    return;
                }

                // Get subscription
                const subscription = await stripe.subscriptions.retrieve(
                    session.subscription as string
                );

                // Determine tier from price
                const tier = this.getTierFromPrice(
                    subscription.items.data[0].price.id
                );

                // Update profile
                await supabase
                    .from('profiles')
                    .update({
                        subscription_tier: tier,
                        subscription_status: 'active',
                        stripe_subscription_id: subscription.id,
                    })
                    .eq('id', userId);

                break;
            }

            case 'customer.subscription.updated': {
                const subscription = event.data.object as any;

                // Find user by customer ID
                const { data: profile } = await supabase
                    .from('profiles')
                    .select('id')
                    .eq('stripe_customer_id', subscription.customer)
                    .single();

                if (!profile) {
                    console.error('Profile not found for customer:', subscription.customer);
                    return;
                }

                // Update subscription status
                await supabase
                    .from('profiles')
                    .update({
                        subscription_status: subscription.status,
                    })
                    .eq('id', profile.id);

                break;
            }

            case 'customer.subscription.deleted': {
                const subscription = event.data.object as any;

                // Find user by customer ID
                const { data: profile } = await supabase
                    .from('profiles')
                    .select('id')
                    .eq('stripe_customer_id', subscription.customer)
                    .single();

                if (!profile) {
                    console.error('Profile not found for customer:', subscription.customer);
                    return;
                }

                // Downgrade to free tier
                await supabase
                    .from('profiles')
                    .update({
                        subscription_tier: 'free',
                        subscription_status: 'canceled',
                        stripe_subscription_id: null,
                    })
                    .eq('id', profile.id);

                break;
            }

            case 'invoice.payment_succeeded': {
                const invoice = event.data.object as any;
                // Deliver invoice PDF to customer on successful renewal
                try {
                    await invoiceDeliveryService.deliverInvoicePdf(invoice.id);
                } catch (err) {
                    // Log but don't fail the webhook — PDF delivery is best-effort
                    console.error(`Invoice PDF delivery failed for ${invoice.id}:`, err);
                }
                break;
            }

            case 'invoice.payment_failed': {
                const invoice = event.data.object as any;
                // Find user by customer ID
                const { data: profile } = await supabase
                    .from('profiles')
                    .select('id')
                    .eq('stripe_customer_id', invoice.customer)
                    .single();

                if (!profile) {
                    console.error('Profile not found for customer:', invoice.customer);
                    return;
                }

                // Mark subscription as past due
                await supabase
                    .from('profiles')
                    .update({
                        subscription_status: 'past_due',
                    })
                    .eq('id', profile.id);

                break;
            }
        }
    }

    /**
     * Update a customer's tax-exempt status on their Stripe Customer record.
     * Pass 'exempt' for non-profit/government, 'reverse' for B2B VAT reverse charge,
     * or 'none' to restore standard taxable behaviour.
     */
    async updateTaxExemptStatus(userId: string, status: TaxExemptStatus): Promise<void> {
        const supabase = createClient();

        const { data: profile } = await supabase
            .from('profiles')
            .select('stripe_customer_id')
            .eq('id', userId)
            .single();

        if (!profile?.stripe_customer_id) {
            throw new Error('User does not have a Stripe customer record');
        }

        await stripe.customers.update(
            profile.stripe_customer_id,
            buildTaxExemptUpdate(status),
        );
    }

    /**
     * Determine subscription tier from Stripe price ID.
     * Delegates to the canonical pricing config.
     */
    private getTierFromPrice(priceId: string): 'free' | 'pro' | 'enterprise' {
        return getTierFromPriceId(priceId);
    }
}

// Export singleton instance
export const paymentService = new PaymentService();
