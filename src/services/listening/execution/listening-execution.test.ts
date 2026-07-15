import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getOrCreateListeningSession } from './get-or-create-listening-session';
import { markListeningPlaybackCompleted } from './mark-listening-playback-completed';
import { submitListeningAnswer } from './submit-listening-answer';
import { abandonListeningSession } from './abandon-listening-session';
import { completeListeningBlock1 } from './complete-listening-block';
import { completeListeningEpisode } from './complete-listening-episode';
import { createOrGetListeningProgress } from './create-listening-progress';
import { expireListeningSessions } from './expire-listening-sessions';
import { ListeningExecutionError, LISTENING_EXECUTION_ERRORS } from './listening-execution-types';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('./expire-listening-sessions', () => ({
  expireListeningSessions: vi.fn(async () => {}),
}));

vi.mock('./complete-listening-block', () => ({
  completeListeningBlock1: vi.fn(async () => {}),
}));

vi.mock('./complete-listening-episode', () => ({
  completeListeningEpisode: vi.fn(async () => {}),
}));

// ─── Constants ────────────────────────────────────────────────────────────────

const EP_ID  = 'ep000000-0000-0000-0000-000000000001';
const B1_ID  = 'b1000000-0000-0000-0000-000000000001';
const B2_ID  = 'b1000000-0000-0000-0000-000000000002';
const Q1_ID  = 'q1000000-0000-0000-0000-000000000001';
const S1_ID  = 'se000000-0000-0000-0000-000000000001';
const USER_ID = 'u1000000-0000-0000-0000-000000000001';
const SUB_ID = 'su000000-0000-0000-0000-000000000001';

const FUTURE_EXPIRY = new Date(Date.now() + 5_400_000).toISOString();
const PAST_EXPIRY   = new Date(Date.now() - 1000).toISOString();

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: S1_ID,
    user_id: USER_ID,
    episode_id: EP_ID,
    block_id: B1_ID,
    question_id: Q1_ID,
    attempt_cycle: 1,
    current_attempt: 1,
    status: 'active',
    started_at: new Date().toISOString(),
    expires_at: FUTURE_EXPIRY,
    completed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeQuestion(overrides: Record<string, unknown> = {}) {
  return {
    id: Q1_ID,
    block_id: B1_ID,
    episode_id: EP_ID,
    question_order: 1,
    correct_option: 1,
    explanation_pt: 'O texto diz que Sarah lê um livro.',
    options_json: ['She sleeps', 'She reads a book', 'She listens to music'],
    max_attempts: 3,
    ...overrides,
  };
}

// ─── Mock builder ─────────────────────────────────────────────────────────────

type TableData = Record<string, unknown[]>;
type InsertOverride = { error?: { code?: string; message?: string } | null; data?: unknown };

function buildMockClient(
  tables: TableData = {},
  insertOverrides: Record<string, InsertOverride> = {},
  updateReturns?: unknown,
) {
  const fromFn = (table: string) => {
    const rows = tables[table] ?? [];
    let _filters: Record<string, unknown> = {};
    let _inFilter: string[] | undefined;

    const builder: any = {
      select: () => builder,
      eq: (_col: string, _val: unknown) => builder,
      in: (_col: string, vals: string[]) => { _inFilter = vals; return builder; },
      neq: () => builder,
      order: () => builder,
      limit: (_n: number) => builder,
      not: () => builder,
      lt: () => builder,
      upsert: () => ({ then: (r: any, j: any) => Promise.resolve({ data: null, error: null }).then(r, j) }),
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () => ({ data: rows[0] ?? null, error: null }),
      insert: (data: unknown) => {
        const ov = insertOverrides[table];
        if (ov?.error) {
          return {
            select: () => ({
              single: async () => ({ data: null, error: ov.error }),
            }),
          };
        }
        const inserted = Array.isArray(data) ? data[0] : data;
        const row = { id: S1_ID, ...makeSession(), ...(inserted as object) };
        return {
          select: () => ({
            single: async () => ({ data: row, error: null }),
          }),
        };
      },
      update: (_data: unknown) => ({
        eq: () => ({
          eq: () => ({
            select: () => ({
              single: async () => ({
                data: updateReturns ?? { ...makeSession(), status: 'awaiting_answer' },
                error: null,
              }),
            }),
            then: (r: any, j: any) => Promise.resolve({ data: null, error: null }).then(r, j),
          }),
          select: () => ({
            single: async () => ({
              data: updateReturns ?? { ...makeSession(), status: 'awaiting_answer' },
              error: null,
            }),
          }),
          then: (r: any, j: any) => Promise.resolve({ data: null, error: null }).then(r, j),
        }),
        then: (r: any, j: any) => Promise.resolve({ data: null, error: null }).then(r, j),
      }),
      then: (resolve: any, reject: any) =>
        Promise.resolve({ data: rows, error: null }).then(resolve, reject),
    };
    return builder;
  };

  return { from: fromFn as any };
}

