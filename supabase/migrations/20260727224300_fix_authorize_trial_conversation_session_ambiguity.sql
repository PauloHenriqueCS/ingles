-- =============================================================================
-- MIGRATION: 20260727224300_fix_authorize_trial_conversation_session_ambiguity
-- Projeto: Lemon
--
-- CORREÇÃO MÍNIMA (Etapa 2B — bug real encontrado na validação em Postgres
-- de lemon-homolog, logo após aplicar 20260727224200). Não altera a
-- migration já aplicada — apenas substitui a versão vigente da função via
-- CREATE OR REPLACE FUNCTION, mesma assinatura, mesmo retorno, mesma
-- lógica, mesmos grants, SECURITY DEFINER e search_path.
--
-- BUG: RETURNS TABLE(authorization_id uuid, authorized_max_seconds integer,
-- blocked boolean, blocked_reason text) cria implicitamente uma variável de
-- saída chamada authorized_max_seconds. Toda referência NÃO qualificada a
-- authorized_max_seconds dentro do corpo da função colide com essa variável
-- de saída E com a coluna real conversation_session_authorizations.
-- authorized_max_seconds — Postgres não consegue decidir qual das duas é a
-- pretendida (ERROR 42702: column reference "authorized_max_seconds" is
-- ambiguous), fazendo TODA chamada da função falhar. Confirmado ao vivo
-- contra lemon-homolog (primeiro cenário da validação real: "trial com 900
-- segundos disponíveis"), nunca detectável pelos testes estáticos (análise
-- de texto, sem Postgres real).
--
-- Mesma classe de bug já corrigida três vezes antes neste projeto, para
-- outras funções RETURNS TABLE — ver
-- supabase/migrations_legacy/20260718020000_ai_gateway_enforcement_function_ambiguity_fix.sql
-- (begin_gateway_idempotent_op_v1, saída "result_ref"; reserve_gateway_usage_v1,
-- saída "status") e
-- supabase/migrations_legacy/20260718030000_ai_gateway_enforcement_budget_conflict_ambiguity_fix.sql.
--
-- REVISÃO DE COLISÕES (item 4 da autorização): conferidas TODAS as saídas de
-- RETURNS TABLE (authorization_id, authorized_max_seconds, blocked,
-- blocked_reason), todos os parâmetros (todos com prefixo p_, portanto
-- nunca colidem com nomes de coluna sem prefixo) e todas as colunas de
-- conversation_session_authorizations (id, user_id, session_date,
-- authorized_at, authorized_max_seconds, status, completed_at,
-- duration_seconds, created_at, gateway_budget_reservation_id,
-- gateway_session_id, idempotency_key, assignment_id) contra as variáveis
-- DECLARE (todas com prefixo v_, também nunca colidem). ÚNICA colisão real:
-- authorized_max_seconds (saída) vs conversation_session_authorizations.
-- authorized_max_seconds (coluna) — a mesma string exata nos dois lugares.
-- Nenhuma outra coluna colide.
--
-- CORREÇÃO: alias explícito "csa" em toda consulta a
-- conversation_session_authorizations dentro do corpo da função, com
-- authorized_max_seconds (e as demais colunas lidas na mesma consulta)
-- sempre qualificados como csa.<coluna>. As 5 ocorrências corrigidas:
--   1. busca de idempotência pré-lock;
--   2. busca de idempotência pós-lock;
--   3. fallback de unique_violation no branch "unlimited";
--   4. soma de consumo (CASE ... csa.authorized_max_seconds ...) — uma
--      5ª ocorrência que não tinha sido citada no diagnóstico original,
--      encontrada nesta revisão completa;
--   5. fallback de unique_violation no branch final (saldo finito).
-- As listas de colunas dos dois INSERT INTO permanecem sem alias — nesse
-- contexto (lista de colunas-alvo de INSERT) a referência nunca é ambígua,
-- então qualificá-las seria só ruído.
--
-- Nenhuma mudança de lógica, comportamento, contrato de retorno,
-- assinatura, grants ou qualquer outro aspecto da função — puramente
-- sintática.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.authorize_trial_conversation_session_v1(
  p_user_id uuid,
  p_requested_max_seconds integer,
  p_session_date date,
  p_gateway_budget_reservation_id uuid,
  p_gateway_session_id uuid,
  p_idempotency_key text
)
RETURNS TABLE(authorization_id uuid, authorized_max_seconds integer, blocked boolean, blocked_reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_existing_id  uuid;
  v_existing_max integer;
  v_plan         RECORD;
  v_base_value   jsonb;
  v_unlimited_value jsonb;
  v_unlimited    boolean;
  v_trial_total  numeric;
  v_consumed     numeric;
  v_remaining    numeric;
  v_authorized   integer;
  v_id           uuid;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required';
  END IF;
  IF p_session_date IS NULL THEN
    RAISE EXCEPTION 'session_date is required';
  END IF;
  IF p_idempotency_key IS NULL OR char_length(p_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'idempotency_key is required';
  END IF;

  -- Server-side re-derivation of the CURRENT effective plan/assignment for
  -- p_user_id — never trusts a caller-supplied assignment_id, window, or
  -- trial total. Reuses the exact canonical resolver every other
  -- entitlement read in this app already uses (see 20260727224200's
  -- "AUDITORIA DO MODELO DE AUTENTICAÇÃO" comment for why calling it here,
  -- via the service-role context this function always runs in, is safe).
  -- Resolved BEFORE any idempotency lookup: the lookup itself needs the
  -- CURRENT assignment_id to scope correctly.
  SELECT * INTO v_plan FROM public.admin_resolve_effective_plan_v1(p_user_id, now());

  IF NOT FOUND
     OR NOT v_plan.access_allowed
     OR v_plan.plan_code IS DISTINCT FROM 'trial'
     OR v_plan.assignment_id IS NULL
     OR v_plan.starts_at IS NULL
     OR v_plan.plan_version_id IS NULL
  THEN
    -- Covers, uniformly: no resolvable plan; suspended user; resolved to
    -- any OTHER plan (this function must never authorize a commercial
    -- balance); the trial-coded plan reached via the default/fallback plan
    -- with no real assignment (assignment_id/starts_at null). An EXPIRED
    -- trial assignment also lands here: admin_resolve_effective_plan_v1's
    -- own WHERE clause already requires
    -- starts_at <= now() < COALESCE(ends_at, infinity) for an
    -- assignment-backed row, so an expired assignment is never returned by
    -- it at all — there is no separate "expired" branch to forget. An old
    -- authorization tied to a now-replaced/expired assignment is therefore
    -- never reachable via any idempotency lookup below either, since none
    -- of them ever run with a stale assignment_id.
    RETURN QUERY SELECT NULL::uuid, 0, true, 'no_active_trial'::text;
    RETURN;
  END IF;

  -- Idempotency — outside the lock, cheap early return for the common case
  -- (a genuine repeat of an already-decided attempt for the SAME user AND
  -- the SAME currently-active assignment). A row tied to a DIFFERENT
  -- assignment_id (including an older, now-replaced trial assignment) is
  -- structurally excluded by this filter — it is never reused, matching
  -- "mesma chave e mesmo usuário, mas assignment diferente → não reutiliza
  -- a autorização anterior". Table alias "csa" qualifies every column read
  -- here, including authorized_max_seconds — otherwise ambiguous against
  -- this function's own RETURNS TABLE output of the same name (see header).
  SELECT csa.id, csa.authorized_max_seconds INTO v_existing_id, v_existing_max
  FROM public.conversation_session_authorizations csa
  WHERE csa.user_id = p_user_id AND csa.assignment_id = v_plan.assignment_id AND csa.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN QUERY SELECT v_existing_id, v_existing_max, false, NULL::text;
    RETURN;
  END IF;

  IF p_requested_max_seconds IS NULL OR p_requested_max_seconds <= 0 THEN
    RETURN QUERY SELECT NULL::uuid, 0, true, 'invalid_request'::text;
    RETURN;
  END IF;

  -- Serializes concurrent authorization attempts for the SAME user. A user
  -- can have at most one active/scheduled assignment at a time (enforced by
  -- admin_assign_plan_v1's own overlap check in ingles-dashboad), so locking
  -- by user_id is equivalent to locking by assignment.
  PERFORM pg_advisory_xact_lock(hashtext('trial_conversation_balance'), hashtext(p_user_id::text));

  -- Re-check idempotency INSIDE the lock (same composite scope: user_id +
  -- CURRENT assignment_id + key): a second concurrent call with the SAME
  -- key for the SAME user AND assignment that arrived between the check
  -- above and acquiring the lock must still be caught here, never
  -- double-inserted.
  SELECT csa.id, csa.authorized_max_seconds INTO v_existing_id, v_existing_max
  FROM public.conversation_session_authorizations csa
  WHERE csa.user_id = p_user_id AND csa.assignment_id = v_plan.assignment_id AND csa.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN QUERY SELECT v_existing_id, v_existing_max, false, NULL::text;
    RETURN;
  END IF;

  -- Resolve trial_total/trial_total.unlimited SERVER-SIDE from the resolved
  -- plan_version — never a number computed by the TypeScript caller.
  SELECT value INTO v_base_value FROM public.plan_capability_values
  WHERE plan_version_id = v_plan.plan_version_id AND capability_key = 'conversation.realtime.seconds.trial_total';
  SELECT value INTO v_unlimited_value FROM public.plan_capability_values
  WHERE plan_version_id = v_plan.plan_version_id AND capability_key = 'conversation.realtime.seconds.trial_total.unlimited';

  v_unlimited := COALESCE(v_unlimited_value = 'true'::jsonb, false);

  IF NOT v_unlimited AND v_base_value IS NULL THEN
    -- Missing configuration on an already-published trial version is a
    -- config bug (publish_plan_version's own completeness check should
    -- have refused to publish it) — never silently treated as unlimited,
    -- never a fallback to the monthly pair.
    RETURN QUERY SELECT NULL::uuid, 0, true, 'no_active_trial'::text;
    RETURN;
  END IF;

  IF v_unlimited THEN
    -- Nothing to protect on the seconds dimension — authorize the
    -- requested ceiling outright (the technical/per-turn ceilings are
    -- still enforced by the caller; this function only guards the
    -- lifetime SECONDS balance).
    BEGIN
      INSERT INTO public.conversation_session_authorizations (
        user_id, session_date, authorized_max_seconds,
        gateway_budget_reservation_id, gateway_session_id, idempotency_key, assignment_id
      ) VALUES (
        p_user_id, p_session_date, p_requested_max_seconds,
        p_gateway_budget_reservation_id, p_gateway_session_id, p_idempotency_key, v_plan.assignment_id
      )
      RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
      SELECT csa.id, csa.authorized_max_seconds INTO v_id, v_authorized
      FROM public.conversation_session_authorizations csa
      WHERE csa.user_id = p_user_id AND csa.assignment_id = v_plan.assignment_id AND csa.idempotency_key = p_idempotency_key;
      RETURN QUERY SELECT v_id, v_authorized, false, NULL::text;
      RETURN;
    END;
    RETURN QUERY SELECT v_id, p_requested_max_seconds, false, NULL::text;
    RETURN;
  END IF;

  v_trial_total := (v_base_value)::text::numeric;

  -- Same accounting rule as plan-entitlements-service.ts's
  -- conversationSecondsConsumed: a completed row counts its recorded
  -- duration; a still-'authorized' (in-progress) row counts its live
  -- elapsed time, clamped to what it was authorized for — so a
  -- currently-running session correctly reduces what a NEW request may
  -- start with, even before it reports its own completion. Bounded by the
  -- SERVER-resolved assignment window, never a caller-supplied one — an
  -- authorization from a DIFFERENT (older) assignment can never contribute
  -- to this sum either, since its authorized_at necessarily falls outside
  -- [v_plan.starts_at, v_plan.ends_at) for the CURRENT assignment. Table
  -- alias "csa" qualifies csa.authorized_max_seconds here too — this was
  -- the 5th, previously-unlisted occurrence of the same ambiguity.
  SELECT COALESCE(SUM(
    CASE
      WHEN csa.status = 'completed' THEN COALESCE(csa.duration_seconds, 0)
      ELSE LEAST(GREATEST(EXTRACT(EPOCH FROM (now() - csa.authorized_at)), 0), csa.authorized_max_seconds)
    END
  ), 0)
  INTO v_consumed
  FROM public.conversation_session_authorizations csa
  WHERE csa.user_id = p_user_id
    AND csa.authorized_at >= v_plan.starts_at
    AND csa.authorized_at < COALESCE(v_plan.ends_at, 'infinity'::timestamptz);

  v_remaining := GREATEST(v_trial_total - v_consumed, 0);

  IF v_remaining <= 0 THEN
    RETURN QUERY SELECT NULL::uuid, 0, true, 'balance_exhausted'::text;
    RETURN;
  END IF;

  v_authorized := LEAST(p_requested_max_seconds, FLOOR(v_remaining)::integer);
  IF v_authorized <= 0 THEN
    RETURN QUERY SELECT NULL::uuid, 0, true, 'balance_exhausted'::text;
    RETURN;
  END IF;

  BEGIN
    INSERT INTO public.conversation_session_authorizations (
      user_id, session_date, authorized_max_seconds,
      gateway_budget_reservation_id, gateway_session_id, idempotency_key, assignment_id
    ) VALUES (
      p_user_id, p_session_date, v_authorized,
      p_gateway_budget_reservation_id, p_gateway_session_id, p_idempotency_key, v_plan.assignment_id
    )
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    -- The same (user_id, assignment_id, idempotency_key) raced in between
    -- the check above and this INSERT (structurally prevented by the
    -- advisory lock in normal operation — the unique index is the final,
    -- unconditional guarantee regardless) — return the row that won
    -- instead of erroring.
    SELECT csa.id, csa.authorized_max_seconds INTO v_id, v_authorized
    FROM public.conversation_session_authorizations csa
    WHERE csa.user_id = p_user_id AND csa.assignment_id = v_plan.assignment_id AND csa.idempotency_key = p_idempotency_key;
    RETURN QUERY SELECT v_id, v_authorized, false, NULL::text;
    RETURN;
  END;

  RETURN QUERY SELECT v_id, v_authorized, false, NULL::text;
END;
$function$;

REVOKE ALL ON FUNCTION public.authorize_trial_conversation_session_v1(uuid, integer, date, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.authorize_trial_conversation_session_v1(uuid, integer, date, uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.authorize_trial_conversation_session_v1(uuid, integer, date, uuid, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.authorize_trial_conversation_session_v1(uuid, integer, date, uuid, uuid, text) TO postgres;
GRANT EXECUTE ON FUNCTION public.authorize_trial_conversation_session_v1(uuid, integer, date, uuid, uuid, text) TO service_role;
