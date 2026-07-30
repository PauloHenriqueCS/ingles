-- =============================================================================
-- MIGRATION: 20260727224400_fix_authorize_trial_conversation_session_reservation_accounting
-- Projeto: Lemon
--
-- CORREÇÃO MÍNIMA (Etapa 2B — segundo bug real encontrado, desta vez na
-- validação de CONCORRÊNCIA em Postgres real contra lemon-homolog, depois
-- de corrigir a ambiguidade de coluna em 20260727224300). Substitui apenas
-- a função via CREATE OR REPLACE FUNCTION — mesma assinatura, retorno,
-- grants, SECURITY DEFINER, search_path. NENHUMA alteração de schema.
--
-- SCHEMA/CICLO DE VIDA EXAMINADOS ANTES DE ESCREVER ESTA MIGRATION (leitura,
-- nenhuma escrita):
--   * conversation_session_authorizations.status tem
--     CHECK (status = ANY (ARRAY['authorized','completed'])) — só existem
--     esses dois valores hoje, confirmado por
--     `SELECT DISTINCT status FROM conversation_session_authorizations`.
--   * 'authorized' = sessão criada, ainda em andamento (por
--     authorize_trial_conversation_session_v1 para trial, ou INSERT direto
--     em api/conversation/[...slug].ts para planos comerciais).
--   * 'completed' = sessão encerrada, com duration_seconds preenchido — seja
--     via /session-complete (handleSessionComplete, encerramento normal do
--     cliente) ou via o sweep plan-agnostic (handleConversationSweep,
--     api/internal/listening/[...slug].ts), que fecha uma linha 'authorized'
--     abandonada há mais de REALTIME_MAX_SESSION_SECONDS + grace, cobrando
--     o teto completo (duration_seconds = authorized_max_seconds) — decisão
--     de produto pré-existente e deliberada ("safe expiration strategy"),
--     não alterada aqui.
--   * "Expirada, cancelada ou liberada SEM consumo" (requisito 3 desta
--     correção) já tem um mecanismo real e existente: DELETE da linha
--     'authorized' via releaseTrialConversationSessionAuthorization
--     (api/_entitlements/authorize-trial-conversation-session.ts), usado
--     quando a chamada à OpenAI falha antes de qualquer uso real — uma
--     linha deletada contribui zero a qualquer soma, por construção. Nenhum
--     terceiro valor de status foi necessário — o CHECK constraint
--     permanece EXATAMENTE como está (nenhum ALTER TABLE nesta migration).
--
-- BUG: o cálculo de saldo disponível somava, para uma linha ainda
-- 'authorized' (não concluída), apenas o tempo REALMENTE decorrido
-- (LEAST(elapsed, authorized_max_seconds)) — nunca o teto reservado
-- integral. Prova ao vivo (Postgres real, lemon-homolog): com 900s
-- disponíveis, sessão A reservou 600s (às 00:32:02) e permaneceu
-- 'authorized'; ~12s depois, sessão B pediu 600s e TAMBÉM recebeu 600s
-- (porque, aos olhos da fórmula antiga, A só tinha "consumido" ~12s até
-- ali) — soma autorizada de 1200s contra um limite de 900s. O advisory
-- lock já serializa corretamente as duas chamadas (B ficou bloqueada até A
-- commitar — confirmado pelos timestamps), mas a fórmula de saldo em si
-- não reservava o teto completo de uma sessão ainda em andamento.
--
-- CORREÇÃO: separa o cálculo em duas somas, dentro da MESMA janela
-- [assignment.starts_at, assignment.ends_at) já usada:
--   • reservado  = SUM(authorized_max_seconds) WHERE status = 'authorized'
--     (sessão ativa/em andamento — reserva o teto INTEIRO, não o tempo
--     decorrido);
--   • consumido  = SUM(duration_seconds)       WHERE status = 'completed'
--     (sessão concluída — conta somente o que foi realmente gravado,
--     inalterado em relação à versão anterior);
--   • saldo restante = GREATEST(trial_total - reservado - consumido, 0).
-- Qualquer linha com um status FORA desses dois (hoje impossível pelo
-- CHECK constraint, mas também nunca aconteceria por um DELETE, que
-- simplesmente remove a linha) contribui zero automaticamente — satisfaz o
-- requisito "expirada/cancelada/liberada conta zero" por construção, sem
-- precisar de um terceiro status.
--
-- Reaproveita 100% do mecanismo existente (mesma tabela, mesmas colunas,
-- mesmo advisory lock por p_user_id, mesmo /session-complete, mesmo sweep)
-- — nenhuma segunda arquitetura de reservas. Aplicável exclusivamente ao
-- trial: a contabilização mensal comercial
-- (plan-entitlements-service.ts:conversationSecondsConsumed) não é tocada
-- por esta migration — continua usando sua própria fórmula de tempo
-- decorrido para uma linha em andamento, sem nenhuma mudança.
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
  v_reserved     numeric;
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
  -- this function's own RETURNS TABLE output of the same name.
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
  -- by user_id is equivalent to locking by assignment. Combined with the
  -- reservation fix below, this is what guarantees two concurrent sessions
  -- can never together be authorized for more than the real remaining
  -- balance: B's recompute only runs after A's INSERT is visible (A either
  -- committed, releasing the lock, or the whole call errored/rolled back
  -- before ever inserting).
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

  -- RESERVATION FIX (this migration): a still-'authorized' (in-progress)
  -- row now reserves its FULL authorized_max_seconds ceiling — never just
  -- its live elapsed time — so a second concurrent request correctly sees
  -- the first one's entire reservation, not just however many seconds have
  -- ticked by so far. A 'completed' row still counts only its real
  -- duration_seconds (unchanged). Both bounded by the SERVER-resolved
  -- assignment window, never a caller-supplied one — an authorization from
  -- a DIFFERENT (older) assignment can never contribute to either sum
  -- either, since its authorized_at necessarily falls outside
  -- [v_plan.starts_at, v_plan.ends_at) for the CURRENT assignment. A row
  -- with neither status (impossible today — chk_csa_status only allows
  -- 'authorized'/'completed' — and a released-before-completion row is
  -- simply DELETEd, never left in a third state) contributes zero to both
  -- sums by construction — this is what satisfies "expirada/cancelada/
  -- liberada conta zero" without a third status value or second ledger.
  SELECT
    COALESCE(SUM(csa.authorized_max_seconds) FILTER (WHERE csa.status = 'authorized'), 0),
    COALESCE(SUM(csa.duration_seconds) FILTER (WHERE csa.status = 'completed'), 0)
  INTO v_reserved, v_consumed
  FROM public.conversation_session_authorizations csa
  WHERE csa.user_id = p_user_id
    AND csa.authorized_at >= v_plan.starts_at
    AND csa.authorized_at < COALESCE(v_plan.ends_at, 'infinity'::timestamptz);

  v_remaining := GREATEST(v_trial_total - v_reserved - v_consumed, 0);

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
