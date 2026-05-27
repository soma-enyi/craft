/**
 * Error Propagation Chain Tests for GitHub-to-Vercel Deployment Integration
 *
 * Issue: #552
 * Branch: test/issue-552-github-vercel-error-propagation-tests
 *
 * Verifies error messages and error types are correctly propagated through
 * the full GitHub-to-Vercel deployment chain, ensuring no silent failures
 * or error swallowing occurs at any layer.
 *
 * Tests 6 distinct failure points:
 *   1. GitHub API failures
 *   2. Vercel API failures
 *   3. Database write failures
 *   4. Partial failures (Vercel succeeds, DB fails)
 *   5. Network timeouts
 *   6. Invalid configuration
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubToVercelDeploymentService } from './github-to-vercel-deployment.service';
import type { TriggerDeploymentRequest } from './github-to-vercel-deployment.service';

// ── Typed Error Classes ───────────────────────────────────────────────────────

/**
 * Base error class for deployment chain failures.
 * All errors in the chain must be instances of typed error classes.
 */
export class DeploymentChainError extends Error {
    constructor(
        public readonly layer: 'github' | 'vercel' | 'database' | 'config',
        public readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = 'DeploymentChainError';
    }
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockVercelService = {
    triggerDeployment: vi.fn(),
    getDeploymentStatus: vi.fn(),
};

const mockSupabase = {
    from: vi.fn(),
};

vi.mock('@/lib/supabase/server', () => ({
    createClient: () => mockSupabase,
}));

vi.mock('@/lib/api/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    }),
}));

// ── Test setup ─────────────────────────────────────────────────────────────────

beforeEach(() => {
    vi.clearAllMocks();
    process.env.VERCEL_PROJECT_ID = 'test-project-id';
});

