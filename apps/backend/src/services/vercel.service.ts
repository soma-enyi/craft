/**
 * VercelService
 *
 * Manages Vercel API interactions for project creation and deployment.
 *
 * Configuration (env vars):
 *   VERCEL_TOKEN     — Vercel API token (required)
 *   VERCEL_TEAM_ID   — Optional. When set, all projects are scoped to this team.
 *
 * Responsibilities:
 *   - Validate required configuration at construction time via validateConfig()
 *   - Create a Vercel project linked to a GitHub repository
 *   - Configure environment variables on the project
 *   - Trigger a deployment and return the deployment URL
 *   - Surface rate-limit and auth errors with structured codes via a single
 *     shared request() helper (no duplicated fetch/error-handling logic)
 *
 * Design doc properties satisfied:
 *   Property 20 — Deployment Pipeline Sequence
 *   Property 21 — Vercel Environment Variable Configuration
 *   Property 22 — Vercel Build Configuration
 *   Property 23 — Deployment Error Capture
 */

import type { VercelEnvVar } from '@/lib/env/env-template-generator';
import { CircuitBreaker } from '@/lib/api/circuit-breaker';

export type { VercelEnvVar };

const VERCEL_API_BASE = 'https://api.vercel.com';

// ── Error types ───────────────────────────────────────────────────────────────

export type VercelErrorCode =
    | 'AUTH_FAILED'
    | 'RATE_LIMITED'
    | 'NETWORK_ERROR'
    | 'PROJECT_EXISTS'
    | 'DOMAIN_EXISTS'
    | 'DOMAIN_ALREADY_EXISTS'
    | 'DOMAIN_NOT_FOUND'
    | 'UNKNOWN';

// ── Domain / certificate types ────────────────────────────────────────────────

export type CertificateState =
    | 'pending'      // Vercel is provisioning the certificate
    | 'active'       // Certificate is live
    | 'error';       // Provisioning failed (e.g. DNS not yet propagated)

export interface DomainCertificate {
    /** The custom domain. */
    domain: string;
    /** Current certificate state. */
    state: CertificateState;
    /** ISO 8601 expiry date — present when state is "active". */
    expiresAt?: string;
    /** Human-readable reason — present when state is "error". */
    error?: string;
}

export class VercelApiError extends Error {
    constructor(
        message: string,
        public readonly code: VercelErrorCode,
        public readonly retryAfterMs?: number,
    ) {
        super(message);
        this.name = 'VercelApiError';
    }
}

// ── Request / response types ──────────────────────────────────────────────────

export interface CreateVercelProjectRequest {
    /** Desired project name (will be used as-is; caller should sanitize). */
    name: string;
    /** GitHub "owner/repo" slug. */
    gitRepo: string;
    /** Environment variables to configure on the project. */
    envVars: VercelEnvVar[];
    /** Framework preset — always nextjs for CRAFT templates. */
    framework?: string;
    /** Turborepo build command override. */
    buildCommand?: string;
    /** Output directory override. */
    outputDirectory?: string;
}

export interface VercelProject {
    id: string;
    name: string;
    /** Vercel-assigned project URL (without https://). */
    url: string;
}

export interface TriggerDeploymentResult {
    deploymentId: string;
    /** Full deployment URL including https://. */
    deploymentUrl: string;
    /** Raw Vercel deployment status at creation time. */
    status: string;
}

export interface VercelAlias {
    uid: string;
    alias: string;
    created?: string;
    redirect?: string | null;
}

// ── Deployment status types (Issue #92) ─────────────────────────────────────

export type VercelDeploymentStatus =
    | 'BUILDING'
    | 'ERROR'
    | 'CANCELED'
    | 'QUEUED'
    | 'READY'
    | 'FAILED';

export interface VercelDeployment {
    /** Vercel deployment ID. */
    id: string;
    /** Deployment name. */
    name: string;
    /** Deployment URL (without https://). */
    url: string;
    /** Current deployment status. */
    status: VercelDeploymentStatus;
    /** Timestamp when the deployment was created. */
    createdAt: number;
    /** Timestamp when the deployment was ready. */
    ready?: number;
    /** Timestamp when the deployment was canceled. */
    canceled?: number;
    /** Timestamp when the deployment failed. */
    error?: number;
    /** Associated project ID. */
    projectId?: string;
    /** Associated project name. */
    projectName?: string;
    /** Deployment metadata. */
    meta?: Record<string, unknown>;
}

