/**
 * Blocker 6 + 5: POST /api/listening/story/complete records the curricular
 * 'listening' practice against the EXACT story the client finished
 * (sharedStoryId), validated server-side (ownership + consumed + same day +
 * identity), via the identity-REQUIRED path (no current-pointer fallback). A
 * retry still reconciles curricular credit (no early return once completed).
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

// Chainable mock: tables → rows. Supports select/eq/is/order/limit/maybeSingle,
// update/insert (recording writes into a log).
function makeListeningClient(fixture: {
  assignment?: { id: string; status: string } | null;
  progress?: Record<string, { completed: boolean; activity_date: string } | null>;
  stories?: Record<string, { curriculum_version_id: string | null; subtopic_key: string | null } | null>;
}) {
  const writes: any[] = [];
  const client: any = {
    _writes: writes,
    from(table: string) {
      const q: any = {
        _eq: {} as Record<string, any>,
        select() { return q; },
        eq(c: string, v: any) { q._eq[c] = v; return q; },
        is(c: string, v: any) { q._eq[c] = v; return q; },
        order() { return q; },
        limit() { return q; },
        async maybeSingle() {
          if (table === 'user_listening_assignments') return { data: fixture.assignment ?? null, error: null };
          if (table === 'user_listening_shared_progress') return { data: fixture.progress?.[q._eq.shared_story_id] ?? null, error: null };
          if (table === 'listening_shared_stories') return { data: fixture.stories?.[q._eq.id] ?? null, error: null };
          return { data: null, error: null };
        },
        async update(row: any) { writes.push({ table, op: 'update', row }); return { data: null, error: null, eq() { return this; } }; },
        async insert(row: any) { writes.push({ table, op: 'insert', row }); return { data: null, error: null }; },
      };
      // update/insert are terminal but return awaitable with .eq chaining for update
      const origUpdate = q.update;
      q.update = (row: any) => { writes.push({ table, op: 'update', row }); const chain: any = { eq() { return chain; }, then: (r: any) => r({ data: null, error: null }) }; return chain; };
      const origInsert = q.insert;
      q.insert = (row: any) => { writes.push({ table, op: 'insert', row }); return Promise.resolve({ data: null, error: null }); };
      void origUpdate; void origInsert;
      return q;
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

describe('story/complete — exact story identity (blocker 6)', () => {
  it('credits the EXACT finished story A (owned + consumed + same day)', async () => {
    mockGetListeningClient.mockReturnValue(makeListeningClient({
      assignment: null,
      progress: { [STORY_A]: { completed: true, activity_date: '2026-08-15' } },
      stories: { [STORY_A]: { curriculum_version_id: 'v1', subtopic_key: 'A1.M1.S1' } },
    }));
    const res = makeRes();
    await handler(makeReq({ sharedStoryId: STORY_A }), res);
    expect(res._status()).toBe(200);
    expect(mockRecordFromIdentity).toHaveBeenCalledWith(
      expect.anything(), USER, 'listening', STORY_A, { versionId: 'v1', subtopicKey: 'A1.M1.S1' },
    );
  });

  it('finishing A after B was started still credits A, never B', async () => {
    mockGetListeningClient.mockReturnValue(makeListeningClient({
      assignment: null,
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

  it('a foreign / not-consumed story is NEVER credited', async () => {
    mockGetListeningClient.mockReturnValue(makeListeningClient({
      assignment: null,
      progress: { [STORY_A]: null }, // no association for this user
      stories: { [STORY_A]: { curriculum_version_id: 'v1', subtopic_key: 'A1.M1.S1' } },
    }));
    const res = makeRes();
    await handler(makeReq({ sharedStoryId: STORY_A }), res);
    expect(res._status()).toBe(200);
    expect(mockRecordFromIdentity).not.toHaveBeenCalled();
  });

  it('no sharedStoryId → assignment completes but NO curricular credit (blocker 5, no guessing)', async () => {
    mockGetListeningClient.mockReturnValue(makeListeningClient({ assignment: null }));
    const res = makeRes();
    await handler(makeReq({}), res);
    expect(res._status()).toBe(200);
    expect(mockRecordFromIdentity).not.toHaveBeenCalled();
  });

  it('retry after an already-completed assignment STILL reconciles curricular credit (idempotent)', async () => {
    mockGetListeningClient.mockReturnValue(makeListeningClient({
      assignment: { id: 'a1', status: 'completed' }, // already completed
      progress: { [STORY_A]: { completed: true, activity_date: '2026-08-15' } },
      stories: { [STORY_A]: { curriculum_version_id: 'v1', subtopic_key: 'A1.M1.S1' } },
    }));
    const res = makeRes();
    await handler(makeReq({ sharedStoryId: STORY_A }), res);
    expect(res._status()).toBe(200);
    // No early return: the curricular reconciliation still ran on retry.
    expect(mockRecordFromIdentity).toHaveBeenCalledTimes(1);
  });
});
