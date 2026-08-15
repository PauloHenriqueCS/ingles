import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockBuildListeningEpisodeSession,
  mockResolveUserListeningLevel,
  mockSelectListeningEpisodeForUser,
  mockGetOrCreateListeningAssignment,
  mockUpdateListeningAssignmentStatus,
} = vi.hoisted(() => ({
  mockBuildListeningEpisodeSession: vi.fn(),
  mockResolveUserListeningLevel: vi.fn(),
  mockSelectListeningEpisodeForUser: vi.fn(),
  mockGetOrCreateListeningAssignment: vi.fn(),
  mockUpdateListeningAssignmentStatus: vi.fn(),
}));

vi.mock('../execution/build-listening-episode-session', () => ({ buildListeningEpisodeSession: mockBuildListeningEpisodeSession }));
vi.mock('./resolve-user-listening-level', () => ({ resolveUserListeningLevel: mockResolveUserListeningLevel }));
vi.mock('./select-listening-episode-for-user', () => ({ selectListeningEpisodeForUser: mockSelectListeningEpisodeForUser }));
vi.mock('./get-or-create-listening-assignment', () => ({ getOrCreateListeningAssignment: mockGetOrCreateListeningAssignment }));
vi.mock('./update-listening-assignment-status', () => ({ updateListeningAssignmentStatus: mockUpdateListeningAssignmentStatus }));

import { getListeningToday } from './get-listening-today';

function makeSupabase(rows: unknown[]) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: async () => ({ data: rows, error: null }),
          }),
        }),
      }),
    }),
  } as any;
}

const fakeServiceClient = {} as any;

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'assignment-1',
    user_id: 'user-1',
    episode_id: 'episode-1',
    activity_date: '2026-07-18',
    status: 'assigned',
    created_at: '2026-07-18T10:00:00Z',
    ...overrides,
  };
}

