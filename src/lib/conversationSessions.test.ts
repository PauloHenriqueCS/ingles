import { describe, it, expect, vi, beforeEach } from 'vitest';

// conversationSessions.ts (via apiAuth.ts and its own getDayTotalSeconds/
// getMonthSessionTotals) imports the real browser supabase client singleton,
// which throws at module-load time without VITE_SUPABASE_URL/ANON_KEY set
// (not present in this test environment — pre-existing, unrelated to the
// audit fix below). Mocking the module here — same technique used
// throughout this codebase's other lib tests — avoids that crash without
// needing real env vars, and lets us control auth/query results per test.
const { mockGetSession, mockSupabaseFrom } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockSupabaseFrom: vi.fn(),
}));

vi.mock('./supabase', () => ({
  supabase: {
    auth: { getSession: mockGetSession },
    from: mockSupabaseFrom,
  },
}));

import {
  isConversationGoalMet,
  completeConversationSession,
  getDayTotalSeconds,
  getMonthSessionTotals,
  getConversationGoalMinutes,
} from './conversationSessions';

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'test-token' } } });
});

describe('isConversationGoalMet', () => {
  it('is false below the goal', () => {
    expect(isConversationGoalMet(10 * 60, 15)).toBe(false);
  });
  it('is true exactly at the goal', () => {
    expect(isConversationGoalMet(15 * 60, 15)).toBe(true);
  });
  it('is true above the goal', () => {
    expect(isConversationGoalMet(20 * 60, 15)).toBe(true);
  });
  it('is false at zero seconds with any positive goal', () => {
    expect(isConversationGoalMet(0, 15)).toBe(false);
  });
});

// ── completeConversationSession ─────────────────────────────────────────────
// Audit fix (2026-07-21): direct client INSERT into conversation_sessions
// (any duration_sec the browser chose) let a student bypass the monthly
// quota. The client now only ever tells the server WHICH authorization row
// to close — completeConversationSession never sends a duration itself, and
// the server computes it authoritatively from authorized_at.

describe('completeConversationSession', () => {
  it('POSTs only the recordingAuthorizationId to /api/conversation/session-complete, never a duration', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'completed', durationSeconds: 900 }) });
    vi.stubGlobal('fetch', mockFetch);

    await completeConversationSession('auth-id-123');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/conversation/session-complete');
    expect(init.method).toBe('POST');
    const sentBody = JSON.parse(init.body);
    expect(sentBody).toEqual({ recordingAuthorizationId: 'auth-id-123' });
    expect(JSON.stringify(sentBody)).not.toMatch(/duration/i);
  });

  it('includes the auth header from the current session', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', mockFetch);

    await completeConversationSession('auth-id-123');

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer test-token');
  });

  it('is best-effort — a network failure never throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(completeConversationSession('auth-id-123')).resolves.toBeUndefined();
  });

  it('a non-ok response never throws (server already logs/no-ops internally)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ status: 'ignored' }) }));
    await expect(completeConversationSession('auth-id-123')).resolves.toBeUndefined();
  });
});

// ── getDayTotalSeconds / getMonthSessionTotals / getConversationGoalMinutes ──
// Unaffected by the audit fix — still plain reads of conversation_sessions
// (now populated only by the server's session-complete handler).

describe('getDayTotalSeconds', () => {
  it('sums duration_sec across rows for the date', async () => {
    mockSupabaseFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [{ duration_sec: 300 }, { duration_sec: 120 }] }) }),
    });
    const total = await getDayTotalSeconds('2026-07-21');
    expect(total).toBe(420);
  });

  it('returns 0 when there is no data', async () => {
    mockSupabaseFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null }) }),
    });
    expect(await getDayTotalSeconds('2026-07-21')).toBe(0);
  });
});

describe('getMonthSessionTotals', () => {
  it('groups duration_sec by session_date within the month range', async () => {
    mockSupabaseFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        gte: vi.fn().mockReturnValue({
          lte: vi.fn().mockResolvedValue({
            data: [
              { session_date: '2026-07-02', duration_sec: 300 },
              { session_date: '2026-07-02', duration_sec: 100 },
              { session_date: '2026-07-15', duration_sec: 600 },
            ],
          }),
        }),
      }),
    });
    const totals = await getMonthSessionTotals(2026, 7);
    expect(totals).toEqual({ '2026-07-02': 400, '2026-07-15': 600 });
  });
});

describe('getConversationGoalMinutes', () => {
  it('returns the stored goal when present', async () => {
    mockSupabaseFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: { daily_conversation_goal_minutes: 20 } }) }),
    });
    expect(await getConversationGoalMinutes()).toBe(20);
  });

  it('defaults to 15 minutes when unset', async () => {
    mockSupabaseFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null }) }),
    });
    expect(await getConversationGoalMinutes()).toBe(15);
  });
});