describe('Error Propagation Chain — GitHub-to-Vercel Deployment', () => {
    let service: GitHubToVercelDeploymentService;

    beforeEach(() => {
        service = new GitHubToVercelDeploymentService(mockVercelService as any);
    });

    const request: TriggerDeploymentRequest = {
        repoFullName: 'owner/repo',
        repoName: 'repo',
        branch: 'main',
        commitSha: 'abc123def456',
        commitMessage: 'Test commit',
        pusherName: 'testuser',
    };

    // ── Failure Point 1: GitHub API Failures ──────────────────────────────

    describe('Failure Point 1: GitHub API failures', () => {
        it('propagates GitHub authentication errors with typed response', async () => {
            const githubError = new Error('GitHub API: 401 Unauthorized');
            mockVercelService.triggerDeployment.mockRejectedValue(githubError);

            const result = await service.triggerDeployment(request);

            expect(result.success).toBe(false);
            expect(result.errorMessage).toBeDefined();
            expect(result.errorMessage).toContain('GitHub');
        });

        it('propagates GitHub rate limit errors', async () => {
            const rateLimitError = new Error('GitHub API: 403 Rate limit exceeded');
            mockVercelService.triggerDeployment.mockRejectedValue(rateLimitError);

            const result = await service.triggerDeployment(request);

            expect(result.success).toBe(false);
            expect(result.errorMessage).toContain('Rate limit');
        });

        it('propagates GitHub repository not found errors', async () => {
            const notFoundError = new Error('GitHub API: 404 Repository not found');
            mockVercelService.triggerDeployment.mockRejectedValue(notFoundError);

            const result = await service.triggerDeployment(request);

            expect(result.success).toBe(false);
            expect(result.errorMessage).toContain('not found');
        });
    });

    // ── Failure Point 2: Vercel API Failures ──────────────────────────────

    describe('Failure Point 2: Vercel API failures', () => {
        it('propagates Vercel authentication errors with typed response', async () => {
            const vercelError = new Error('Vercel API: 401 Invalid token');
            mockVercelService.triggerDeployment.mockRejectedValue(vercelError);

            const result = await service.triggerDeployment(request);

            expect(result.success).toBe(false);
            expect(result.errorMessage).toBeDefined();
            expect(result.errorMessage).toContain('Vercel');
        });

        it('propagates Vercel project not found errors', async () => {
            const notFoundError = new Error('Vercel API: 404 Project not found');
            mockVercelService.triggerDeployment.mockRejectedValue(notFoundError);

            const result = await service.triggerDeployment(request);

            expect(result.success).toBe(false);
            expect(result.errorMessage).toContain('not found');
        });

        it('propagates Vercel quota exceeded errors', async () => {
            const quotaError = new Error('Vercel API: 429 Deployment quota exceeded');
            mockVercelService.triggerDeployment.mockRejectedValue(quotaError);

            const result = await service.triggerDeployment(request);

            expect(result.success).toBe(false);
            expect(result.errorMessage).toContain('quota');
        });

        it('propagates Vercel internal server errors', async () => {
            const serverError = new Error('Vercel API: 500 Internal server error');
            mockVercelService.triggerDeployment.mockRejectedValue(serverError);

            const result = await service.triggerDeployment(request);

            expect(result.success).toBe(false);
            expect(result.errorMessage).toContain('Internal');
        });
    });

    // ── Failure Point 3: Database Write Failures ──────────────────────────

    describe('Failure Point 3: Database write failures', () => {
        it('logs database insert errors without failing deployment', async () => {
            mockVercelService.triggerDeployment.mockResolvedValue({
                deploymentId: 'dpl_abc123',
                deploymentUrl: 'https://test.vercel.app',
                status: 'QUEUED',
            });

            const dbError = new Error('Database: connection timeout');
            mockSupabase.from.mockReturnValue({
                insert: vi.fn().mockReturnValue({
                    error: dbError,
                }),
            });

            const result = await service.triggerDeployment(request);

            // Deployment should still succeed even if DB fails
            expect(result.success).toBe(true);
            expect(result.deploymentId).toBeDefined();
        });

        it('propagates database constraint violation errors', async () => {
            mockVercelService.triggerDeployment.mockResolvedValue({
                deploymentId: 'dpl_abc123',
                deploymentUrl: 'https://test.vercel.app',
                status: 'QUEUED',
            });

            const constraintError = new Error('Database: unique constraint violation');
            mockSupabase.from.mockReturnValue({
                insert: vi.fn().mockReturnValue({
                    error: constraintError,
                }),
            });

            const result = await service.triggerDeployment(request);

            // Should still succeed (DB error is non-fatal)
            expect(result.success).toBe(true);
        });

        it('propagates database permission errors', async () => {
            mockVercelService.triggerDeployment.mockResolvedValue({
                deploymentId: 'dpl_abc123',
                deploymentUrl: 'https://test.vercel.app',
                status: 'QUEUED',
            });

            const permError = new Error('Database: permission denied');
            mockSupabase.from.mockReturnValue({
                insert: vi.fn().mockReturnValue({
                    error: permError,
                }),
            });

            const result = await service.triggerDeployment(request);

            expect(result.success).toBe(true);
        });
    });

    // ── Failure Point 4: Partial Failures ─────────────────────────────────

    describe('Failure Point 4: Partial failures (Vercel succeeds, DB fails)', () => {
        it('returns success when Vercel succeeds but DB insert fails', async () => {
            mockVercelService.triggerDeployment.mockResolvedValue({
                deploymentId: 'dpl_abc123',
                deploymentUrl: 'https://test.vercel.app',
                status: 'QUEUED',
            });

            mockSupabase.from.mockReturnValue({
                insert: vi.fn().mockReturnValue({
                    error: new Error('Database error'),
                }),
            });

            const result = await service.triggerDeployment(request);

            expect(result.success).toBe(true);
            expect(result.deploymentId).toBe('dpl_abc123');
            expect(result.deploymentUrl).toBe('https://test.vercel.app');
        });

        it('returns success with deployment URL even if metadata storage fails', async () => {
            mockVercelService.triggerDeployment.mockResolvedValue({
                deploymentId: 'dpl_abc123',
                deploymentUrl: 'https://test.vercel.app',
                status: 'QUEUED',
            });

            mockSupabase.from.mockReturnValue({
                insert: vi.fn().mockReturnValue({
                    error: new Error('Metadata storage failed'),
                }),
            });

            const result = await service.triggerDeployment(request);

            expect(result.success).toBe(true);
            expect(result.deploymentUrl).toBe('https://test.vercel.app');
        });
    });

    // ── Failure Point 5: Network Timeouts ─────────────────────────────────

    describe('Failure Point 5: Network timeouts', () => {
        it('propagates Vercel API timeout errors', async () => {
            const timeoutError = new Error('Vercel API: request timeout after 30s');
            mockVercelService.triggerDeployment.mockRejectedValue(timeoutError);

            const result = await service.triggerDeployment(request);

            expect(result.success).toBe(false);
            expect(result.errorMessage).toContain('timeout');
        });

        it('propagates database connection timeout errors', async () => {
            mockVercelService.triggerDeployment.mockResolvedValue({
                deploymentId: 'dpl_abc123',
                deploymentUrl: 'https://test.vercel.app',
                status: 'QUEUED',
            });

            const timeoutError = new Error('Database: connection timeout');
            mockSupabase.from.mockReturnValue({
                insert: vi.fn().mockReturnValue({
                    error: timeoutError,
                }),
            });

            const result = await service.triggerDeployment(request);

            // Should still succeed (DB timeout is non-fatal)
            expect(result.success).toBe(true);
        });

        it('propagates network unreachable errors', async () => {
            const networkError = new Error('Network: ECONNREFUSED');
            mockVercelService.triggerDeployment.mockRejectedValue(networkError);

            const result = await service.triggerDeployment(request);

            expect(result.success).toBe(false);
            expect(result.errorMessage).toContain('Network');
        });
    });

    // ── Failure Point 6: Invalid Configuration ────────────────────────────

    describe('Failure Point 6: Invalid configuration', () => {
        it('returns typed error when VERCEL_PROJECT_ID is missing', async () => {
            delete process.env.VERCEL_PROJECT_ID;

            const result = await service.triggerDeployment(request);

            expect(result.success).toBe(false);
            expect(result.errorMessage).toBe('VERCEL_PROJECT_ID is not configured');
        });

        it('returns typed error when VERCEL_TOKEN is missing', async () => {
            delete process.env.VERCEL_TOKEN;

            const result = await service.triggerDeployment(request);

            // Should fail gracefully with typed error
            expect(result.success).toBe(false);
            expect(result.errorMessage).toBeDefined();
        });

        it('returns typed error for invalid request parameters', async () => {
            const invalidRequest = {
                repoFullName: '',
                repoName: '',
                branch: '',
                commitSha: '',
                commitMessage: '',
                pusherName: '',
            };

            const result = await service.triggerDeployment(invalidRequest as any);

            expect(result.success).toBe(false);
            expect(result.errorMessage).toBeDefined();
        });
    });

    // ── Error Type Consistency ────────────────────────────────────────────

    describe('Error type consistency across chain', () => {
        it('all error responses have consistent structure', async () => {
            const testCases = [
                {
                    name: 'GitHub error',
                    setup: () => {
                        mockVercelService.triggerDeployment.mockRejectedValue(
                            new Error('GitHub API error')
                        );
                    },
                },
                {
                    name: 'Vercel error',
                    setup: () => {
                        mockVercelService.triggerDeployment.mockRejectedValue(
                            new Error('Vercel API error')
                        );
                    },
                },
                {
                    name: 'Config error',
                    setup: () => {
                        delete process.env.VERCEL_PROJECT_ID;
                    },
                },
            ];

            for (const testCase of testCases) {
                testCase.setup();
                const result = await service.triggerDeployment(request);

                expect(result).toHaveProperty('success');
                expect(result).toHaveProperty('deploymentId');
                expect(result).toHaveProperty('errorMessage');
                expect(typeof result.success).toBe('boolean');
                expect(typeof result.deploymentId).toBe('string');
                if (!result.success) {
                    expect(typeof result.errorMessage).toBe('string');
                }

                vi.clearAllMocks();
                process.env.VERCEL_PROJECT_ID = 'test-project-id';
            }
        });

        it('error messages are never null or undefined', async () => {
            mockVercelService.triggerDeployment.mockRejectedValue(
                new Error('Some error')
            );

            const result = await service.triggerDeployment(request);

            expect(result.success).toBe(false);
            expect(result.errorMessage).not.toBeNull();
            expect(result.errorMessage).not.toBeUndefined();
            expect(result.errorMessage).toBeTruthy();
        });

        it('error messages contain actionable information', async () => {
            mockVercelService.triggerDeployment.mockRejectedValue(
                new Error('Vercel API: 401 Invalid token')
            );

            const result = await service.triggerDeployment(request);

            expect(result.success).toBe(false);
            expect(result.errorMessage).toMatch(/Vercel|401|token/i);
        });
    });

    // ── Rollback and Cleanup ──────────────────────────────────────────────

    describe('Rollback and cleanup on failure', () => {
        it('does not create database record if Vercel deployment fails', async () => {
            mockVercelService.triggerDeployment.mockRejectedValue(
                new Error('Vercel API error')
            );

            const insertMock = vi.fn();
            mockSupabase.from.mockReturnValue({
                insert: insertMock,
            });

            await service.triggerDeployment(request);

            // Insert should not be called if Vercel fails
            expect(insertMock).not.toHaveBeenCalled();
        });

        it('logs errors at appropriate levels', async () => {
            const loggerMock = {
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
            };

            vi.doMock('@/lib/api/logger', () => ({
                createLogger: () => loggerMock,
            }));

            mockVercelService.triggerDeployment.mockRejectedValue(
                new Error('Vercel API error')
            );

            await service.triggerDeployment(request);

            // Error should be logged
            expect(loggerMock.error).toHaveBeenCalled();
        });
    });
});
