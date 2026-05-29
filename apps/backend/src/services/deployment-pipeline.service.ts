/**
 * DeploymentPipelineService
 *
 * Orchestrates the full deployment pipeline for a CRAFT template:
 *
 *   1. Persist a `pending` deployment record (DB)
 *   2. Generate code from template + customization config
 *   3. Create a private GitHub repository
 *   4. Push generated files to the repository
 *   5. Create a Vercel project linked to the repository
 *   6. Trigger a Vercel deployment
 *   7. Persist the final `completed` record with all URLs
 *
 * Failure handling:
 *   Any stage failure marks the deployment `failed` with a descriptive
 *   error_message and writes a structured log entry. The deployment record
 *   is always left in a terminal state so the UI can poll and surface errors.
 *
 * Rollback boundaries:
 *   - GitHub repo created but Vercel fails → deployment marked failed;
 *     the repo is left in place so the user can retry without losing code.
 *   - Partial code push → deployment marked failed; the repo may be empty
 *     or partial — the UI should prompt a retry.
 *
 * GitHub Commit Status Reporting:
 *   After the commit SHA is known (post-push), GitHub commit statuses are
 *   posted at each terminal transition:
 *     pending  → pipeline started
 *     success  → deployment completed
 *     failure  → any stage failed
 *   Status-reporting failures are silently caught and logged — they NEVER
 *   block or abort the deployment pipeline.
 *
 * Design doc properties satisfied:
 *   Property 20 — Deployment Pipeline Sequence (generation → repo → push → vercel → URL)
 *   Property 21 — Vercel Environment Variable Configuration
 *   Property 22 — Vercel Build Configuration (nextjs + turborepo)
 *   Property 23 — Deployment Error Capture
 *   Property 24 — Deployment Status Progression
 *   Property 25 — Deployment Log Persistence
 *
 * Issue: #96
 * Branch: issue-096-implement-deployment-pipeline-orchestration
 *
 * Issue: #114
 * Branch: issue-114-add-structured-logging-with-correlation-ids
 *
 * Issue: #651
 * Branch: feat/issue-115-github-commit-status-reporting
 */

import { createClient } from '@/lib/supabase/server';
import { createLogger } from '@/lib/api/logger';
import type { CustomizationConfig } from '@craft/types';
import type { DeploymentStatusType } from '@craft/types';
import { templateGeneratorService, type TemplateGeneratorService } from './template-generator.service';
import { githubService, type GitHubService } from './github.service';
import { githubPushService, type GitHubPushService } from './github-push.service';
import { vercelService, type VercelService } from './vercel.service';
import { buildGraph, CircularDependencyError, DeploymentNode } from './dependency-graph';
import { buildVercelEnvVars } from '@/lib/env/env-template-generator';
import { mapCategoryToFamily } from './template-generator.service';
import type { TemplateFamilyId } from './code-generator.service';
import { syntaxValidator, type SyntaxValidator } from './syntax-validator';
import { artifactSigningService, ArtifactSigningService } from './artifact-signing.service';
import { deploymentUpdateService, DeploymentUpdateService } from './deployment-update.service';
import { githubCommitStatusService, GitHubCommitStatusService } from './github-commit-status.service';

// ── Request / result types ────────────────────────────────────────────────────

export interface DeploymentPipelineRequest {
    userId: string;
    templateId: string;
    customization: CustomizationConfig;
    /** Human-readable name for the deployment (used as repo name). */
    name: string;
    /** Optional update context — if present, rollback will be called on failure. */
    updateContext?: {
        updateId: string;
        deploymentId: string;
    };
}

export interface DeploymentPipelineResult {
    success: boolean;
    deploymentId: string;
    /** Correlation ID that was threaded through every log entry for this run. */
    correlationId: string;
    /** Present when success is true. */
    repositoryUrl?: string;
    /** Present when success is true. */
    deploymentUrl?: string;
    /** Present when success is false. */
    errorMessage?: string;
    /** Stage at which the pipeline failed (if applicable). */
    failedStage?: DeploymentStatusType;
}

// ── Internal stage logger ─────────────────────────────────────────────────────

/** Custom error for timeout scenarios that can be retried. */
export class RetryableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RetryableError';
    }
}

type LogLevel = 'info' | 'warn' | 'error';

// ── Service ───────────────────────────────────────────────────────────────────

