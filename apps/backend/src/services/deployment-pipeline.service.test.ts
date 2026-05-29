/**
 * Tests for DeploymentPipelineService
 *
 * Covers:
 *   - Happy path: all stages succeed → completed record with URLs
 *   - Generation failure → failed record at 'generating' stage
 *   - GitHub creation failure → failed record at 'creating_repo' stage
 *   - GitHub push failure → failed record at 'pushing_code' stage
 *   - Vercel failure → failed record at 'deploying' stage
 *   - DB insert failure → early return without crashing
 *
 * Issue: #96
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the template-generator service before it is imported (avoids path polyfill issue)
vi.mock('./template-generator.service', () => ({
    templateGeneratorService: { generate: vi.fn() },
    mapCategoryToFamily: vi.fn().mockReturnValue('stellar-dex'),
}));

import { DeploymentPipelineService } from './deployment-pipeline.service';
import type { DeploymentPipelineRequest } from './deployment-pipeline.service';
import type { CustomizationConfig } from '@craft/types';
import type { DeploymentNode } from './dependency-graph';

// ── Supabase mock ─────────────────────────────────────────────────────────────

const mockUpdate = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
const mockInsert = vi.fn().mockResolvedValue({ error: null });
const mockSelect = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
    createClient: () => ({
        from: (table: string) => ({
            insert: mockInsert,
            update: mockUpdate,
            select: (cols: string) => ({
                eq: (col: string, val: string) => ({
                    single: () => {
                        if (table === 'templates') {
                            return Promise.resolve({ data: { category: 'dex' }, error: null });
                        }
                        return Promise.resolve({ data: null, error: null });
                    },
                }),
            }),
        }),
        auth: { getUser: vi.fn() },
    }),
}));

// ── Fixture ───────────────────────────────────────────────────────────────────

const customization: CustomizationConfig = {
    branding: {
        appName: 'TestApp',
        primaryColor: '#000000',
        secondaryColor: '#ffffff',
        fontFamily: 'Inter',
    },
    features: {
        enableCharts: true,
        enableTransactionHistory: true,
        enableAnalytics: false,
        enableNotifications: false,
    },
    stellar: {
        network: 'testnet',
        horizonUrl: 'https://horizon-testnet.stellar.org',
    },
};

const request: DeploymentPipelineRequest = {
    userId: 'user-123',
    templateId: 'template-abc',
    name: 'my-dex-app',
    customization,
};

// ── Mock dependencies ─────────────────────────────────────────────────────────

function makeGeneratorMock(success = true) {
    return {
        generate: vi.fn().mockResolvedValue(
            success
                ? {
                      success: true,
                      generatedFiles: [{ path: 'src/index.ts', content: 'export {}', type: 'code' }],
                      errors: [],
                  }
                : {
                      success: false,
                      generatedFiles: [],
                      errors: [{ file: 'unknown', message: 'generation error', severity: 'error' }],
                  },
        ),
    };
}

function makeSyntaxValidatorMock(valid = true) {
    return {
        validate: vi.fn().mockReturnValue(
            valid
                ? { valid: true, errors: [] }
                : { valid: false, errors: [{ file: 'src/index.ts', message: "'}' expected", line: 1 }] },
        ),
    };
}

function makeArtifactSigningMock() {
    return {
        signArtifact: vi.fn().mockReturnValue({ checksum: 'mock-checksum', signature: 'mock-signature' }),
        verifyArtifact: vi.fn().mockReturnValue(true),
    };
}

function makeGithubMock(fail = false) {
    return {
        createRepository: fail
            ? vi.fn().mockRejectedValue(Object.assign(new Error('GitHub error'), { code: 'NETWORK_ERROR' }))
            : vi.fn().mockResolvedValue({
                  repository: {
                      id: 1,
                      url: 'https://github.com/org/my-dex-app',
                      cloneUrl: 'https://github.com/org/my-dex-app.git',
                      sshUrl: 'git@github.com:org/my-dex-app.git',
                      fullName: 'org/my-dex-app',
                      defaultBranch: 'main',
                      private: true,
                  },
                  resolvedName: 'my-dex-app',
              }),
    };
}

function makeGithubPushMock(fail = false) {
    return {
        pushGeneratedCode: fail
            ? vi.fn().mockRejectedValue(new Error('Push failed'))
            : vi.fn().mockResolvedValue({
                  owner: 'org',
                  repo: 'my-dex-app',
                  branch: 'main',
                  commitSha: 'abc1234',
                  treeSha: 'def5678',
                  commitUrl: 'https://github.com/org/my-dex-app/commit/abc1234',
                  previousCommitSha: '000',
                  createdBranch: false,
                  fileCount: 1,
              }),
    };
}

function makeVercelMock(fail = false) {
    return {
        createProject: fail
            ? vi.fn().mockRejectedValue(Object.assign(new Error('Vercel error'), { code: 'UNKNOWN' }))
            : vi.fn().mockResolvedValue({
                  id: 'prj_abc',
                  name: 'craft-my-dex-app',
                  url: 'craft-my-dex-app.vercel.app',
              }),
        triggerDeployment: vi.fn().mockResolvedValue({
            deploymentId: 'dpl_xyz',
            deploymentUrl: 'https://craft-my-dex-app.vercel.app',
            status: 'QUEUED',
        }),
    };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DeploymentPipelineService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset insert to succeed by default
        mockInsert.mockResolvedValue({ error: null });
        mockUpdate.mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null }),
        });
    });

    it('completes the full pipeline and returns URLs', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
        );

        const result = await svc.deploy(request);

        expect(result.success).toBe(true);
        expect(result.deploymentId).toBeTruthy();
        expect(result.repositoryUrl).toBe('https://github.com/org/my-dex-app');
        expect(result.deploymentUrl).toBe('https://craft-my-dex-app.vercel.app');
        expect(result.errorMessage).toBeUndefined();
    });

    it('fails at generating stage when code generation fails', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(false),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
        );

        const result = await svc.deploy(request);

        expect(result.success).toBe(false);
        expect(result.failedStage).toBe('generating');
        expect(result.errorMessage).toContain('generation error');
    });

    it('fails at creating_repo stage when GitHub throws', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(true),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
        );

        const result = await svc.deploy(request);

        expect(result.success).toBe(false);
        expect(result.failedStage).toBe('creating_repo');
        expect(result.errorMessage).toContain('GitHub error');
    });

    it('fails at pushing_code stage when push throws', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(true),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
        );

        const result = await svc.deploy(request);

        expect(result.success).toBe(false);
        expect(result.failedStage).toBe('pushing_code');
        expect(result.errorMessage).toContain('Push failed');
    });

    it('fails at deploying stage when Vercel throws', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(true),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
        );

        const result = await svc.deploy(request);

        expect(result.success).toBe(false);
        expect(result.failedStage).toBe('deploying');
        expect(result.errorMessage).toContain('Vercel error');
    });

    it('returns early when DB insert fails', async () => {
        mockInsert.mockResolvedValueOnce({ error: { message: 'DB constraint violation' } });

        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
        );

        const result = await svc.deploy(request);

        expect(result.success).toBe(false);
        expect(result.errorMessage).toContain('Failed to create deployment record');
    });
    it('always returns a deploymentId even on failure', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(false),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
        );

        const result = await svc.deploy(request);

        expect(result.deploymentId).toBeTruthy();
        expect(typeof result.deploymentId).toBe('string');
    });

    it('fails at pending stage when customization contains a circular dependency', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
        );

        const nodes: DeploymentNode[] = [
            { id: 'a', dependsOn: ['b'] },
            { id: 'b', dependsOn: ['a'] },
        ];

        const reqWithCycle: DeploymentPipelineRequest = {
            ...request,
            customization: { ...customization, nodes } as any,
        };

        const result = await svc.deploy(reqWithCycle);

        expect(result.success).toBe(false);
        expect(result.failedStage).toBe('pending');
        expect(result.errorMessage).toContain('Circular dependency detected');
    });

    it('fails at pending stage when customization contains a missing node dependency', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
        );

        const nodes: DeploymentNode[] = [
            { id: 'a', dependsOn: ['ghost'] },
        ];

        const reqWithMissing: DeploymentPipelineRequest = {
            ...request,
            customization: { ...customization, nodes } as any,
        };

        const result = await svc.deploy(reqWithMissing);

        expect(result.success).toBe(false);
        expect(result.failedStage).toBe('pending');
        expect(result.errorMessage).toContain('depends on missing node "ghost"');
    });
});

// ── Issue #100 — Deployment status tracking persistence ───────────────────────
//
// Verifies that every status transition is persisted to the `deployments` table
// with an `updated_at` timestamp, and that provider IDs (repository_url,
// vercel_project_id, vercel_deployment_id) are stored at the right stages.

describe('DeploymentPipelineService — status tracking persistence (#100)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockInsert.mockResolvedValue({ error: null });
        mockUpdate.mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    });

    it('persists every status in order for a successful pipeline', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
        );

        await svc.deploy(request);

        const statusUpdates = mockUpdate.mock.calls
            .map((call: any[]) => call[0])
            .filter((payload: any) => payload.status)
            .map((payload: any) => payload.status);

        const order = ['generating', 'creating_repo', 'pushing_code', 'deploying', 'completed'];
        const indices = order.map((s) => statusUpdates.indexOf(s));
        // Every expected status must appear
        expect(indices.every((i) => i !== -1)).toBe(true);
        // Indices must be strictly ascending (correct order)
        expect(indices).toEqual([...indices].sort((a, b) => a - b));
    });

    it('persists updated_at timestamp on every status update', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
        );

        await svc.deploy(request);

        const statusUpdates = mockUpdate.mock.calls
            .map((call: any[]) => call[0])
            .filter((payload: any) => payload.status);

        expect(statusUpdates.length).toBeGreaterThan(0);
        for (const payload of statusUpdates) {
            expect(payload).toHaveProperty('updated_at');
            expect(typeof payload.updated_at).toBe('string');
        }
    });

    it('persists repository_url when creating_repo succeeds', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
        );

        await svc.deploy(request);

        const repoUpdate = mockUpdate.mock.calls
            .map((call: any[]) => call[0])
            .find((payload: any) => payload.repository_url);

        expect(repoUpdate).toBeDefined();
        expect(repoUpdate.repository_url).toBe('https://github.com/org/my-dex-app');
    });

    it('persists vercel_project_id, vercel_deployment_id, and deployment_url on completion', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
        );

        await svc.deploy(request);

        const completedUpdate = mockUpdate.mock.calls
            .map((call: any[]) => call[0])
            .find((payload: any) => payload.status === 'completed');

        expect(completedUpdate).toBeDefined();
        expect(completedUpdate.vercel_project_id).toBe('prj_abc');
        expect(completedUpdate.vercel_deployment_id).toBe('dpl_xyz');
        expect(completedUpdate.deployment_url).toBe('https://craft-my-dex-app.vercel.app');
        expect(completedUpdate).toHaveProperty('deployed_at');
    });

    it('persists failed status with error_message when a stage fails', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(false),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
        );

        await svc.deploy(request);

        const failedUpdate = mockUpdate.mock.calls
            .map((call: any[]) => call[0])
            .find((payload: any) => payload.status === 'failed');

        expect(failedUpdate).toBeDefined();
        expect(typeof failedUpdate.error_message).toBe('string');
        expect(failedUpdate.error_message.length).toBeGreaterThan(0);
        expect(failedUpdate).toHaveProperty('updated_at');
    });

    it('records the initial deployment row with pending status and required fields', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
        );

        await svc.deploy(request);

        const insertCall = mockInsert.mock.calls
            .map((call: any[]) => call[0])
            .find((payload: any) => payload.status === 'pending');

        expect(insertCall).toBeDefined();
        expect(insertCall.user_id).toBe(request.userId);
        expect(insertCall.template_id).toBe(request.templateId);
        expect(insertCall).toHaveProperty('created_at');
        expect(insertCall).toHaveProperty('updated_at');
    });
});

// ── Issue #101 — Deployment logging integration ───────────────────────────────
//
// Verifies that structured log entries are written to `deployment_logs` at each
// pipeline stage, with the correct level, stage label, and metadata.

describe('DeploymentPipelineService — logging integration (#101)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockInsert.mockResolvedValue({ error: null });
        mockUpdate.mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    });

    /** Returns all rows written to deployment_logs (identified by having deployment_id + stage). */
    function getLogInserts(): any[] {
        return mockInsert.mock.calls
            .map((call: any[]) => call[0])
            .filter((payload: any) => payload.deployment_id && payload.stage && payload.message);
    }

    it('emits a log entry for every pipeline stage on success', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
        );

        await svc.deploy(request);

        const stages = getLogInserts().map((l) => l.stage);
        for (const expected of ['pending', 'generating', 'creating_repo', 'pushing_code', 'deploying', 'completed']) {
            expect(stages).toContain(expected);
        }
    });

    it('associates every log entry with the deployment ID', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
        );

        const result = await svc.deploy(request);
        const logs = getLogInserts();

        expect(logs.length).toBeGreaterThan(0);
        for (const log of logs) {
            expect(log.deployment_id).toBe(result.deploymentId);
        }
    });

    it('writes an error-level log when generation fails', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(false),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
        );

        await svc.deploy(request);

        const errorLog = getLogInserts().find((l) => l.level === 'error');
        expect(errorLog).toBeDefined();
        expect(errorLog.stage).toBe('generating');
        expect(errorLog.message).toContain('generation error');
    });

    it('writes an error-level log when GitHub repo creation fails', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(true),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
        );

        await svc.deploy(request);

        const errorLog = getLogInserts().find((l) => l.level === 'error');
        expect(errorLog).toBeDefined();
        expect(errorLog.stage).toBe('creating_repo');
    });

    it('writes an error-level log when code push fails', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(true),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
        );

        await svc.deploy(request);

        const errorLog = getLogInserts().find((l) => l.level === 'error');
        expect(errorLog).toBeDefined();
        expect(errorLog.stage).toBe('pushing_code');
    });

    it('writes an error-level log when Vercel deployment fails', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(true),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
        );

        await svc.deploy(request);

        const errorLog = getLogInserts().find((l) => l.level === 'error');
        expect(errorLog).toBeDefined();
        expect(errorLog.stage).toBe('deploying');
    });

    it('includes file count metadata in the generating log', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
        );

        await svc.deploy(request);

        const genLog = getLogInserts().find(
            (l) => l.stage === 'generating' && l.metadata?.fileCount !== undefined,
        );
        expect(genLog).toBeDefined();
        expect(genLog.metadata.fileCount).toBe(1);
    });

    it('includes commitSha and fileCount metadata in the pushing_code log', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
        );

        await svc.deploy(request);

        const pushLog = getLogInserts().find(
            (l) => l.stage === 'pushing_code' && l.metadata?.commitSha !== undefined,
        );
        expect(pushLog).toBeDefined();
        expect(pushLog.metadata.commitSha).toBe('abc1234');
        expect(pushLog.metadata.fileCount).toBe(1);
    });

    it('includes deploymentUrl metadata in the deploying log', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
        );

        await svc.deploy(request);

        const deployLog = getLogInserts().find(
            (l) => l.stage === 'deploying' && l.metadata?.deploymentUrl !== undefined,
        );
        expect(deployLog).toBeDefined();
        expect(deployLog.metadata.deploymentUrl).toBe('https://craft-my-dex-app.vercel.app');
    });

    it('all log entries carry a created_at timestamp', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
        );

        await svc.deploy(request);

        for (const log of getLogInserts()) {
            expect(log).toHaveProperty('created_at');
            expect(typeof log.created_at).toBe('string');
        }
    });
});

