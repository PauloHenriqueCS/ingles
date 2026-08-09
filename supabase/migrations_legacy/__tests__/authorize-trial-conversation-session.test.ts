/**
 * Static SQL-text assertions for
 * 20260727224200_authorize_trial_conversation_session.sql — no live
 * database connection here (same posture as the other migration static
 * tests in this directory).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const sql = readFileSync(
  resolve(__dirname, '..', '..', 'migrations', '20260727224200_authorize_trial_conversation_session.sql'),
  'utf8',
);

const fnBody = sql.slice(
  sql.indexOf('CREATE OR REPLACE FUNCTION public.authorize_trial_conversation_session_v1'),
  sql.lastIndexOf('$function$;'),
);

describe('20260727224200 — authorize_trial_conversation_session_v1', () => {
  it('is SECURITY DEFINER with a pinned search_path', () => {
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/SET search_path TO 'public'/);
  });

  it('adds idempotency_key and assignment_id as nullable, additive columns (assignment_id FK to user_plan_assignments)', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS idempotency_key text;');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS assignment_id uuid REFERENCES public.user_plan_assignments(id);');
  });

  it('drops the earlier (never-applied) indexes from this same Etapa before creating the final composite one', () => {
    expect(sql).toContain('DROP INDEX IF EXISTS public.uq_conversation_session_authorizations_idempotency_key;');
    expect(sql).toContain('DROP INDEX IF EXISTS public.uq_conversation_session_authorizations_user_idempotency_key;');
  });

  it('scopes idempotency uniqueness by (user_id, assignment_id, idempotency_key) — a colliding key from a different user OR a different assignment must never match', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_session_authorizations_user_assignment_idempotency_key\s*\n\s*ON public\.conversation_session_authorizations \(user_id, assignment_id, idempotency_key\)\s*\n\s*WHERE assignment_id IS NOT NULL AND idempotency_key IS NOT NULL;/);
  });

  it('resolves the plan/assignment BEFORE any idempotency lookup — the lookup itself needs the CURRENT assignment_id to scope correctly', () => {
    const planResolveIdx = fnBody.indexOf('SELECT * INTO v_plan FROM public.admin_resolve_effective_plan_v1');
    const firstLookupIdx = fnBody.indexOf('WHERE user_id = p_user_id AND assignment_id = v_plan.assignment_id AND idempotency_key = p_idempotency_key');
    expect(planResolveIdx).toBeGreaterThan(-1);
    expect(firstLookupIdx).toBeGreaterThan(-1);
    expect(planResolveIdx).toBeLessThan(firstLookupIdx);
  });

  it('every idempotency lookup (pre-lock, post-lock, unique_violation fallbacks) filters by user_id AND assignment_id = v_plan.assignment_id, never idempotency_key alone or user_id alone', () => {
    const lookups = fnBody.match(/WHERE user_id = p_user_id AND assignment_id = v_plan\.assignment_id AND idempotency_key = p_idempotency_key/g) ?? [];
    expect(lookups.length).toBeGreaterThanOrEqual(4); // pre-lock, post-lock, unlimited-branch unique_violation, finite-branch unique_violation
    // No lookup unscoped by assignment_id anywhere.
    expect(fnBody).not.toMatch(/WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key(?!\s*AND assignment_id)/);
    expect(fnBody).not.toMatch(/WHERE idempotency_key = p_idempotency_key(?!\s)/);
  });

  it('cenário: mesma chave + mesmo usuário + MESMO assignment retorna a autorização existente (nenhuma nova reserva)', () => {
    // The pre-lock lookup runs before any INSERT — a match short-circuits
    // straight to RETURN QUERY with the EXISTING row's id/authorized_max_seconds.
    expect(fnBody).toMatch(/SELECT id, authorized_max_seconds INTO v_existing_id, v_existing_max\s*\n\s*FROM public\.conversation_session_authorizations\s*\n\s*WHERE user_id = p_user_id AND assignment_id = v_plan\.assignment_id AND idempotency_key = p_idempotency_key;\s*\n\s*IF FOUND THEN\s*\n\s*RETURN QUERY SELECT v_existing_id, v_existing_max, false, NULL::text;/);
  });

  it('cenário: mesma chave + mesmo usuário + assignment DIFERENTE não reutiliza a autorização antiga — a busca usa v_plan.assignment_id (resolvido AGORA), nunca um assignment armazenado/antigo', () => {
    // The lookup's assignment_id operand is always the freshly-resolved
    // v_plan.assignment_id, never a literal/cached/older value — so a row
    // whose OWN assignment_id column differs (an older assignment) can
    // never satisfy this WHERE, regardless of how the key string compares.
    expect(fnBody).not.toMatch(/assignment_id = '[0-9a-f-]{36}'/i);
    expect(fnBody.match(/assignment_id = v_plan\.assignment_id/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it('cenário: mesma chave + usuário DIFERENTE nunca revela nem reutiliza a autorização de outro usuário', () => {
    // user_id = p_user_id is present in EVERY lookup/insert/unique_violation
    // fallback — there is no code path that searches by idempotency_key (or
    // by assignment_id) without ALSO requiring the same user_id.
    const totalLookups = fnBody.match(/FROM public\.conversation_session_authorizations\s*\n\s*WHERE user_id = p_user_id/g) ?? [];
    expect(totalLookups.length).toBeGreaterThanOrEqual(4);
  });

  it('cenário: autorização antiga fora da janela/assignment atual nunca é reutilizada nem soma no consumo — ambos filtram exclusivamente pelo assignment/janela ATUAL resolvidos por admin_resolve_effective_plan_v1', () => {
    expect(fnBody).toContain('authorized_at >= v_plan.starts_at');
    expect(fnBody).toContain("authorized_at < COALESCE(v_plan.ends_at, 'infinity'::timestamptz)");
  });

  it('never accepts an assignment_id, window, or trial total from the caller — only user_id, requested seconds, session date, gateway ids, and an idempotency key', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.authorize_trial_conversation_session_v1\(\s*\n\s*p_user_id uuid,\s*\n\s*p_requested_max_seconds integer,\s*\n\s*p_session_date date,\s*\n\s*p_gateway_budget_reservation_id uuid,\s*\n\s*p_gateway_session_id uuid,\s*\n\s*p_idempotency_key text\s*\n\)/);
    expect(fnBody).not.toMatch(/p_assignment_id|p_window_start|p_window_end|p_trial_total_seconds/);
  });

  it('documents the admin_resolve_effective_plan_v1 auth-model audit — confirms no admin gate and the Modelo B decision', () => {
    expect(sql).toMatch(/N[ãÃ]O exige que auth\.uid\(\) seja administrador/);
    expect(sql).toContain("auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM p_user_id");
    expect(sql).toMatch(/MODELO DE AUTENTICA[ÇC][ÃA]O ESCOLHIDO: Modelo B/);
  });

  it('rejects when the resolved plan is not exactly plan_code = \'trial\', has no real assignment, or the user is not access_allowed', () => {
    expect(fnBody).toMatch(/NOT v_plan\.access_allowed/);
    expect(fnBody).toMatch(/v_plan\.plan_code IS DISTINCT FROM 'trial'/);
    expect(fnBody).toMatch(/v_plan\.assignment_id IS NULL/);
    expect(fnBody).toMatch(/v_plan\.starts_at IS NULL/);
    expect(fnBody).toMatch(/'no_active_trial'/);
  });

  it('resolves trial_total/trial_total.unlimited from plan_capability_values using the SERVER-resolved plan_version_id, never a caller-supplied number', () => {
    expect(fnBody).toMatch(/WHERE plan_version_id = v_plan\.plan_version_id AND capability_key = 'conversation\.realtime\.seconds\.trial_total'/);
    expect(fnBody).toMatch(/WHERE plan_version_id = v_plan\.plan_version_id AND capability_key = 'conversation\.realtime\.seconds\.trial_total\.unlimited'/);
  });

  it('rejects (never fails open to unlimited) when trial_total is missing and unlimited is not explicitly true', () => {
    expect(fnBody).toMatch(/IF NOT v_unlimited AND v_base_value IS NULL THEN/);
  });

  it('serializes via an advisory lock keyed on the user id', () => {
    expect(fnBody).toMatch(/pg_advisory_xact_lock\(hashtext\('trial_conversation_balance'\), hashtext\(p_user_id::text\)\)/);
  });

  it('trial expirado é rejeitado — admin_resolve_effective_plan_v1 nunca retorna um assignment_id para uma janela cujo ends_at já passou, então cai no branch no_active_trial', () => {
    expect(fnBody).toMatch(/v_plan\.assignment_id IS NULL/);
    expect(fnBody).toContain("RETURN QUERY SELECT NULL::uuid, 0, true, 'no_active_trial'::text;");
  });

  it('counts a still-authorized row by its live elapsed time clamped to authorized_max_seconds, and a completed row by duration_seconds', () => {
    expect(fnBody).toMatch(/WHEN status = 'completed' THEN COALESCE\(duration_seconds, 0\)/);
    expect(fnBody).toMatch(/LEAST\(GREATEST\(EXTRACT\(EPOCH FROM \(now\(\) - authorized_at\)\), 0\), authorized_max_seconds\)/);
  });

  it('never returns a negative remaining balance', () => {
    expect(fnBody).toContain('v_remaining := GREATEST(v_trial_total - v_consumed, 0);');
  });

  it('caps the authorized ceiling at the smaller of requested and remaining, and blocks (no insert) when remaining is exhausted', () => {
    expect(fnBody).toContain('v_authorized := LEAST(p_requested_max_seconds, FLOOR(v_remaining)::integer);');
    expect(fnBody).toMatch(/IF v_remaining <= 0 THEN\s*\n\s*RETURN QUERY SELECT NULL::uuid, 0, true, 'balance_exhausted'::text;/);
  });

  it('the unique index is the final guarantee — a unique_violation on insert is caught and returns the winning row instead of erroring', () => {
    expect(fnBody).toMatch(/EXCEPTION WHEN unique_violation THEN/);
  });

  it('inserts exactly one authorization row per genuinely new attempt, attaching the caller-supplied gateway ids, the idempotency key, and the resolved assignment_id', () => {
    expect(fnBody).toMatch(/INSERT INTO public\.conversation_session_authorizations \(\s*\n\s*user_id, session_date, authorized_max_seconds,\s*\n\s*gateway_budget_reservation_id, gateway_session_id, idempotency_key, assignment_id/);
    expect(fnBody).toMatch(/p_gateway_budget_reservation_id, p_gateway_session_id, p_idempotency_key, v_plan\.assignment_id/);
  });

  it('is revoked from PUBLIC/anon/authenticated and only executable by postgres/service_role (called from trusted backend code, like reserve_gateway_usage_v1)', () => {
    const sig = 'public.authorize_trial_conversation_session_v1(uuid, integer, date, uuid, uuid, text)';
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC;`);
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM anon;`);
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM authenticated;`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO postgres;`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role;`);
  });
});
