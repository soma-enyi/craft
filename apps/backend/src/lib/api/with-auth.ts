import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '../supabase/server';
import { canConfigureCustomDomain } from '../stripe/pricing';
import {
    withLogging,
    CORRELATION_ID_HEADER,
    type Logger,
} from './logger';
import type { User } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SubscriptionTier } from '@craft/types';

export type AuthedRouteContext = {
    user: User;
    supabase: SupabaseClient;
    correlationId: string;
    log: Logger;
};

type RouteHandler<TParams = {}> = (
    req: NextRequest,
    ctx: AuthedRouteContext & { params: TParams }
) => Promise<NextResponse>;

/**
 * Wraps a route handler with Supabase session authentication.
 * Returns 401 if the user is not authenticated.
 * Attaches a correlation ID and logger to the context via withLogging.
 */
export function withAuth<TParams = {}>(handler: RouteHandler<TParams>) {
    return withLogging<TParams>(async (req, { params, correlationId, log }) => {
        const supabase = createClient();
        const { data: { user }, error } = await supabase.auth.getUser();

        if (error || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        return handler(req, { user, supabase, correlationId, log, params });
    });
}

/**
 * Wraps a route handler with auth + deployment ownership check.
 * Returns 401 if unauthenticated, 403 if the deployment doesn't belong to the user.
 * Requires `params.id` to be the deployment ID.
 */
export function withDeploymentAuth<TParams extends { id: string }>(
    handler: RouteHandler<TParams>
) {
    return withAuth<TParams>(async (req, ctx) => {
        const { data: deployment } = await ctx.supabase
            .from('deployments')
            .select('user_id')
            .eq('id', ctx.params.id)
            .is('deleted_at', null)
            .single();

        if (!deployment || deployment.user_id !== ctx.user.id) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        return handler(req, ctx);
    });
}

/**
 * Wraps a route handler with auth + deployment ownership + custom-domain tier check.
 * Returns 403 with an upgrade prompt if the user's subscription tier does not
 * include custom domain support (i.e. free tier).
 * Requires `params.id` to be the deployment ID.
 */
export function withDomainTierCheck<TParams extends { id: string }>(
    handler: RouteHandler<TParams>
) {
    return withDeploymentAuth<TParams>(async (req, ctx) => {
        const { data: profile } = await ctx.supabase
            .from('profiles')
            .select('subscription_tier')
            .eq('id', ctx.user.id)
            .single();

        const tier = (profile?.subscription_tier ?? 'free') as SubscriptionTier;

        if (!canConfigureCustomDomain(tier)) {
            return NextResponse.json(
                {
                    error: 'Custom domains require a Pro or Enterprise subscription.',
                    upgradeUrl: '/pricing',
                },
                { status: 403 },
            );
        }

        return handler(req, ctx);
    });
}
