import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const mockExportAnalytics = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}));

vi.mock('@/services/analytics.service', () => ({
  analyticsService: {
    exportAnalytics: mockExportAnalytics,
  },
}));

const fakeUser = { id: 'user-1', email: 'user@example.com' };

const makeDeploymentsTable = (ownerId: string) => ({
  select: vi.fn((columns: string) => ({
    eq: vi.fn(() => ({
      single: vi
        .fn()
        .mockResolvedValue(
          columns === 'user_id'
            ? { data: { user_id: ownerId }, error: null }
            : { data: { name: 'stellar-dex' }, error: null }
        ),
    })),
  })),
});

function makeExportRequest(searchParams: Record<string, string> = {}) {
  const url = new URL('http://localhost/api/deployments/dep-1/analytics/export');
  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url.toString());
}

describe('GET /api/deployments/[id]/analytics/export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: fakeUser }, error: null });
    mockFrom.mockReturnValue(makeDeploymentsTable(fakeUser.id));
    mockExportAnalytics.mockResolvedValue(
      'Metric Type,Value,Recorded At\npage_view,1,2026-03-01T00:00:00.000Z'
    );
  });

  // ── Basic export ───────────────────────────────────────────────────────────

  it('returns CSV export with proper content headers', async () => {
    mockExportAnalytics.mockResolvedValue(
      'Metric Type,Value,Recorded At\npage_view,1,2026-03-01T00:00:00.000Z'
    );

    const { GET } = await import('./route');
    const res = await GET(makeExportRequest(), { params: { id: 'dep-1' } });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Metric Type,Value,Recorded At');
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('Content-Disposition')).toContain(
      'attachment; filename="analytics-'
    );
    expect(mockExportAnalytics).toHaveBeenCalledWith('dep-1', undefined, undefined);
  });

  it('returns 403 when user does not own deployment analytics', async () => {
    mockFrom.mockReturnValue(makeDeploymentsTable('other-user'));
    const { GET } = await import('./route');

    const res = await GET(makeExportRequest(), { params: { id: 'dep-1' } });

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Forbidden');
    expect(mockExportAnalytics).not.toHaveBeenCalled();
  });

  // ── Date-range filtering ───────────────────────────────────────────────────

  it('passes startDate as a Date object when provided as a query param', async () => {
    const { GET } = await import('./route');
    await GET(makeExportRequest({ startDate: '2026-01-01T00:00:00.000Z' }), { params: { id: 'dep-1' } });

    const [, startDate, endDate] = mockExportAnalytics.mock.calls[0];
    expect(startDate).toBeInstanceOf(Date);
    expect(startDate.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(endDate).toBeUndefined();
  });

  it('passes endDate as a Date object when provided as a query param', async () => {
    const { GET } = await import('./route');
    await GET(makeExportRequest({ endDate: '2026-03-31T23:59:59.999Z' }), { params: { id: 'dep-1' } });

    const [, startDate, endDate] = mockExportAnalytics.mock.calls[0];
    expect(startDate).toBeUndefined();
    expect(endDate).toBeInstanceOf(Date);
    expect(endDate.toISOString()).toBe('2026-03-31T23:59:59.999Z');
  });

  it('passes both startDate and endDate when both are provided', async () => {
    const { GET } = await import('./route');
    await GET(
      makeExportRequest({
        startDate: '2026-01-01T00:00:00.000Z',
        endDate: '2026-03-31T23:59:59.999Z',
      }),
      { params: { id: 'dep-1' } }
    );

    const [deploymentId, startDate, endDate] = mockExportAnalytics.mock.calls[0];
    expect(deploymentId).toBe('dep-1');
    expect(startDate).toBeInstanceOf(Date);
    expect(endDate).toBeInstanceOf(Date);
    expect(startDate.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(endDate.toISOString()).toBe('2026-03-31T23:59:59.999Z');
  });

  it('omits both date params (undefined) when neither startDate nor endDate is provided', async () => {
    const { GET } = await import('./route');
    await GET(makeExportRequest(), { params: { id: 'dep-1' } });

    expect(mockExportAnalytics).toHaveBeenCalledWith('dep-1', undefined, undefined);
  });

  // ── Pagination boundaries (via empty / partial result sets) ───────────────

  it('returns a header-only CSV when there are no analytics records (empty page)', async () => {
    mockExportAnalytics.mockResolvedValue('Metric Type,Value,Recorded At');
    const { GET } = await import('./route');
    const res = await GET(makeExportRequest(), { params: { id: 'dep-1' } });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe('Metric Type,Value,Recorded At');
    expect(res.headers.get('Content-Type')).toContain('text/csv');
  });

  it('returns all rows when the dataset fills exactly one page', async () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      `page_view,${i},2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`
    );
    const csv = ['Metric Type,Value,Recorded At', ...rows].join('\n');
    mockExportAnalytics.mockResolvedValue(csv);

    const { GET } = await import('./route');
    const res = await GET(makeExportRequest(), { params: { id: 'dep-1' } });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.split('\n')).toHaveLength(101); // header + 100 rows
  });

  // ── Export format and CSV escaping ─────────────────────────────────────────

  it('returns content with Content-Disposition filename containing the deployment name', async () => {
    const { GET } = await import('./route');
    const res = await GET(makeExportRequest(), { params: { id: 'dep-1' } });

    const disposition = res.headers.get('Content-Disposition') ?? '';
    expect(disposition).toContain('stellar-dex');
  });

  it('preserves CSV content with commas inside quoted fields', async () => {
    const csvWithCommas =
      'Metric Type,Value,Recorded At\n"page,view",1,2026-03-01T00:00:00.000Z';
    mockExportAnalytics.mockResolvedValue(csvWithCommas);

    const { GET } = await import('./route');
    const res = await GET(makeExportRequest(), { params: { id: 'dep-1' } });

    expect(await res.text()).toBe(csvWithCommas);
  });

  it('preserves CSV content with double-quote escaping', async () => {
    const csvWithQuotes =
      'Metric Type,Value,Recorded At\n"metric ""with"" quotes",1,2026-03-01T00:00:00.000Z';
    mockExportAnalytics.mockResolvedValue(csvWithQuotes);

    const { GET } = await import('./route');
    const res = await GET(makeExportRequest(), { params: { id: 'dep-1' } });

    expect(await res.text()).toBe(csvWithQuotes);
  });

  it('handles a large dataset (10 000 rows) without error', async () => {
    const rows = Array.from(
      { length: 10_000 },
      (_, i) => `page_view,${i},2026-01-01T00:00:00.000Z`
    );
    const csv = ['Metric Type,Value,Recorded At', ...rows].join('\n');
    mockExportAnalytics.mockResolvedValue(csv);

    const { GET } = await import('./route');
    const res = await GET(makeExportRequest(), { params: { id: 'dep-1' } });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.split('\n')).toHaveLength(10_001);
  });

  // ── Error handling ─────────────────────────────────────────────────────────

  it('returns 500 with an error message when exportAnalytics throws', async () => {
    mockExportAnalytics.mockRejectedValue(new Error('Query timeout'));
    const { GET } = await import('./route');
    const res = await GET(makeExportRequest(), { params: { id: 'dep-1' } });

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Query timeout');
  });

  it('returns 500 with fallback message when thrown value has no message', async () => {
    mockExportAnalytics.mockRejectedValue({});
    const { GET } = await import('./route');
    const res = await GET(makeExportRequest(), { params: { id: 'dep-1' } });

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to export analytics');
  });

  it('returns 401 when user is not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const { GET } = await import('./route');
    const res = await GET(makeExportRequest(), { params: { id: 'dep-1' } });

    expect(res.status).toBe(401);
    expect(mockExportAnalytics).not.toHaveBeenCalled();
  });
});
