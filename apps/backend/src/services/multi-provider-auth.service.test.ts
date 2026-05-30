/**
 * Tests for MultiProviderAuthService (#661)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── token-encryption mock ─────────────────────────────────────────────────────
const mockEncryptToken = vi.fn((t: string) => `enc:${t}`);
const mockDecryptToken = vi.fn((t: string) => t.replace('enc:', ''));
vi.mock('@/lib/github/token-encryption', () => ({
    encryptToken: mockEncryptToken,
    decryptToken: mockDecryptToken,
}));

// ── helpers ───────────────────────────────────────────────────────────────────

type UpdatePayload = Record<string, unknown>;

function makeSupabase(rows: Record<string, unknown> = {}) {
    const updateCalls: UpdatePayload[] = [];
    const client = {
        _updateCalls: updateCalls,
        from: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnThis(),
            update: vi.fn().mockImplementation((payload: UpdatePayload) => {
                updateCalls.push(payload);
                return {
                    eq: vi.fn().mockResolvedValue({ error: null }),
                };
            }),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({ data: rows, error: null }),
        }),
    };
    return client as any;
}

describe('MultiProviderAuthService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // ── connectGitHub ─────────────────────────────────────────────────────────

    it('encrypts the GitHub token before storing it', async () => {
        const supabase = makeSupabase();
        const { multiProviderAuthService } = await import('./multi-provider-auth.service');

        const result = await multiProviderAuthService.connectGitHub(
            supabase, 'user-1', 'ghp_token', 'octocat', null,
        );

        expect(result.connected).toBe(true);
        expect(result.provider).toBe('github');
        expect(mockEncryptToken).toHaveBeenCalledWith('ghp_token');

        const payload = supabase._updateCalls[0];
        expect(payload.github_token_encrypted).toBe('enc:ghp_token');
        expect(payload.github_connected).toBe(true);
        expect(payload.github_username).toBe('octocat');
    });

    it('stores expiry when provided', async () => {
        const supabase = makeSupabase();
        const { multiProviderAuthService } = await import('./multi-provider-auth.service');
        const expiry = '2027-01-01T00:00:00Z';

        await multiProviderAuthService.connectGitHub(supabase, 'user-1', 'tok', 'user', expiry);

        expect(supabase._updateCalls[0].github_token_expires_at).toBe(expiry);
    });

    // ── connectStellar ────────────────────────────────────────────────────────

    it('stores only the Stellar public key (no private key)', async () => {
        const supabase = makeSupabase({ provider_connections: {} });
        const { multiProviderAuthService } = await import('./multi-provider-auth.service');

        const result = await multiProviderAuthService.connectStellar(
            supabase, 'user-1', 'GABC123',
        );

        expect(result.connected).toBe(true);
        expect(result.provider).toBe('stellar');

        const payload = supabase._updateCalls[0];
        expect(payload.provider_connections).toMatchObject({
            stellar: { publicKey: 'GABC123' },
        });
        // No private key field
        expect(JSON.stringify(payload)).not.toContain('privateKey');
        expect(JSON.stringify(payload)).not.toContain('secretKey');
    });

    it('preserves existing provider_connections when adding Stellar', async () => {
        const existing = { someOther: { data: 'value' } };
        const supabase = makeSupabase({ provider_connections: existing });
        const { multiProviderAuthService } = await import('./multi-provider-auth.service');

        await multiProviderAuthService.connectStellar(supabase, 'user-1', 'GXYZ');

        const payload = supabase._updateCalls[0];
        expect(payload.provider_connections).toMatchObject({
            someOther: { data: 'value' },
            stellar: { publicKey: 'GXYZ' },
        });
    });

    // ── disconnectProvider ────────────────────────────────────────────────────

    it('clears GitHub fields on disconnect', async () => {
        const supabase = makeSupabase();
        const { multiProviderAuthService } = await import('./multi-provider-auth.service');

        const result = await multiProviderAuthService.disconnectProvider(
            supabase, 'user-1', 'github',
        );

        expect(result.connected).toBe(false);
        const payload = supabase._updateCalls[0];
        expect(payload.github_connected).toBe(false);
        expect(payload.github_token_encrypted).toBeNull();
    });

    it('removes only the stellar key from provider_connections on disconnect', async () => {
        const supabase = makeSupabase({
            provider_connections: { stellar: { publicKey: 'G1' }, other: { x: 1 } },
        });
        const { multiProviderAuthService } = await import('./multi-provider-auth.service');

        await multiProviderAuthService.disconnectProvider(supabase, 'user-1', 'stellar');

        const payload = supabase._updateCalls[0];
        expect(payload.provider_connections).not.toHaveProperty('stellar');
        expect(payload.provider_connections).toMatchObject({ other: { x: 1 } });
    });

    // ── getConnectionStatus ───────────────────────────────────────────────────

    it('returns correct status when both providers are connected', async () => {
        const supabase = makeSupabase({
            github_connected: true,
            github_token_refreshed_at: '2026-01-01T00:00:00Z',
            provider_connections: {
                stellar: { publicKey: 'GABC', connectedAt: '2026-02-01T00:00:00Z' },
            },
        });
        const { multiProviderAuthService } = await import('./multi-provider-auth.service');

        const status = await multiProviderAuthService.getConnectionStatus(supabase, 'user-1');

        expect(status.github).toBe(true);
        expect(status.stellar).toBe(true);
        expect(status.connectedAt.github).toBe('2026-01-01T00:00:00Z');
        expect(status.connectedAt.stellar).toBe('2026-02-01T00:00:00Z');
    });

    it('handles partial connection (GitHub only)', async () => {
        const supabase = makeSupabase({
            github_connected: true,
            github_token_refreshed_at: '2026-01-01T00:00:00Z',
            provider_connections: null,
        });
        const { multiProviderAuthService } = await import('./multi-provider-auth.service');

        const status = await multiProviderAuthService.getConnectionStatus(supabase, 'user-1');

        expect(status.github).toBe(true);
        expect(status.stellar).toBe(false);
        expect(status.connectedAt.stellar).toBeUndefined();
    });

    it('handles partial connection (Stellar only)', async () => {
        const supabase = makeSupabase({
            github_connected: false,
            github_token_refreshed_at: null,
            provider_connections: { stellar: { publicKey: 'G1', connectedAt: '2026-03-01T00:00:00Z' } },
        });
        const { multiProviderAuthService } = await import('./multi-provider-auth.service');

        const status = await multiProviderAuthService.getConnectionStatus(supabase, 'user-1');

        expect(status.github).toBe(false);
        expect(status.stellar).toBe(true);
    });

    // ── getGitHubToken ────────────────────────────────────────────────────────

    it('decrypts and returns the GitHub token', async () => {
        const supabase = makeSupabase({
            github_connected: true,
            github_token_encrypted: 'enc:ghp_secret',
        });
        const { multiProviderAuthService } = await import('./multi-provider-auth.service');

        const token = await multiProviderAuthService.getGitHubToken(supabase, 'user-1');

        expect(mockDecryptToken).toHaveBeenCalledWith('enc:ghp_secret');
        expect(token).toBe('ghp_secret');
    });

    it('returns null when GitHub is not connected', async () => {
        const supabase = makeSupabase({ github_connected: false, github_token_encrypted: null });
        const { multiProviderAuthService } = await import('./multi-provider-auth.service');

        const token = await multiProviderAuthService.getGitHubToken(supabase, 'user-1');
        expect(token).toBeNull();
    });

    // ── getStellarPublicKey ───────────────────────────────────────────────────

    it('returns the Stellar public key when connected', async () => {
        const supabase = makeSupabase({
            provider_connections: { stellar: { publicKey: 'GABC123' } },
        });
        const { multiProviderAuthService } = await import('./multi-provider-auth.service');

        const key = await multiProviderAuthService.getStellarPublicKey(supabase, 'user-1');
        expect(key).toBe('GABC123');
    });

    it('returns null when Stellar is not connected', async () => {
        const supabase = makeSupabase({ provider_connections: null });
        const { multiProviderAuthService } = await import('./multi-provider-auth.service');

        const key = await multiProviderAuthService.getStellarPublicKey(supabase, 'user-1');
        expect(key).toBeNull();
    });
});
