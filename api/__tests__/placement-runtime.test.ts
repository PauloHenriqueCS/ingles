/**
 * Placement runtime integration tests over an in-memory fake Supabase client.
 * Verifies the wiring the pure engine can't: server-side answer checking against
 * the PRIVATE key, adaptive advance across checkpoints, the MONOTONIC apply RPC
 * on a terminal level, conclusion EXACTLY once, and skip (enroll-and-record).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The curriculum seam is mocked — buildCtx only needs a version + language.
vi.mock('../_curriculum/curriculum-runtime', () => ({
  ensureUserCurriculum: vi.fn(async () => ({ versionId: 'ver-1', languageContext: { learningLanguage: 'en', interfaceLanguage: 'pt-BR' } })),
  resolveActiveLearningLanguage: vi.fn(async () => 'en'),
}));
vi.mock('../_curriculum/presentation-i18n', () => ({
  getLanguageDisplayName: vi.fn(async () => 'inglês'),
}));

import { getPlacementState, startPlacement, submitAnswer, skipPlacement } from '../_placement/placement-runtime';

// ── Fixtures (subset of the English V1 seed) ─────────────────────────────────
const TEST = { id: 'test-1', version: 1, learning_language: 'en', is_active: true, start_checkpoint_key: 'B1', attempt_ttl_seconds: 86400 };
const CHECKPOINTS = [
  { id: 'cp-A2', placement_test_id: 'test-1', checkpoint_key: 'A2', kind: 'objective', main_question_count: 2, on_pass_checkpoint_key: null, on_fail_checkpoint_key: null, on_pass_level_code: 'A2', on_fail_level_code: 'A1' },
  { id: 'cp-B1', placement_test_id: 'test-1', checkpoint_key: 'B1', kind: 'objective', main_question_count: 2, on_pass_checkpoint_key: 'B2', on_fail_checkpoint_key: 'A2', on_pass_level_code: null, on_fail_level_code: null },
  { id: 'cp-B2', placement_test_id: 'test-1', checkpoint_key: 'B2', kind: 'objective', main_question_count: 2, on_pass_checkpoint_key: 'C1', on_fail_checkpoint_key: null, on_pass_level_code: null, on_fail_level_code: 'B1' },
];
function q(id: string, cp: string, key: string, role: string, sort: number) {
  return { id, checkpoint_id: cp, question_key: key, role, sort_order: sort, prompt_type: 'single_choice', stem: key, context: null, meta: {} };
}
const QUESTIONS = [
  q('q-b1-1', 'cp-B1', 'B1.1', 'main', 1), q('q-b1-2', 'cp-B1', 'B1.2', 'main', 2), q('q-b1-tb', 'cp-B1', 'B1.TB', 'tiebreaker', 1),
  q('q-a2-1', 'cp-A2', 'A2.1', 'main', 1), q('q-a2-2', 'cp-A2', 'A2.2', 'main', 2), q('q-a2-tb', 'cp-A2', 'A2.TB', 'tiebreaker', 1),
  q('q-b2-1', 'cp-B2', 'B2.1', 'main', 1), q('q-b2-2', 'cp-B2', 'B2.2', 'main', 2), q('q-b2-tb', 'cp-B2', 'B2.TB', 'tiebreaker', 1),
];
const OPTIONS = QUESTIONS.flatMap((qq) => [
  { question_id: qq.id, option_key: 'A', sort_order: 1, label: 'a' },
  { question_id: qq.id, option_key: 'B', sort_order: 2, label: 'b' },
]);
const KEYS = QUESTIONS.map((qq) => ({ question_id: qq.id, correct_option_key: 'A' })); // 'A' correct everywhere
const COPY = [
  { placement_test_id: 'test-1', interface_language: 'pt-BR', copy_key: 'result_headline', body: 'Seu nível inicial: {level}' },
  { placement_test_id: 'test-1', interface_language: 'pt-BR', copy_key: 'result_body', body: 'Comece em {level}.' },
  { placement_test_id: 'test-1', interface_language: 'pt-BR', copy_key: 'result_cta', body: 'Começar no {level}' },
];

// ── Minimal in-memory fake Supabase client ───────────────────────────────────
function makeFakeClient() {
  const db: Record<string, any[]> = {
    placement_tests: [TEST],
    placement_checkpoints: CHECKPOINTS,
    placement_questions: QUESTIONS,
    placement_question_options: OPTIONS,
    placement_question_keys: KEYS,
    placement_c2_rubrics: [],
    placement_ui_copy: COPY,
    placement_attempts: [],
    placement_attempt_answers: [],
    placement_c2_responses: [],
    placement_c2_evaluations: [],
  };
  const rpcCalls: Array<{ name: string; args: any }> = [];
  let idSeq = 0;

  function embed(table: string, sel: string, rows: any[]): any[] {
    return rows.map((r) => {
      const out = { ...r };
      if (table === 'placement_questions' && sel.includes('placement_checkpoints!inner')) {
        out.placement_checkpoints = db.placement_checkpoints.find((c) => c.id === r.checkpoint_id);
      }
      if (table === 'placement_attempt_answers' && sel.includes('placement_questions!inner')) {
        out.placement_questions = db.placement_questions.find((x) => x.id === r.question_id);
      }
      return out;
    });
  }
  function getPath(row: any, col: string): any {
    if (!col.includes('.')) return row[col];
    const [a, b] = col.split('.');
    return row[a]?.[b];
  }

  function from(table: string) {
    const filters: Array<{ type: string; col: string; val: any }> = [];
    let sel = '*';
    let mode: 'select' | 'insert' | 'update' | 'upsert' = 'select';
    let payload: any = null;
    let onConflict: string | null = null;
    let orderCol: string | null = null;
    let orderAsc = true;
    let limitN: number | null = null;

    function resolveSelect(): any[] {
      let rows = embed(table, sel, db[table]);
      for (const f of filters) {
        if (f.type === 'eq') rows = rows.filter((r) => getPath(r, f.col) === f.val);
        if (f.type === 'in') rows = rows.filter((r) => (f.val as any[]).includes(getPath(r, f.col)));
      }
      if (orderCol) rows = [...rows].sort((a, b) => (a[orderCol!] < b[orderCol!] ? -1 : 1) * (orderAsc ? 1 : -1));
      if (limitN != null) rows = rows.slice(0, limitN);
      return rows;
    }
    function applyWrite(): { data: any; error: any } {
      if (mode === 'insert') {
        // Enforce the real uq_placement_answer_once (attempt_id, question_id) so
        // a double-tap surfaces as Postgres unique_violation (23505), exactly
        // like production — the runtime must absorb it as a no-op.
        if (table === 'placement_attempt_answers') {
          const dup = db[table].find((r) => r.attempt_id === payload.attempt_id && r.question_id === payload.question_id);
          if (dup) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        }
        const row = { id: `row-${++idSeq}`, ...payload };
        db[table].push(row);
        return { data: row, error: null };
      }
      if (mode === 'upsert') {
        const keys = (onConflict ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        const match = db[table].find((r) => keys.every((k) => r[k] === payload[k]));
        if (match) Object.assign(match, payload);
        else db[table].push({ id: `row-${++idSeq}`, ...payload });
        return { data: null, error: null };
      }
      if (mode === 'update') {
        for (const r of resolveSelectForWrite()) Object.assign(r, payload);
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    function resolveSelectForWrite(): any[] {
      let rows = db[table];
      for (const f of filters) if (f.type === 'eq') rows = rows.filter((r) => r[f.col] === f.val);
      return rows;
    }

    const builder: any = {
      select(s: string) { sel = s ?? '*'; return builder; },
      eq(col: string, val: any) { filters.push({ type: 'eq', col, val }); return builder; },
      in(col: string, val: any[]) { filters.push({ type: 'in', col, val }); return builder; },
      order(col: string, opts?: { ascending?: boolean }) { orderCol = col; orderAsc = opts?.ascending !== false; return builder; },
      limit(n: number) { limitN = n; return builder; },
      insert(p: any) { mode = 'insert'; payload = p; return builder; },
      update(p: any) { mode = 'update'; payload = p; return builder; },
      upsert(p: any, opts?: { onConflict?: string }) { mode = 'upsert'; payload = p; onConflict = opts?.onConflict ?? null; return builder; },
      maybeSingle() { const rows = resolveSelect(); return Promise.resolve({ data: rows[0] ?? null, error: null }); },
      single() {
        if (mode === 'insert') return Promise.resolve(applyWrite());
        const rows = resolveSelect();
        return Promise.resolve({ data: rows[0] ?? null, error: rows[0] ? null : { message: 'no rows' } });
      },
      then(onF: any, onR: any) {
        const res = mode === 'select' ? { data: resolveSelect(), error: null } : applyWrite();
        return Promise.resolve(res).then(onF, onR);
      },
    };
    return builder;
  }

  const client: any = {
    from,
    rpc(name: string, args: any) {
      rpcCalls.push({ name, args });
      // Simulate the monotonic apply: effective = the requested target (user was
      // at A1). Returns the same shape as placement_apply_result_v1.
      return Promise.resolve({ data: [{ effective_level_code: args.p_target_level_code, current_subtopic_id: 'sub-x', status: 'active' }], error: null });
    },
    __rpcCalls: rpcCalls,
    __db: db,
  };
  return client;
}

const USER = 'user-1';

describe('placement runtime — adaptive flow + monotonic apply', () => {
  let client: any;
  beforeEach(() => { client = makeFakeClient(); });

  it('starts at B1 and serves the first main question', async () => {
    const s = await startPlacement(client, USER);
    expect(s.placementStatus).toBe('in_progress');
    expect(s.screen).toBe('question');
    expect(s.question?.questionKey).toBe('B1.1');
    // Options never leak a correctness flag.
    expect(s.question?.options.every((o) => !('isCorrect' in o))).toBe(true);
  });

  it('B1 FAIL → A2 FAIL routes to A1 and completes with a monotonic apply', async () => {
    let s = await startPlacement(client, USER);
    const attemptId = s.attemptId!;
    // Both B1 mains wrong ('B' when 'A' is correct).
    s = await submitAnswer(client, USER, attemptId, 'B1.1', 'B');
    s = await submitAnswer(client, USER, attemptId, 'B1.2', 'B');
    // Now at A2; both wrong → A1.
    expect(s.screen).toBe('question');
    expect(s.question?.checkpointKey).toBe('A2');
    s = await submitAnswer(client, USER, attemptId, 'A2.1', 'B');
    s = await submitAnswer(client, USER, attemptId, 'A2.2', 'B');

    expect(s.screen).toBe('result');
    expect(s.placementStatus).toBe('completed');
    expect(s.result?.effectiveLevel).toBe('A1');
    expect(s.result?.headline).toBe('Seu nível inicial: A1');
    // The monotonic apply RPC was invoked with the raw result level.
    const applyCall = client.__rpcCalls.find((c: any) => c.name === 'placement_apply_result_v1');
    expect(applyCall?.args.p_target_level_code).toBe('A1');
  });

  it('correct answers score via the PRIVATE key (B1 PASS advances to B2)', async () => {
    let s = await startPlacement(client, USER);
    const attemptId = s.attemptId!;
    s = await submitAnswer(client, USER, attemptId, 'B1.1', 'A');
    s = await submitAnswer(client, USER, attemptId, 'B1.2', 'A');
    expect(s.question?.checkpointKey).toBe('B2');
  });

  it('conclusion is exactly once: after completion, start returns the done result', async () => {
    let s = await startPlacement(client, USER);
    const id = s.attemptId!;
    await submitAnswer(client, USER, id, 'B1.1', 'B');
    await submitAnswer(client, USER, id, 'B1.2', 'B');
    await submitAnswer(client, USER, id, 'A2.1', 'B');
    s = await submitAnswer(client, USER, id, 'A2.2', 'B');
    expect(s.placementStatus).toBe('completed');

    const again = await startPlacement(client, USER);
    expect(again.screen).toBe('done');
    expect(again.placementStatus).toBe('completed');
    // No second open attempt was created.
    const open = client.__db.placement_attempts.filter((a: any) => a.status === 'in_progress');
    expect(open.length).toBe(0);
  });

  it("reproduces the reported path: B1 PASS (had already left / had) → B2, then B2 FAIL → result B1", async () => {
    let s = await startPlacement(client, USER);
    const id = s.attemptId!;
    // B1.1 + B1.2 correct → B1 PASS → B2.
    s = await submitAnswer(client, USER, id, 'B1.1', 'A');
    s = await submitAnswer(client, USER, id, 'B1.2', 'A');
    expect(s.question?.checkpointKey).toBe('B2');
    expect(s.question?.questionKey).toBe('B2.1');
    // B2.1 wrong, then B2.2 wrong (the balanced-argument question) → 0/2 FAIL → B1.
    s = await submitAnswer(client, USER, id, 'B2.1', 'B');
    expect(s.question?.questionKey).toBe('B2.2');
    s = await submitAnswer(client, USER, id, 'B2.2', 'B');
    expect(s.screen).toBe('result');
    expect(s.result?.effectiveLevel).toBe('B1');
    const applyCall = client.__rpcCalls.find((c: any) => c.name === 'placement_apply_result_v1');
    expect(applyCall?.args.p_target_level_code).toBe('B1');
  });

  it('is idempotent under a double-tap: a repeated Confirmar never records twice nor advances twice', async () => {
    let s = await startPlacement(client, USER);
    const id = s.attemptId!;
    // Two concurrent submits of the SAME first question.
    const [a, b] = await Promise.all([
      submitAnswer(client, USER, id, 'B1.1', 'A'),
      submitAnswer(client, USER, id, 'B1.1', 'A'),
    ]);
    // Exactly ONE answer row exists for that question.
    const rows = client.__db.placement_attempt_answers.filter((r: any) => r.attempt_id === id);
    expect(rows.length).toBe(1);
    // Both calls resolve to a consistent next state (still B1, awaiting B1.2).
    for (const st of [a, b]) {
      expect(st.screen).toBe('question');
      expect(st.question?.checkpointKey).toBe('B1');
    }
    s = await submitAnswer(client, USER, id, 'B1.2', 'A');
    expect(s.question?.checkpointKey).toBe('B2');
  });

  it('skip records a skipped attempt and leaves the user not-completed', async () => {
    const s = await skipPlacement(client, USER);
    expect(s.placementStatus).toBe('skipped');
    const rows = client.__db.placement_attempts;
    expect(rows.some((a: any) => a.status === 'skipped')).toBe(true);
    // Menu must still show the item → status !== 'completed'.
    const state = await getPlacementState(client, USER);
    expect(state.placementStatus).toBe('skipped');
  });
});
