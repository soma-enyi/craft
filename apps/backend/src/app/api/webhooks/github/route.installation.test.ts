import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/github/webhook-verification', () => ({
    verifyGitHubWebhookSignature: vi.fn().mockReturnValue(true),
}));

vi.mock('@/lib/api/logger', () => ({
    createLogger: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    })),
    resolveCorrelationId: vi.fn(() => 'test-correlation-id'),
    CORRELATION_ID_HEADER: 'x-correlation-id',
}));

const mockHandleInstallationCreated = vi.fn();
const mockHandleInstallationDeleted = vi.fn();
const mockHandleInstallationRepositoriesAdded = vi.fn();
const mockHandleInstallationRepositoriesRemoved = vi.fn();

vi.mock('@/services/github-app-installation.service', () => ({
    gitHubAppInstallationService: {
        handleInstallationCreated: mockHandleInstallationCreated,
        handleInstallationDeleted: mockHandleInstallationDeleted,
        handleInstallationRepositoriesAdded: mockHandleInstallationRepositoriesAdded,
        handleInstallationRepositoriesRemoved: mockHandleInstallationRepositoriesRemoved,
    },
}));

vi.stubEnv('GITHUB_WEBHOOK_SECRET', 'test-secret');

let POST: any;

beforeEach(async () => {
    vi.clearAllMocks();
    const module = await import('./route');
    POST = module.POST;
});

describe('POST /api/webhooks/github – installation events', () => {
    it('rejects invalid webhook signature', async () => {
        const { verifyGitHubWebhookSignature } = await import(
            '@/lib/github/webhook-verification'
        );
        vi.mocked(verifyGitHubWebhookSignature).mockReturnValueOnce(false);

        const payload = { action: 'created', installation: { id: 123 } };
        const req = new NextRequest('http://localhost:3000/api/webhooks/github', {
            method: 'POST',
            headers: {
                'x-hub-signature-256': 'sha256=invalid',
                'x-github-event': 'installation',
                'x-github-delivery': 'test-delivery-123',
            },
            body: JSON.stringify(payload),
        });

        const res = await POST(req);
        expect(res.status).toBe(401);
        expect(mockHandleInstallationCreated).not.toHaveBeenCalled();
    });

    it('handles installation.created event', async () => {
        mockHandleInstallationCreated.mockResolvedValue(undefined);

        const payload = {
            action: 'created',
            installation: {
                id: 123,
                app_id: 456,
                account: { login: 'test-org', type: 'Organization', id: 789 },
            },
            repositories: [],
        };

        const req = new NextRequest('http://localhost:3000/api/webhooks/github', {
            method: 'POST',
            headers: {
                'x-hub-signature-256': 'sha256=valid',
                'x-github-event': 'installation',
                'x-github-delivery': 'test-delivery-123',
            },
            body: JSON.stringify(payload),
        });

        const res = await POST(req);
        expect(res.status).toBe(200);
        expect(mockHandleInstallationCreated).toHaveBeenCalled();
        const call = mockHandleInstallationCreated.mock.calls[0][0];
        expect(call.action).toBe('created');
        expect(call.installation?.id).toBe(123);
    });

    it('handles installation.deleted event', async () => {
        mockHandleInstallationDeleted.mockResolvedValue(undefined);

        const payload = {
            action: 'deleted',
            installation: {
                id: 123,
                app_id: 456,
                account: { login: 'test-org', type: 'Organization', id: 789 },
            },
        };

        const req = new NextRequest('http://localhost:3000/api/webhooks/github', {
            method: 'POST',
            headers: {
                'x-hub-signature-256': 'sha256=valid',
                'x-github-event': 'installation',
                'x-github-delivery': 'test-delivery-456',
            },
            body: JSON.stringify(payload),
        });

        const res = await POST(req);
        expect(res.status).toBe(200);
        expect(mockHandleInstallationDeleted).toHaveBeenCalled();
    });

    it('handles installation_repositories.added event', async () => {
        mockHandleInstallationRepositoriesAdded.mockResolvedValue(undefined);

        const payload = {
            action: 'added',
            installation: { id: 123, account: { login: 'test', type: 'Organization', id: 1 } },
            repositories_added: [{ id: 1, name: 'repo1', full_name: 'test/repo1' }],
        };

        const req = new NextRequest('http://localhost:3000/api/webhooks/github', {
            method: 'POST',
            headers: {
                'x-hub-signature-256': 'sha256=valid',
                'x-github-event': 'installation_repositories',
                'x-github-delivery': 'test-delivery-789',
            },
            body: JSON.stringify(payload),
        });

        const res = await POST(req);
        expect(res.status).toBe(200);
        expect(mockHandleInstallationRepositoriesAdded).toHaveBeenCalled();
    });

    it('handles installation_repositories.removed event', async () => {
        mockHandleInstallationRepositoriesRemoved.mockResolvedValue(undefined);

        const payload = {
            action: 'removed',
            installation: { id: 123, account: { login: 'test', type: 'Organization', id: 1 } },
            repositories_removed: [{ id: 1, name: 'repo1', full_name: 'test/repo1' }],
        };

        const req = new NextRequest('http://localhost:3000/api/webhooks/github', {
            method: 'POST',
            headers: {
                'x-hub-signature-256': 'sha256=valid',
                'x-github-event': 'installation_repositories',
                'x-github-delivery': 'test-delivery-999',
            },
            body: JSON.stringify(payload),
        });

        const res = await POST(req);
        expect(res.status).toBe(200);
        expect(mockHandleInstallationRepositoriesRemoved).toHaveBeenCalled();
    });

    it('returns 500 if handler throws error', async () => {
        mockHandleInstallationCreated.mockRejectedValueOnce(new Error('Service error'));

        const payload = { action: 'created', installation: { id: 123 } };
        const req = new NextRequest('http://localhost:3000/api/webhooks/github', {
            method: 'POST',
            headers: {
                'x-hub-signature-256': 'sha256=valid',
                'x-github-event': 'installation',
                'x-github-delivery': 'test-delivery-error',
            },
            body: JSON.stringify(payload),
        });

        const res = await POST(req);
        expect(res.status).toBe(500);
    });
});
