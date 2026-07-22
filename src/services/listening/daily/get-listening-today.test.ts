import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockBuildListeningEpisodeSession,
  mockResolveUserListeningLevel,
  mockSelectListeningEpisodeForUser,
  mockGetOrCreateListeningAssignment,
  mockUpdateListeningAssignmentStatus,
  mockGetOrCreateListeningGroupJob,
} = vi.hoisted(() => ({
  mockBuildListeningEpisodeSession: vi.fn(),
  mockResolveUserListeningLevel: vi.fn(),
  mockSelectListeningEpisodeForUser: vi.fn(),
  mockGetOrCreateListeningAssignment: vi.fn(),
  mockUpdateListeningAssignmentStatus: vi.fn(),
  mockGetOrCreateListeningGroupJob: vi.fn(),
}));

vi.mock('../execution/build-listening-episode-session', () => ({ buildListeningEpisodeSession: mockBuildListeningEpisodeSession }));
vi.mock('./resolve-user-listening-level', () => ({ resolveUserListeningLevel: mockResolveUserListeningLevel }));
vi.mock('./select-listening-episode-for-user', () => ({ selectListeningEpisodeForUser: mockSelectListeningEpisodeForUser }));
vi.mock('./get-or-create-listening-assignment', () => ({ getOrCreateListeningAssignment: mockGetOrCreateListeningAssignment }));
vi.mock('./update-listening-assignment-status', () => ({ updateListeningAssignmentStatus: mockUpdateListeningAssignmentStatus }));
vi.mock('../group-generation/get-or-create-listening-group-job', () => ({ getOrCreateListeningGroupJob: mockGetOrCreateListeningGroupJob }));

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

  it('scenario 1/2: limit=1 — first call selects and creates the single story', async () => {
    mockSelectListeningEpisodeForUser.mockResolvedValue('episode-1');
    mockGetOrCreateListeningAssignment.mockResolvedValue({
      assignment: { id: 'assignment-1', episodeId: 'episode-1', status: 'assigned' },
      created: true,
    });

    const result = await getListeningToday(makeSupabase([]), 'user-1', fakeServiceClient);

    expect(mockSelectListeningEpisodeForUser).toHaveBeenCalledWith(expect.anything(), 'user-1', 'A1', []);
    expect(result.status).toBe('in_progress');
    if (result.status !== 'empty_inventory' && result.status !== 'story_completed') {
      expect(result.episodeId).toBe('episode-1');
    }
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

  it('scenario 5/6: limit=3 — after finishing story 1, getListeningToday selects a distinct story 2, excluding story 1', async () => {
    const completedRow = makeRow({ id: 'assignment-1', episode_id: 'episode-1', status: 'completed' });
    mockSelectListeningEpisodeForUser.mockResolvedValue('episode-2');
    mockGetOrCreateListeningAssignment.mockResolvedValue({
      assignment: { id: 'assignment-2', episodeId: 'episode-2', status: 'assigned' },
      created: true,
    });

    await getListeningToday(makeSupabase([completedRow]), 'user-1', fakeServiceClient);

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

    await getListeningToday(makeSupabase(rows), 'user-1', fakeServiceClient);

    const excludeArg = mockSelectListeningEpisodeForUser.mock.calls[0][3];
    expect(excludeArg).toEqual(expect.arrayContaining(['episode-1', 'episode-2']));
    expect(excludeArg).toHaveLength(2);
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
});

describe('getListeningToday — shared level-group generation fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T15:00:00Z'));
    mockResolveUserListeningLevel.mockResolvedValue('A1');
    mockBuildListeningEpisodeSession.mockResolvedValue({ progress: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('no reusable published episode -> calls getOrCreateListeningGroupJob for the resolved level_group (A1 -> A1_A2), never empty_inventory', async () => {
    mockSelectListeningEpisodeForUser.mockResolvedValue(null);
    mockGetOrCreateListeningGroupJob.mockResolvedValue({
      kind: 'created',
      job: {
        id: 'job-1', levelGroup: 'A1_A2', targetLevel: 'A1', status: 'created',
        currentStep: 'Iniciando', progressPercent: 0, episodeId: null,
        attempts: 0, maxAttempts: 3, errorCode: null, errorMessage: null, retryable: false,
      },
    });

    const result = await getListeningToday(makeSupabase([]), 'user-1', fakeServiceClient);

    expect(mockGetOrCreateListeningGroupJob).toHaveBeenCalledWith(fakeServiceClient, 'A1_A2');
    expect(result.status).toBe('group_generating');
    expect(mockGetOrCreateListeningAssignment).not.toHaveBeenCalled();
    if (result.status === 'group_generating') {
      expect(result.levelGroup).toBe('A1_A2');
      expect(result.targetLevel).toBe('A1');
      expect(result.groupJob.jobId).toBe('job-1');
    }
  });

  it('an already-active job for the group is surfaced as group_generating too (second poller/user reuses it, no new job)', async () => {
    mockSelectListeningEpisodeForUser.mockResolvedValue(null);
    mockGetOrCreateListeningGroupJob.mockResolvedValue({
      kind: 'active',
      job: {
        id: 'job-1', levelGroup: 'A1_A2', targetLevel: 'A1', status: 'generating_block_1',
        currentStep: 'Criando a primeira parte da história', progressPercent: 10, episodeId: null,
        attempts: 0, maxAttempts: 3, errorCode: null, errorMessage: null, retryable: false,
      },
    });

    const result = await getListeningToday(makeSupabase([]), 'user-1', fakeServiceClient);

    expect(result.status).toBe('group_generating');
    if (result.status === 'group_generating') {
      expect(result.groupJob.status).toBe('generating_block_1');
    }
  });

  it('a reusable published shared story assigns it to the user directly, without touching group job creation', async () => {
    mockSelectListeningEpisodeForUser.mockResolvedValue(null);
    mockGetOrCreateListeningGroupJob.mockResolvedValue({ kind: 'reused', episodeId: 'episode-shared-1' });
    mockGetOrCreateListeningAssignment.mockResolvedValue({
      assignment: { id: 'assignment-9', episodeId: 'episode-shared-1', status: 'assigned' },
      created: true,
    });

    const result = await getListeningToday(makeSupabase([]), 'user-1', fakeServiceClient);

    expect(mockGetOrCreateListeningAssignment).toHaveBeenCalledWith(expect.anything(), {
      userId: 'user-1', episodeId: 'episode-shared-1', activityDate: '2026-07-18',
    });
    expect(result.status).toBe('in_progress');
    if (result.status !== 'empty_inventory' && result.status !== 'story_completed' && result.status !== 'group_generating') {
      expect(result.episodeId).toBe('episode-shared-1');
    }
  });

  it('concurrency: two different users of the same level_group both resolve to the ONE shared episode, each with their own assignment', async () => {
    // Both users resolve to the same group (A1 -> A1_A2). By the time each
    // calls getListeningToday, the shared job for the group has already
    // published — getOrCreateListeningGroupJob reports 'reused' for both,
    // never creating a second job/pipeline for the group.
    mockSelectListeningEpisodeForUser.mockResolvedValue(null);
    mockGetOrCreateListeningGroupJob.mockResolvedValue({ kind: 'reused', episodeId: 'episode-shared-1' });
    mockGetOrCreateListeningAssignment.mockImplementation(async (_supabase: unknown, params: { userId: string; episodeId: string }) => ({
      assignment: { id: `assignment-${params.userId}`, episodeId: params.episodeId, status: 'assigned' },
      created: true,
    }));

    const resultA = await getListeningToday(makeSupabase([]), 'user-a', fakeServiceClient);
    const resultB = await getListeningToday(makeSupabase([]), 'user-b', fakeServiceClient);

    // Exactly one shared pipeline lookup per user request — never a second
    // job created for the group just because two different users asked.
    expect(mockGetOrCreateListeningGroupJob).toHaveBeenCalledTimes(2);
    expect(mockGetOrCreateListeningGroupJob).toHaveBeenNthCalledWith(1, fakeServiceClient, 'A1_A2');
    expect(mockGetOrCreateListeningGroupJob).toHaveBeenNthCalledWith(2, fakeServiceClient, 'A1_A2');

    // Both users get assigned the SAME shared episode...
    expect(mockGetOrCreateListeningAssignment).toHaveBeenNthCalledWith(1, expect.anything(), {
      userId: 'user-a', episodeId: 'episode-shared-1', activityDate: '2026-07-18',
    });
    expect(mockGetOrCreateListeningAssignment).toHaveBeenNthCalledWith(2, expect.anything(), {
      userId: 'user-b', episodeId: 'episode-shared-1', activityDate: '2026-07-18',
    });

    // ...but through their own, distinct assignment rows.
    if (resultA.status !== 'empty_inventory' && resultA.status !== 'story_completed' && resultA.status !== 'group_generating'
      && resultB.status !== 'empty_inventory' && resultB.status !== 'story_completed' && resultB.status !== 'group_generating') {
      expect(resultA.episodeId).toBe('episode-shared-1');
      expect(resultB.episodeId).toBe('episode-shared-1');
      expect(resultA.assignmentId).not.toBe(resultB.assignmentId);
    }
  });

  it('different level groups generate independently: a B1 user never triggers/observes the A1_A2 group job', async () => {
    mockSelectListeningEpisodeForUser.mockResolvedValue(null);
    mockResolveUserListeningLevel.mockResolvedValue('B1');
    mockGetOrCreateListeningGroupJob.mockResolvedValue({
      kind: 'created',
      job: {
        id: 'job-b1b2', levelGroup: 'B1_B2', targetLevel: 'B1', status: 'created',
        currentStep: 'Iniciando', progressPercent: 0, episodeId: null,
        attempts: 0, maxAttempts: 3, errorCode: null, errorMessage: null, retryable: false,
      },
    });

    const result = await getListeningToday(makeSupabase([]), 'user-b1', fakeServiceClient);

    expect(mockGetOrCreateListeningGroupJob).toHaveBeenCalledWith(fakeServiceClient, 'B1_B2');
    if (result.status === 'group_generating') {
      expect(result.levelGroup).toBe('B1_B2');
    } else {
      throw new Error('expected group_generating status');
    }
  });
});
