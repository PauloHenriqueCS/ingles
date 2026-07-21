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

  it('scenario 1/2: limit=1 — first call selects and creates the single story', async () => {
    mockSelectListeningEpisodeForUser.mockResolvedValue('episode-1');
    mockGetOrCreateListeningAssignment.mockResolvedValue({
      assignment: { id: 'assignment-1', episodeId: 'episode-1', status: 'assigned' },
      created: true,
    });

    const result = await getListeningToday(makeSupabase([]), 'user-1');

    expect(mockSelectListeningEpisodeForUser).toHaveBeenCalledWith(expect.anything(), 'user-1', 'A1', []);
    expect(result.status).toBe('in_progress');
    if (result.status !== 'empty_inventory' && result.status !== 'story_completed') {
      expect(result.episodeId).toBe('episode-1');
    }
  });

  it('scenario 3: reopening the same active story does not select a new episode', async () => {
    const activeRow = makeRow({ status: 'in_progress' });
    mockBuildListeningEpisodeSession.mockResolvedValue({ progress: null });

    const result = await getListeningToday(makeSupabase([activeRow]), 'user-1');

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

    const result1 = await getListeningToday(makeSupabase([]), 'user-1');
    const result2 = await getListeningToday(makeSupabase([]), 'user-1');

    if (result1.status !== 'empty_inventory' && result1.status !== 'story_completed'
      && result2.status !== 'empty_inventory' && result2.status !== 'story_completed') {
      expect(result1.assignmentId).toBe(result2.assignmentId);
    }
  });

  it('scenario 5/6: limit=3 — after finishing story 1, getListeningToday selects a distinct story 2, excluding story 1', async () => {
    const completedRow = makeRow({ id: 'assignment-1', episode_id: 'episode-1', status: 'completed' });
    mockSelectListeningEpisodeForUser.mockResolvedValue('episode-2');
    mockGetOrCreateListeningAssignment.mockResolvedValue({
      assignment: { id: 'assignment-2', episodeId: 'episode-2', status: 'assigned' },
      created: true,
    });

    await getListeningToday(makeSupabase([completedRow]), 'user-1');

    expect(mockSelectListeningEpisodeForUser).toHaveBeenCalledWith(expect.anything(), 'user-1', 'A1', ['episode-1']);
  });

  it('scenario 5/6b: with 2 completed stories today, both are excluded when picking story 3', async () => {
    const rows = [
      makeRow({ id: 'assignment-2', episode_id: 'episode-2', status: 'completed', created_at: '2026-07-18T11:00:00Z' }),
      makeRow({ id: 'assignment-1', episode_id: 'episode-1', status: 'completed', created_at: '2026-07-18T10:00:00Z' }),
    ];
    mockSelectListeningEpisodeForUser.mockResolvedValue('episode-3');
    mockGetOrCreateListeningAssignment.mockResolvedValue({
      assignment: { id: 'assignment-3', episodeId: 'episode-3', status: 'assigned' },
      created: true,
    });

    await getListeningToday(makeSupabase(rows), 'user-1');

    const excludeArg = mockSelectListeningEpisodeForUser.mock.calls[0][3];
    expect(excludeArg).toEqual(expect.arrayContaining(['episode-1', 'episode-2']));
    expect(excludeArg).toHaveLength(2);
  });

  it('scenario 7: empty inventory after excluding today\'s stories returns empty_inventory, never blocks with an error', async () => {
    const completedRow = makeRow({ status: 'completed' });
    mockSelectListeningEpisodeForUser.mockResolvedValue(null);

    const result = await getListeningToday(makeSupabase([completedRow]), 'user-1');

    expect(result).toEqual({ status: 'empty_inventory' });
    expect(mockGetOrCreateListeningAssignment).not.toHaveBeenCalled();
  });

  it('scenario 8: story-mode row (episode_id null) short-circuits and never touches episode selection', async () => {
    const storyModeRow = { id: 'story-1', episode_id: null, activity_date: '2026-07-18', status: 'completed', created_at: '2026-07-18T10:00:00Z' };

    const result = await getListeningToday(makeSupabase([storyModeRow]), 'user-1');

    expect(result).toEqual({ status: 'story_completed', assignmentId: 'story-1', activityDate: '2026-07-18' });
    expect(mockSelectListeningEpisodeForUser).not.toHaveBeenCalled();
    expect(mockBuildListeningEpisodeSession).not.toHaveBeenCalled();
  });

  it('replaying an already in_progress story (no status change) never calls updateListeningAssignmentStatus — no extra consumption', async () => {
    const activeRow = makeRow({ status: 'in_progress' });
    mockBuildListeningEpisodeSession.mockResolvedValue({ progress: null }); // still not completed

    await getListeningToday(makeSupabase([activeRow]), 'user-1');

    expect(mockUpdateListeningAssignmentStatus).not.toHaveBeenCalled();
  });

  it('finishing the active story transitions its own row to completed exactly once', async () => {
    const activeRow = makeRow({ status: 'in_progress' });
    mockBuildListeningEpisodeSession.mockResolvedValue({ progress: { completedAt: '2026-07-18T12:00:00Z' } });

    await getListeningToday(makeSupabase([activeRow]), 'user-1');

    expect(mockUpdateListeningAssignmentStatus).toHaveBeenCalledTimes(1);
    expect(mockUpdateListeningAssignmentStatus).toHaveBeenCalledWith(expect.anything(), 'assignment-1', 'completed');
  });
});
