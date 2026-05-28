/**
 * EnvSyncService
 *
 * Synchronizes Stellar config and other environment variables to Vercel projects.
 * Handles creation, update, and deletion of environment variables with automatic
 * retry logic using exponential backoff.
 *
 * Responsibilities:
 *   - Sync desired env vars to Vercel, updating only changed values
 *   - Automatically delete stale env vars not in the desired set
 *   - Treat sensitive variables (type = 'secret') as Vercel secrets
 *   - Retry failed operations with exponential backoff
 *   - Surface clear error messages when retries are exhausted
 *
 * Sync contract:
 *   - Variables are upserted per (key, target) pair.
 *   - Sensitive variables (type = "secret") are encrypted by Vercel.
 *   - Deletions remove the variable from all specified targets.
 *   - Environment-specific variables are scoped to the correct target
 *     (production | preview | development).
 */

import type { VercelEnvVar } from '@/lib/env/env-template-generator';
import { withRetry, type RetryConfig } from '@/lib/api/retry';

type EnvTarget = 'production' | 'preview' | 'development';
type EnvType = 'plain' | 'secret' | 'encrypted';

interface VercelEnvRecord {
    id: string;
    key: string;
    value: string;
    target: EnvTarget[];
    type: EnvType;
}

export interface EnvVar {
    key: string;
    value: string;
    target: EnvTarget[];
    type: EnvType;
}

interface VercelApiClient {
    listEnvVars(projectId: string): Promise<VercelEnvRecord[]>;
    createEnvVar(projectId: string, variable: EnvVar): Promise<VercelEnvRecord>;
    updateEnvVar(projectId: string, envId: string, patch: { value?: string; type?: string }): Promise<VercelEnvRecord>;
    deleteEnvVar(projectId: string, envId: string): Promise<void>;
}

export class EnvSyncError extends Error {
    constructor(
        message: string,
        public readonly statusCode?: number,
    ) {
        super(message);
        this.name = 'EnvSyncError';
    }
}

export interface EnvSyncResult {
    created: number;
    updated: number;
    deleted: number;
}

/**
 * Converts VercelEnvVar[] to a normalized format with target metadata.
 */
function normalizeEnvVars(vars: VercelEnvVar[]): EnvVar[] {
    return vars.map((v) => ({
        key: v.key,
        value: v.value,
        target: v.target,
        type: v.type as EnvType,
    }));
}

export class EnvSyncService {
    constructor(
        private readonly api: VercelApiClient,
        private readonly retryConfig: RetryConfig = {},
    ) {}

    /**
     * Sync desired environment variables to a Vercel project.
     * - Creates new variables
     * - Updates variables with changed values or types
     * - Deletes stale variables not in the desired set
     * Returns counts of created, updated, and deleted variables.
     */
    async sync(projectId: string, desired: EnvVar[]): Promise<EnvSyncResult> {
        return withRetry(
            async () => {
                const existing = await this.api.listEnvVars(projectId);
                const existingMap = new Map(
                    existing.map((e) => [`${e.key}:${e.target.sort().join(',')}`, e])
                );

                let created = 0;
                let updated = 0;

                for (const variable of desired) {
                    const mapKey = `${variable.key}:${[...variable.target].sort().join(',')}`;
                    const record = existingMap.get(mapKey);
                    if (record) {
                        if (record.value !== variable.value || record.type !== variable.type) {
                            await this.api.updateEnvVar(projectId, record.id, {
                                value: variable.value,
                                type: variable.type,
                            });
                            updated++;
                        }
                        existingMap.delete(mapKey);
                    } else {
                        await this.api.createEnvVar(projectId, variable);
                        created++;
                    }
                }

                // Remaining entries in existingMap are stale — delete them
                let deleted = 0;
                for (const stale of existingMap.values()) {
                    await this.api.deleteEnvVar(projectId, stale.id);
                    deleted++;
                }

                return { created, updated, deleted };
            },
            {
                maxAttempts: 4,
                baseDelayMs: 300,
                maxDelayMs: 10_000,
                ...this.retryConfig,
            }
        ).catch((err: unknown) => {
            if (err instanceof Error) {
                throw new EnvSyncError(
                    `Failed to sync environment variables: ${err.message}`
                );
            }
            throw new EnvSyncError('Failed to sync environment variables');
        });
    }

    /**
     * Sync Vercel env vars from VercelEnvVar[] format (as returned by code generators).
     */
    async syncVercelEnvVars(projectId: string, vars: VercelEnvVar[]): Promise<EnvSyncResult> {
        const normalized = normalizeEnvVars(vars);
        return this.sync(projectId, normalized);
    }
}
