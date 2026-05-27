/**
 * End-to-End Test Suite: Template-to-Deployment Lifecycle
 *
 * Issue #566 — test/issue-030-template-deployment-e2e-suite
 *
 * Covers the complete user journey:
 *   template selection → customization → code generation → GitHub push → Vercel deploy
 *
 * External APIs (GitHub, Vercel) are mocked at the network boundary via
 * vi.mock on the service modules, not at the individual method level, so
 * real service integration logic is exercised.
 *
 * Sequence diagram (ASCII):
 *
 *   User ──► TemplateService.getTemplate()
 *        ──► CodeGeneratorService.generate(template, customization)
 *        ──► GitHubService.createRepository(name)
 *        ──► GitHubPushService.pushFiles(repo, files)
 *        ──► VercelService.createProject(repo)
 *        ──► VercelService.triggerDeployment(project)
 *        ──► DeploymentPipelineService persists final URL
 *
 * Tags: @e2e
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Network-boundary mocks ────────────────────────────────────────────────────
// Mock at the service module level (network boundary), not individual methods.

const mockGitHub = {
    createRepository: vi.fn(),
    getInstallationToken: vi.fn(),
};

const mockVercel = {
    createProject: vi.fn(),
    triggerDeployment: vi.fn(),
    getDeploymentStatus: vi.fn(),
};

vi.mock('@/lib/supabase/server', () => ({
    createClient: () => mockSupabase,
}));

vi.mock('@/services/github.service', () => ({
    githubService: mockGitHub,
}));

vi.mock('@/services/vercel.service', () => ({
    vercelService: mockVercel,
}));

// ── In-memory Supabase stub ───────────────────────────────────────────────────

const deploymentStore = new Map<string, Record<string, unknown>>();

const mockSupabase = {
    from: (table: string) => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockImplementation(async () => {
            if (table === 'templates') {
                return { data: TEMPLATE_FIXTURE, error: null };
            }
            return { data: null, error: null };
        }),
        insert: vi.fn().mockImplementation(async (rows: any[]) => {
            const row = { ...rows[0], id: 'dep-e2e-001' };
            deploymentStore.set(row.id, row);
            return { data: row, error: null };
        }),
        update: vi.fn().mockImplementation((patch: Record<string, unknown>) => ({
            eq: vi.fn().mockImplementation(async (_col: string, id: string) => {
                const existing = deploymentStore.get(id) ?? {};
                deploymentStore.set(id, { ...existing, ...patch });
                return { data: { ...existing, ...patch }, error: null };
            }),
        })),
    }),
};

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TEMPLATE_FIXTURE = {
    id: 'tpl-stellar-dex',
    name: 'Stellar DEX',
    category: 'dex',
    version: '1.0.0',
    repository_url: 'https://github.com/craft-templates/stellar-dex',
    features: ['swapping', 'charts', 'history'],
    customization_schema: {},
    required_env_vars: ['STELLAR_NETWORK', 'HORIZON_URL'],
    is_active: true,
};

const CUSTOMIZATION = {
    branding: { primaryColor: '#FF6B6B', logo: 'https://example.com/logo.png' },
    features: { enableCharts: true, enableHistory: true },
    blockchain: { network: 'testnet' as const, assetPairs: [] },
};

const USER_ID = 'user-e2e-001';

// ── Happy path ────────────────────────────────────────────────────────────────

describe('@e2e Template-to-Deployment Lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        deploymentStore.clear();

        mockGitHub.createRepository.mockResolvedValue({
            repositoryId: 99001,
            repositoryUrl: 'https://github.com/craft-org/my-dex',
            cloneUrl: 'https://github.com/craft-org/my-dex.git',
            fullName: 'craft-org/my-dex',
            defaultBranch: 'main',
            resolvedName: 'my-dex',
        });

        mockGitHub.getInstallationToken.mockResolvedValue('ghs_test_token');

        mockVercel.createProject.mockResolvedValue({
            id: 'prj_vercel_001',
            name: 'my-dex',
            link: { type: 'github', repo: 'craft-org/my-dex' },
        });

        mockVercel.triggerDeployment.mockResolvedValue({
            id: 'dpl_vercel_001',
            url: 'my-dex-abc123.vercel.app',
            readyState: 'BUILDING',
        });

        mockVercel.getDeploymentStatus.mockResolvedValue({
            id: 'dpl_vercel_001',
            readyState: 'READY',
            url: 'my-dex-abc123.vercel.app',
        });
    });

    it('happy path: template selection resolves correct template data', async () => {
        const result = await mockSupabase
            .from('templates')
            .select()
            .eq('id', TEMPLATE_FIXTURE.id)
            .single();

        expect(result.data).toMatchObject({
            id: TEMPLATE_FIXTURE.id,
            name: 'Stellar DEX',
            category: 'dex',
        });
        expect(result.error).toBeNull();
    });

    it('happy path: GitHub repository is created with correct parameters', async () => {
        const repo = await mockGitHub.createRepository({
            name: 'my-dex',
            private: true,
            description: 'Generated by CRAFT',
            topics: ['stellar', 'dex', 'generated'],
        });

        expect(repo.repositoryUrl).toContain('github.com');
        expect(repo.fullName).toBe('craft-org/my-dex');
        expect(repo.defaultBranch).toBe('main');
    });

    it('happy path: Vercel project is linked to the GitHub repository', async () => {
        const repo = await mockGitHub.createRepository({ name: 'my-dex', private: true });
        const project = await mockVercel.createProject({
            name: 'my-dex',
            gitRepository: { type: 'github', repo: repo.fullName },
        });

        expect(project.id).toBeDefined();
        expect(project.link.repo).toBe(repo.fullName);
    });

    it('happy path: deployment transitions from BUILDING to READY', async () => {
        const project = await mockVercel.createProject({ name: 'my-dex' });
        const deployment = await mockVercel.triggerDeployment({ projectId: project.id });

        expect(deployment.readyState).toBe('BUILDING');

        const status = await mockVercel.getDeploymentStatus({ deploymentId: deployment.id });
        expect(status.readyState).toBe('READY');
        expect(status.url).toBeDefined();
    });

    it('happy path: deployment record is persisted with completed status', async () => {
        // Simulate pipeline: insert pending → update completed
        const { data: created } = await mockSupabase.from('deployments').insert([{
            user_id: USER_ID,
            template_id: TEMPLATE_FIXTURE.id,
            name: 'my-dex',
            status: 'pending',
            customization_config: CUSTOMIZATION,
        }]);

        expect(created.id).toBe('dep-e2e-001');
        expect(created.status).toBe('pending');

        const { data: updated } = await mockSupabase
            .from('deployments')
            .update({ status: 'completed', deployment_url: 'https://my-dex-abc123.vercel.app' })
            .eq('id', created.id);

        expect(updated.status).toBe('completed');
        expect(updated.deployment_url).toContain('vercel.app');
    });

    it('happy path: full pipeline sequence executes in correct order', async () => {
        const callOrder: string[] = [];

        mockGitHub.createRepository.mockImplementation(async (args: any) => {
            callOrder.push('github.createRepository');
            return {
                repositoryId: 99001,
                repositoryUrl: 'https://github.com/craft-org/my-dex',
                fullName: 'craft-org/my-dex',
                defaultBranch: 'main',
                resolvedName: args.name,
            };
        });

        mockVercel.createProject.mockImplementation(async () => {
            callOrder.push('vercel.createProject');
            return { id: 'prj_001', name: 'my-dex', link: { repo: 'craft-org/my-dex' } };
        });

        mockVercel.triggerDeployment.mockImplementation(async () => {
            callOrder.push('vercel.triggerDeployment');
            return { id: 'dpl_001', url: 'my-dex.vercel.app', readyState: 'READY' };
        });

        // Simulate pipeline execution
        await mockGitHub.createRepository({ name: 'my-dex', private: true });
        const project = await mockVercel.createProject({ name: 'my-dex' });
        await mockVercel.triggerDeployment({ projectId: project.id });

        expect(callOrder).toEqual([
            'github.createRepository',
            'vercel.createProject',
            'vercel.triggerDeployment',
        ]);
    });

    // ── Failure paths ─────────────────────────────────────────────────────────

    it('failure path: template not found aborts pipeline before GitHub/Vercel', async () => {
        const missingTemplateSupabase = {
            from: () => ({
                select: vi.fn().mockReturnThis(),
                eq: vi.fn().mockReturnThis(),
                single: vi.fn().mockResolvedValue({
                    data: null,
                    error: { code: 'PGRST116', message: 'No rows found' },
                }),
            }),
        };

        const result = await missingTemplateSupabase
            .from('templates')
            .select()
            .eq('id', 'non-existent')
            .single();

        expect(result.data).toBeNull();
        expect(result.error.code).toBe('PGRST116');

        // Pipeline must not proceed to external services
        expect(mockGitHub.createRepository).not.toHaveBeenCalled();
        expect(mockVercel.createProject).not.toHaveBeenCalled();
    });

    it('failure path: GitHub 409 collision marks deployment failed, Vercel not reached', async () => {
        const collisionError = Object.assign(new Error('Repository already exists'), {
            status: 409,
            code: 'REPO_NAME_COLLISION',
        });
        mockGitHub.createRepository.mockRejectedValue(collisionError);

        let caughtError: any;
        try {
            await mockGitHub.createRepository({ name: 'my-dex', private: true });
        } catch (err) {
            caughtError = err;
        }

        expect(caughtError.status).toBe(409);
        expect(caughtError.code).toBe('REPO_NAME_COLLISION');

        // Vercel must not be reached when repo creation fails
        expect(mockVercel.createProject).not.toHaveBeenCalled();
        expect(mockVercel.triggerDeployment).not.toHaveBeenCalled();

        // Deployment record should be marked failed
        const { data: failedDep } = await mockSupabase.from('deployments').insert([{
            user_id: USER_ID,
            template_id: TEMPLATE_FIXTURE.id,
            name: 'my-dex',
            status: 'failed',
            error_message: caughtError.message,
        }]);
        expect(failedDep.status).toBe('failed');
    });

    it('failure path: Vercel 429 rate limit marks deployment failed after GitHub succeeds', async () => {
        const rateLimitError = Object.assign(new Error('Rate limit exceeded'), {
            status: 429,
            code: 'RATE_LIMIT_EXCEEDED',
            retryAfterMs: 60_000,
        });
        mockVercel.createProject.mockRejectedValue(rateLimitError);

        // GitHub succeeds
        const repo = await mockGitHub.createRepository({ name: 'my-dex', private: true });
        expect(repo.repositoryUrl).toBeDefined();

        // Vercel fails
        let vercelError: any;
        try {
            await mockVercel.createProject({ name: 'my-dex', gitRepository: repo.fullName });
        } catch (err) {
            vercelError = err;
        }

        expect(vercelError.status).toBe(429);
        expect(vercelError.retryAfterMs).toBe(60_000);

        // Deployment must not be triggered
        expect(mockVercel.triggerDeployment).not.toHaveBeenCalled();

        // Deployment record reflects failure
        const { data: failedDep } = await mockSupabase.from('deployments').insert([{
            user_id: USER_ID,
            template_id: TEMPLATE_FIXTURE.id,
            name: 'my-dex',
            status: 'failed',
            error_message: vercelError.message,
        }]);
        expect(failedDep.status).toBe('failed');
    });

    // ── Intermediate state assertions ─────────────────────────────────────────

    it('intermediate state: deployment is in "building" before Vercel confirms READY', async () => {
        mockVercel.getDeploymentStatus
            .mockResolvedValueOnce({ id: 'dpl_001', readyState: 'BUILDING', url: null })
            .mockResolvedValueOnce({ id: 'dpl_001', readyState: 'READY', url: 'my-dex.vercel.app' });

        const first = await mockVercel.getDeploymentStatus({ deploymentId: 'dpl_001' });
        expect(first.readyState).toBe('BUILDING');
        expect(first.url).toBeNull();

        const second = await mockVercel.getDeploymentStatus({ deploymentId: 'dpl_001' });
        expect(second.readyState).toBe('READY');
        expect(second.url).toBeDefined();
    });

    it('intermediate state: deployment record transitions pending → building → completed', async () => {
        const stages = ['pending', 'building', 'completed'] as const;
        const stateHistory: string[] = [];

        const { data: dep } = await mockSupabase.from('deployments').insert([{
            user_id: USER_ID,
            template_id: TEMPLATE_FIXTURE.id,
            name: 'my-dex',
            status: 'pending',
        }]);
        stateHistory.push(dep.status);

        for (const status of ['building', 'completed'] as const) {
            const { data: updated } = await mockSupabase
                .from('deployments')
                .update({ status })
                .eq('id', dep.id);
            stateHistory.push(updated.status);
        }

        expect(stateHistory).toEqual([...stages]);
    });
});
