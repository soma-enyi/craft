/**
 * Tests for BuildCacheService (#660)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BuildCacheService } from './build-cache.service';
import type { GeneratedFile } from '@craft/types';

const makeFiles = (entries: Array<[string, string]>): GeneratedFile[] =>
    entries.map(([path, content]) => ({ path, content, type: 'config' as const }));

const makeSupabase = (storedHash: string | null) => ({
    from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
            data: storedHash
                ? { customization_config: { _buildCacheHash: storedHash } }
                : { customization_config: {} },
        }),
    }),
});

describe('BuildCacheService', () => {
    let service: BuildCacheService;

    beforeEach(() => {
        service = new BuildCacheService();
    });

    // ── computeContentHash ────────────────────────────────────────────────────

    it('produces a deterministic hex hash for a set of files', () => {
        const files = makeFiles([['a.ts', 'hello'], ['b.ts', 'world']]);
        const hash1 = service.computeContentHash(files);
        const hash2 = service.computeContentHash(files);
        expect(hash1).toBe(hash2);
        expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces the same hash regardless of file order', () => {
        const files1 = makeFiles([['a.ts', 'hello'], ['b.ts', 'world']]);
        const files2 = makeFiles([['b.ts', 'world'], ['a.ts', 'hello']]);
        expect(service.computeContentHash(files1)).toBe(service.computeContentHash(files2));
    });

    it('produces a different hash when file content changes', () => {
        const original = makeFiles([['a.ts', 'hello']]);
        const changed = makeFiles([['a.ts', 'hello changed']]);
        expect(service.computeContentHash(original)).not.toBe(service.computeContentHash(changed));
    });

    it('produces a different hash when a file is added', () => {
        const before = makeFiles([['a.ts', 'hello']]);
        const after = makeFiles([['a.ts', 'hello'], ['b.ts', 'new']]);
        expect(service.computeContentHash(before)).not.toBe(service.computeContentHash(after));
    });

    // ── checkCache ────────────────────────────────────────────────────────────

    it('returns cache miss when no previous hash is stored', async () => {
        const supabase = makeSupabase(null) as any;
        const files = makeFiles([['index.ts', 'code']]);
        const result = await service.checkCache(supabase, 'dep-1', files);

        expect(result.status).toBe('miss');
        expect(result.previousHash).toBeNull();
        expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns cache hit when hash matches stored hash', async () => {
        const files = makeFiles([['index.ts', 'code']]);
        const hash = service.computeContentHash(files);
        const supabase = makeSupabase(hash) as any;

        const result = await service.checkCache(supabase, 'dep-1', files);

        expect(result.status).toBe('hit');
        expect(result.previousHash).toBe(hash);
        expect(result.contentHash).toBe(hash);
    });

    it('returns cache miss when hash differs from stored hash', async () => {
        const supabase = makeSupabase('old-hash-value') as any;
        const files = makeFiles([['index.ts', 'new code']]);

        const result = await service.checkCache(supabase, 'dep-1', files);

        expect(result.status).toBe('miss');
        expect(result.previousHash).toBe('old-hash-value');
    });

    // ── storeHash ─────────────────────────────────────────────────────────────

    it('merges _buildCacheHash into existing customization_config', async () => {
        const mockUpdate = vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({}),
        });
        const supabase = {
            from: vi.fn().mockReturnValue({
                select: vi.fn().mockReturnThis(),
                update: mockUpdate,
                eq: vi.fn().mockReturnThis(),
                single: vi.fn().mockResolvedValue({
                    data: { customization_config: { existingKey: 'value' } },
                }),
            }),
        } as any;

        await service.storeHash(supabase, 'dep-1', 'abc123');

        expect(mockUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                customization_config: expect.objectContaining({
                    existingKey: 'value',
                    _buildCacheHash: 'abc123',
                }),
            }),
        );
    });
});