export interface NormalizedDeploymentStatus {
    /** Internal deployment status. */
    status: 'pending' | 'building' | 'ready' | 'failed' | 'canceled';
    /** Deployment URL. */
    url: string;
    /** Deployment ID. */
    deploymentId: string;
    /** Timestamp when the deployment was created. */
    createdAt: Date;
    /** Timestamp when the deployment was ready (if applicable). */
    readyAt?: Date;
    /** Timestamp when the deployment failed (if applicable). */
    failedAt?: Date;
    /** Timestamp when the deployment was canceled (if applicable). */
    canceledAt?: Date;
    /** Error message if the deployment failed. */
    errorMessage?: string;
    /** Associated project ID. */
    projectId?: string;
    /** Associated project name. */
    projectName?: string;
}

// ── Domain configuration types ──────────────────────────────────────────────

export interface DomainVerification {
    /** Domain name that needs verification. */
    domain: string;
    /** Type of DNS record to create (e.g., 'CNAME', 'A'). */
    type: string;
    /** Value for the DNS record. */
    value: string;
    /** Domain to configure DNS for. */
    name: string;
}

export interface AddDomainRequest {
    /** Domain name to add (e.g., 'example.com'). */
    domain: string;
    /** Optional project ID to attach the domain to. */
    projectId?: string;
    /** Optional deployment ID to attach the domain to. */
    deploymentId?: string;
    /** Whether to redirect HTTPS traffic to this domain. */
    redirect?: boolean;
    /** Whether to force HTTPS. */
    forceHttps?: boolean;
}

export interface AddDomainResult {
    /** Whether the domain was successfully added. */
    success: boolean;
    /** Domain name that was added. */
    domain: string;
    /** Verification requirements, if any. */
    verification?: DomainVerification[];
    /** Error message if the domain could not be added. */
    error?: string;
    /** Error code if the domain could not be added. */
    errorCode?: VercelErrorCode;
}

export interface DomainConfig {
    /** Domain name. */
    name: string;
    /** Whether the domain is verified. */
    verified: boolean;
    /** Whether HTTPS is forced. */
    forceHttps: boolean;
    /** Whether to redirect to this domain. */
    redirect: boolean;
    /** Associated project ID, if any. */
    projectId?: string;
    /** Associated deployment ID, if any. */
    deploymentId?: string;
}

// ── Deployment log types (Issue #90) ─────────────────────────────────────────

/**
 * Raw event entry returned by the Vercel /v2/deployments/{id}/events API.
 */
export interface VercelDeploymentLogEvent {
    /** Event type (e.g. 'stdout', 'stderr', 'command', 'exit'). */
    type: string;
    /** Unix timestamp in milliseconds. */
    created: number;
    payload?: {
        /** Log line text. */
        text?: string;
        /** Severity level from Vercel ('error' | 'warning' | any). */
        level?: string;
    };
}

export interface GetDeploymentLogsOptions {
    /** Return only events after this Unix-ms timestamp (pagination cursor). */
    since?: number;
    /** Maximum number of log entries to return. */
    limit?: number;
}

export interface VercelDeploymentLogsResult {
    logs: import('@craft/types').DeploymentLogResponse[];
    /** Timestamp of the last entry — use as `since` for the next page. */
    nextCursor?: number;
}

// ── Config validation ─────────────────────────────────────────────────────────

export interface VercelConfigValidationResult {
    valid: boolean;
    /** Present when valid is false. */
    missing?: 'VERCEL_TOKEN';
}

/**
 * Validates that all required Vercel environment variables are present.
 * Call this at application startup or before the first deployment operation.
 */
export function validateVercelConfig(): VercelConfigValidationResult {
    if (!process.env.VERCEL_TOKEN) {
        return { valid: false, missing: 'VERCEL_TOKEN' };
    }
    return { valid: true };
}

// ── Service ───────────────────────────────────────────────────────────────────

interface FetchLike {
    (input: string, init?: RequestInit): Promise<Response>;
}

const vercelCircuitBreaker = new CircuitBreaker({ name: 'vercel' });

export class VercelService {
    constructor(
        private readonly _fetch: FetchLike = fetch,
        public readonly breaker: CircuitBreaker = vercelCircuitBreaker
    ) {}