describe('getListeningToday — multi-story per day', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // getListeningToday calls resolveListeningActivityDate() with no
    // argument internally — it always reads the real wall clock. Every
    // fixture below hardcodes activity_date/activityDate as '2026-07-18';
    // without pinning the clock here, that hardcode only worked by
    // coincidence on the day this suite happened to be written, and would
    // silently diverge (wrong assertions, or assignments created under a
    // date nothing else in the fixtures matches) on any other day.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T15:00:00Z')); // 2026-07-18 noon in America/Sao_Paulo (UTC-3)
    mockResolveUserListeningLevel.mockResolvedValue('A1');
    mockBuildListeningEpisodeSession.mockResolvedValue({ progress: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('scenario 1/2 (data-driven cutover): with no active episode, defers to the curriculum Story path (empty_inventory) and never selects a legacy episode', async () => {
    // The level-indexed legacy episode inventory is no longer selected for NEW
    // practice — the sole authority is the per-recorte data-driven Story path.
    const result = await getListeningToday(makeSupabase([]), 'user-1', fakeServiceClient);

    expect(result).toEqual({ status: 'empty_inventory' });
    expect(mockSelectListeningEpisodeForUser).not.toHaveBeenCalled();
    expect(mockGetOrCreateListeningAssignment).not.toHaveBeenCalled();
  });

  it('scenario 3: reopening the same active story does not select a new episode', async () => {
    const activeRow = makeRow({ status: 'in_progress' });
    mockBuildListeningEpisodeSession.mockResolvedValue({ progress: null });

    const result = await getListeningToday(makeSupabase([activeRow]), 'user-1', fakeServiceClient);

    expect(mockSelectListeningEpisodeForUser).not.toHaveBeenCalled();
    expect(mockGetOrCreateListeningAssignment).not.toHaveBeenCalled();
    if (result.status !== 'empty_inventory' && result.status !== 'story_completed') {
      expect(result.assignmentId).toBe('assignment-1');
      expect(result.episodeId).toBe('episode-1');
    }
  });

  it('scenario 4: double-click safe — two concurrent calls with no active row both resolve to the same assignment via getOrCreate idempotency', async () => {
    mockSelectListeningEpisodeForUser.mockResolvedValue('episode-1');
    mockGetOrCreateListeningAssignment.mockResolvedValue({
      assignment: { id: 'assignment-1', episodeId: 'episode-1', status: 'assigned' },
      created: false, // second caller finds the row the first one just created
    });

    const result1 = await getListeningToday(makeSupabase([]), 'user-1', fakeServiceClient);
    const result2 = await getListeningToday(makeSupabase([]), 'user-1', fakeServiceClient);

    if (result1.status !== 'empty_inventory' && result1.status !== 'story_completed'
      && result2.status !== 'empty_inventory' && result2.status !== 'story_completed') {
      expect(result1.assignmentId).toBe(result2.assignmentId);
    }
  });

  it('scenario 5/6 (data-driven cutover): after finishing a story, still defers to the Story path (empty_inventory) — never selects a new legacy episode', async () => {
    const completedRow = makeRow({ id: 'assignment-1', episode_id: 'episode-1', status: 'completed' });

    const result = await getListeningToday(makeSupabase([completedRow]), 'user-1', fakeServiceClient);

    expect(result).toEqual({ status: 'empty_inventory' });
    expect(mockSelectListeningEpisodeForUser).not.toHaveBeenCalled();
  });

  it('scenario 5/6b (data-driven cutover): with completed stories today and nothing active, still defers to the Story path (empty_inventory)', async () => {
    const rows = [
      makeRow({ id: 'assignment-2', episode_id: 'episode-2', status: 'completed', created_at: '2026-07-18T11:00:00Z' }),
      makeRow({ id: 'assignment-1', episode_id: 'episode-1', status: 'completed', created_at: '2026-07-18T10:00:00Z' }),
    ];

    const result = await getListeningToday(makeSupabase(rows), 'user-1', fakeServiceClient);

    expect(result).toEqual({ status: 'empty_inventory' });
    expect(mockSelectListeningEpisodeForUser).not.toHaveBeenCalled();
  });

  it('scenario 8: story-mode row (episode_id null) short-circuits and never touches episode selection', async () => {
    const storyModeRow = { id: 'story-1', episode_id: null, activity_date: '2026-07-18', status: 'completed', created_at: '2026-07-18T10:00:00Z' };

    const result = await getListeningToday(makeSupabase([storyModeRow]), 'user-1', fakeServiceClient);

    expect(result).toEqual({ status: 'story_completed', assignmentId: 'story-1', activityDate: '2026-07-18' });
    expect(mockSelectListeningEpisodeForUser).not.toHaveBeenCalled();
    expect(mockBuildListeningEpisodeSession).not.toHaveBeenCalled();
  });

  it('replaying an already in_progress story (no status change) never calls updateListeningAssignmentStatus — no extra consumption', async () => {
    const activeRow = makeRow({ status: 'in_progress' });
    mockBuildListeningEpisodeSession.mockResolvedValue({ progress: null }); // still not completed

    await getListeningToday(makeSupabase([activeRow]), 'user-1', fakeServiceClient);

    expect(mockUpdateListeningAssignmentStatus).not.toHaveBeenCalled();
  });

  it('finishing the active story transitions its own row to completed exactly once', async () => {
    const activeRow = makeRow({ status: 'in_progress' });
    mockBuildListeningEpisodeSession.mockResolvedValue({ progress: { completedAt: '2026-07-18T12:00:00Z' } });

    await getListeningToday(makeSupabase([activeRow]), 'user-1', fakeServiceClient);

    expect(mockUpdateListeningAssignmentStatus).toHaveBeenCalledTimes(1);
    expect(mockUpdateListeningAssignmentStatus).toHaveBeenCalledWith(expect.anything(), 'assignment-1', 'completed');
  });

  it('no reusable episode for the level -> empty_inventory, never touches assignment creation', async () => {
    mockSelectListeningEpisodeForUser.mockResolvedValue(null);

    const result = await getListeningToday(makeSupabase([]), 'user-1', fakeServiceClient);

    expect(result).toEqual({ status: 'empty_inventory' });
    expect(mockGetOrCreateListeningAssignment).not.toHaveBeenCalled();
  });
});

// A "shared level-group generation fallback" suite lived here, testing
// getOrCreateListeningGroupJob being called from getListeningToday when no
// reusable published episode exists. That routing was deliberately reverted
// in bb2a3c6 ("fix(listening): restore empty_inventory fallback, drop
// group-generation entry point") — getListeningToday now returns
// {status: 'empty_inventory'} again in that case (see get-listening-today.ts)
// and never imports getOrCreateListeningGroupJob at all. The revert commit
// was scoped to get-listening-today.ts only and never touched this test
// file, leaving the suite permanently failing (mocking a module the source
// no longer imports). Removed rather than reimplemented — group-generation
// itself is untouched and still covered by its own tests elsewhere; the
// empty_inventory path this entry point actually takes now has direct
// coverage above ("no reusable episode for the level").