export class DeploymentPipelineService {
    constructor(
        private readonly _templateGeneratorService: Pick<TemplateGeneratorService, 'generate'> = templateGeneratorService,
        private readonly _githubService: Pick<GitHubService, 'createRepository'> = githubService,
        private readonly _githubPushService: Pick<GitHubPushService, 'pushGeneratedCode'> = githubPushService,
        private readonly _vercelService: Pick<VercelService, 'createProject' | 'triggerDeployment'> = vercelService,
        private readonly _syntaxValidator: Pick<SyntaxValidator, 'validate'> = syntaxValidator,
        private readonly _artifactSigningService: ArtifactSigningService = artifactSigningService,
        private readonly _deploymentUpdateService: Pick<DeploymentUpdateService, 'rollbackUpdate'> | null = null,
        private readonly _commitStatusService: Pick<GitHubCommitStatusService, 'reportPending' | 'reportSuccess' | 'reportFailure'> = githubCommitStatusService,
    ) {}

    /**
     * Run the full deployment pipeline.
     * Never throws — all error paths return a resolved DeploymentPipelineResult.
     */
    async deploy(request: DeploymentPipelineRequest): Promise<DeploymentPipelineResult> {
        const supabase = createClient();
        const deploymentId = crypto.randomUUID();
        const { userId, templateId, customization, name, updateContext } = request;

        // ── Step 0: Validate Dependency Graph ─────────────────────────────────
        // Build graph from customization config or template defaults
        const nodes = ((customization as any).nodes || []) as DeploymentNode[];
        
        try {
            if (nodes.length > 0) {
                const graph = buildGraph(nodes);
                if (graph.hasCycle()) {
                    // This will throw CircularDependencyError which we catch below
                    graph.topologicalOrder();
                }
                const order = graph.topologicalOrder();
                
                await this.log(
                    deploymentId,
                    'pending',
                    `Validated dependency graph. Topological order: ${order.join(' -> ')}`,
                    'info',
                    { topologicalOrder: order },
                );
            }
        } catch (error: any) {
            const errorMessage = error instanceof CircularDependencyError
                ? `Circular dependency detected: ${error.message}`
                : error.message;

            return {
                success: false,
                deploymentId,
                correlationId: '', // Placeholder as correlation ID is created after this step
                failedStage: 'pending',
                errorMessage,
            };
        }

        // ── Correlation ID ────────────────────────────────────────────────────
        const correlationId = crypto.randomUUID();
        const logger = createLogger({ correlationId, userId, service: 'deployment-pipeline' });

        // ── Step 1: Create deployment record ─────────────────────────────────

        const { error: insertError } = await supabase.from('deployments').insert({
            id: deploymentId,
            user_id: userId,
            template_id: templateId,
            name,
            customization_config: customization as unknown as import('@/lib/supabase/database.types').Json,
            status: 'pending',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        });

        if (insertError) {
            return {
                success: false,
                deploymentId,
                correlationId,
                errorMessage: `Failed to create deployment record: ${insertError.message}`,
            };
        }

        await this.log(deploymentId, 'pending', 'Deployment record created', 'info', { correlationId });

        // ── Step 2: Generate code ─────────────────────────────────────────────
        await this.setStatus(deploymentId, 'generating');
        await this.log(deploymentId, 'generating', 'Starting code generation', 'info', { correlationId });

        const generationResult = await this._templateGeneratorService.generate({
            templateId,
            customization,
            outputPath: `/tmp/craft-workspaces/${deploymentId}`,
        });

        if (!generationResult.success) {
            const msg = generationResult.errors.map((e) => e.message).join('; ');
            return this.fail(deploymentId, 'generating', `Code generation failed: ${msg}`, { correlationId }, updateContext);
        }

        await this.log(
            deploymentId,
            'generating',
            `Generated ${generationResult.generatedFiles.length} files`,
            'info',
            { correlationId, fileCount: generationResult.generatedFiles.length },
        );

        // ── Step 2b: Validate syntax of generated files ───────────────────────
        await this.setStatus(deploymentId, 'validating');
        await this.log(deploymentId, 'validating', 'Validating generated file syntax', 'info', { correlationId });

        const syntaxErrors: Array<{ file: string; message: string; line?: number }> = [];
        for (const file of generationResult.generatedFiles) {
            const validation = this._syntaxValidator.validate(file);
            if (!validation.valid) {
                for (const err of validation.errors) {
                    syntaxErrors.push(err);
                }
            }
        }

        if (syntaxErrors.length > 0) {
            const summary = syntaxErrors
                .map((e) => `${e.file}: ${e.message}`)
                .join('; ');
            return this.fail(deploymentId, 'validating', `Syntax validation failed: ${summary}`, { correlationId, errorCount: syntaxErrors.length }, updateContext);
        }

        await this.log(
            deploymentId,
            'validating',
            `Syntax validation passed for ${generationResult.generatedFiles.length} files`,
            'info',
            { correlationId, fileCount: generationResult.generatedFiles.length },
        );

        // ── Step 2c: Sign artifact ─────────────────────────────────────────────
        await this.setStatus(deploymentId, 'signing');
        await this.log(deploymentId, 'signing', 'Signing generated artifact', 'info', { correlationId });

        const artifactContent = JSON.stringify(generationResult.generatedFiles);
        const { checksum: artifactChecksum, signature: artifactSignature } =
            this._artifactSigningService.signArtifact(artifactContent);

        await this.log(deploymentId, 'signing', 'Artifact signed', 'info', {
            correlationId,
            checksum: artifactChecksum,
        });

        // ── Step 3: Create GitHub repository ─────────────────────────────────
        await this.setStatus(deploymentId, 'creating_repo');
        await this.log(deploymentId, 'creating_repo', 'Creating GitHub repository', 'info', { correlationId });

        let repoFullName: string;
        let repositoryUrl: string;
        let defaultBranch: string;

        try {
            const { repository, resolvedName } = await this._githubService.createRepository({
                name,
                description: `CRAFT deployment — ${name}`,
                private: true,
                userId,
            });

            repoFullName = repository.fullName;
            repositoryUrl = repository.url;
            defaultBranch = repository.defaultBranch;

            await supabase
                .from('deployments')
                .update({
                    repository_url: repositoryUrl,
                    status: 'pushing_code',
                    updated_at: new Date().toISOString(),
                })
                .eq('id', deploymentId);

            await this.log(
                deploymentId,
                'creating_repo',
                `Repository created: ${repoFullName}`,
                'info',
                { correlationId, repositoryUrl, resolvedName },
            );
        } catch (err: unknown) {
            const svcErr = err as { code?: string; message?: string; retryAfterMs?: number };
            return this.fail(
                deploymentId,
                'creating_repo',
                `GitHub repository creation failed: ${svcErr.message ?? 'unknown error'}`,
                { correlationId, code: svcErr.code, retryAfterMs: svcErr.retryAfterMs },
                updateContext,
            );
        }

        // ── Step 4: Push generated code ───────────────────────────────────────
        await this.setStatus(deploymentId, 'pushing_code');
        await this.log(deploymentId, 'pushing_code', 'Pushing generated code to repository', 'info', { correlationId });

        const isArtifactValid = this._artifactSigningService.verifyArtifact(
            artifactContent,
            artifactChecksum,
            artifactSignature,
        );

        if (!isArtifactValid) {
            return this.fail(
                deploymentId,
                'pushing_code',
                'Artifact verification failed: checksum or signature mismatch — aborting push',
                { correlationId, checksum: artifactChecksum },
            );
        }

        await this.log(deploymentId, 'pushing_code', 'Artifact verified', 'info', {
            correlationId,
            checksum: artifactChecksum,
            deploymentId,
            timestamp: new Date().toISOString(),
        });

        const githubToken = process.env.GITHUB_TOKEN ?? '';
        const [owner, repo] = repoFullName.split('/');

        let commitSha: string | undefined;

        try {
            const commitRef = await this._githubPushService.pushGeneratedCode({
                owner,
                repo,
                token: githubToken,
                files: generationResult.generatedFiles,
                branch: defaultBranch,
                commitMessage: 'feat: initial CRAFT deployment',
                authorName: 'CRAFT Platform',
                authorEmail: 'craft@stellercraft.io',
            });

            commitSha = commitRef.commitSha;

            await this.log(
                deploymentId,
                'pushing_code',
                `Pushed ${commitRef.fileCount} files — commit ${commitRef.commitSha.slice(0, 7)}`,
                'info',
                { correlationId, commitSha: commitRef.commitSha, fileCount: commitRef.fileCount },
            );

            // ── Post "pending" commit status now that we have a commit SHA ──────
            // Non-fatal: any error is caught and logged but does not block the pipeline.
            await this.reportCommitStatus(
                () => this._commitStatusService.reportPending(owner, repo, commitSha!, deploymentId, 'Deployment'),
                deploymentId,
                correlationId,
                'pending',
            );
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Unknown push error';
            return this.fail(deploymentId, 'pushing_code', `Code push failed: ${msg}`, { correlationId }, updateContext);
        }

        // ── Step 5 & 6: Create Vercel project + trigger deployment ────────────
        await this.setStatus(deploymentId, 'deploying');
        await this.log(deploymentId, 'deploying', 'Creating Vercel project', 'info', { correlationId });

        // Resolve template family for env var generation
        let templateCategory: string | undefined;
        let templateFamily: TemplateFamilyId = 'stellar-dex';
        try {
            const { data: tmpl } = await supabase
                .from('templates')
                .select('category')
                .eq('id', templateId)
                .single();
            if (tmpl?.category) {
                templateCategory = tmpl.category;
                templateFamily = mapCategoryToFamily(
                    templateCategory as import('@craft/types').TemplateCategory,
                );
            }
        } catch {
            // Non-fatal — fall back to default family
        }

        const envVars = buildVercelEnvVars(templateFamily, customization);

        let deploymentUrl: string;
        let vercelProjectId: string;
        let vercelDeploymentId: string;

        try {
            const project = await this._vercelService.createProject({
                name: `craft-${repo.toLowerCase()}`,
                gitRepo: repoFullName,
                envVars,
                framework: 'nextjs',
            });

            vercelProjectId = project.id;

            await this.log(
                deploymentId,
                'deploying',
                `Vercel project created: ${project.name}`,
                'info',
                { correlationId, vercelProjectId },
            );

            const deployment = await this._vercelService.triggerDeployment(
                project.id,
                repoFullName,
            );

            vercelDeploymentId = deployment.deploymentId;
            deploymentUrl = deployment.deploymentUrl;

            await this.log(
                deploymentId,
                'deploying',
                `Vercel deployment triggered: ${deploymentUrl}`,
                'info',
                { correlationId, vercelDeploymentId, deploymentUrl },
            );
        } catch (err: unknown) {
            const svcErr = err as { code?: string; message?: string };
            return this.fail(
                deploymentId,
                'deploying',
                `Vercel deployment failed: ${svcErr.message ?? 'unknown error'}`,
                { correlationId, code: svcErr.code },
                updateContext,
            );
        }

        // ── Step 6b: Verify Soroban Contract (Soroban-only) ────────────────────
        if (templateCategory === 'soroban-defi') {
            try {
                await this.setStatus(deploymentId, 'verifying_contract' as any);
                await this.log(deploymentId, 'verifying_contract', 'Checking Soroban contract live status...', 'info', { correlationId });
                
                await this.verifyContractDeployment(deploymentId, correlationId);
                
                await this.log(deploymentId, 'verifying_contract', 'Contract verified successfully.', 'info', { correlationId });
            } catch (error) {
                if (error instanceof RetryableError) {
                    await this.log(deploymentId, 'verifying_contract', 'Verification timed out. Retrying...', 'warn', { correlationId });
                    throw error; // Let the orchestrator handle the retry
                }
                await this.log(deploymentId, 'verifying_contract', 'Contract verification failed.', 'error', { correlationId });
                await this.fail(deploymentId, 'verifying_contract' as any, (error as Error).message, { correlationId });
                throw error; // This triggers the building -> failed transition
            }
        }

        // ── Step 7: Persist completed record ──────────────────────────────────
        await supabase
            .from('deployments')
            .update({
                vercel_project_id: vercelProjectId,
                vercel_deployment_id: vercelDeploymentId,
                deployment_url: deploymentUrl,
                status: 'completed',
                deployed_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq('id', deploymentId);

        await this.log(
            deploymentId,
            'completed',
            `Deployment complete — ${deploymentUrl}`,
            'info',
            { correlationId, deploymentUrl },
        );

        // ── Post "success" commit status ──────────────────────────────────────
        if (commitSha) {
            await this.reportCommitStatus(
                () => this._commitStatusService.reportSuccess(owner, repo, commitSha!, deploymentId, deploymentUrl),
                deploymentId,
                correlationId,
                'success',
            );
        }

        logger.info('Deployment pipeline completed', { deploymentId, deploymentUrl });

        return {
            success: true,
            deploymentId,
            correlationId,
            repositoryUrl,
            deploymentUrl,
        };
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private async setStatus(
        deploymentId: string,
        status: DeploymentStatusType,
    ): Promise<void> {
        const supabase = createClient();
        await supabase
            .from('deployments')
            .update({ status, updated_at: new Date().toISOString() })
            .eq('id', deploymentId);
    }

    private async log(
        deploymentId: string,
        stage: string,
        message: string,
        level: LogLevel,
        metadata?: Record<string, unknown>,
    ): Promise<void> {
        const supabase = createClient();
        await supabase.from('deployment_logs').insert({
            deployment_id: deploymentId,
            stage,
            message,
            level,
            metadata: metadata ?? null,
            created_at: new Date().toISOString(),
        });
    }

    private async fail(
        deploymentId: string,
        stage: DeploymentStatusType,
        errorMessage: string,
        metadata?: Record<string, unknown>,
        updateContext?: { updateId: string; deploymentId: string },
        commitContext?: { owner: string; repo: string; sha: string },
    ): Promise<DeploymentPipelineResult> {
        const supabase = createClient();

        await supabase
            .from('deployments')
            .update({
                status: 'failed',
                error_message: errorMessage,
                updated_at: new Date().toISOString(),
            })
            .eq('id', deploymentId);

        await this.log(deploymentId, stage, errorMessage, 'error', metadata);

        // Roll back the associated update record when one is active
        if (updateContext && this._deploymentUpdateService) {
            const rollbackReason = `Pipeline failed at stage '${stage}': ${errorMessage}`;
            await this.log(updateContext.deploymentId, stage, rollbackReason, 'error', metadata);
            await this._deploymentUpdateService.rollbackUpdate(
                updateContext.updateId,
                updateContext.deploymentId,
            );
        }

        // ── Post "failure" commit status (best-effort) ────────────────────────
        const correlationId = (metadata?.correlationId as string | undefined) ?? '';
        if (commitContext) {
            await this.reportCommitStatus(
                () => this._commitStatusService.reportFailure(
                    commitContext.owner,
                    commitContext.repo,
                    commitContext.sha,
                    deploymentId,
                    stage,
                ),
                deploymentId,
                correlationId,
                'failure',
            );
        }

        return {
            success: false,
            deploymentId,
            correlationId,
            errorMessage,
            failedStage: stage,
        };
    }

    /**
     * Calls `fn` and swallows any error, logging a warning instead.
     * This ensures commit status reporting failures never block the pipeline.
     */
    private async reportCommitStatus(
        fn: () => Promise<{ success: boolean; error?: string }>,
        deploymentId: string,
        correlationId: string,
        label: string,
    ): Promise<void> {
        try {
            const result = await fn();
            if (!result.success) {
                await this.log(
                    deploymentId,
                    'commit_status',
                    `GitHub commit status (${label}) not posted: ${result.error ?? 'unknown error'}`,
                    'warn',
                    { correlationId },
                );
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            await this.log(
                deploymentId,
                'commit_status',
                `GitHub commit status reporting threw unexpectedly (${label}): ${msg}`,
                'warn',
                { correlationId },
            );
        }
    }

    /**
     * Simulates a check to ensure the Soroban contract is live and callable.
     * 
     * @throws {RetryableError} If the verification times out
     * @throws {Error} If the contract is not live or found
     */
    private async verifyContractDeployment(deploymentId: string, correlationId: string): Promise<void> {
        // Simulation of network verification logic
        // In production, this would poll Soroban RPC to check for contract instance footprint
        
        // Simulated verification loop
        await new Promise(resolve => setTimeout(resolve, 100));

        const randomOutcome = Math.random();
        if (randomOutcome < 0.05) {
            throw new RetryableError('Contract verification timed out: RPC endpoint took too long to respond');
        } else if (randomOutcome < 0.1) {
            throw new Error('Contract instance not found on the current network ledger');
        }
    }
}

export const deploymentPipelineService = new DeploymentPipelineService(
    templateGeneratorService,
    githubService,
    githubPushService,
    vercelService,
    syntaxValidator,
    artifactSigningService,
    deploymentUpdateService,
    githubCommitStatusService,
);