    private get token(): string {
        return process.env.VERCEL_TOKEN ?? '';
    }

    private get teamId(): string | null {
        return process.env.VERCEL_TEAM_ID || null;
    }

    private buildHeaders(): Record<string, string> {
        if (!this.token) {
            throw new VercelApiError('VERCEL_TOKEN is not configured', 'AUTH_FAILED');
        }
        return {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
        };
    }

    /** Append ?teamId=... when a team scope is configured. */
    private url(path: string): string {
        const base = `${VERCEL_API_BASE}${path}`;
        return this.teamId ? `${base}?teamId=${this.teamId}` : base;
    }

    /**
     * Shared request helper — all Vercel API calls go through here.
     * Handles network errors, status-to-error-code mapping, and JSON parsing.
     */
    private async request<T = Record<string, unknown>>(
        path: string,
        init: RequestInit,
        /** Optional status code that should be treated as a specific error before assertOk. */
        earlyThrow?: { status: number; code: VercelErrorCode; message: string },
    ): Promise<T> {
        return this.breaker.call(async () => {
            const headers = this.buildHeaders(); // throws AUTH_FAILED if token missing

            let res: Response;
            try {
                res = await this._fetch(this.url(path), {
                    ...init,
                    headers: { ...headers, ...(init.headers ?? {}) },
                });
            } catch (err: unknown) {
                throw new VercelApiError(
                    err instanceof Error ? err.message : 'Network request failed',
                    'NETWORK_ERROR',
                );
            }

            const data = await res.json().catch(() => ({})) as Record<string, unknown>;

            if (earlyThrow && res.status === earlyThrow.status) {
                throw new VercelApiError(earlyThrow.message, earlyThrow.code);
            }

            this.assertOk(res, data);
            return data as T;
        });
    }

    /**
     * Create a Vercel project linked to a GitHub repository and configure
     * environment variables. Returns the created project record.
     */
    async createProject(request: CreateVercelProjectRequest): Promise<VercelProject> {
        const payload: Record<string, unknown> = {
            name: request.name,
            framework: request.framework ?? 'nextjs',
            gitRepository: { type: 'github', repo: request.gitRepo },
        };
        if (request.buildCommand) payload.buildCommand = request.buildCommand;
        if (request.outputDirectory) payload.outputDirectory = request.outputDirectory;

        const data = await this.request('/v9/projects', {
            method: 'POST',
            body: JSON.stringify(payload),
        }, {
            status: 409,
            code: 'PROJECT_EXISTS',
            message: `Vercel project "${request.name}" already exists`,
        });

        const project: VercelProject = {
            id: data.id as string,
            name: data.name as string,
            url: `${data.name as string}.vercel.app`,
        };

        if (request.envVars.length > 0) {
            await this.request(`/v9/projects/${project.id}/env`, {
                method: 'POST',
                body: JSON.stringify(request.envVars),
            });
        }

        return project;
    }

    /**
     * Trigger a new deployment for an existing Vercel project.
     * Returns the deployment ID and URL immediately — the build runs async.
     */
    async triggerDeployment(projectId: string, gitRepo: string): Promise<TriggerDeploymentResult> {
        const [owner, repo] = gitRepo.split('/');

        const data = await this.request('/v13/deployments', {
            method: 'POST',
            body: JSON.stringify({
                name: repo,
                gitSource: { type: 'github', org: owner, repo, ref: 'main' },
                projectSettings: { framework: 'nextjs' },
            }),
        });

        return {
            deploymentId: data.id as string,
            deploymentUrl: `https://${data.url as string}`,
            status: (data.status as string) ?? 'QUEUED',
        };
    }

    async listDeploymentAliases(deploymentId: string): Promise<VercelAlias[]> {
        const data = await this.request<{ aliases?: Array<Record<string, unknown>> }>(
            `/v2/deployments/${deploymentId}/aliases`,
            { method: 'GET' },
        );

        return (data.aliases ?? []).map((alias) => ({
            uid: alias.uid as string,
            alias: alias.alias as string,
            created: alias.created as string | undefined,
            redirect: (alias.redirect as string | null | undefined) ?? null,
        }));
    }

