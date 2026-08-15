/**
 * SERVER-ONLY placement runtime — orchestrates the adaptive level test.
 *
 * Responsibilities (glue only; the generic rules live in the pure engine
 * src/domain/placement/placement-engine.ts):
 *   - resolve the ACTIVE placement test for the user's TARGET language;
 *   - resolve/create the single open attempt (TTL-based abandonment, one open,
 *     conclusion exactly once — all backed by DB partial-unique indexes);
 *   - serve one question at a time WITHOUT ever exposing the answer key;
 *   - check answers SERVER-SIDE against the PRIVATE placement_question_keys;
 *   - run the C2 gate (open responses + AI rubric evaluation, injected);
 *   - apply the result MONOTONICALLY via placement_apply_result_v1 and reuse
 *     ensureUserCurriculum so the official level NEVER decreases.
 *
 * The official level authority stays user_curriculum_progress.current_level_code
 * — this module only ever RAISES it (apply marks lower levels complete + resync).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  decideCheckpoint,
  nextAfterCheckpoint,
  validateAndScoreC2,
  c2Decision,
  type PlacementCheckpoint,
  type PlacementQuestionRef,
  type AnswerRecord,
  type C2Criterion,
} from '../../src/domain/placement/placement-engine';
import { ensureUserCurriculum, resolveActiveLearningLanguage } from '../_curriculum/curriculum-runtime';
import { getLanguageDisplayName } from '../_curriculum/presentation-i18n';

export class PlacementConfigError extends Error {}

// ── Wire types (returned to the client via the route handler) ────────────────

export type PlacementStatus =
  | 'not_started'
  | 'in_progress'
  | 'skipped'
  | 'pending_evaluation'
  | 'completed';

export type PlacementScreen = 'intro' | 'question' | 'c2_gate' | 'result' | 'pending' | 'done';

export interface PlacementOptionView {
  key: string;
  label: string;
}

export interface PlacementQuestionView {
  questionKey: string;
  checkpointKey: string;
  promptType: 'single_choice';
  stem: string;
  context: string | null;
  options: PlacementOptionView[];
  progress: number;
}

export interface PlacementC2View {
  stepKey: string;
  stem: string;
  context: string | null;
  timeLimitSeconds: number;
  progress: number;
}

export interface PlacementResultView {
  rawLevel: string | null;
  effectiveLevel: string;
  headline: string;
  body: string;
  cta: string;
}

export interface PlacementState {
  placementStatus: PlacementStatus;
  learningLanguage: string;
  interfaceLanguage: string;
  languageLabel: string;
  copy: Record<string, string>;
  screen: PlacementScreen;
  attemptId: string | null;
  question?: PlacementQuestionView;
  c2?: PlacementC2View;
  result?: PlacementResultView;
}

// ── C2 evaluator (OpenAI call injected by the route handler) ─────────────────

export interface C2EvaluatorInput {
  taskManager: string;
  taskFriend: string;
  responseManager: string;
  responseFriend: string;
  criteria: C2Criterion[];
  /** Full rubric criteria (with labels + 0/1/2 descriptors) for the prompt. */
  criteriaRaw: unknown[];
  promptTemplateKey: string;
}
export type C2EvaluatorResult =
  | { ok: true; rawScores: unknown; reasonCodes: string[]; model: string; provider: string; raw: unknown }
  | { ok: false; code: string };
export type C2Evaluator = (input: C2EvaluatorInput) => Promise<C2EvaluatorResult>;

// ── Loaded test definition (cached per request) ──────────────────────────────

interface LoadedQuestion extends PlacementQuestionRef {
  id: string;
  checkpointKey: string;
  promptType: 'single_choice' | 'c2_open';
  stem: string;
  context: string | null;
  meta: Record<string, unknown>;
}
interface LoadedTest {
  id: string;
  version: number;
  learningLanguage: string;
  startCheckpointKey: string;
  attemptTtlSeconds: number;
  checkpoints: Map<string, PlacementCheckpoint>;
  questionsByCheckpoint: Map<string, LoadedQuestion[]>;
  optionsByQuestionId: Map<string, PlacementOptionView[]>;
  rubric: { rubricVersion: number; passThreshold: number; promptTemplateKey: string; criteria: C2Criterion[]; criteriaRaw: unknown[] } | null;
}

