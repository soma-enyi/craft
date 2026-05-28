import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUpsert = vi.fn();
const mockUpdate = vi.fn();
const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
    createClient: () => ({
        from: mockFrom,
    }),
}));

let service: InstanceType<typeof import('./github-app-installation.service').GitHubAppInstallationService>;

beforeEach(async () => {
    vi.clearAllMocks();
    if (!service) {
        const { GitHubAppInstallationService } = await import('./github-app-installation.service');
        service = new GitHubAppInstallationService();
    }
});

function setupQuery(result: any) {
    const eqFn = vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue(result) });
    const selectFn = vi.fn().mockReturnValue({ eq: eqFn });
    const updateEqFn = vi.fn().mockResolvedValue({ error: null });
    const updateFn = vi.fn().mockReturnValue({ eq: updateEqFn });

    mockUpdate.mockReturnValue({ eq: updateEqFn });
    mockSelect.mockReturnValue({ eq: eqFn });
    mockUpsert.mockResolvedValue({ error: null });
    mockFrom.mockReturnValue({
        upsert: mockUpsert,
        update: mockUpdate,
        select: selectFn,
    });
}

describe('GitHubAppInstallationService', () => {
    describe('handleInstallationCreated', () => {
        it('stores installation with repositories and organizations', async () => {
            setupQuery({ error: null });

            const payload = {
                action: 'created',
                installation: {
                    id: 123,
                    app_id: 456,
                    account: { login: 'test-org', type: 'Organization', id: 789 },
                    repositories: [
                        { id: 1, name: 'repo1', full_name: 'test-org/repo1' },
                    ],
                    repository_selection: 'selected',
                },
                repositories: [
                    { id: 1, name: 'repo1', full_name: 'test-org/repo1' },
                ],
            };

            await service.handleInstallationCreated(payload as any);

            expect(mockUpsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    installation_id: 123,
                    app_id: 456,
                    account_login: 'test-org',
                    account_type: 'Organization',
                    repositories: expect.arrayContaining([
                        expect.objectContaining({ full_name: 'test-org/repo1' }),
                    ]),
                    organizations: expect.arrayContaining([
                        expect.objectContaining({ login: 'test-org' }),
                    ]),
                }),
                expect.any(Object)
            );
        });

        it('stores user installation without organizations', async () => {
            setupQuery({ error: null });

            const payload = {
                action: 'created',
                installation: {
                    id: 789,
                    app_id: 456,
                    account: { login: 'test-user', type: 'User', id: 111 },
                    repository_selection: 'all',
                },
                repositories: [],
            };

            await service.handleInstallationCreated(payload as any);

            expect(mockUpsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    account_type: 'User',
                    organizations: [],
                }),
                expect.any(Object)
            );
        });

        it('throws error if upsert fails', async () => {
            mockFrom.mockReturnValue({
                upsert: vi.fn().mockResolvedValue({
                    error: { message: 'Database error' },
                }),
            });

            const payload = {
                action: 'created',
                installation: {
                    id: 123,
                    app_id: 456,
                    account: { login: 'test', type: 'Organization', id: 1 },
                },
            };

            await expect(
                service.handleInstallationCreated(payload as any)
            ).rejects.toThrow('Failed to create installation record');
        });
    });

    describe('handleInstallationDeleted', () => {
        it('marks installation as deleted', async () => {
            const eqFn = vi.fn().mockResolvedValue({ error: null });
            const updateFn = vi.fn().mockReturnValue({ eq: eqFn });
            mockFrom.mockReturnValue({ update: updateFn });

            const payload = {
                action: 'deleted',
                installation: { id: 123, app_id: 456, account: { login: 'test', type: 'Organization', id: 1 } },
            };

            await service.handleInstallationDeleted(payload as any);

            expect(updateFn).toHaveBeenCalledWith({
                deleted_at: expect.any(String),
            });
            expect(eqFn).toHaveBeenCalledWith('installation_id', 123);
        });

        it('throws error if update fails', async () => {
            const eqFn = vi.fn().mockResolvedValue({ error: { message: 'Database error' } });
            const updateFn = vi.fn().mockReturnValue({ eq: eqFn });
            mockFrom.mockReturnValue({ update: updateFn });

            const payload = {
                action: 'deleted',
                installation: { id: 123, app_id: 456, account: { login: 'test', type: 'Organization', id: 1 } },
            };

            await expect(
                service.handleInstallationDeleted(payload as any)
            ).rejects.toThrow('Failed to delete installation record');
        });
    });

    describe('handleInstallationRepositoriesAdded', () => {
        it('adds new repositories to existing installation', async () => {
            const existingRepos = [{ id: 1, name: 'repo1', full_name: 'test/repo1' }];
            const eqFnForSelect = vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: { repositories: existingRepos }, error: null }),
            });
            const selectFn = vi.fn().mockReturnValue({ eq: eqFnForSelect });
            const eqFnForUpdate = vi.fn().mockResolvedValue({ error: null });
            const updateFn = vi.fn().mockReturnValue({ eq: eqFnForUpdate });

            mockFrom.mockReturnValue({
                select: selectFn,
                update: updateFn,
            });

            const payload = {
                action: 'added',
                installation: { id: 123, account: { login: 'test', type: 'Organization', id: 1 } },
                repository_selection: 'selected',
                repositories_added: [
                    { id: 2, name: 'repo2', full_name: 'test/repo2' },
                ],
            };

            await service.handleInstallationRepositoriesAdded(payload as any);

            expect(updateFn).toHaveBeenCalledWith({
                repositories: expect.arrayContaining([
                    expect.objectContaining({ id: 1 }),
                    expect.objectContaining({ id: 2 }),
                ]),
            });
        });

        it('throws error if installation not found', async () => {
            const eqFnForSelect = vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: null, error: null }),
            });
            const selectFn = vi.fn().mockReturnValue({ eq: eqFnForSelect });
            mockFrom.mockReturnValue({ select: selectFn });

            const payload = {
                action: 'added',
                installation: { id: 999, account: { login: 'test', type: 'Organization', id: 1 } },
                repository_selection: 'selected',
                repositories_added: [],
            };

            await expect(
                service.handleInstallationRepositoriesAdded(payload as any)
            ).rejects.toThrow('Installation not found');
        });
    });

    describe('handleInstallationRepositoriesRemoved', () => {
        it('removes repositories from installation', async () => {
            const existingRepos = [
                { id: 1, name: 'repo1', full_name: 'test/repo1' },
                { id: 2, name: 'repo2', full_name: 'test/repo2' },
            ];
            const eqFnForSelect = vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: { repositories: existingRepos }, error: null }),
            });
            const selectFn = vi.fn().mockReturnValue({ eq: eqFnForSelect });
            const eqFnForUpdate = vi.fn().mockResolvedValue({ error: null });
            const updateFn = vi.fn().mockReturnValue({ eq: eqFnForUpdate });

            mockFrom.mockReturnValue({
                select: selectFn,
                update: updateFn,
            });

            const payload = {
                action: 'removed',
                installation: { id: 123, account: { login: 'test', type: 'Organization', id: 1 } },
                repository_selection: 'selected',
                repositories_removed: [{ id: 1, name: 'repo1', full_name: 'test/repo1' }],
            };

            await service.handleInstallationRepositoriesRemoved(payload as any);

            expect(updateFn).toHaveBeenCalledWith({
                repositories: expect.arrayContaining([
                    expect.objectContaining({ id: 2 }),
                ]),
            });
        });

        it('throws error if installation not found', async () => {
            const eqFnForSelect = vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: null, error: null }),
            });
            const selectFn = vi.fn().mockReturnValue({ eq: eqFnForSelect });
            mockFrom.mockReturnValue({ select: selectFn });

            const payload = {
                action: 'removed',
                installation: { id: 999, account: { login: 'test', type: 'Organization', id: 1 } },
                repository_selection: 'selected',
                repositories_removed: [],
            };

            await expect(
                service.handleInstallationRepositoriesRemoved(payload as any)
            ).rejects.toThrow('Installation not found');
        });
    });
});