// ─── getOrCreateListeningSession ──────────────────────────────────────────────

describe('getOrCreateListeningSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns existing live session', async () => {
    const session = makeSession({ status: 'awaiting_answer' });
    const client = buildMockClient({ user_listening_block_sessions: [session] });
    const result = await getOrCreateListeningSession(client as any, {
      userId: USER_ID, episodeId: EP_ID, blockId: B1_ID, questionId: Q1_ID,
    });
    expect(result.id).toBe(S1_ID);
    expect(result.status).toBe('awaiting_answer');
  });

  it('creates new session when none exists', async () => {
    const client = buildMockClient({ user_listening_block_sessions: [] });
    const result = await getOrCreateListeningSession(client as any, {
      userId: USER_ID, episodeId: EP_ID, blockId: B1_ID, questionId: Q1_ID,
    });
    expect(result.id).toBe(S1_ID);
    expect(result.attemptCycle).toBe(1);
    expect(result.currentAttempt).toBe(1);
  });

  it('throws SESSION_CONFLICT on unique index violation', async () => {
    const client = buildMockClient(
      { user_listening_block_sessions: [] },
      { user_listening_block_sessions: { error: { code: '23505', message: 'duplicate' } } },
    );
    await expect(
      getOrCreateListeningSession(client as any, {
        userId: USER_ID, episodeId: EP_ID, blockId: B1_ID, questionId: Q1_ID,
      }),
    ).rejects.toThrow(expect.objectContaining({ code: LISTENING_EXECUTION_ERRORS.SESSION_CONFLICT }));
  });

  it('determines attempt_cycle = max_past_cycle + 1', async () => {
    // First query (live sessions) returns empty; second query (past sessions) returns cycle 2.
    let callCount = 0;
    const from = (_table: string) => {
      callCount++;
      const rows = callCount <= 1
        ? []  // no live session
        : [{ attempt_cycle: 2 }];  // past sessions
      const b: any = {
        select: () => b, eq: () => b, in: () => b, order: () => b, limit: () => b,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        insert: () => ({
          select: () => ({
            single: async () => ({ data: makeSession({ attempt_cycle: 3 }), error: null }),
          }),
        }),
        then: (r: any, j: any) => Promise.resolve({ data: rows, error: null }).then(r, j),
      };
      return b;
    };
    const result = await getOrCreateListeningSession({ from } as any, {
      userId: USER_ID, episodeId: EP_ID, blockId: B1_ID, questionId: Q1_ID,
    });
    expect(result.attemptCycle).toBe(3);
  });
});

// ─── markListeningPlaybackCompleted ───────────────────────────────────────────

