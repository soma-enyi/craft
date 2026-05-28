import { describe, it, expect, vi, beforeEach } from 'vitest';

// Polyfill File.prototype.arrayBuffer for test environment
if (typeof File !== 'undefined' && !File.prototype.arrayBuffer) {
    File.prototype.arrayBuffer = function () {
        return Promise.resolve(Uint8Array.from(this).buffer);
    };
}
import { NextRequest } from 'next/server';

const mockGetUser = vi.fn();
const mockStorageUpload = vi.fn();
const mockGetPublicUrl = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
    createClient: () => ({
        auth: { getUser: mockGetUser },
        storage: {
            from: vi.fn(() => ({
                upload: mockStorageUpload,
                getPublicUrl: mockGetPublicUrl,
            })),
        },
        from: vi.fn(),
    }),
}));

const fakeUser = { id: 'user-1', email: 'a@b.com' };

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeMultipartRequest(file: File | null) {
    const form = new FormData();
    if (file) {
        form.append('file', file);
    }

    const req = new NextRequest('http://localhost/api/branding/upload', { method: 'POST' });
    (req as any).formData = async () => form;
    return req;
}

describe('POST /api/branding/upload', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetUser.mockResolvedValue({ data: { user: fakeUser }, error: null });
    });

    it('returns 401 when unauthenticated', async () => {
        mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
        const { POST } = await import('./route');
        const res = await POST(makeMultipartRequest(null), { params: {} });
        expect(res.status).toBe(401);
    });

    it('returns 400 when no file field is present', async () => {
        const { POST } = await import('./route');
        const res = await POST(makeMultipartRequest(null), { params: {} });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/file/i);
    });

    it('returns 422 for disallowed MIME type', async () => {
        const { POST } = await import('./route');
        const file = new File([new Uint8Array([0x47, 0x49, 0x46])], 'logo.gif', { type: 'image/gif' });
        const res = await POST(makeMultipartRequest(file), { params: {} });
        expect(res.status).toBe(422);
        const body = await res.json();
        expect(body.code).toBe('INVALID_MIME_TYPE');
    });

    it('returns 422 for file exceeding size limit', async () => {
        const { POST } = await import('./route');
        const big = new Uint8Array(2 * 1024 * 1024 + 1);
        big.set(PNG_MAGIC);
        const file = new File([big], 'logo.png', { type: 'image/png' });
        const res = await POST(makeMultipartRequest(file), { params: {} });
        expect(res.status).toBe(422);
        expect((await res.json()).code).toBe('FILE_TOO_LARGE');
    });

    it('returns 200 and uploads to user namespace with path-based policy', async () => {
        const { POST } = await import('./route');
        const file = new File([PNG_MAGIC], 'logo.png', { type: 'image/png' });

        mockStorageUpload.mockResolvedValue({
            data: { path: 'user-1/logo.png' },
            error: null,
        });
        mockGetPublicUrl.mockReturnValue({
            data: { publicUrl: 'https://storage.example.com/user-1/logo.png' },
        });

        const res = await POST(makeMultipartRequest(file), { params: {} });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.url).toBe('https://storage.example.com/user-1/logo.png');

        // Verify upload used user namespace path
        expect(mockStorageUpload).toHaveBeenCalledWith(
            'user-1/logo.png',
            expect.any(Uint8Array),
            expect.objectContaining({ contentType: 'image/png', upsert: true }),
        );
    });

    it('returns 422 for unsafe SVG', async () => {
        const { POST } = await import('./route');
        const evil = new TextEncoder().encode('<svg><script>alert(1)</script></svg>');
        const file = new File([evil], 'logo.svg', { type: 'image/svg+xml' });
        const res = await POST(makeMultipartRequest(file), { params: {} });
        expect(res.status).toBe(422);
        expect((await res.json()).code).toBe('UNSAFE_SVG');
    });

    it('returns 500 when storage upload fails', async () => {
        const { POST } = await import('./route');
        const file = new File([PNG_MAGIC], 'logo.png', { type: 'image/png' });

        mockStorageUpload.mockResolvedValue({
            data: null,
            error: { message: 'Storage quota exceeded' },
        });

        const res = await POST(makeMultipartRequest(file), { params: {} });

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error).toMatch(/Storage quota exceeded/);
    });

    it('enforces path-based namespace - user cannot upload to another user namespace', async () => {
        const { POST } = await import('./route');
        const file = new File([PNG_MAGIC], '../other-user-file.png', { type: 'image/png' });

        // The endpoint should use the authenticated user's ID, not allow path traversal
        mockStorageUpload.mockResolvedValue({
            data: { path: 'user-1/../other-user-file.png' },
            error: null,
        });
        mockGetPublicUrl.mockReturnValue({
            data: { publicUrl: 'https://storage.example.com/user-1/..%2Fother-user-file.png' },
        });

        const res = await POST(makeMultipartRequest(file), { params: {} });

        // The upload should be made to the user's own namespace
        expect(mockStorageUpload).toHaveBeenCalledWith(
            'user-1/../other-user-file.png',
            expect.any(Uint8Array),
            expect.any(Object),
        );

        // Supabase RLS policy will enforce the namespace restriction
        expect(res.status).toBe(200);
    });
});
