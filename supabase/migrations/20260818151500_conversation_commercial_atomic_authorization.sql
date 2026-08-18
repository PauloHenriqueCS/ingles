-- ============================================================================
-- Security hardening — commercial (monthly) conversation sessions must reserve
-- the balance ATOMICALLY, exactly like the trial path already does.
--
-- Root cause (TOCTOU): a commercial-plan session start read
-- entitlements.conversation.monthlyTime.canStart (a point-in-time snapshot),
-- created the paid OpenAI Realtime session, and only THEN inserted the
-- authorization row. Nothing serialized concurrent starts, so a user with a
-- small remaining balance could fire N simultaneous /conversation/session
-- requests, all observe the same balance, all mint a paid ephemeral token, and
-- consume N× the entitlement.
--
-- Fix: this function is the commercial twin of
-- authorize_trial_conversation_session_v1 — SERVICE-ROLE-ONLY, takes a per-user
-- advisory lock, and — critically — RESERVES the full authorized_max_seconds of
-- every still-open ('authorized') row (never just its live-elapsed time). A
-- second concurrent request therefore sees the first one's entire reservation
-- and can never, together, be authorized for more than the real remaining
-- balance.
--
-- Identity + assignment scope (for idempotency) and the non-trial guard are
-- re-derived server-side (admin_resolve_effective_plan_v1), never trusted from
-- the caller. The EFFECTIVE monthly allowance (p_plan_limit_seconds /
-- p_plan_unlimited) and available purchased credits (p_extra_credits_seconds)
-- are supplied by the trusted server route, which already resolves them from
-- getCurrentUserPlanEntitlements INCLUDING user_capability_overrides — so an
-- admin override that grants extra minutes is honored (reading the raw plan
-- capability here would silently ignore overrides). This is safe because the
-- function is service_role-only: no client can ever call it or supply these.
-- Balance math mirrors computeFeatureState EXACTLY:
--   base = max(p_plan_limit_seconds - reserved - consumed, 0);
--   remaining = base + extra_credits   (never double-counts over-plan usage).
-- The monthly window is the calendar UTC month bounded by session_date,
-- matching utcMonthRange() in plan-entitlements-service.ts.
--
-- The route calls this via the service-role client BEFORE reserving budget and
-- before the OpenAI call, and DELETEs the row if the OpenAI call fails — same
-- lifecycle as the trial path. Idempotent: CREATE OR REPLACE + re-lock grants.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.authorize_commercial_conversation_session_v1(
  p_user_id uuid,
  p_requested_max_seconds integer,
  p_session_date date,
  p_plan_limit_seconds integer,
  p_plan_unlimited boolean,
  p_extra_credits_seconds integer,
  p_idempotency_key text
) RETURNS TABLE(authorization_id uuid, authorized_max_seconds integer, blocked boolean, blocked_reason text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_existing_id     uuid;
  v_existing_max    integer;
  v_plan            RECORD;
  v_reserved        numeric;
  v_consumed        numeric;
  v_extra           numeric;
  v_base_remaining  numeric;
  v_remaining       numeric;
  v_authorized      integer;
  v_month_start     date;
  v_month_end       date;
  v_id              uuid;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'user_id is required'; END IF;
  IF p_session_date IS NULL THEN RAISE EXCEPTION 'session_date is required'; END IF;
  IF p_idempotency_key IS NULL OR char_length(p_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'idempotency_key is required';
  END IF;

  -- Server-side re-derivation of the CURRENT effective plan for identity +
  -- assignment scope + the non-trial guard. This function must NEVER authorize
  -- a trial balance (that is authorize_trial_conversation_session_v1's job).
  SELECT * INTO v_plan FROM public.admin_resolve_effective_plan_v1(p_user_id, now());

  IF NOT FOUND
     OR NOT v_plan.access_allowed
     OR v_plan.plan_version_id IS NULL
     OR v_plan.plan_code IS NOT DISTINCT FROM 'trial'
  THEN
    RETURN QUERY SELECT NULL::uuid, 0, true, 'no_active_plan'::text;
    RETURN;
  END IF;

  -- Idempotency (outside the lock): a genuine repeat of an already-decided
  -- attempt for the SAME user + CURRENT assignment + key returns the same row.
  SELECT csa.id, csa.authorized_max_seconds INTO v_existing_id, v_existing_max
  FROM public.conversation_session_authorizations csa
  WHERE csa.user_id = p_user_id
    AND csa.assignment_id IS NOT DISTINCT FROM v_plan.assignment_id
    AND csa.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN QUERY SELECT v_existing_id, v_existing_max, false, NULL::text;
    RETURN;
  END IF;

  IF p_requested_max_seconds IS NULL OR p_requested_max_seconds <= 0 THEN
    RETURN QUERY SELECT NULL::uuid, 0, true, 'invalid_request'::text;
    RETURN;
  END IF;

  -- Serialize concurrent authorization attempts for the SAME user. Combined
  -- with the full-ceiling reservation below, this guarantees two concurrent
  -- sessions can never together be authorized beyond the real remaining balance.
  PERFORM pg_advisory_xact_lock(hashtext('commercial_conversation_balance'), hashtext(p_user_id::text));

  -- Re-check idempotency INSIDE the lock.
  SELECT csa.id, csa.authorized_max_seconds INTO v_existing_id, v_existing_max
  FROM public.conversation_session_authorizations csa
  WHERE csa.user_id = p_user_id
    AND csa.assignment_id IS NOT DISTINCT FROM v_plan.assignment_id
    AND csa.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN QUERY SELECT v_existing_id, v_existing_max, false, NULL::text;
    RETURN;
  END IF;

  IF COALESCE(p_plan_unlimited, false) THEN
    BEGIN
      INSERT INTO public.conversation_session_authorizations (
        user_id, session_date, authorized_max_seconds, idempotency_key, assignment_id
      ) VALUES (
        p_user_id, p_session_date, p_requested_max_seconds, p_idempotency_key, v_plan.assignment_id
      )
      RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
      SELECT csa.id, csa.authorized_max_seconds INTO v_id, v_authorized
      FROM public.conversation_session_authorizations csa
      WHERE csa.user_id = p_user_id AND csa.assignment_id IS NOT DISTINCT FROM v_plan.assignment_id
        AND csa.idempotency_key = p_idempotency_key;
      RETURN QUERY SELECT v_id, v_authorized, false, NULL::text;
      RETURN;
    END;
    RETURN QUERY SELECT v_id, p_requested_max_seconds, false, NULL::text;
    RETURN;
  END IF;

  -- Calendar UTC month by session_date — matches utcMonthRange(now) used by the
  -- entitlements service's consumed query.
  v_month_start := date_trunc('month', (now() AT TIME ZONE 'utc'))::date;
  v_month_end   := (date_trunc('month', (now() AT TIME ZONE 'utc')) + interval '1 month')::date;

  -- Reserve the FULL authorized_max_seconds of open rows (never live-elapsed) +
  -- real duration of completed rows, within the month window.
  SELECT
    COALESCE(SUM(csa.authorized_max_seconds) FILTER (WHERE csa.status = 'authorized'), 0),
    COALESCE(SUM(csa.duration_seconds) FILTER (WHERE csa.status = 'completed'), 0)
  INTO v_reserved, v_consumed
  FROM public.conversation_session_authorizations csa
  WHERE csa.user_id = p_user_id
    AND csa.session_date >= v_month_start
    AND csa.session_date < v_month_end;

  v_extra := GREATEST(COALESCE(p_extra_credits_seconds, 0), 0);

  -- computeFeatureState: base first, then extra (never summed against over-plan).
  v_base_remaining := GREATEST(COALESCE(p_plan_limit_seconds, 0) - v_reserved - v_consumed, 0);
  v_remaining := v_base_remaining + v_extra;

  IF v_remaining <= 0 THEN
    RETURN QUERY SELECT NULL::uuid, 0, true, 'monthly_limit_reached'::text;
    RETURN;
  END IF;

  v_authorized := LEAST(p_requested_max_seconds, FLOOR(v_remaining)::integer);
  IF v_authorized <= 0 THEN
    RETURN QUERY SELECT NULL::uuid, 0, true, 'monthly_limit_reached'::text;
    RETURN;
  END IF;

  BEGIN
    INSERT INTO public.conversation_session_authorizations (
      user_id, session_date, authorized_max_seconds, idempotency_key, assignment_id
    ) VALUES (
      p_user_id, p_session_date, v_authorized, p_idempotency_key, v_plan.assignment_id
    )
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT csa.id, csa.authorized_max_seconds INTO v_id, v_authorized
    FROM public.conversation_session_authorizations csa
    WHERE csa.user_id = p_user_id AND csa.assignment_id IS NOT DISTINCT FROM v_plan.assignment_id
      AND csa.idempotency_key = p_idempotency_key;
    RETURN QUERY SELECT v_id, v_authorized, false, NULL::text;
    RETURN;
  END;

  RETURN QUERY SELECT v_id, v_authorized, false, NULL::text;
END;
$function$;

REVOKE ALL ON FUNCTION public.authorize_commercial_conversation_session_v1(uuid, integer, date, integer, boolean, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.authorize_commercial_conversation_session_v1(uuid, integer, date, integer, boolean, integer, text) TO service_role;