    /**
     * List all environment variables for a Vercel project.
     */
    async listEnvVars(projectId: string): Promise<Array<{ id: string; key: string; value: string; target: string[]; type: string }>> {
        type EnvResponse = {
            envs?: Array<{ id: string; key: string; value: string; target: string[]; type: string }>;
        };
        const data = await this.request<EnvResponse>(
            `/v9/projects/${projectId}/env`,
            { method: 'GET' },
        );

        return data.envs ?? [];
    }

    /**
     * Create a new environment variable on a Vercel project.
     */
    async createEnvVar(
        projectId: string,
        variable: { key: string; value: string; target: string[]; type: string }
    ): Promise<{ id: string; key: string; value: string; target: string[]; type: string }> {
        return this.request(
            `/v9/projects/${projectId}/env`,
            {
                method: 'POST',
                body: JSON.stringify(variable),
            },
        );
    }

    /**
     * Update an environment variable on a Vercel project.
     */
    async updateEnvVar(
        projectId: string,
        envId: string,
        patch: { value?: string; type?: string }
    ): Promise<{ id: string; key: string; value: string; target: string[]; type: string }> {
        return this.request(
            `/v9/projects/${projectId}/env/${envId}`,
            {
                method: 'PATCH',
                body: JSON.stringify(patch),
            },
        );
    }

    /**
     * Delete an environment variable from a Vercel project.
     */
    async deleteEnvVar(projectId: string, envId: string): Promise<void> {
        await this.request(
            `/v9/projects/${projectId}/env/${envId}`,
            { method: 'DELETE' },
        );
    }

    async assignAliasToDeployment(deploymentId: string, alias: string): Promise<VercelAlias> {
        const data = await this.request<Record<string, unknown>>(
            `/v2/deployments/${deploymentId}/aliases`,
            {
                method: 'POST',
                body: JSON.stringify({
                    alias,
                    redirect: null,
                }),
            },
        );

        return {
            uid: data.uid as string,
            alias: data.alias as string,
            created: data.created as string | undefined,
            redirect: (data.redirect as string | null | undefined) ?? null,
        };
    }


    /**
     * Verify that the configured token can reach the Vercel API.
     */
    async validateAccess(): Promise<boolean> {
        try {
            const res = await this._fetch(this.url('/v2/user'), {
                headers: this.buildHeaders(),
            });
            return res.ok;
        } catch {
            return false;
        }
    }

    /**
     * Add a custom domain to a Vercel project and trigger SSL provisioning.
     *
     * Vercel automatically begins certificate provisioning once the domain is
     * added. The caller should poll `getCertificate` to track progress.
     *
     * Throws DOMAIN_EXISTS (409) if the domain is already attached.
     */
    async addDomain(projectId: string, domain: string): Promise<void> {
        await this.request(`/v10/projects/${projectId}/domains`, {
            method: 'POST',
            body: JSON.stringify({ name: domain }),
        }, {
            status: 409,
            code: 'DOMAIN_EXISTS',
            message: `Domain "${domain}" is already added to project ${projectId}`,
        });
    }

    /**
     * Retrieve the SSL certificate state for a domain on a Vercel project.
     *
     * Maps Vercel's `certs` API response to a simplified `DomainCertificate`.
     * Returns `state: "pending"` when no certificate record exists yet.
     */
    async getCertificate(projectId: string, domain: string): Promise<DomainCertificate> {
        type CertResponse = {
            cns?: string[];
            expiresAt?: string;
            createdAt?: number;
            error?: { message: string };
        };

        let data: CertResponse;
        try {
            data = await this.request<CertResponse>(
                `/v7/projects/${projectId}/domains/${domain}/cert`,
                { method: 'GET' },
            );
        } catch (err: unknown) {
            const vercelErr = err as VercelApiError;
            // 404 means Vercel hasn't issued a cert yet — treat as pending
            if (
                vercelErr.code === 'UNKNOWN' &&
                (vercelErr.message.includes('404') || vercelErr.message.toLowerCase().includes('not found'))
            ) {
                return { domain, state: 'pending' };
            }
            throw err;
        }

        if (data.error) {
            return { domain, state: 'error', error: data.error.message };
        }

        if (data.expiresAt) {
            return { domain, state: 'active', expiresAt: data.expiresAt };
        }

        return { domain, state: 'pending' };
    }

