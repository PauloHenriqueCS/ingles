/**
 * POST /api/listening/story/complete — CANONICAL calendar registration.
 *
 * The calendar's source of truth is the user_listening_assignments row
 * (episode_id IS NULL). The handler writes it via the ATOMIC, idempotent RPC
 * complete_listening_shared_assignment (INSERT ... ON CONFLICT DO UPDATE on the
 * partial unique index), so a retry / lost-response re-send / two concurrent
 * finishes can never duplicate the calendar registration. Curricular credit
 * (blockers 5/6) runs only on the FIRST completion (skipped on an idempotent
 * retry — it already ran, and skipping keeps retries fast). The handler never
 * consumes the daily quota (consumption happens separately, at "Começar a
 * ouvir"), so a completion retry can never double-consume.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAuth, mockGetListeningClient, mockRecordFromIdentity } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockGetListeningClient: vi.fn(),
  mockRecordFromIdentity: vi.fn(),
}));

vi.mock('../_auth', () => ({ requireAuth: mockRequireAuth }));
vi.mock('../../src/services/listening/publication/_supabase', () => ({ getListeningServiceClient: mockGetListeningClient }));
vi.mock('../_curriculum/service-client', () => ({ getCurriculumServiceClient: () => ({}) }));
vi.mock('../_curriculum/curriculum-runtime', () => ({
  recordCurricularPracticeFromIdentity: mockRecordFromIdentity,
  CurriculumConfigError: class extends Error {},
}));
vi.mock('../../src/services/listening/daily/resolve-listening-activity-date', () => ({
  resolveListeningActivityDate: () => '2026-08-15',
}));

import handler from '../listening/[...slug]';

const USER = 'user-1';
const STORY_A = '11111111-1111-1111-1111-111111111111';
const STORY_B = '22222222-2222-2222-2222-222222222222';

// Mock listening client: select/eq/is/maybeSingle for the progress/story reads,
// plus rpc() for the atomic completion. `alreadyCompleted` drives the RPC return
// (i.e., whether this call is the first completion or an idempotent retry).
function makeListeningClient(fixture: {
  alreadyCompleted?: boolean;
  progress?: Record<string, { completed: boolean; activity_date: string } | null>;
  stories?: Record<string, { curriculum_version_id: string | null; subtopic_key: string | null } | null>;
  rpcError?: unknown;
}) {
  const rpcCalls: Array<{ name: string; args: any }> = [];
  const client: any = {
    _rpcCalls: rpcCalls,
    from(table: string) {
      const q: any = {
        _eq: {} as Record<string, any>,
        select() { return q; },
        eq(c: string, v: any) { q._eq[c] = v; return q; },
        is(c: string, v: any) { q._eq[c] = v; return q; },
        order() { return q; },
        limit() { return q; },
        async maybeSingle() {
          if (table === 'user_listening_shared_progress') return { data: fixture.progress?.[q._eq.shared_story_id] ?? null, error: null };
          if (table === 'listening_shared_stories') return { data: fixture.stories?.[q._eq.id] ?? null, error: null };
          return { data: null, error: null };
        },
      };
      return q;
    },
    async rpc(name: string, args: any) {
      rpcCalls.push({ name, args });
      if (fixture.rpcError) return { data: null, error: fixture.rpcError };
      return { data: [{ already_completed: Boolean(fixture.alreadyCompleted) }], error: null };
    },
  };
  return client;
}

function makeReq(body: any) {
  return { method: 'POST', headers: { authorization: 'Bearer t' }, query: { slug: 'story/complete' }, url: '/api/listening/story/complete', body };
}
function makeRes() {
  let _s = 200; let _b: any;
  const res: any = { status(s: number) { _s = s; return res; }, json(b: any) { _b = b; return res; }, setHeader() {}, _status: () => _s, _body: () => _b };
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ userId: USER });
  mockRecordFromIdentity.mockResolvedValue({ recorded: true, subtopicKey: 'A1.M1.S1', versionId: 'v1', currentSubtopicKey: 'A1.M1.S1', status: 'active' });
});

describe('story/complete — canonical calendar registration (atomic + idempotent)', () => {
  it('registers the calendar via the atomic RPC, with the SP activity date, and credits the exact story', async () => {
    const client = makeListeningClient({
      alreadyCompleted: false,
      progress: { [STORY_A]: { completed: true, activity_date: '2026-08-15' } },
      stories: { [STORY_A]: { curriculum_version_id: 'v1', subtopic_key: 'A1.M1.S1' } },
    });
    mockGetListeningClient.mockReturnValue(client);
    const res = makeRes();
    await handler(makeReq({ sharedStoryId: STORY_A }), res);

    expect(res._status()).toBe(200);
    expect(res._body()).toEqual({ activityDate: '2026-08-15', saved: true, alreadyCompleted: false });
    // Exactly one completion RPC, keyed by user + the America/Sao_Paulo date.
    const completeCalls = client._rpcCalls.filter((c: any) => c.name === 'complete_listening_shared_assignment');
    expect(completeCalls).toHaveLength(1);
    expect(completeCalls[0].args).toEqual({ p_user_id: USER, p_activity_date: '2026-08-15' });
    // First completion → curricular credit for the EXACT finished story.
    expect(mockRecordFromIdentity).toHaveBeenCalledWith(
      expect.anything(), USER, 'listening', STORY_A, { versionId: 'v1', subtopicKey: 'A1.M1.S1' },
    );
  });

  it('NEVER consumes the daily quota — no consume RPC is ever invoked on completion', async () => {
    const client = makeListeningClient({
      alreadyCompleted: false,
      progress: { [STORY_A]: { completed: true, activity_date: '2026-08-15' } },
      stories: { [STORY_A]: { curriculum_version_id: 'v1', subtopic_key: 'A1.M1.S1' } },
    });
    mockGetListeningClient.mockReturnValue(client);
    await handler(makeReq({ sharedStoryId: STORY_A }), makeRes());
    expect(client._rpcCalls.some((c: any) => c.name === 'consume_listening_pending_story')).toBe(false);
  });

  it('IDEMPOTENT RETRY: an already-completed day returns success, skips curricular (no double credit), never consumes', async () => {
    const client = makeListeningClient({
      alreadyCompleted: true, // the calendar row already existed → this is a retry
      progress: { [STORY_A]: { completed: true, activity_date: '2026-08-15' } },
      stories: { [STORY_A]: { curriculum_version_id: 'v1', subtopic_key: 'A1.M1.S1' } },
    });
    mockGetListeningClient.mockReturnValue(client);
    const res = makeRes();
    await handler(makeReq({ sharedStoryId: STORY_A }), res);

    expect(res._status()).toBe(200);
    expect(res._body()).toEqual({ activityDate: '2026-08-15', saved: true, alreadyCompleted: true });
    // The atomic RPC still runs (idempotent, no duplicate), but curricular credit
    // is NOT re-applied on a retry.
    expect(client._rpcCalls.filter((c: any) => c.name === 'complete_listening_shared_assignment')).toHaveLength(1);
    expect(mockRecordFromIdentity).not.toHaveBeenCalled();
    expect(client._rpcCalls.some((c: any) => c.name === 'consume_listening_pending_story')).toBe(false);
  });

  it('finishing A after B was started still credits A, never B', async () => {
    mockGetListeningClient.mockReturnValue(makeListeningClient({
      alreadyCompleted: false,
      progress: {
        [STORY_A]: { completed: true, activity_date: '2026-08-15' },
        [STORY_B]: { completed: true, activity_date: '2026-08-15' },
      },
      stories: {
        [STORY_A]: { curriculum_version_id: 'v1', subtopic_key: 'A1.M1.S1' },
        [STORY_B]: { curriculum_version_id: 'v1', subtopic_key: 'A1.M1.S2' },
      },
    }));
    const res = makeRes();
    await handler(makeReq({ sharedStoryId: STORY_A }), res);
    expect(mockRecordFromIdentity).toHaveBeenCalledWith(
      expect.anything(), USER, 'listening', STORY_A, { versionId: 'v1', subtopicKey: 'A1.M1.S1' },
    );
  });

  it('a foreign / not-consumed story is NEVER credited (calendar still registers)', async () => {
    mockGetListeningClient.mockReturnValue(makeListeningClient({
      alreadyCompleted: false,
      progress: { [STORY_A]: null },
      stories: { [STORY_A]: { curriculum_version_id: 'v1', subtopic_key: 'A1.M1.S1' } },
    }));
    const res = makeRes();
    await handler(makeReq({ sharedStoryId: STORY_A }), res);
    expect(res._status()).toBe(200);
    expect(mockRecordFromIdentity).not.toHaveBeenCalled();
  });

  it('no sharedStoryId → calendar completes but NO curricular credit (no guessing)', async () => {
    mockGetListeningClient.mockReturnValue(makeListeningClient({ alreadyCompleted: false }));
    const res = makeRes();
    await handler(makeReq({}), res);
    expect(res._status()).toBe(200);
    expect(res._body()).toEqual({ activityDate: '2026-08-15', saved: true, alreadyCompleted: false });
    expect(mockRecordFromIdentity).not.toHaveBeenCalled();
  });

  it('a real RPC failure surfaces as 500 (never a silent false success)', async () => {
    mockGetListeningClient.mockReturnValue(makeListeningClient({ rpcError: { message: 'db down' } }));
    const res = makeRes();
    await handler(makeReq({ sharedStoryId: STORY_A }), res);
    expect(res._status()).toBe(500);
  });
});
