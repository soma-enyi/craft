/**
 * BuildCacheService
 *
 * Computes a deterministic content hash of generated template code and
 * decides whether the Vercel build cache should be invalidated.
 *
 * Strategy:
 *   - Hash all generated file paths + contents with SHA-256.
 *   - Compare against the previously stored hash for the deployment.
 *   - If the hash changed → cache miss → trigger a fresh Vercel build.
 *   - If the hash is unchanged → cache hit → skip the build.
 *
 * The hash is stored in the `deployments` table under the
 * `customization_config` JSONB column at key `_buildCacheHash` so no
 * schema migration is required.
 *
 * Cache status is surfaced in deployment logs via DeploymentLogsService.
 */

import { createHash } from 'crypto';
import type { GeneratedFile } from '@craft/types';
import type { SupabaseClient } from '@supabase/supabase-js';

export type CacheStatus = 'hit' | 'miss';

export interface CacheCheckResult {
    status: CacheStatus;
    contentHash: string;
    previousHash: string | null;
}

export class BuildCacheService {
    /**
     * Compute a deterministic SHA-256 hash over all generated files.
     * Files are sorted by path so the hash is order-independent.
     */
    computeContentHash(files: GeneratedFile[]): string {
        const hash = createHash('sha256');
        const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
        for (const file of sorted) {
            hash.update(file.path);
            hash.update('\0');
            hash.update(file.content);
            hash.update('\0');
        }
        return hash.digest('hex');
    }

    /**
     * Check whether the build cache is valid for a deployment.
     *
     * Returns:
     *   - status: 'hit'  → code unchanged, skip build
     *   - status: 'miss' → code changed or first build, proceed with build
     *   - contentHash: the newly computed hash
     *   - previousHash: the hash stored from the last build (null if none)
     */
    async checkCache(
        supabase: SupabaseClient,
        deploymentId: string,
        files: GeneratedFile[],
    ): Promise<CacheCheckResult> {
        const contentHash = this.computeContentHash(files);

        const { data } = await supabase
            .from('deployments')
            .select('customization_config')
            .eq('id', deploymentId)
            .single();

        const previousHash: string | null =
            (data?.customization_config as any)?._buildCacheHash ?? null;

        const status: CacheStatus = previousHash === contentHash ? 'hit' : 'miss';

        return { status, contentHash, previousHash };
    }

    /**
     * Persist the content hash after a successful build so future runs can
     * compare against it.
     */
    async storeHash(
        supabase: SupabaseClient,
        deploymentId: string,
        contentHash: string,
    ): Promise<void> {
        // Merge _buildCacheHash into the existing customization_config JSONB
        const { data } = await supabase
            .from('deployments')
            .select('customization_config')
            .eq('id', deploymentId)
            .single();

        const existing = (data?.customization_config as Record<string, unknown>) ?? {};

        await supabase
            .from('deployments')
            .update({
                customization_config: { ...existing, _buildCacheHash: contentHash },
            })
            .eq('id', deploymentId);
    }
}

export const buildCacheService = new BuildCacheService();
