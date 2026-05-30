/**
 * MultiProviderAuthService
 *
 * Coordinates OAuth token exchange across GitHub and Stellar wallet providers,
 * linking both to a single platform identity (Supabase user ID).
 *
 * Design:
 *   - Each provider's token is stored encrypted and isolated — GitHub tokens
 *     use GITHUB_TOKEN_ENCRYPTION_KEY via lib/github/token-encryption, and
 *     Stellar wallet addresses are stored in a separate provider_connections
 *     JSONB column on the profiles row (no raw private key is ever stored).
 *   - Provider identities are linked to the platform user ID without merging
 *     provider tokens together.
 *   - Partial connection is supported: a user may have GitHub connected,
 *     Stellar connected, both, or neither.
 *
 * Provider connection state:
 *   github   — stored in profiles.github_connected / github_token_encrypted
 *   stellar  — stored in profiles.provider_connections->>'stellar' as a JSON
 *              object { publicKey, connectedAt } (no private key stored)
 *
 * Token isolation:
 *   GitHub tokens are encrypted with AES-256-GCM before storage.
 *   Stellar wallet integration stores only the public key — the wallet signs
 *   transactions client-side; the platform never holds the private key.
 */

import { encryptToken, decryptToken } from '@/lib/github/token-encryption';
import type { SupabaseClient } from '@supabase/supabase-js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type OAuthProvider = 'github' | 'stellar';

export interface ProviderToken {
    provider: OAuthProvider;
    /** Encrypted token blob (GitHub) or public key (Stellar). */
    value: string;
    /** ISO 8601 expiry — null if the token does not expire. */
    expiresAt: string | null;
}

export interface ProviderConnectionStatus {
    github: boolean;
    stellar: boolean;
    /** ISO 8601 timestamp of when each provider was connected, if connected. */
    connectedAt: { github?: string; stellar?: string };
}

export interface ExchangeResult {
    userId: string;
    provider: OAuthProvider;
    connected: boolean;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class MultiProviderAuthService {
    /**
     * Connect a GitHub OAuth token to the platform identity.
     * Encrypts the token before storage. Idempotent — re-connecting replaces
     * the existing token.
     */
    async connectGitHub(
        supabase: SupabaseClient,
        userId: string,
        accessToken: string,
        username: string,
        expiresAt: string | null = null,
    ): Promise<ExchangeResult> {
        const encrypted = encryptToken(accessToken);

        const { error } = await supabase
            .from('profiles')
            .update({
                github_connected: true,
                github_username: username,
                github_token_encrypted: encrypted,
                github_token_expires_at: expiresAt,
                github_token_refreshed_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq('id', userId);

        if (error) throw new Error(`Failed to connect GitHub: ${error.message}`);

        return { userId, provider: 'github', connected: true };
    }

    /**
     * Connect a Stellar wallet to the platform identity.
     * Only the public key is stored — the platform never holds the private key.
     * Idempotent — re-connecting replaces the existing public key.
     */
    async connectStellar(
        supabase: SupabaseClient,
        userId: string,
        publicKey: string,
    ): Promise<ExchangeResult> {
        // Read existing provider_connections to merge
        const { data } = await supabase
            .from('profiles')
            .select('provider_connections')
            .eq('id', userId)
            .single();

        const existing = (data?.provider_connections as Record<string, unknown>) ?? {};
        const updated = {
            ...existing,
            stellar: { publicKey, connectedAt: new Date().toISOString() },
        };

        const { error } = await supabase
            .from('profiles')
            .update({
                provider_connections: updated,
                updated_at: new Date().toISOString(),
            })
            .eq('id', userId);

        if (error) throw new Error(`Failed to connect Stellar wallet: ${error.message}`);

        return { userId, provider: 'stellar', connected: true };
    }

    /**
     * Disconnect a provider from the platform identity.
     * Clears the stored token/key for the given provider.
     */
    async disconnectProvider(
        supabase: SupabaseClient,
        userId: string,
        provider: OAuthProvider,
    ): Promise<ExchangeResult> {
        if (provider === 'github') {
            const { error } = await supabase
                .from('profiles')
                .update({
                    github_connected: false,
                    github_username: null,
                    github_token_encrypted: null,
                    github_token_expires_at: null,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', userId);

            if (error) throw new Error(`Failed to disconnect GitHub: ${error.message}`);
        } else {
            const { data } = await supabase
                .from('profiles')
                .select('provider_connections')
                .eq('id', userId)
                .single();

            const existing = (data?.provider_connections as Record<string, unknown>) ?? {};
            const { stellar: _removed, ...rest } = existing as any;

            const { error } = await supabase
                .from('profiles')
                .update({
                    provider_connections: rest,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', userId);

            if (error) throw new Error(`Failed to disconnect Stellar: ${error.message}`);
        }

        return { userId, provider, connected: false };
    }

    /**
     * Return the connection status for all providers for a given user.
     * Handles the partial-connection case (one provider connected, not the other).
     */
    async getConnectionStatus(
        supabase: SupabaseClient,
        userId: string,
    ): Promise<ProviderConnectionStatus> {
        const { data } = await supabase
            .from('profiles')
            .select('github_connected, github_token_refreshed_at, provider_connections')
            .eq('id', userId)
            .single();

        const stellarConn = (data?.provider_connections as any)?.stellar;

        return {
            github: data?.github_connected ?? false,
            stellar: !!stellarConn?.publicKey,
            connectedAt: {
                ...(data?.github_token_refreshed_at
                    ? { github: data.github_token_refreshed_at }
                    : {}),
                ...(stellarConn?.connectedAt ? { stellar: stellarConn.connectedAt } : {}),
            },
        };
    }

    /**
     * Retrieve the decrypted GitHub access token for a user.
     * Returns null if GitHub is not connected.
     */
    async getGitHubToken(
        supabase: SupabaseClient,
        userId: string,
    ): Promise<string | null> {
        const { data } = await supabase
            .from('profiles')
            .select('github_token_encrypted, github_connected')
            .eq('id', userId)
            .single();

        if (!data?.github_connected || !data.github_token_encrypted) return null;
        return decryptToken(data.github_token_encrypted);
    }

    /**
     * Retrieve the Stellar public key for a user.
     * Returns null if Stellar is not connected.
     */
    async getStellarPublicKey(
        supabase: SupabaseClient,
        userId: string,
    ): Promise<string | null> {
        const { data } = await supabase
            .from('profiles')
            .select('provider_connections')
            .eq('id', userId)
            .single();

        return (data?.provider_connections as any)?.stellar?.publicKey ?? null;
    }
}

export const multiProviderAuthService = new MultiProviderAuthService();