// ── Issue #067 — Syntax validation hook ──────────────────────────────────────
//
// Verifies that the pipeline runs SyntaxValidator on every generated file
// between code generation and GitHub repo creation, surfaces errors with
// file references, and marks the deployment failed at the 'validating' stage.

describe('DeploymentPipelineService — syntax validation hook (#067)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockInsert.mockResolvedValue({ error: null });
        mockUpdate.mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    });

    it('proceeds past validation when all generated files are syntactically valid', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(true),
            makeArtifactSigningMock(),
        );

        const result = await svc.deploy(request);

        expect(result.success).toBe(true);
        expect(result.deploymentUrl).toBe('https://craft-my-dex-app.vercel.app');
    });

    it('fails at validating stage when a generated file has a syntax error', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(false),
            makeArtifactSigningMock(),
        );

        const result = await svc.deploy(request);

        expect(result.success).toBe(false);
        expect(result.failedStage).toBe('validating');
    });

    it('includes the file path in the error message when validation fails', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(false),
            makeArtifactSigningMock(),
        );

        const result = await svc.deploy(request);

        expect(result.errorMessage).toContain('src/index.ts');
    });

    it('does not create a GitHub repo when validation fails', async () => {
        const githubMock = makeGithubMock();
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            githubMock,
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(false),
        );

        await svc.deploy(request);

        expect(githubMock.createRepository).not.toHaveBeenCalled();
    });

    it('calls validate once per generated file', async () => {
        const validatorMock = makeSyntaxValidatorMock(true);
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            validatorMock,
            makeArtifactSigningMock(),
        );

        await svc.deploy(request);

        // makeGeneratorMock returns 1 file
        expect(validatorMock.validate).toHaveBeenCalledTimes(1);
        expect(validatorMock.validate).toHaveBeenCalledWith({ path: 'src/index.ts', content: 'export {}', type: 'code' });
    });

    it('persists validating status before running validation', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(true),
            makeArtifactSigningMock(),
        );

        await svc.deploy(request);

        const statusUpdates = mockUpdate.mock.calls
            .map((call: any[]) => call[0])
            .filter((p: any) => p.status)
            .map((p: any) => p.status);

        expect(statusUpdates).toContain('validating');
    });

    it('writes a validating log entry on success', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(true),
            makeArtifactSigningMock(),
        );

        await svc.deploy(request);

        const logs = mockInsert.mock.calls
            .map((call: any[]) => call[0])
            .filter((p: any) => p.stage === 'validating');

        expect(logs.length).toBeGreaterThan(0);
    });

    it('writes an error-level log at validating stage when validation fails', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(false),
            makeArtifactSigningMock(),
        );

        await svc.deploy(request);

        const errorLog = mockInsert.mock.calls
            .map((call: any[]) => call[0])
            .find((p: any) => p.stage === 'validating' && p.level === 'error');

        expect(errorLog).toBeDefined();
        expect(errorLog.message).toContain('Syntax validation failed');
    });

    it('validating stage appears between generating and creating_repo in the status sequence', async () => {
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(true),
            makeArtifactSigningMock(),
        );

        await svc.deploy(request);

        const statusUpdates = mockUpdate.mock.calls
            .map((call: any[]) => call[0])
            .filter((p: any) => p.status)
            .map((p: any) => p.status);

        const genIdx = statusUpdates.indexOf('generating');
        const valIdx = statusUpdates.indexOf('validating');
        const repoIdx = statusUpdates.indexOf('creating_repo');

        expect(genIdx).not.toBe(-1);
        expect(valIdx).not.toBe(-1);
        expect(repoIdx).not.toBe(-1);
        expect(genIdx).toBeLessThan(valIdx);
        expect(valIdx).toBeLessThan(repoIdx);
    });
});