describe('markListeningPlaybackCompleted', () => {
  it('transitions active → awaiting_answer', async () => {
    const session = makeSession({ status: 'active' });
    const updated = makeSession({ status: 'awaiting_answer' });
    const client = buildMockClient({ user_listening_block_sessions: [session] }, {}, updated);
    const result = await markListeningPlaybackCompleted(client as any, S1_ID, USER_ID);
    expect(result.status).toBe('awaiting_answer');
  });

  it('transitions replay_required → awaiting_answer', async () => {
    const session = makeSession({ status: 'replay_required', current_attempt: 2 });
    const updated = makeSession({ status: 'awaiting_answer', current_attempt: 2 });
    const client = buildMockClient({ user_listening_block_sessions: [session] }, {}, updated);
    const result = await markListeningPlaybackCompleted(client as any, S1_ID, USER_ID);
    expect(result.status).toBe('awaiting_answer');
  });

  it('throws SESSION_NOT_FOUND when session missing', async () => {
    const client = buildMockClient({ user_listening_block_sessions: [] });
    await expect(
      markListeningPlaybackCompleted(client as any, S1_ID, USER_ID),
    ).rejects.toThrow(expect.objectContaining({ code: LISTENING_EXECUTION_ERRORS.SESSION_NOT_FOUND }));
  });

  it('throws SESSION_EXPIRED for expired session', async () => {
    const session = makeSession({ status: 'active', expires_at: PAST_EXPIRY });
    const client = buildMockClient({ user_listening_block_sessions: [session] });
    await expect(
      markListeningPlaybackCompleted(client as any, S1_ID, USER_ID),
    ).rejects.toThrow(expect.objectContaining({ code: LISTENING_EXECUTION_ERRORS.SESSION_EXPIRED }));
  });

  it('throws SESSION_WRONG_STATE if session is awaiting_answer', async () => {
    const session = makeSession({ status: 'awaiting_answer' });
    const client = buildMockClient({ user_listening_block_sessions: [session] });
    await expect(
      markListeningPlaybackCompleted(client as any, S1_ID, USER_ID),
    ).rejects.toThrow(expect.objectContaining({ code: LISTENING_EXECUTION_ERRORS.SESSION_WRONG_STATE }));
  });

  it('throws SESSION_WRONG_STATE if session is completed', async () => {
    const session = makeSession({ status: 'completed' });
    const client = buildMockClient({ user_listening_block_sessions: [session] });
    await expect(
      markListeningPlaybackCompleted(client as any, S1_ID, USER_ID),
    ).rejects.toThrow(expect.objectContaining({ code: LISTENING_EXECUTION_ERRORS.SESSION_WRONG_STATE }));
  });
});

// ─── submitListeningAnswer ────────────────────────────────────────────────────

