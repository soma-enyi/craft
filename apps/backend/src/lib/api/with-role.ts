import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '../supabase/server';
import { withLogging, type Logger } from './logger';

export type AppRole = 'admin';

export type RoleRouteContext = {
    userId: string;
    correlationId: string;
    log: Logger;
};

type RoleRouteHandler = (
    req: NextRequest,
    ctx: RoleRouteContext
) => Promise<NextResponse>;

/**
 * RBAC middleware for admin analytics and aggregate-data routes.
 *
 * - Returns 401 for unauthenticated requests.
 * - Returns 403 for authenticated users whose role doesn't match.
 * - Role is resolved from user_metadata.role (set server-side via Supabase
 *   admin) with a fallback to the ADMIN_USER_IDS env variable (comma-separated
 *   user IDs). Roles are never trusted from client-supplied headers.
 */
export function withRole(requiredRole: AppRole, handler: RoleRouteHandler) {
    return withLogging(async (req: NextRequest, { correlationId, log }) => {
        const supabase = createClient();
        const { data: { user }, error } = await supabase.auth.getUser();

        if (error || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        if (!hasRole(user, requiredRole)) {
            log.warn('Access denied: insufficient role', {
                userId: user.id,
                requiredRole,
            });
            return NextResponse.json(
                { error: 'Forbidden: insufficient role' },
                { status: 403 }
            );
        }

        return handler(req, { userId: user.id, correlationId, log });
    });
}

function hasRole(
    user: { id: string; user_metadata?: Record<string, unknown> },
    role: AppRole
): boolean {
    // Primary: role stored in server-side user metadata (set via Supabase admin API).
    if (user.user_metadata?.role === role) return true;

    // Fallback: comma-separated allowlist in env (useful before metadata is provisioned).
    const adminIds = process.env.ADMIN_USER_IDS;
    if (role === 'admin' && adminIds) {
        return adminIds.split(',').map((s) => s.trim()).includes(user.id);
    }

    return false;
}
