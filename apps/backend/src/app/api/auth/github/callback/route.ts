/**
 * GET /api/auth/github/callback
 *
 * Completes the GitHub OAuth / App installation flow.
 *
 * Expected query parameters (GitHub redirects these automatically):
 *   code          — one-time OAuth authorisation code
 *   state         — opaque value echoed back from the initial authorise request;
 *                   must match the value stored in the `github_oauth_state` cookie
 *                   to prevent CSRF attacks
 *   installation_id — present when the user installs the GitHub App (optional)
 *   setup_action    — "install" | "update" when installation_id is present (optional)
 *
 * Flow:
 *   1. Validate state cookie (CSRF guard)
 *   2. Exchange code for an access token via GitHub's token endpoint
 *   3. Validate OAuth scopes — token must grant `repo` and `read:user`
 *   4. Fetch the authenticated user's GitHub login
 *   5. Encrypt the token with AES-256-GCM and persist github_connected,
 *      github_username, and github_token_encrypted on the profile row
 *   6. Clear the state cookie and redirect to /app?github=connected
 *
 * Error redirects:
 *   /app?github=error&reason=<reason>
 *
 * Reasons:
 *   missing_code        — no `code` param in the callback URL
 *   state_mismatch      — CSRF state check failed
 *   token_exchange      — GitHub rejected the code exchange
 *   insufficient_scopes — token is missing required repository scopes
 *   user_fetch          — could not retrieve GitHub user info
 *   unauthenticated     — no active Craft session
 *   db_error            — profile update failed
 *
 * Required GitHub OAuth scopes:
 *   repo       — full repository access (create, push, webhooks)
 *   read:user  — read authenticated user profile
 *
 * Feature: github-oauth-callback
 * Issue branch: issue-083-create-the-github-oauth-callback-route
 * Scope validation: issue-122-github-oauth-scope-validation
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { encryptToken } from '@/lib/github/token-encryption';
import { fetchAndValidateScopes } from '@/lib/github/scope-validator';

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
const STATE_COOKIE = 'github_oauth_state';

function redirectError(base: string, reason: string): NextResponse {
    return NextResponse.redirect(`${base}/app?github=error&reason=${reason}`);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
    const { searchParams, origin } = new URL(req.url);

    const code = searchParams.get('code');
    const state = searchParams.get('state');

    // ── 1. Require code ───────────────────────────────────────────────────────
    if (!code) {
        return redirectError(origin, 'missing_code');
    }

    // ── 2. CSRF state check ───────────────────────────────────────────────────
    const storedState = req.cookies.get(STATE_COOKIE)?.value;
    if (!storedState || storedState !== state) {
        return redirectError(origin, 'state_mismatch');
    }

    // ── 3. Exchange code for access token ─────────────────────────────────────
    let accessToken: string;
    try {
        const tokenRes = await fetch(GITHUB_TOKEN_URL, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                client_id: process.env.GITHUB_CLIENT_ID,
                client_secret: process.env.GITHUB_CLIENT_SECRET,
                code,
            }),
        });

        const tokenData = (await tokenRes.json()) as {
            access_token?: string;
            error?: string;
        };

        if (!tokenData.access_token) {
            return redirectError(origin, 'token_exchange');
        }

        accessToken = tokenData.access_token;
    } catch {
        return redirectError(origin, 'token_exchange');
    }

    // ── 4. Validate OAuth scopes ──────────────────────────────────────────────
    // The token must grant `repo` and `read:user` before any deployment work
    // is attempted. Missing scopes redirect to re-authorization rather than
    // surfacing a mid-deployment failure.
    const scopeResult = await fetchAndValidateScopes(accessToken);
    if (!scopeResult.valid) {
        const missing = scopeResult.missingScopes.join(',');
        return redirectError(origin, `insufficient_scopes&missing=${encodeURIComponent(missing)}`);
    }

    // ── 5. Fetch GitHub username ──────────────────────────────────────────────
    let githubUsername: string;
    try {
        const userRes = await fetch(GITHUB_USER_URL, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/vnd.github+json',
            },
        });

        if (!userRes.ok) {
            return redirectError(origin, 'user_fetch');
        }

        const userData = (await userRes.json()) as { login?: string };
        if (!userData.login) {
            return redirectError(origin, 'user_fetch');
        }

        githubUsername = userData.login;
    } catch {
        return redirectError(origin, 'user_fetch');
    }

    // ── 6. Require an active Craft session ────────────────────────────────────
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
        return redirectError(origin, 'unauthenticated');
    }

    // ── 7. Persist connection on the profile ──────────────────────────────────
    const { error: dbError } = await supabase
        .from('profiles')
        .update({
            github_connected: true,
            github_username: githubUsername,
            github_token_encrypted: encryptToken(accessToken),
            updated_at: new Date().toISOString(),
        })
        .eq('id', user.id);

    if (dbError) {
        return redirectError(origin, 'db_error');
    }

    // ── 8. Clear state cookie and redirect to success ─────────────────────────
    const response = NextResponse.redirect(`${origin}/app?github=connected`);
    response.cookies.set(STATE_COOKIE, '', { maxAge: 0, path: '/' });
    return response;
}