    /**
     * Delete a Vercel project by ID (Issue #110).
     * Uses the shared request() helper for consistent error handling.
     * Logs errors but does not throw - best effort cleanup.
     */
    async deleteProject(projectId: string): Promise<void> {
        try {
            await this.request(`/v10/projects/${projectId}`, {
                method: 'DELETE',
            });
        } catch (error: any) {
            console.error(`Vercel project delete failed for ${projectId}:`, error.message);
            // Continue - DB deletion should succeed regardless
        }
    }

    // ── Deployment status retrieval (Issue #92) ──────────────────────────────

    /**
     * Get deployment details from Vercel.
     *
     * @param deploymentId - Vercel deployment ID
     * @returns Deployment details or null if not found
     */
    async getDeployment(deploymentId: string): Promise<VercelDeployment | null> {
        try {
            const data = await this.request(`/v13/deployments/${deploymentId}`, {
                method: 'GET',
            });

            return {
                id: data.id as string,
                name: data.name as string,
                url: data.url as string,
                status: (data.status as VercelDeploymentStatus) ?? 'QUEUED',
                createdAt: data.createdAt as number,
                ready: data.ready as number | undefined,
                canceled: data.canceled as number | undefined,
                error: data.error as number | undefined,
                projectId: data.projectId as string | undefined,
                projectName: data.projectName as string | undefined,
                meta: data.meta as Record<string, unknown> | undefined,
            };
        } catch (error: unknown) {
            if (error instanceof VercelApiError) {
                throw error;
            }
            throw new VercelApiError(
                error instanceof Error ? error.message : 'Failed to get deployment',
                'UNKNOWN',
            );
        }
    }

    /**
     * Get normalized deployment status from Vercel.
     * Maps Vercel deployment status to internal deployment states.
     *
     * @param deploymentId - Vercel deployment ID
     * @returns Normalized deployment status
     */
    async getDeploymentStatus(deploymentId: string): Promise<NormalizedDeploymentStatus> {
        const deployment = await this.getDeployment(deploymentId);

        if (!deployment) {
            throw new VercelApiError(
                `Deployment ${deploymentId} not found`,
                'UNKNOWN',
            );
        }

        return this.normalizeDeploymentStatus(deployment);
    }

    /**
     * Normalize Vercel deployment status to internal deployment states.
     *
     * @param deployment - Vercel deployment object
     * @returns Normalized deployment status
     */
    normalizeDeploymentStatus(deployment: VercelDeployment): NormalizedDeploymentStatus {
        let status: NormalizedDeploymentStatus['status'];

        switch (deployment.status) {
            case 'QUEUED':
                status = 'pending';
                break;
            case 'BUILDING':
                status = 'building';
                break;
            case 'READY':
                status = 'ready';
                break;
            case 'ERROR':
            case 'FAILED':
                status = 'failed';
                break;
            case 'CANCELED':
                status = 'canceled';
                break;
            default:
                status = 'pending';
        }

        const normalized: NormalizedDeploymentStatus = {
            status,
            url: `https://${deployment.url}`,
            deploymentId: deployment.id,
            createdAt: new Date(deployment.createdAt),
            projectId: deployment.projectId,
            projectName: deployment.projectName,
        };

        if (deployment.ready) {
            normalized.readyAt = new Date(deployment.ready);
        }

        if (deployment.error) {
            normalized.failedAt = new Date(deployment.error);
            normalized.errorMessage = 'Deployment failed';
        }

        if (deployment.canceled) {
            normalized.canceledAt = new Date(deployment.canceled);
        }

        return normalized;
    }

    /**
     * List deployments for a project.
     *
     * @param projectId - Vercel project ID
     * @param limit - Maximum number of deployments to return (default: 10)
     * @returns List of deployments
     */
    async listDeployments(projectId: string, limit: number = 10): Promise<VercelDeployment[]> {
        try {
            const data = await this.request(`/v6/deployments?projectId=${projectId}&limit=${limit}`, {
                method: 'GET',
            });

            const deployments = (data.deployments as Array<Record<string, unknown>>) ?? [];

            return deployments.map((d) => ({
                id: d.id as string,
                name: d.name as string,
                url: d.url as string,
                status: (d.status as VercelDeploymentStatus) ?? 'QUEUED',
                createdAt: d.createdAt as number,
                ready: d.ready as number | undefined,
                canceled: d.canceled as number | undefined,
                error: d.error as number | undefined,
                projectId: d.projectId as string | undefined,
                projectName: d.projectName as string | undefined,
                meta: d.meta as Record<string, unknown> | undefined,
            }));
        } catch (error: unknown) {
            if (error instanceof VercelApiError) {
                throw error;
            }
            throw new VercelApiError(
                error instanceof Error ? error.message : 'Failed to list deployments',
                'UNKNOWN',
            );
        }
    }

