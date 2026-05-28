/**
 * Tests for withGitHubRetry — bounded exponential backoff for GitHub API calls.
 *
 * Retry strategy:
 *   - Up to 3 retries (4 total attempts) on RATE_LIMITED or NETWORK_ERROR.
 *   - When GitHub supplies a Retry-After header the value is used as the delay floor.
 *   - Otherwise full-jitter exponential backoff is applied:
 *       delay = Math.random() * min(BASE_MS * 2^attempt, 32_000)
 *     where BASE_MS = 1_000 ms and the hard cap is 32_000 ms.
 *   - Terminal errors (AUTH_FAILED, COLLISION, UNKNOWN) are re-thrown immediately.
 *
 * Covers:
 *   - Succeeds on first attempt (no retries)
 *   - Retries RATE_LIMITED and recovers
 *   - Retries NETWORK_ERROR and recovers
 *   - Honours Retry-After header as the delay floor
 *   - Falls back to exponential backoff when Retry-After is absent
 *   - Exhausts retries and re-throws the last error
 *   - Does NOT retry terminal errors (AUTH_FAILED, COLLISION, UNKNOWN)
 *   - Logs a warning on each retry
 *   - Full-jitter is applied: delay scales with Math.random()
 *   - Backoff grows exponentially across successive attempts
 *   - Backoff is capped at 32_000 ms
 *   - createRepository retries transparently and returns on recovery
 *   - createRepository still surfaces COLLISION after name retries
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withGitHubRetry, GitHubService } from './github.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

const noSleep = vi.fn().mockResolvedValue(undefined);

function makeError(code: string, retryAfterMs?: number) {
    const err = new Error(`GitHub error: ${code}`) as Error & {
        code: string;
        retryAfterMs?: number;
    };
    err.code = code;
    if (retryAfterMs !== undefined) err.retryAfterMs = retryAfterMs;
    return err;
}

function makeJsonResponse(
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k: string) => headers[k] ?? null },
        json: async () => body,
    };
}

const REPO_RESPONSE = {
    id: 1,
    html_url: 'https://github.com/org/repo',
    clone_url: 'https://github.com/org/repo.git',
    ssh_url: 'git@github.com:org/repo.git',
    full_name: 'org/repo',
    default_branch: 'main',
    private: true,
};

// ── withGitHubRetry ───────────────────────────────────────────────────────────

describe('withGitHubRetry', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns immediately when fn succeeds on the first attempt', async () => {
        const fn = vi.fn().mockResolvedValue('ok');
        const result = await withGitHubRetry(fn, noSleep);
        expect(result).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(1);
        expect(noSleep).not.toHaveBeenCalled();
    });

    it('retries on RATE_LIMITED and returns on recovery', async () => {
        const fn = vi
            .fn()
            .mockRejectedValueOnce(makeError('RATE_LIMITED'))
            .mockResolvedValue('recovered');

        const result = await withGitHubRetry(fn, noSleep);
        expect(result).toBe('recovered');
        expect(fn).toHaveBeenCalledTimes(2);
        expect(noSleep).toHaveBeenCalledTimes(1);
    });

    it('retries on NETWORK_ERROR and returns on recovery', async () => {
        const fn = vi
            .fn()
            .mockRejectedValueOnce(makeError('NETWORK_ERROR'))
            .mockResolvedValue('recovered');

        const result = await withGitHubRetry(fn, noSleep);
        expect(result).toBe('recovered');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('honours Retry-After as the sleep delay', async () => {
        const delays: number[] = [];
        const sleep = (ms: number) => { delays.push(ms); return Promise.resolve(); };

        const fn = vi
            .fn()
            .mockRejectedValueOnce(makeError('RATE_LIMITED', 5_000))
            .mockResolvedValue('ok');

        await withGitHubRetry(fn, sleep);
        expect(delays).toHaveLength(1);
        expect(delays[0]).toBe(5_000);
    });

    it('uses exponential backoff when Retry-After is absent', async () => {
        const delays: number[] = [];
        const sleep = (ms: number) => { delays.push(ms); return Promise.resolve(); };

        const fn = vi
            .fn()
            .mockRejectedValueOnce(makeError('RATE_LIMITED'))
            .mockRejectedValueOnce(makeError('RATE_LIMITED'))
            .mockResolvedValue('ok');

        await withGitHubRetry(fn, sleep);
        expect(delays).toHaveLength(2);
        // Both delays must be non-negative and within the 32 s cap
        for (const d of delays) {
            expect(d).toBeGreaterThanOrEqual(0);
            expect(d).toBeLessThanOrEqual(32_000);
        }
    });

    it('exhausts retries and re-throws the last error', async () => {
        const lastErr = makeError('RATE_LIMITED', 1_000);
        const fn = vi.fn().mockRejectedValue(lastErr);

        await expect(withGitHubRetry(fn, noSleep)).rejects.toBe(lastErr);
        // 1 initial + 3 retries = 4 total calls
        expect(fn).toHaveBeenCalledTimes(4);
    });

    it('does NOT retry AUTH_FAILED — throws immediately', async () => {
        const fn = vi.fn().mockRejectedValue(makeError('AUTH_FAILED'));

        await expect(withGitHubRetry(fn, noSleep)).rejects.toMatchObject({ code: 'AUTH_FAILED' });
        expect(fn).toHaveBeenCalledTimes(1);
        expect(noSleep).not.toHaveBeenCalled();
    });

    it('does NOT retry COLLISION — throws immediately', async () => {
        const fn = vi.fn().mockRejectedValue(makeError('COLLISION'));

        await expect(withGitHubRetry(fn, noSleep)).rejects.toMatchObject({ code: 'COLLISION' });
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry UNKNOWN — throws immediately', async () => {
        const fn = vi.fn().mockRejectedValue(makeError('UNKNOWN'));

        await expect(withGitHubRetry(fn, noSleep)).rejects.toMatchObject({ code: 'UNKNOWN' });
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('logs a console.warn on each retry with attempt context', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const fn = vi
            .fn()
            .mockRejectedValueOnce(makeError('RATE_LIMITED'))
            .mockRejectedValueOnce(makeError('NETWORK_ERROR'))
            .mockResolvedValue('ok');

        await withGitHubRetry(fn, noSleep);

        expect(warnSpy).toHaveBeenCalledTimes(2);
        expect(warnSpy.mock.calls[0][0]).toMatch(/RATE_LIMITED/);
        expect(warnSpy.mock.calls[0][0]).toMatch(/attempt 1\/3/);
        expect(warnSpy.mock.calls[1][0]).toMatch(/NETWORK_ERROR/);
        expect(warnSpy.mock.calls[1][0]).toMatch(/attempt 2\/3/);

        warnSpy.mockRestore();
    });
});

// ── GitHubService.createRepository — backoff integration ─────────────────────

describe('GitHubService.createRepository — backoff integration', () => {
    const mockFetch = vi.fn();

    beforeEach(() => {
        vi.stubGlobal('fetch', mockFetch);
        process.env.GITHUB_TOKEN = 'ghp_test_token';
        vi.clearAllMocks();
    });

    afterEach(() => {
        delete process.env.GITHUB_TOKEN;
        vi.unstubAllGlobals();
    });

    it('retries a 429 transparently and returns the repository on recovery', async () => {
        mockFetch
            .mockResolvedValueOnce(
                makeJsonResponse(429, { message: 'rate limited' }, { 'Retry-After': '1' }),
            )
            .mockResolvedValueOnce(makeJsonResponse(201, REPO_RESPONSE));

        const service = new GitHubService();
        const result = await service.createRepository(
            { name: 'repo', private: true, userId: 'u1' },
            noSleep,
        );

        expect(result.resolvedName).toBe('repo');
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('retries a transient 500 and returns the repository on recovery', async () => {
        mockFetch
            .mockResolvedValueOnce(makeJsonResponse(500, { message: 'Internal Server Error' }))
            .mockResolvedValueOnce(makeJsonResponse(201, REPO_RESPONSE));

        const service = new GitHubService();
        const result = await service.createRepository(
            { name: 'repo', private: true, userId: 'u1' },
            noSleep,
        );

        expect(result.resolvedName).toBe('repo');
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('surfaces the last RATE_LIMITED error after all retries are exhausted', async () => {
        // 1 initial + 3 retries = 4 calls, all rate-limited
        mockFetch.mockResolvedValue(
            makeJsonResponse(429, { message: 'rate limited' }, { 'Retry-After': '0' }),
        );

        const service = new GitHubService();
        await expect(
            service.createRepository({ name: 'repo', private: true, userId: 'u1' }, noSleep),
        ).rejects.toMatchObject({ code: 'RATE_LIMITED' });

        expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('still surfaces COLLISION after name retries are exhausted', async () => {
        const collisionBody = { errors: [{ message: 'name already exists on this account' }] };
        // 6 collision responses (base + 5 suffixes), each wrapped in withGitHubRetry
        for (let i = 0; i < 6; i++) {
            mockFetch.mockResolvedValueOnce(makeJsonResponse(422, collisionBody));
        }

        const service = new GitHubService();
        await expect(
            service.createRepository({ name: 'repo', private: true, userId: 'u1' }, noSleep),
        ).rejects.toMatchObject({ code: 'COLLISION' });
    });

    it('does not retry AUTH_FAILED — surfaces it immediately', async () => {
        mockFetch.mockResolvedValueOnce(makeJsonResponse(401, { message: 'Bad credentials' }));

        const service = new GitHubService();
        await expect(
            service.createRepository({ name: 'repo', private: true, userId: 'u1' }, noSleep),
        ).rejects.toMatchObject({ code: 'AUTH_FAILED' });

        expect(mockFetch).toHaveBeenCalledTimes(1);
    });
});

// ── withGitHubRetry — jitter and exponential backoff invariants ───────────────

describe('withGitHubRetry — jitter and exponential backoff invariants', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('delay scales with Math.random() output (full-jitter)', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        const delays: number[] = [];
        const sleep = (ms: number) => { delays.push(ms); return Promise.resolve(); };

        const fn = vi
            .fn()
            .mockRejectedValueOnce(makeError('RATE_LIMITED'))
            .mockRejectedValueOnce(makeError('RATE_LIMITED'))
            .mockResolvedValue('ok');

        await withGitHubRetry(fn, sleep);

        // attempt 0: 0.5 * min(1_000 * 2^0, 32_000) = 0.5 * 1_000 = 500
        // attempt 1: 0.5 * min(1_000 * 2^1, 32_000) = 0.5 * 2_000 = 1_000
        expect(delays[0]).toBe(500);
        expect(delays[1]).toBe(1_000);
    });

    it('delay is 0 when Math.random returns 0 (minimum jitter)', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const delays: number[] = [];
        const sleep = (ms: number) => { delays.push(ms); return Promise.resolve(); };

        const fn = vi
            .fn()
            .mockRejectedValueOnce(makeError('RATE_LIMITED'))
            .mockResolvedValue('ok');

        await withGitHubRetry(fn, sleep);
        expect(delays[0]).toBe(0);
    });

    it('backoff ceiling grows across successive retry attempts (exponential growth)', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(1);
        const delays: number[] = [];
        const sleep = (ms: number) => { delays.push(ms); return Promise.resolve(); };

        const fn = vi
            .fn()
            .mockRejectedValueOnce(makeError('RATE_LIMITED'))
            .mockRejectedValueOnce(makeError('RATE_LIMITED'))
            .mockResolvedValue('ok');

        await withGitHubRetry(fn, sleep);

        // With Math.random()=1 the delay equals the cap for each attempt.
        // attempt 0 cap: min(1000*1, 32000) = 1_000
        // attempt 1 cap: min(1000*2, 32000) = 2_000
        expect(delays[1]).toBeGreaterThan(delays[0]);
    });

    it('delay is bounded at 32_000 ms regardless of attempt number', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(1);
        const delays: number[] = [];
        const sleep = (ms: number) => { delays.push(ms); return Promise.resolve(); };

        const fn = vi.fn().mockRejectedValue(makeError('RATE_LIMITED'));
        await withGitHubRetry(fn, sleep).catch(() => {});

        for (const d of delays) {
            expect(d).toBeLessThanOrEqual(32_000);
        }
    });

    it('total attempt count is 1 initial + 3 retries = 4 when all attempts fail', async () => {
        const fn = vi.fn().mockRejectedValue(makeError('RATE_LIMITED'));
        await withGitHubRetry(fn, noSleep).catch(() => {});
        expect(fn).toHaveBeenCalledTimes(4);
    });

    it('total attempt count is 1 when fn succeeds immediately (no retry slot consumed)', async () => {
        const fn = vi.fn().mockResolvedValue('success');
        await withGitHubRetry(fn, noSleep);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('Retry-After takes precedence over jitter: jitter is not applied when Retry-After is present', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        const delays: number[] = [];
        const sleep = (ms: number) => { delays.push(ms); return Promise.resolve(); };

        const fn = vi
            .fn()
            .mockRejectedValueOnce(makeError('RATE_LIMITED', 7_000))
            .mockResolvedValue('ok');

        await withGitHubRetry(fn, sleep);

        // Retry-After of 7_000 ms must be honoured exactly, not multiplied by Math.random()
        expect(delays[0]).toBe(7_000);
    });
});