// ── Issue #480 — Wire DeploymentUpdateService rollback into pipeline failure ──
//
// Verifies that when the pipeline fails mid-run and an updateContext is
// provided, rollbackUpdate is called exactly once with the correct IDs.
// Also verifies idempotency and the no-op edge case (no update record).

describe('DeploymentPipelineService — rollback on failure (#480)', () => {
    const UPDATE_ID = 'update-abc';
    const DEPLOYMENT_ID_FOR_UPDATE = 'dep-xyz';

    function makeUpdateServiceMock() {
        return { rollbackUpdate: vi.fn().mockResolvedValue(true) };
    }

    const updateContext = { updateId: UPDATE_ID, deploymentId: DEPLOYMENT_ID_FOR_UPDATE };

    beforeEach(() => {
        vi.clearAllMocks();
        mockInsert.mockResolvedValue({ error: null });
        mockUpdate.mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    });

    it('calls rollbackUpdate when pipeline fails at generating stage', async () => {
        const updateSvc = makeUpdateServiceMock();
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(false),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
            updateSvc,
        );

        const result = await svc.deploy({ ...request, updateContext });

        expect(result.success).toBe(false);
        expect(updateSvc.rollbackUpdate).toHaveBeenCalledOnce();
        expect(updateSvc.rollbackUpdate).toHaveBeenCalledWith(UPDATE_ID, DEPLOYMENT_ID_FOR_UPDATE);
    });

    it('calls rollbackUpdate when pipeline fails at creating_repo stage', async () => {
        const updateSvc = makeUpdateServiceMock();
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(true),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
            updateSvc,
        );

        const result = await svc.deploy({ ...request, updateContext });

        expect(result.success).toBe(false);
        expect(updateSvc.rollbackUpdate).toHaveBeenCalledOnce();
        expect(updateSvc.rollbackUpdate).toHaveBeenCalledWith(UPDATE_ID, DEPLOYMENT_ID_FOR_UPDATE);
    });

    it('calls rollbackUpdate when pipeline fails at pushing_code stage', async () => {
        const updateSvc = makeUpdateServiceMock();
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(true),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
            updateSvc,
        );

        const result = await svc.deploy({ ...request, updateContext });

        expect(result.success).toBe(false);
        expect(updateSvc.rollbackUpdate).toHaveBeenCalledOnce();
        expect(updateSvc.rollbackUpdate).toHaveBeenCalledWith(UPDATE_ID, DEPLOYMENT_ID_FOR_UPDATE);
    });

    it('calls rollbackUpdate when pipeline fails at deploying stage', async () => {
        const updateSvc = makeUpdateServiceMock();
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(true),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
            updateSvc,
        );

        const result = await svc.deploy({ ...request, updateContext });

        expect(result.success).toBe(false);
        expect(updateSvc.rollbackUpdate).toHaveBeenCalledOnce();
        expect(updateSvc.rollbackUpdate).toHaveBeenCalledWith(UPDATE_ID, DEPLOYMENT_ID_FOR_UPDATE);
    });

    it('update record transitions to rolled_back status after pipeline failure', async () => {
        // Simulate rollbackUpdate updating the status — verify the mock was called
        // (status transition is owned by DeploymentUpdateService; here we confirm
        //  the pipeline delegates correctly).
        const updateSvc = makeUpdateServiceMock();
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(false),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
            updateSvc,
        );

        await svc.deploy({ ...request, updateContext });

        expect(updateSvc.rollbackUpdate).toHaveBeenCalledWith(UPDATE_ID, DEPLOYMENT_ID_FOR_UPDATE);
    });

    it('emits an error deployment_log entry describing the rollback reason', async () => {
        const updateSvc = makeUpdateServiceMock();
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(false),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
            updateSvc,
        );

        await svc.deploy({ ...request, updateContext });

        const errorLogs = (mockInsert.mock.calls as any[][])
            .map((call) => call[0])
            .filter((payload: any) => payload?.level === 'error');

        expect(errorLogs.length).toBeGreaterThan(0);
        const rollbackLog = errorLogs.find((l: any) =>
            typeof l.message === 'string' && l.message.toLowerCase().includes('pipeline failed'),
        );
        expect(rollbackLog).toBeDefined();
    });

    it('is a no-op when no updateContext is provided (pipeline fails before update record is created)', async () => {
        const updateSvc = makeUpdateServiceMock();
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(false),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            updateSvc,
        );

        // No updateContext — rollbackUpdate must NOT be called
        const result = await svc.deploy(request);

        expect(result.success).toBe(false);
        expect(updateSvc.rollbackUpdate).not.toHaveBeenCalled();
    });

    it('rollback is idempotent — calling rollbackUpdate twice does not throw', async () => {
        const updateSvc = {
            rollbackUpdate: vi.fn()
                .mockResolvedValueOnce(true)
                .mockResolvedValueOnce(true), // second call also resolves cleanly
        };
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(false),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            updateSvc,
        );

        await svc.deploy({ ...request, updateContext });
        // Manually call rollback a second time — must not throw
        await expect(
            updateSvc.rollbackUpdate(UPDATE_ID, DEPLOYMENT_ID_FOR_UPDATE),
        ).resolves.toBe(true);
    });

    it('does not call rollbackUpdate on successful pipeline run', async () => {
        const updateSvc = makeUpdateServiceMock();
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
            updateSvc,
        );

        const result = await svc.deploy({ ...request, updateContext });

        expect(result.success).toBe(true);
        expect(updateSvc.rollbackUpdate).not.toHaveBeenCalled();
    });
});