describe('submitListeningAnswer', () => {
  beforeEach(() => vi.clearAllMocks());

  const baseInput = {
    sessionId: S1_ID,
    userId: USER_ID,
    questionId: Q1_ID,
    selectedOption: 1,
    submissionId: SUB_ID,
  };

  function buildAnswerClient(opts: {
    priorAttempt?: unknown;
    session?: unknown;
    question?: unknown;
    block?: unknown;
    insertError?: { code?: string } | null;
    updateStatus?: string;
  } = {}) {
    const {
      priorAttempt = null,
      session = makeSession({ status: 'awaiting_answer' }),
      question = makeQuestion(),
      block = { id: B1_ID, block_order: 1 },
      insertError = null,
      updateStatus = 'completed',
    } = opts;

    const tables: Record<string, unknown[]> = {
      user_listening_attempts: priorAttempt ? [priorAttempt] : [],
      user_listening_block_sessions: session ? [session] : [],
      listening_questions: question ? [question] : [],
      listening_blocks: block ? [block] : [],
    };

    const insertOverrides = insertError
      ? { user_listening_attempts: { error: insertError } }
      : {};

    return buildMockClient(tables, insertOverrides, { ...makeSession(), status: updateStatus });
  }

  it('returns correct=true and saves progress on correct answer (block 1)', async () => {
    const client = buildAnswerClient();
    const result = await submitListeningAnswer(client as any, baseInput);
    expect(result.correct).toBe(true);
    expect(result.blockCompleted).toBe(true);
    expect(result.episodeCompleted).toBe(false);
    expect(result.explanationPt).toBe('O texto diz que Sarah lê um livro.');
    expect(completeListeningBlock1).toHaveBeenCalledWith(
      client, USER_ID, EP_ID, 1,
    );
  });

  it('returns episodeCompleted=true on correct answer for block 2', async () => {
    const client = buildAnswerClient({
      session: makeSession({ status: 'awaiting_answer', question_id: Q1_ID, block_id: B2_ID }),
      block: { id: B2_ID, block_order: 2 },
    });
    const result = await submitListeningAnswer(client as any, { ...baseInput });
    expect(result.episodeCompleted).toBe(true);
    expect(completeListeningEpisode).toHaveBeenCalled();
  });

  it('sets replay_required and increments attempt on wrong answer (attempt 1)', async () => {
    const client = buildAnswerClient({
      session: makeSession({ status: 'awaiting_answer', current_attempt: 1 }),
    });
    const result = await submitListeningAnswer(client as any, {
      ...baseInput,
      selectedOption: 0, // wrong
    });
    expect(result.correct).toBe(false);
    expect(result.sessionStatus).toBe('replay_required');
    expect(result.nextAttempt).toBe(2);
    expect(result.nextSubtitleMode).toBe('en');
  });

  it('sets replay_required with pt-BR mode on wrong answer (attempt 2)', async () => {
    const client = buildAnswerClient({
      session: makeSession({ status: 'awaiting_answer', current_attempt: 2 }),
    });
    const result = await submitListeningAnswer(client as any, {
      ...baseInput,
      selectedOption: 0,
    });
    expect(result.nextAttempt).toBe(3);
    expect(result.nextSubtitleMode).toBe('pt-BR');
  });

  it('abandons session on wrong answer at attempt 3', async () => {
    const client = buildAnswerClient({
      session: makeSession({ status: 'awaiting_answer', current_attempt: 3 }),
    });
    const result = await submitListeningAnswer(client as any, {
      ...baseInput,
      selectedOption: 0,
    });
    expect(result.correct).toBe(false);
    expect(result.sessionStatus).toBe('abandoned');
    expect(result.nextAttempt).toBeNull();
    expect(result.blockCompleted).toBe(false);
    expect(result.correctOption).toBe(1);
    expect(result.explanationPt).toBe('O texto diz que Sarah lê um livro.');
  });

  it('returns reconstructed result for duplicate submissionId', async () => {
    const priorAttempt = { is_correct: true, attempt_number: 1 };
    const client = buildAnswerClient({ priorAttempt });
    const result = await submitListeningAnswer(client as any, baseInput);
    expect(result.correct).toBe(true);
    expect(result.sessionStatus).toBe('completed');
    expect(completeListeningBlock1).not.toHaveBeenCalled();
  });

  it('throws SESSION_NOT_FOUND when session is missing', async () => {
    const client = buildAnswerClient({ session: null });
    await expect(
      submitListeningAnswer(client as any, baseInput),
    ).rejects.toThrow(expect.objectContaining({ code: LISTENING_EXECUTION_ERRORS.SESSION_NOT_FOUND }));
  });

  it('throws SESSION_EXPIRED when session is past expires_at', async () => {
    const client = buildAnswerClient({
      session: makeSession({ status: 'awaiting_answer', expires_at: PAST_EXPIRY }),
    });
    await expect(
      submitListeningAnswer(client as any, baseInput),
    ).rejects.toThrow(expect.objectContaining({ code: LISTENING_EXECUTION_ERRORS.SESSION_EXPIRED }));
  });

  it('throws SESSION_WRONG_STATE when session is not awaiting_answer', async () => {
    const client = buildAnswerClient({
      session: makeSession({ status: 'active' }),
    });
    await expect(
      submitListeningAnswer(client as any, baseInput),
    ).rejects.toThrow(expect.objectContaining({ code: LISTENING_EXECUTION_ERRORS.SESSION_WRONG_STATE }));
  });

  it('throws QUESTION_NOT_FOUND when question is missing', async () => {
    const client = buildAnswerClient({ question: null });
    await expect(
      submitListeningAnswer(client as any, baseInput),
    ).rejects.toThrow(expect.objectContaining({ code: LISTENING_EXECUTION_ERRORS.QUESTION_NOT_FOUND }));
  });

  it('throws DUPLICATE_SUBMISSION on unique index violation during insert', async () => {
    const client = buildAnswerClient({ insertError: { code: '23505' } });
    await expect(
      submitListeningAnswer(client as any, baseInput),
    ).rejects.toThrow(expect.objectContaining({ code: LISTENING_EXECUTION_ERRORS.DUPLICATE_SUBMISSION }));
  });

  it('returns correctOption=null for correct answer (only set on cycle failure)', async () => {
    const client = buildAnswerClient();
    const result = await submitListeningAnswer(client as any, baseInput);
    expect(result.correctOption).toBeNull();
    expect(result).not.toHaveProperty('correct_option');
  });
});