    // ── Domain configuration (Issue #91) ─────────────────────────────────────

    /**
     * Add a domain to a Vercel project or deployment.
     * Returns verification requirements for DNS setup.
     *
     * @param request - Domain configuration request
     * @returns Result with verification requirements or error details
     */
    async addDomain(request: AddDomainRequest): Promise<AddDomainResult> {
        const payload: Record<string, unknown> = {
            name: request.domain,
        };

        if (request.projectId) {
            payload.projectId = request.projectId;
        }

        if (request.deploymentId) {
            payload.deploymentId = request.deploymentId;
        }

        if (request.redirect !== undefined) {
            payload.redirect = request.redirect;
        }

        if (request.forceHttps !== undefined) {
            payload.forceHttps = request.forceHttps;
        }

        try {
            const data = await this.request('/v4/domains', {
                method: 'POST',
                body: JSON.stringify(payload),
            }, {
                status: 409,
                code: 'DOMAIN_ALREADY_EXISTS',
                message: `Domain "${request.domain}" already exists`,
            });

            const verification = (data.verification as Array<Record<string, unknown>>)?.map((v) => ({
                domain: v.domain as string,
                type: v.type as string,
                value: v.value as string,
                name: v.name as string,
            }));

            return {
                success: true,
                domain: request.domain,
                verification: verification?.length ? verification : undefined,
            };
        } catch (error: unknown) {
            if (error instanceof VercelApiError) {
                return {
                    success: false,
                    domain: request.domain,
                    error: error.message,
                    errorCode: error.code,
                };
            }
            return {
                success: false,
                domain: request.domain,
                error: error instanceof Error ? error.message : 'Unknown error',
                errorCode: 'UNKNOWN',
            };
        }
    }

    /**
     * Remove a domain from a Vercel project.
     *
     * @param domain - Domain name to remove
     * @param projectId - Project ID to remove the domain from
     */
    async removeDomain(domain: string, projectId: string): Promise<void> {
        try {
            await this.request(`/v4/domains/${domain}`, {
                method: 'DELETE',
            });
        } catch (error: unknown) {
            if (
                error instanceof VercelApiError &&
                (error.code === 'DOMAIN_NOT_FOUND' || error.message.toLowerCase().includes('not found'))
            ) {
                // Domain doesn't exist, which is fine for cleanup
                return;
            }
            console.error(`Vercel domain delete failed for ${domain}:`, error);
            // Continue - DB deletion should succeed regardless
        }
    }

    /**
     * Get domain configuration and verification status.
     *
     * @param domain - Domain name to query
     * @returns Domain configuration details
     */
    async getDomainConfig(domain: string): Promise<DomainConfig | null> {
        try {
            const data = await this.request(`/v4/domains/${domain}`, {
                method: 'GET',
            });

            return {
                name: data.name as string,
                verified: data.verified as boolean,
                forceHttps: data.forceHttps as boolean,
                redirect: data.redirect as boolean,
                projectId: data.projectId as string | undefined,
                deploymentId: data.deploymentId as string | undefined,
            };
        } catch (error: unknown) {
            if (
                error instanceof VercelApiError &&
                (error.code === 'DOMAIN_NOT_FOUND' || error.message.toLowerCase().includes('not found'))
            ) {
                return null;
            }
            throw error;
        }
    }

    /**
     * List all domains attached to a Vercel project.
     *
     * @param projectId - Vercel project ID
     * @returns Array of domain configs for the project
     */
    async listDomains(projectId: string): Promise<DomainConfig[]> {
        const data = await this.request<{ domains: Array<Record<string, unknown>> }>(
            `/v9/projects/${projectId}/domains`,
            { method: 'GET' },
        );

        return (data.domains ?? []).map((d) => ({
            name: d.name as string,
            verified: d.verified as boolean,
            forceHttps: (d.forceHttps ?? false) as boolean,
            redirect: (d.redirect ?? false) as boolean,
            projectId: d.projectId as string | undefined,
            deploymentId: d.deploymentId as string | undefined,
        }));
    }