interface AttemptRow {
  id: string;
  user_id: string;
  status: PlacementStatus;
  test_version: number;
  current_checkpoint_key: string | null;
  raw_result_level_code: string | null;
  effective_level_code: string | null;
  expires_at: string;
}

async function loadActiveTest(service: SupabaseClient, learningLanguage: string): Promise<LoadedTest> {
  const { data: testRow, error } = await service
    .from('placement_tests')
    .select('id, version, learning_language, start_checkpoint_key, attempt_ttl_seconds')
    .eq('learning_language', learningLanguage)
    .eq('is_active', true)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new PlacementConfigError(`failed to read placement_tests: ${error.message}`);
  if (!testRow) throw new PlacementConfigError(`no active placement test for learning_language=${learningLanguage}`);
  const t = testRow as { id: string; version: number; learning_language: string; start_checkpoint_key: string; attempt_ttl_seconds: number };

  const { data: cpRows } = await service
    .from('placement_checkpoints')
    .select('checkpoint_key, kind, main_question_count, on_pass_checkpoint_key, on_fail_checkpoint_key, on_pass_level_code, on_fail_level_code')
    .eq('placement_test_id', t.id);
  const checkpoints = new Map<string, PlacementCheckpoint>();
  for (const r of (cpRows ?? []) as any[]) {
    checkpoints.set(r.checkpoint_key, {
      checkpointKey: r.checkpoint_key,
      kind: r.kind,
      mainQuestionCount: r.main_question_count,
      onPassCheckpointKey: r.on_pass_checkpoint_key,
      onFailCheckpointKey: r.on_fail_checkpoint_key,
      onPassLevelCode: r.on_pass_level_code,
      onFailLevelCode: r.on_fail_level_code,
    });
  }

  // Load every question of the test (join to checkpoints). Options are loaded
  // for single_choice questions (never the private key).
  const cpIds = (cpRows ?? []) as any[];
  const { data: qRows } = await service
    .from('placement_questions')
    .select('id, question_key, role, sort_order, prompt_type, stem, context, meta, checkpoint_id, placement_checkpoints!inner(checkpoint_key, placement_test_id)')
    .eq('placement_checkpoints.placement_test_id', t.id);
  const questionsByCheckpoint = new Map<string, LoadedQuestion[]>();
  const allQuestionIds: string[] = [];
  for (const r of (qRows ?? []) as any[]) {
    const checkpointKey = r.placement_checkpoints.checkpoint_key as string;
    const q: LoadedQuestion = {
      id: r.id,
      questionKey: r.question_key,
      role: r.role,
      sortOrder: r.sort_order,
      checkpointKey,
      promptType: r.prompt_type,
      stem: r.stem,
      context: r.context ?? null,
      meta: (r.meta ?? {}) as Record<string, unknown>,
    };
    const arr = questionsByCheckpoint.get(checkpointKey) ?? [];
    arr.push(q);
    questionsByCheckpoint.set(checkpointKey, arr);
    if (r.prompt_type === 'single_choice') allQuestionIds.push(r.id);
  }
  void cpIds;

  const optionsByQuestionId = new Map<string, PlacementOptionView[]>();
  if (allQuestionIds.length > 0) {
    const { data: optRows } = await service
      .from('placement_question_options')
      .select('question_id, option_key, sort_order, label')
      .in('question_id', allQuestionIds)
      .order('sort_order', { ascending: true });
    for (const r of (optRows ?? []) as any[]) {
      const arr = optionsByQuestionId.get(r.question_id) ?? [];
      arr.push({ key: r.option_key, label: r.label });
      optionsByQuestionId.set(r.question_id, arr);
    }
  }

  const { data: rubricRow } = await service
    .from('placement_c2_rubrics')
    .select('rubric_version, pass_threshold, prompt_template_key, criteria')
    .eq('placement_test_id', t.id)
    .order('rubric_version', { ascending: false })
    .limit(1)
    .maybeSingle();
  let rubric: LoadedTest['rubric'] = null;
  if (rubricRow) {
    const rr = rubricRow as any;
    const criteriaRaw = (rr.criteria as any[]) ?? [];
    const criteria: C2Criterion[] = criteriaRaw.map((c) => ({ key: c.key, maxScore: c.max_score }));
    rubric = { rubricVersion: rr.rubric_version, passThreshold: rr.pass_threshold, promptTemplateKey: rr.prompt_template_key, criteria, criteriaRaw };
  }

  return {
    id: t.id,
    version: t.version,
    learningLanguage: t.learning_language,
    startCheckpointKey: t.start_checkpoint_key,
    attemptTtlSeconds: t.attempt_ttl_seconds,
    checkpoints,
    questionsByCheckpoint,
    optionsByQuestionId,
    rubric,
  };
}