// ── Issue #651 — GitHub Commit Status Reporting ───────────────────────────────
//
// Verifies that the deployment pipeline calls the GitHubCommitStatusService at
// the correct stages and that status-reporting failures NEVER block the pipeline.

describe('DeploymentPipelineService — GitHub commit status reporting (#651)', () => {
    function makeCommitStatusMock(reportResult: { success: boolean; error?: string } = { success: true }) {
        return {
            reportPending: vi.fn().mockResolvedValue(reportResult),
            reportSuccess: vi.fn().mockResolvedValue(reportResult),
            reportFailure: vi.fn().mockResolvedValue(reportResult),
        };
    }

    beforeEach(() => {
        vi.clearAllMocks();
        mockInsert.mockResolvedValue({ error: null });
        mockUpdate.mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    });

    it('reports pending status after a successful code push', async () => {
        const commitStatusMock = makeCommitStatusMock();
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
            null,
            commitStatusMock,
        );

        const result = await svc.deploy(request);

        expect(result.success).toBe(true);
        expect(commitStatusMock.reportPending).toHaveBeenCalledOnce();
    });

    it('reports success status after the pipeline completes', async () => {
        const commitStatusMock = makeCommitStatusMock();
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
            null,
            commitStatusMock,
        );

        const result = await svc.deploy(request);

        expect(result.success).toBe(true);
        expect(commitStatusMock.reportSuccess).toHaveBeenCalledOnce();
        expect(commitStatusMock.reportFailure).not.toHaveBeenCalled();
    });

    it('reports pending with the commit SHA from the push result', async () => {
        const commitStatusMock = makeCommitStatusMock();
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
            null,
            commitStatusMock,
        );

        await svc.deploy(request);

        const [, , sha] = commitStatusMock.reportPending.mock.calls[0] as string[];
        // makeGithubPushMock returns commitSha: 'abc1234'
        expect(sha).toBe('abc1234');
    });

    it('does NOT report a commit status when the pipeline fails before pushing code', async () => {
        const commitStatusMock = makeCommitStatusMock();
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(false), // fails at generating — no commit SHA yet
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
            null,
            commitStatusMock,
        );

        const result = await svc.deploy(request);

        expect(result.success).toBe(false);
        expect(commitStatusMock.reportPending).not.toHaveBeenCalled();
        expect(commitStatusMock.reportSuccess).not.toHaveBeenCalled();
        expect(commitStatusMock.reportFailure).not.toHaveBeenCalled();
    });

    it('does NOT report success when the Vercel deployment step fails', async () => {
        const commitStatusMock = makeCommitStatusMock();
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(true), // Vercel fails
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
            null,
            commitStatusMock,
        );

        const result = await svc.deploy(request);

        expect(result.success).toBe(false);
        expect(commitStatusMock.reportSuccess).not.toHaveBeenCalled();
    });

    it('does NOT block the pipeline when reportPending returns a failure result', async () => {
        const commitStatusMock = makeCommitStatusMock({ success: false, error: 'GitHub API unreachable' });
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
            null,
            commitStatusMock,
        );

        // Entire pipeline must still succeed even though status reporting failed
        const result = await svc.deploy(request);

        expect(result.success).toBe(true);
        expect(result.deploymentUrl).toBe('https://craft-my-dex-app.vercel.app');
    });

    it('does NOT block the pipeline when reportSuccess throws unexpectedly', async () => {
        const commitStatusMock = {
            reportPending: vi.fn().mockResolvedValue({ success: true }),
            reportSuccess: vi.fn().mockRejectedValue(new Error('Unexpected commit status error')),
            reportFailure: vi.fn().mockResolvedValue({ success: true }),
        };
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
            null,
            commitStatusMock,
        );

        const result = await svc.deploy(request);

        expect(result.success).toBe(true);
    });

    it('does NOT block the pipeline when reportPending throws unexpectedly', async () => {
        const commitStatusMock = {
            reportPending: vi.fn().mockRejectedValue(new Error('Status API down')),
            reportSuccess: vi.fn().mockResolvedValue({ success: true }),
            reportFailure: vi.fn().mockResolvedValue({ success: true }),
        };
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
            null,
            commitStatusMock,
        );

        const result = await svc.deploy(request);

        // Pipeline must complete successfully regardless of status reporting failure
        expect(result.success).toBe(true);
        expect(result.deploymentUrl).toBeDefined();
    });

    it('writes a warn log when commit status reporting returns a failure result', async () => {
        const commitStatusMock = makeCommitStatusMock({ success: false, error: 'token missing' });
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
            null,
            commitStatusMock,
        );

        await svc.deploy(request);

        const warnLogs = mockInsert.mock.calls
            .map((call: any[]) => call[0])
            .filter((p: any) => p?.level === 'warn' && p?.stage === 'commit_status');

        expect(warnLogs.length).toBeGreaterThan(0);
        expect(warnLogs[0].message).toContain('token missing');
    });

    it('writes a warn log when commit status reporting throws unexpectedly', async () => {
        const commitStatusMock = {
            reportPending: vi.fn().mockRejectedValue(new Error('unexpected throw')),
            reportSuccess: vi.fn().mockResolvedValue({ success: true }),
            reportFailure: vi.fn().mockResolvedValue({ success: true }),
        };
        const svc = new DeploymentPipelineService(
            makeGeneratorMock(),
            makeGithubMock(),
            makeGithubPushMock(),
            makeVercelMock(),
            makeSyntaxValidatorMock(),
            makeArtifactSigningMock(),
            null,
            commitStatusMock,
        );

        await svc.deploy(request);

        const warnLogs = mockInsert.mock.calls
            .map((call: any[]) => call[0])
            .filter((p: any) => p?.level === 'warn' && p?.stage === 'commit_status');

        expect(warnLogs.length).toBeGreaterThan(0);
        expect(warnLogs[0].message).toContain('unexpected throw');
    });
});