    /**
     * Verify domain ownership by checking DNS records.
     *
     * @param domain - Domain name to verify
     * @returns Verification status and requirements
     */
    async verifyDomain(domain: string): Promise<{
        verified: boolean;
        requirements?: DomainVerification[];
    }> {
        try {
            const data = await this.request(`/v4/domains/${domain}/verify`, {
                method: 'POST',
            });

            const verification = (data.verification as Array<Record<string, unknown>>)?.map((v) => ({
                domain: v.domain as string,
                type: v.type as string,
                value: v.value as string,
                name: v.name as string,
            }));

            return {
                verified: data.verified as boolean,
                requirements: verification?.length ? verification : undefined,
            };
        } catch (error: unknown) {
            if (error instanceof VercelApiError) {
                throw error;
            }
            throw new VercelApiError(
                error instanceof Error ? error.message : 'Domain verification failed',
                'UNKNOWN',
            );
        }
    }

    /**
     * Assign a custom alias to a Vercel deployment.
     */
    async assignAlias(deploymentId: string, alias: string): Promise<void> {
        await this.request(`/v2/deployments/${deploymentId}/aliases`, {
            method: 'POST',
            body: JSON.stringify({ alias }),
        });
    }

    // ── Private helpers ───────────────────────────────────────────────────────


    // ── Deployment log retrieval (Issue #90) ─────────────────────────────────

    /**
     * Fetch build and runtime log events for a Vercel deployment.
     *
     * Calls GET /v2/deployments/{id}/events and normalises each event into the
     * platform's `DeploymentLogResponse` shape.  Supports incremental retrieval
     * via the `since` cursor (Unix-ms timestamp of the last seen event).
     *
     * Level mapping:
     *   Vercel "error"   → LogLevel "error"
     *   Vercel "warning" → LogLevel "warn"
     *   anything else    → LogLevel "info"
     *
     * @param deploymentId - Vercel deployment ID
     * @param options      - Optional `since` cursor and `limit`
     */
    async getDeploymentLogs(
        deploymentId: string,
        options: GetDeploymentLogsOptions = {},
    ): Promise<VercelDeploymentLogsResult> {
        const params = new URLSearchParams();
        if (options.since !== undefined) params.set('since', String(options.since));
        if (options.limit !== undefined) params.set('limit', String(options.limit));

        const qs = params.toString();
        const path = `/v2/deployments/${deploymentId}/events${qs ? `?${qs}` : ''}`;

        const data = await this.request<{ events?: VercelDeploymentLogEvent[] }>(path, {
            method: 'GET',
        });

        const events: VercelDeploymentLogEvent[] = data.events ?? (data as unknown as VercelDeploymentLogEvent[]);
        const entries = Array.isArray(events) ? events : [];

        const logs: import('@craft/types').DeploymentLogResponse[] = entries.map((event) => {
            const text = event.payload?.text ?? '';
            const rawLevel = event.payload?.level ?? '';

            let level: import('@craft/types').LogLevel;
            if (rawLevel === 'error') {
                level = 'error';
            } else if (rawLevel === 'warning') {
                level = 'warn';
            } else {
                level = 'info';
            }

            return {
                id: `${deploymentId}-${event.created}`,
                deploymentId,
                timestamp: new Date(event.created).toISOString(),
                level,
                message: text,
            };
        });

        const nextCursor = entries.length > 0
            ? entries[entries.length - 1].created
            : undefined;

        return { logs, nextCursor };
    }

    private assertOk(res: Response, data: Record<string, unknown>): void {
        if (res.ok) return;

        const message = (data.error as Record<string, unknown>)?.message as string
            ?? data.message as string
            ?? `Vercel API error: ${res.status}`;

        const code = (data.error as Record<string, unknown>)?.code as string
            ?? data.code as string
            ?? (res.status === 404 ? 'NOT_FOUND' : 'UNKNOWN');

        if (res.status === 401 || res.status === 403) {
            throw new VercelApiError(message, 'AUTH_FAILED');
        }

        if (res.status === 429) {
            const retryAfterSec = parseInt(res.headers.get('Retry-After') ?? '0', 10);
            throw new VercelApiError(message, 'RATE_LIMITED', retryAfterSec * 1000);
        }

        throw new VercelApiError(message, code as VercelErrorCode);
    }
}