function questionRefs(qs: LoadedQuestion[]): PlacementQuestionRef[] {
  return qs.map((q) => ({ questionKey: q.questionKey, role: q.role, sortOrder: q.sortOrder }));
}

async function loadAnswers(service: SupabaseClient, attemptId: string): Promise<Array<AnswerRecord & { checkpointKey: string }>> {
  const { data } = await service
    .from('placement_attempt_answers')
    .select('question_id, checkpoint_key, is_correct, placement_questions!inner(question_key, role)')
    .eq('attempt_id', attemptId);
  return ((data ?? []) as any[]).map((r) => ({
    questionKey: r.placement_questions.question_key,
    role: r.placement_questions.role,
    isCorrect: r.is_correct,
    checkpointKey: r.checkpoint_key,
  }));
}

async function resolveCopy(
  service: SupabaseClient,
  testId: string,
  interfaceLanguage: string,
  languageLabel: string,
): Promise<Record<string, string>> {
  const { data } = await service
    .from('placement_ui_copy')
    .select('copy_key, body')
    .eq('placement_test_id', testId)
    .eq('interface_language', interfaceLanguage);
  const copy: Record<string, string> = {};
  for (const r of (data ?? []) as any[]) {
    copy[r.copy_key] = String(r.body).replace(/\{language\}/g, languageLabel);
  }
  return copy;
}

function applyLevelToCopy(copy: Record<string, string>, key: string, level: string): string {
  return (copy[key] ?? '').replace(/\{level\}/g, level);
}

interface Ctx {
  service: SupabaseClient;
  userId: string;
  test: LoadedTest;
  interfaceLanguage: string;
  languageLabel: string;
  copy: Record<string, string>;
  versionId: string;
}

async function buildCtx(service: SupabaseClient, userId: string): Promise<Ctx> {
  const learningLanguage = await resolveActiveLearningLanguage(service, userId);
  const ensured = await ensureUserCurriculum(service, userId);
  const test = await loadActiveTest(service, learningLanguage);
  const interfaceLanguage = ensured.languageContext.interfaceLanguage;
  const languageLabel = await getLanguageDisplayName(service, learningLanguage, interfaceLanguage);
  const copy = await resolveCopy(service, test.id, interfaceLanguage, languageLabel);
  return { service, userId, test, interfaceLanguage, languageLabel, copy, versionId: ensured.versionId };
}

async function readCompletedAttempt(service: SupabaseClient, userId: string, testId: string): Promise<AttemptRow | null> {
  const { data } = await service
    .from('placement_attempts')
    .select('id, user_id, status, test_version, current_checkpoint_key, raw_result_level_code, effective_level_code, expires_at')
    .eq('user_id', userId)
    .eq('placement_test_id', testId)
    .eq('status', 'completed')
    .maybeSingle();
  return (data ?? null) as AttemptRow | null;
}

async function readOpenAttempt(service: SupabaseClient, userId: string, testId: string): Promise<AttemptRow | null> {
  const { data } = await service
    .from('placement_attempts')
    .select('id, user_id, status, test_version, current_checkpoint_key, raw_result_level_code, effective_level_code, expires_at')
    .eq('user_id', userId)
    .eq('placement_test_id', testId)
    .in('status', ['in_progress', 'pending_evaluation'])
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data ?? null) as AttemptRow | null;
}

async function readLatestAttempt(service: SupabaseClient, userId: string, testId: string): Promise<AttemptRow | null> {
  const { data } = await service
    .from('placement_attempts')
    .select('id, user_id, status, test_version, current_checkpoint_key, raw_result_level_code, effective_level_code, expires_at')
    .eq('user_id', userId)
    .eq('placement_test_id', testId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data ?? null) as AttemptRow | null;
}

