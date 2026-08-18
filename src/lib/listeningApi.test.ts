import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./apiAuth', () => ({ getAuthHeader: vi.fn().mockResolvedValue({}) }));
vi.mock('./apiUrl', () => ({ apiUrl: (p: string) => p }));

import { completeStoryListening, ListeningApiError } from './listeningApi';

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('completeStoryListening — idempotent auto-retry (kills false calendar error)', () => {
  it('succeeds on the first attempt with a single request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { activityDate: '2026-08-18', saved: true, alreadyCompleted: false }));
    global.fetch = fetchMock as any;
    const r = await completeStoryListening('story-1');
    expect(r).toEqual({ activityDate: '2026-08-18', saved: true, alreadyCompleted: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a lost response (network reject) — the idempotent retry returns already_completed success', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse(200, { activityDate: '2026-08-18', saved: true, alreadyCompleted: true }));
    global.fetch = fetchMock as any;
    const p = completeStoryListening('story-1');
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.saved).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 5xx / non-JSON timeout response then succeeds', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 504, json: async () => { throw new Error('not json'); } })
      .mockResolvedValueOnce(jsonResponse(200, { activityDate: '2026-08-18', saved: true }));
    global.fetch = fetchMock as any;
    const p = completeStoryListening('story-1');
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.saved).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a definitive 4xx error (e.g. auth) — fails fast', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ code: 'UNAUTHORIZED', message: 'no' }) });
    global.fetch = fetchMock as any;
    await expect(completeStoryListening('story-1')).rejects.toBeInstanceOf(ListeningApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is bounded: gives up after 3 transient failures (manual retry button remains)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    global.fetch = fetchMock as any;
    const p = completeStoryListening('story-1');
    const rejects = expect(p).rejects.toBeInstanceOf(TypeError);
    await vi.runAllTimersAsync();
    await rejects;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
