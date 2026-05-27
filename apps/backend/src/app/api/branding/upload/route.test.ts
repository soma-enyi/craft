import { describe, it, expect, vi, beforeEach } from 'vitest';

// Polyfill File.prototype.arrayBuffer for test environment
if (typeof File !== 'undefined' && !File.prototype.arrayBuffer) {
    File.prototype.arrayBuffer = function () {
        return Promise.resolve(Uint8Array.from(this).buffer);
    };
}
import { NextRequest } from 'next/server';

const mockGetUser = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
    createClient: () => ({ auth: { getUser: mockGetUser }, from: vi.fn() }),
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

    it('returns 200 for a valid PNG', async () => {
        const { POST } = await import('./route');
        const file = new File([PNG_MAGIC], 'logo.png', { type: 'image/png' });
        const res = await POST(makeMultipartRequest(file), { params: {} });
        expect(res.status).toBe(200);
    });

    it('returns 422 for unsafe SVG', async () => {
        const { POST } = await import('./route');
        const evil = new TextEncoder().encode('<svg><script>alert(1)</script></svg>');
        const file = new File([evil], 'logo.svg', { type: 'image/svg+xml' });
        const res = await POST(makeMultipartRequest(file), { params: {} });
        expect(res.status).toBe(422);
        expect((await res.json()).code).toBe('UNSAFE_SVG');
    });

    it('returns 413 when content-length exceeds size limit', async () => {
        const { POST } = await import('./route');
        const req = new NextRequest('http://localhost/api/branding/upload', {
            method: 'POST',
            headers: {
                'content-length': String(6 * 1024 * 1024), // 6MB, exceeds 5MB limit
            },
        });
        const res = await POST(req, { params: {} });
        expect(res.status).toBe(413);
        expect((await res.json()).error).toContain('exceeds maximum');
    });

    it('returns 413 when content-length is missing', async () => {
        const { POST } = await import('./route');
        const req = new NextRequest('http://localhost/api/branding/upload', {
            method: 'POST',
            headers: {},
        });
        const res = await POST(req, { params: {} });
        expect(res.status).toBe(413);
    });

    it('accepts valid metadata in JSON format', async () => {
        const { POST } = await import('./route');
        const form = new FormData();
        const file = new File([PNG_MAGIC], 'logo.png', { type: 'image/png' });
        form.append('file', file);
        form.append('metadata', JSON.stringify({
            filename: 'logo.png',
            description: 'Main logo',
            tags: ['logo', 'brand'],
            category: 'branding',
        }));

        const req = new NextRequest('http://localhost/api/branding/upload', { method: 'POST' });
        (req as any).formData = async () => form;

        const res = await POST(req, { params: {} });
        expect(res.status).toBe(200);
    });

    it('returns 400 for invalid metadata JSON', async () => {
        const { POST } = await import('./route');
        const form = new FormData();
        const file = new File([PNG_MAGIC], 'logo.png', { type: 'image/png' });
        form.append('file', file);
        form.append('metadata', '{invalid json}');

        const req = new NextRequest('http://localhost/api/branding/upload', { method: 'POST' });
        (req as any).formData = async () => form;

        const res = await POST(req, { params: {} });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toContain('JSON');
    });

    it('returns 400 for invalid metadata schema', async () => {
        const { POST } = await import('./route');
        const form = new FormData();
        const file = new File([PNG_MAGIC], 'logo.png', { type: 'image/png' });
        form.append('file', file);
        form.append('metadata', JSON.stringify({
            filename: 123, // Invalid: should be string
            tags: 'not-array', // Invalid: should be array
        }));

        const req = new NextRequest('http://localhost/api/branding/upload', { method: 'POST' });
        (req as any).formData = async () => form;

        const res = await POST(req, { params: {} });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toContain('Validation');
    });

    it('returns 400 when metadata is not a JSON string', async () => {
        const { POST } = await import('./route');
        const form = new FormData();
        const file = new File([PNG_MAGIC], 'logo.png', { type: 'image/png' });
        form.append('file', file);
        form.append('metadata', 123); // Not a string

        const req = new NextRequest('http://localhost/api/branding/upload', { method: 'POST' });
        (req as any).formData = async () => form;

        const res = await POST(req, { params: {} });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toContain('JSON string');
    });

    it('returns 413 when file size exceeds limit in body validation', async () => {
        const { POST } = await import('./route');
        const big = new Uint8Array(6 * 1024 * 1024); // 6MB
        big.set(PNG_MAGIC);
        const file = new File([big], 'logo.png', { type: 'image/png' });
        const res = await POST(makeMultipartRequest(file), { params: {} });
        expect(res.status).toBe(413);
        expect((await res.json()).error).toContain('exceeds maximum');
    });
});