function isExpired(row: AttemptRow, nowMs: number): boolean {
  return new Date(row.expires_at).getTime() <= nowMs;
}

async function markAbandoned(service: SupabaseClient, attemptId: string): Promise<void> {
  await service.from('placement_attempts').update({ status: 'abandoned', updated_at: new Date().toISOString() }).eq('id', attemptId);
}

// ── Result finalization (monotonic) ──────────────────────────────────────────

async function applyMonotonicResult(ctx: Ctx, levelCode: string): Promise<string> {
  const { data, error } = await ctx.service.rpc('placement_apply_result_v1', {
    p_user_id: ctx.userId,
    p_curriculum_version_id: ctx.versionId,
    p_target_level_code: levelCode,
  });
  if (error) throw new PlacementConfigError(`placement_apply_result_v1 failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as { effective_level_code: string | null } | undefined;
  // effective is the (monotonic) official level after applying — never below the
  // raw result, and never below where the user already was.
  return row?.effective_level_code ?? levelCode;
}

function resultView(ctx: Ctx, rawLevel: string | null, effectiveLevel: string): PlacementResultView {
  return {
    rawLevel,
    effectiveLevel,
    headline: applyLevelToCopy(ctx.copy, 'result_headline', effectiveLevel),
    body: applyLevelToCopy(ctx.copy, 'result_body', effectiveLevel),
    cta: applyLevelToCopy(ctx.copy, 'result_cta', effectiveLevel),
  };
}

/** Completes the attempt with a terminal level (single completion enforced by
 *  uq_placement_one_completed). Idempotent: a duplicate completion is absorbed. */
async function completeWithLevel(ctx: Ctx, attempt: AttemptRow, rawLevel: string): Promise<PlacementResultView> {
  const effective = await applyMonotonicResult(ctx, rawLevel);
  const { error } = await ctx.service
    .from('placement_attempts')
    .update({
      status: 'completed',
      raw_result_level_code: rawLevel,
      effective_level_code: effective,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', attempt.id);
  if (error) {
    // A concurrent completion (unique index) — read the winning completed row.
    const done = await readCompletedAttempt(ctx.service, ctx.userId, ctx.test.id);
    if (done) return resultView(ctx, done.raw_result_level_code, done.effective_level_code ?? effective);
    throw new PlacementConfigError(`failed to complete attempt: ${error.message}`);
  }
  return resultView(ctx, rawLevel, effective);
}

function baseState(ctx: Ctx, status: PlacementStatus, screen: PlacementScreen, attemptId: string | null): PlacementState {
  return {
    placementStatus: status,
    learningLanguage: ctx.test.learningLanguage,
    interfaceLanguage: ctx.interfaceLanguage,
    languageLabel: ctx.languageLabel,
    copy: ctx.copy,
    screen,
    attemptId,
  };
}

function serveQuestion(ctx: Ctx, checkpointKey: string, questionKey: string, progress: number): PlacementQuestionView {
  const q = (ctx.test.questionsByCheckpoint.get(checkpointKey) ?? []).find((x) => x.questionKey === questionKey);
  if (!q) throw new PlacementConfigError(`question ${questionKey} not found in ${checkpointKey}`);
  return {
    questionKey: q.questionKey,
    checkpointKey,
    promptType: 'single_choice',
    stem: q.stem,
    context: q.context,
    options: ctx.test.optionsByQuestionId.get(q.id) ?? [],
    progress,
  };
}

function serveC2Step(ctx: Ctx, q: LoadedQuestion, progress: number): PlacementC2View {
  const t = q.meta.time_limit_seconds;
  return {
    stepKey: String(q.meta.step_key ?? q.questionKey),
    stem: q.stem,
    context: q.context,
    timeLimitSeconds: typeof t === 'number' ? t : 60,
    progress,
  };
}

/**
 * Advances the in-progress attempt as far as the persisted answers allow and
 * returns the current renderable screen. Persists current_checkpoint_key across
 * checkpoint transitions. On a terminal level it finalizes (monotonic apply +
 * complete). Deterministic and safe to call repeatedly (resume/reload).
 */
async function advanceInProgress(ctx: Ctx, attempt: AttemptRow): Promise<PlacementState> {
  const answers = await loadAnswers(ctx.service, attempt.id);
  const answerCount = answers.length;
  let cpKey = attempt.current_checkpoint_key ?? ctx.test.startCheckpointKey;

  // Bounded by the number of checkpoints; guards against a misconfigured cycle.
  for (let guard = 0; guard <= ctx.test.checkpoints.size + 1; guard++) {
    const cp = ctx.test.checkpoints.get(cpKey);
    if (!cp) throw new PlacementConfigError(`unknown checkpoint ${cpKey}`);

    if (cp.kind === 'c2_gate') {
      return await c2GateScreen(ctx, attempt, cpKey);
    }

    const qs = ctx.test.questionsByCheckpoint.get(cpKey) ?? [];
    const cpAnswers = answers.filter((a) => a.checkpointKey === cpKey);
    const decision = decideCheckpoint(cp, questionRefs(qs), cpAnswers);
    const progress = Math.min(0.9, 0.15 + answerCount * 0.12);

    if (decision.type === 'ask') {
      if (attempt.current_checkpoint_key !== cpKey) {
        await ctx.service.from('placement_attempts').update({ current_checkpoint_key: cpKey, updated_at: new Date().toISOString() }).eq('id', attempt.id);
        attempt.current_checkpoint_key = cpKey;
      }
      const state = baseState(ctx, 'in_progress', 'question', attempt.id);
      state.question = serveQuestion(ctx, cpKey, decision.questionKey, progress);
      return state;
    }

    const transition = nextAfterCheckpoint(cp, decision.outcome);
    if (transition.type === 'level') {
      const result = await completeWithLevel(ctx, attempt, transition.levelCode);
      const state = baseState(ctx, 'completed', 'result', attempt.id);
      state.result = result;
      return state;
    }
    // Move to the next checkpoint and persist the pointer.
    cpKey = transition.checkpointKey;
    await ctx.service.from('placement_attempts').update({ current_checkpoint_key: cpKey, updated_at: new Date().toISOString() }).eq('id', attempt.id);
    attempt.current_checkpoint_key = cpKey;
  }
  throw new PlacementConfigError('placement checkpoint transition did not converge');
}

async function loadC2Responses(service: SupabaseClient, attemptId: string): Promise<Set<string>> {
  const { data } = await service.from('placement_c2_responses').select('step_key').eq('attempt_id', attemptId);
  return new Set(((data ?? []) as any[]).map((r) => r.step_key));
}

async function c2GateScreen(ctx: Ctx, attempt: AttemptRow, cpKey: string): Promise<PlacementState> {
  // Ensure the pointer is persisted at the gate.
  if (attempt.current_checkpoint_key !== cpKey) {
    await ctx.service.from('placement_attempts').update({ current_checkpoint_key: cpKey, updated_at: new Date().toISOString() }).eq('id', attempt.id);
    attempt.current_checkpoint_key = cpKey;
  }
  const steps = (ctx.test.questionsByCheckpoint.get(cpKey) ?? [])
    .filter((q) => q.promptType === 'c2_open')
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const submitted = await loadC2Responses(ctx.service, attempt.id);
  const nextStep = steps.find((q) => !submitted.has(String(q.meta.step_key ?? q.questionKey)));
  if (nextStep) {
    const state = baseState(ctx, 'in_progress', 'c2_gate', attempt.id);
    state.c2 = serveC2Step(ctx, nextStep, 0.9);
    return state;
  }
  // Both submitted but not yet evaluated → pending (the eval is triggered by
  // c2-submit; state just reports it so the client can retry evaluation).
  if (attempt.status !== 'pending_evaluation') {
    await ctx.service.from('placement_attempts').update({ status: 'pending_evaluation', updated_at: new Date().toISOString() }).eq('id', attempt.id);
    attempt.status = 'pending_evaluation';
  }
  return baseState(ctx, 'pending_evaluation', 'pending', attempt.id);
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function getPlacementState(service: SupabaseClient, userId: string): Promise<PlacementState> {
  const ctx = await buildCtx(service, userId);
  const now = Date.now();

  const completed = await readCompletedAttempt(service, userId, ctx.test.id);
  if (completed) {
    const state = baseState(ctx, 'completed', 'done', completed.id);
    state.result = resultView(ctx, completed.raw_result_level_code, completed.effective_level_code ?? completed.raw_result_level_code ?? '');
    return state;
  }

  let open = await readOpenAttempt(service, userId, ctx.test.id);
  if (open && open.status === 'in_progress' && isExpired(open, now)) {
    await markAbandoned(service, open.id);
    open = null;
  }
  if (open) {
    if (open.status === 'pending_evaluation') {
      return baseState(ctx, 'pending_evaluation', 'pending', open.id);
    }
    return await advanceInProgress(ctx, open);
  }

  const latest = await readLatestAttempt(service, userId, ctx.test.id);
  const status: PlacementStatus = latest?.status === 'skipped' ? 'skipped' : 'not_started';
  return baseState(ctx, status, 'intro', null);
}

export async function startPlacement(service: SupabaseClient, userId: string): Promise<PlacementState> {
  const ctx = await buildCtx(service, userId);
  const now = Date.now();

  const completed = await readCompletedAttempt(service, userId, ctx.test.id);
  if (completed) {
    const state = baseState(ctx, 'completed', 'done', completed.id);
    state.result = resultView(ctx, completed.raw_result_level_code, completed.effective_level_code ?? completed.raw_result_level_code ?? '');
    return state;
  }

  let open = await readOpenAttempt(service, userId, ctx.test.id);
  if (open && open.status === 'in_progress' && isExpired(open, now)) {
    await markAbandoned(service, open.id);
    open = null;
  }
  if (open) {
    if (open.status === 'pending_evaluation') return baseState(ctx, 'pending_evaluation', 'pending', open.id);
    return await advanceInProgress(ctx, open);
  }

  const expiresAt = new Date(now + ctx.test.attemptTtlSeconds * 1000).toISOString();
  const { data, error } = await service
    .from('placement_attempts')
    .insert({
      user_id: userId,
      placement_test_id: ctx.test.id,
      test_version: ctx.test.version,
      learning_language: ctx.test.learningLanguage,
      status: 'in_progress',
      current_checkpoint_key: ctx.test.startCheckpointKey,
      expires_at: expiresAt,
    })
    .select('id, user_id, status, test_version, current_checkpoint_key, raw_result_level_code, effective_level_code, expires_at')
    .single();
  if (error || !data) {
    // Lost a race to create the single open attempt — re-read and advance it.
    const retry = await readOpenAttempt(service, userId, ctx.test.id);
    if (retry) return await advanceInProgress(ctx, retry);
    throw new PlacementConfigError(`failed to start placement: ${error?.message ?? 'unknown'}`);
  }
  return await advanceInProgress(ctx, data as AttemptRow);
}

export async function skipPlacement(service: SupabaseClient, userId: string): Promise<PlacementState> {
  const ctx = await buildCtx(service, userId);

  const completed = await readCompletedAttempt(service, userId, ctx.test.id);
  if (completed) {
    const state = baseState(ctx, 'completed', 'done', completed.id);
    state.result = resultView(ctx, completed.raw_result_level_code, completed.effective_level_code ?? completed.raw_result_level_code ?? '');
    return state;
  }

  // ensureUserCurriculum (called in buildCtx) already guaranteed the user is
  // enrolled at the course's first level (A1 default) — skipping just records
  // the skip; the official level stays whatever enrollment set (never below A1).
  const open = await readOpenAttempt(service, userId, ctx.test.id);
  if (open && open.status === 'in_progress') {
    await service.from('placement_attempts').update({ status: 'skipped', updated_at: new Date().toISOString() }).eq('id', open.id);
  } else if (!open) {
    const now = Date.now();
    await service.from('placement_attempts').insert({
      user_id: userId,
      placement_test_id: ctx.test.id,
      test_version: ctx.test.version,
      learning_language: ctx.test.learningLanguage,
      status: 'skipped',
      current_checkpoint_key: null,
      expires_at: new Date(now + ctx.test.attemptTtlSeconds * 1000).toISOString(),
    });
  }
  return baseState(ctx, 'skipped', 'intro', null);
}

export async function submitAnswer(
  service: SupabaseClient,
  userId: string,
  attemptId: string,
  questionKey: string,
  optionKey: string,
): Promise<PlacementState> {
  const ctx = await buildCtx(service, userId);
  const now = Date.now();

  const { data: attemptData } = await service
    .from('placement_attempts')
    .select('id, user_id, status, test_version, current_checkpoint_key, raw_result_level_code, effective_level_code, expires_at')
    .eq('id', attemptId)
    .eq('user_id', userId)
    .maybeSingle();
  const attempt = (attemptData ?? null) as AttemptRow | null;
  if (!attempt || attempt.status !== 'in_progress') {
    // Nothing to answer against — return the authoritative current state.
    return await getPlacementState(service, userId);
  }
  if (isExpired(attempt, now)) {
    await markAbandoned(service, attempt.id);
    return await getPlacementState(service, userId);
  }

  const cpKey = attempt.current_checkpoint_key ?? ctx.test.startCheckpointKey;
  const qs = ctx.test.questionsByCheckpoint.get(cpKey) ?? [];
  const q = qs.find((x) => x.questionKey === questionKey && x.promptType === 'single_choice');
  if (!q) {
    // Out-of-order / unknown question — ignore and return current state.
    return await advanceInProgress(ctx, attempt);
  }

  // Only accept the question the engine currently expects (no going back / no
  // skipping ahead). Idempotent: a duplicate is absorbed by the unique index.
  const cpAnswers = (await loadAnswers(service, attempt.id)).filter((a) => a.checkpointKey === cpKey);
  const decision = decideCheckpoint(ctx.test.checkpoints.get(cpKey)!, questionRefs(qs), cpAnswers);
  if (decision.type !== 'ask' || decision.questionKey !== questionKey) {
    return await advanceInProgress(ctx, attempt);
  }

  // SERVER-SIDE correctness: read the PRIVATE key (never sent to the client).
  const { data: keyRow } = await service
    .from('placement_question_keys')
    .select('correct_option_key')
    .eq('question_id', q.id)
    .maybeSingle();
  const correctKey = (keyRow as { correct_option_key?: string } | null)?.correct_option_key ?? null;
  const isCorrect = correctKey != null && optionKey === correctKey;

  await service.from('placement_attempt_answers').insert({
    attempt_id: attempt.id,
    question_id: q.id,
    checkpoint_key: cpKey,
    selected_option_key: optionKey,
    is_correct: isCorrect,
  });
  // Ignore duplicate-insert errors (unique attempt+question) — the answer is
  // final and unchangeable (§16); we just re-advance.

  return await advanceInProgress(ctx, attempt);
}

export async function submitC2Response(
  service: SupabaseClient,
  userId: string,
  attemptId: string,
  stepKey: string,
  text: string,
  evaluator: C2Evaluator,
): Promise<PlacementState> {
  const ctx = await buildCtx(service, userId);
  const { data: attemptData } = await service
    .from('placement_attempts')
    .select('id, user_id, status, test_version, current_checkpoint_key, raw_result_level_code, effective_level_code, expires_at')
    .eq('id', attemptId)
    .eq('user_id', userId)
    .maybeSingle();
  const attempt = (attemptData ?? null) as AttemptRow | null;
  if (!attempt || (attempt.status !== 'in_progress' && attempt.status !== 'pending_evaluation')) {
    return await getPlacementState(service, userId);
  }

  const cpKey = attempt.current_checkpoint_key;
  if (!cpKey) return await advanceInProgress(ctx, attempt);
  const cp = ctx.test.checkpoints.get(cpKey);
  if (!cp || cp.kind !== 'c2_gate') return await advanceInProgress(ctx, attempt);

  const steps = (ctx.test.questionsByCheckpoint.get(cpKey) ?? []).filter((q) => q.promptType === 'c2_open');
  const step = steps.find((q) => String(q.meta.step_key ?? q.questionKey) === stepKey);
  if (!step) return await advanceInProgress(ctx, attempt);

  // Store/overwrite the step response (allowed until the gate is evaluated).
  await service.from('placement_c2_responses').upsert(
    { attempt_id: attempt.id, step_key: stepKey, response_text: text, submitted_at: new Date().toISOString() },
    { onConflict: 'attempt_id,step_key' },
  );

  // If BOTH steps are present, evaluate now.
  const submitted = await loadC2Responses(service, attempt.id);
  const allSubmitted = steps.every((q) => submitted.has(String(q.meta.step_key ?? q.questionKey)));
  if (!allSubmitted) {
    return await advanceInProgress(ctx, attempt);
  }
  return await runC2Evaluation(ctx, attempt, evaluator);
}

export async function evaluatePendingC2(
  service: SupabaseClient,
  userId: string,
  evaluator: C2Evaluator,
): Promise<PlacementState> {
  const ctx = await buildCtx(service, userId);
  const open = await readOpenAttempt(service, userId, ctx.test.id);
  if (!open || open.status !== 'pending_evaluation') {
    return await getPlacementState(service, userId);
  }
  return await runC2Evaluation(ctx, open, evaluator);
}

async function runC2Evaluation(ctx: Ctx, attempt: AttemptRow, evaluator: C2Evaluator): Promise<PlacementState> {
  const rubric = ctx.test.rubric;
  if (!rubric) throw new PlacementConfigError('placement C2 rubric not configured');

  const cpKey = attempt.current_checkpoint_key!;
  const steps = (ctx.test.questionsByCheckpoint.get(cpKey) ?? []).filter((q) => q.promptType === 'c2_open');
  const managerStep = steps.find((q) => String(q.meta.step_key) === 'manager');
  const friendStep = steps.find((q) => String(q.meta.step_key) === 'friend');
  const cp = ctx.test.checkpoints.get(cpKey)!;

  const { data: respRows } = await ctx.service.from('placement_c2_responses').select('step_key, response_text').eq('attempt_id', attempt.id);
  const respMap = new Map(((respRows ?? []) as any[]).map((r) => [r.step_key, r.response_text as string]));
  const responseManager = respMap.get('manager') ?? '';
  const responseFriend = respMap.get('friend') ?? '';

  const evalResult = await evaluator({
    taskManager: managerStep?.stem ?? '',
    taskFriend: friendStep?.stem ?? '',
    responseManager,
    responseFriend,
    criteria: rubric.criteria,
    criteriaRaw: rubric.criteriaRaw,
    promptTemplateKey: rubric.promptTemplateKey,
  });

  if (!evalResult.ok) {
    // §25 — a technical AI failure must NOT trap the user. Give a TEMPORARY
    // effective level of C1 (monotonic: only raises) so the course opens, keep
    // status pending_evaluation (NOT completed), preserve both responses, and
    // leave "Teste de nível" in the menu. The evaluation is retried later.
    await applyMonotonicResult(ctx, 'C1');
    if (attempt.status !== 'pending_evaluation') {
      await ctx.service.from('placement_attempts').update({ status: 'pending_evaluation', updated_at: new Date().toISOString() }).eq('id', attempt.id);
    }
    return baseState(ctx, 'pending_evaluation', 'pending', attempt.id);
  }

  const validation = validateAndScoreC2(evalResult.rawScores, rubric.criteria);
  if (!validation.ok) {
    // Invalid JSON/scores → same safe pending path as a provider failure.
    await applyMonotonicResult(ctx, 'C1');
    if (attempt.status !== 'pending_evaluation') {
      await ctx.service.from('placement_attempts').update({ status: 'pending_evaluation', updated_at: new Date().toISOString() }).eq('id', attempt.id);
    }
    return baseState(ctx, 'pending_evaluation', 'pending', attempt.id);
  }

  const decision = c2Decision(validation.total, rubric.passThreshold);
  await ctx.service.from('placement_c2_evaluations').upsert(
    {
      attempt_id: attempt.id,
      rubric_version: rubric.rubricVersion,
      prompt_version: 1,
      scores: validation.scores,
      total: validation.total,
      decision,
      reason_codes: evalResult.reasonCodes,
      provider: evalResult.provider,
      model: evalResult.model,
      raw_output: evalResult.raw as any,
    },
    { onConflict: 'attempt_id' },
  );

  // Route the C2 gate outcome through the SAME data-driven tree: pass → C2,
  // fail → C1 (from the checkpoint's on_pass/on_fail level).
  const transition = nextAfterCheckpoint(cp, decision === 'C2' ? 'pass' : 'fail');
  const level = transition.type === 'level' ? transition.levelCode : decision;
  const result = await completeWithLevel(ctx, attempt, level);
  const state = baseState(ctx, 'completed', 'result', attempt.id);
  state.result = result;
  return state;
}
