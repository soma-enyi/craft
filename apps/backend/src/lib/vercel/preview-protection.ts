/**
 * Vercel preview environment deployment protection helpers.
 *
 * Preview deployments are protected by default — only authenticated team
 * members or holders of a valid bypass token can access them.
 *
 * Bypass token flow
 * ─────────────────
 * 1. A signed bypass token is issued via POST /api/preview/access.
 * 2. The token is appended as `?x-vercel-protection-bypass=<token>` on the
 *    preview URL, or set via the `x-vercel-protection-bypass` header.
 * 3. Vercel validates the token and grants access to the preview.
 *
 * Environment variables required
 * ──────────────────────────────
 * VERCEL_PROTECTION_BYPASS_SECRET — shared secret used to sign bypass tokens.
 *   Set this in Vercel project settings → Environment Variables (Preview only).
 *
 * Security notes
 * ──────────────
 * - Bypass tokens are scoped to a single deployment ID.
 * - Tokens expire after BYPASS_TOKEN_TTL_SECONDS.
 * - Never expose the VERCEL_PROTECTION_BYPASS_SECRET in client-side code.
 *
 * Feature: vercel-preview-protection-rules
 * Issue: #656
 */

import { createHmac, timingSafeEqual } from 'crypto';

const BYPASS_TOKEN_TTL_SECONDS = 3600; // 1 hour

export interface BypassTokenPayload {
    deploymentId: string;
    issuedAt: number;
    expiresAt: number;
}

export interface BypassTokenResult {
    token: string;
    expiresAt: number;
    queryParam: string;
}

export interface TokenValidationResult {
    valid: boolean;
    reason?: 'invalid_signature' | 'expired' | 'deployment_mismatch' | 'missing_secret';
}

function getSecret(): string {
    return process.env.VERCEL_PROTECTION_BYPASS_SECRET ?? '';
}

/**
 * Issue a time-limited bypass token for a specific preview deployment.
 * Returns the token and the ready-to-append query parameter value.
 */
export function issueBypassToken(
    deploymentId: string,
    nowSeconds: number = Math.floor(Date.now() / 1000),
): BypassTokenResult {
    const secret = getSecret();
    if (!secret) {
        throw new Error('VERCEL_PROTECTION_BYPASS_SECRET is not configured');
    }

    const issuedAt = nowSeconds;
    const expiresAt = issuedAt + BYPASS_TOKEN_TTL_SECONDS;

    const payload = `${deploymentId}:${issuedAt}:${expiresAt}`;
    const signature = createHmac('sha256', secret).update(payload).digest('hex');
    const token = Buffer.from(`${payload}:${signature}`).toString('base64url');

    return {
        token,
        expiresAt,
        queryParam: `x-vercel-protection-bypass=${token}`,
    };
}

/**
 * Validate a bypass token for a given deployment ID.
 * Returns { valid: true } on success, or { valid: false, reason } on failure.
 */
export function validateBypassToken(
    token: string,
    expectedDeploymentId: string,
    nowSeconds: number = Math.floor(Date.now() / 1000),
): TokenValidationResult {
    const secret = getSecret();
    if (!secret) {
        return { valid: false, reason: 'missing_secret' };
    }

    let decoded: string;
    try {
        decoded = Buffer.from(token, 'base64url').toString('utf-8');
    } catch {
        return { valid: false, reason: 'invalid_signature' };
    }

    const parts = decoded.split(':');
    if (parts.length !== 4) {
        return { valid: false, reason: 'invalid_signature' };
    }

    const [deploymentId, issuedAtStr, expiresAtStr, signature] = parts;
    const payload = `${deploymentId}:${issuedAtStr}:${expiresAtStr}`;
    const expectedSig = createHmac('sha256', secret).update(payload).digest('hex');

    const sigBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSig, 'hex');

    if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
        return { valid: false, reason: 'invalid_signature' };
    }

    const expiresAt = parseInt(expiresAtStr, 10);
    if (nowSeconds > expiresAt) {
        return { valid: false, reason: 'expired' };
    }

    if (deploymentId !== expectedDeploymentId) {
        return { valid: false, reason: 'deployment_mismatch' };
    }

    return { valid: true };
}