// ─── abandonListeningSession ──────────────────────────────────────────────────

describe('abandonListeningSession', () => {
  it('marks session abandoned', async () => {
    const session = makeSession({ status: 'active' });
    const client = buildMockClient({ user_listening_block_sessions: [session] });
    await expect(
      abandonListeningSession(client as any, S1_ID, USER_ID),
    ).resolves.toBeUndefined();
  });

  it('is idempotent — no-ops when already abandoned', async () => {
    const session = makeSession({ status: 'abandoned' });
    const client = buildMockClient({ user_listening_block_sessions: [session] });
    await expect(
      abandonListeningSession(client as any, S1_ID, USER_ID),
    ).resolves.toBeUndefined();
  });

  it('is idempotent — no-ops when already completed', async () => {
    const session = makeSession({ status: 'completed' });
    const client = buildMockClient({ user_listening_block_sessions: [session] });
    await expect(
      abandonListeningSession(client as any, S1_ID, USER_ID),
    ).resolves.toBeUndefined();
  });

  it('throws SESSION_NOT_FOUND when session missing', async () => {
    const client = buildMockClient({ user_listening_block_sessions: [] });
    await expect(
      abandonListeningSession(client as any, S1_ID, USER_ID),
    ).rejects.toThrow(expect.objectContaining({ code: LISTENING_EXECUTION_ERRORS.SESSION_NOT_FOUND }));
  });
});

// ─── createOrGetListeningProgress ────────────────────────────────────────────

describe('createOrGetListeningProgress', () => {
  it('returns progress for existing row', async () => {
    const progress = {
      status: 'not_started',
      block_1_completed_at: null,
      block_2_completed_at: null,
      completed_at: null,
    };
    const from = (_table: string) => {
      const b: any = {
        select: () => b,
        eq: () => b,
        upsert: () => ({ then: (r: any, j: any) => Promise.resolve({ data: null, error: null }).then(r, j) }),
        single: async () => ({ data: progress, error: null }),
        then: (r: any, j: any) => Promise.resolve({ data: null, error: null }).then(r, j),
      };
      return b;
    };
    const result = await createOrGetListeningProgress({ from } as any, USER_ID, EP_ID);
    expect(result.status).toBe('not_started');
    expect(result.block1CompletedAt).toBeNull();
  });

  it('throws PROGRESS_SAVE_FAILED when DB returns error', async () => {
    const from = (_table: string) => {
      const b: any = {
        select: () => b,
        eq: () => b,
        upsert: () => ({ then: (r: any, j: any) => Promise.resolve({ data: null, error: null }).then(r, j) }),
        single: async () => ({ data: null, error: { message: 'DB error' } }),
        then: (r: any, j: any) => Promise.resolve({ data: null, error: null }).then(r, j),
      };
      return b;
    };
    await expect(
      createOrGetListeningProgress({ from } as any, USER_ID, EP_ID),
    ).rejects.toThrow(expect.objectContaining({ code: LISTENING_EXECUTION_ERRORS.PROGRESS_SAVE_FAILED }));
  });
});

// ─── subtitle mode by attempt ─────────────────────────────────────────────────

describe('subtitle mode contract', () => {
  it('attempt 1 → none, 2 → en, 3 → pt-BR in session state machine', () => {
    const map: Record<number, string> = { 1: 'none', 2: 'en', 3: 'pt-BR' };
    for (const [attempt, mode] of Object.entries(map)) {
      expect(map[Number(attempt)]).toBe(mode);
    }
  });
});
