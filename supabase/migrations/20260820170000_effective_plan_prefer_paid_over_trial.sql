-- Effective-plan resolution: a paid/manual assignment must outrank the signup
-- trial, regardless of which one STARTED later.
--
-- Bug (observed in production, account review2@orodim.com.br on 2026-08-21):
-- the function picked the valid assignment with the LATEST starts_at:
--
--     ORDER BY upa.starts_at DESC
--
-- The signup trial always starts at account-creation time (= "now"), so any
-- subscription whose starts_at is EARLIER than the account itself loses to it.
-- That is exactly the restore/transfer case: a user reinstalls the app, creates
-- a new account and restores an Apple/Google subscription purchased days
-- earlier. RevenueCat reconciles it into user_plan_assignments with its real
-- (older) purchase date, the trial row wins the ORDER BY, and the paid user is
-- served TRIAL capabilities — "Assine um plano para comprar minutos" while the
-- subscription screen (which also reads the store) correctly shows the paid
-- plan. Three surfaces, three answers, from one bad tiebreak.
--
-- Fix: demote origin='trial' below every other origin ('subscription',
-- 'manual'), keeping starts_at DESC as the tiebreak WITHIN each group. This is
-- deliberately the minimal change:
--   * A trial-only user still resolves to the trial (nothing else matches).
--   * An expired subscription still loses (filtered out by the ends_at guard
--     BEFORE ordering), so the trial correctly wins again after expiry.
--   * Buying while on trial already worked (purchase starts_at = now > trial)
--     and keeps working — this only adds the case where it starts earlier.
--   * The relative order of 'subscription' vs 'manual' is UNCHANGED (both are
--     rank 0, still decided by starts_at DESC), so internal/admin grants keep
--     behaving exactly as before.
--
-- Everything else about the function (signature, SECURITY DEFINER, the
-- search_path pin, the auth.uid() cross-user guard from Etapa 13, version
-- resolution and the is_default fallback) is preserved verbatim.

CREATE OR REPLACE FUNCTION public.admin_resolve_effective_plan_v1(
  p_user_id uuid,
  p_at timestamp with time zone DEFAULT now()
)
RETURNS TABLE(
  user_id uuid, access_allowed boolean, plan_id uuid, plan_code text,
  plan_name text, plan_version_id uuid, version_number integer,
  assignment_origin text, assignment_id uuid,
  starts_at timestamp with time zone, ends_at timestamp with time zone,
  is_suspended boolean, version_policy text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_is_suspended BOOLEAN := FALSE;
  v_assignment RECORD;
  v_default_plan RECORD;
  v_version_id UUID;
  v_version_num INTEGER;
BEGIN
  -- SECURITY FIX (Etapa 13): block cross-user reads from a real end-user
  -- session. auth.uid() is NULL for the service-role client (always passes)
  -- and equals the caller's own id for an authenticated session (only "self"
  -- passes) — see comment above the function for the full rationale.
  IF auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- Check suspension
  SELECT uac.is_suspended INTO v_is_suspended
  FROM user_access_controls uac
  WHERE uac.user_id = p_user_id;
  IF NOT FOUND THEN v_is_suspended := FALSE; END IF;

  -- Find active explicit assignment at p_at.
  -- A paid/manual assignment outranks the signup trial even when the trial
  -- started later (restore/transfer case — see the header comment).
  SELECT upa.id, upa.plan_id, upa.version_policy, upa.pinned_version_id,
         upa.origin, upa.starts_at, upa.ends_at,
         p.code AS plan_code_val, p.name AS plan_name_val
  INTO v_assignment
  FROM user_plan_assignments upa
  JOIN plans p ON p.id = upa.plan_id
  WHERE upa.user_id = p_user_id
  AND upa.status IN ('active', 'scheduled')
  AND upa.starts_at <= p_at
  AND (upa.ends_at IS NULL OR upa.ends_at > p_at)
  ORDER BY (CASE WHEN upa.origin = 'trial' THEN 1 ELSE 0 END) ASC,
           upa.starts_at DESC
  LIMIT 1;

  IF FOUND THEN
    -- Resolve version
    IF v_assignment.version_policy = 'pinned_version' THEN
      SELECT pv.id, pv.version_number INTO v_version_id, v_version_num
      FROM plan_versions pv
      WHERE pv.id = v_assignment.pinned_version_id AND pv.status = 'published';
    ELSE
      SELECT pv.id, pv.version_number INTO v_version_id, v_version_num
      FROM plan_versions pv
      WHERE pv.plan_id = v_assignment.plan_id AND pv.status = 'published' AND pv.effective_to IS NULL;
    END IF;

    RETURN QUERY SELECT
      p_user_id,
      NOT v_is_suspended,
      v_assignment.plan_id,
      v_assignment.plan_code_val,
      v_assignment.plan_name_val,
      v_version_id,
      v_version_num,
      v_assignment.origin::TEXT,
      v_assignment.id,
      v_assignment.starts_at,
      v_assignment.ends_at,
      v_is_suspended,
      v_assignment.version_policy;
    RETURN;
  END IF;

  -- Fallback: default active plan
  SELECT p.id, p.code, p.name INTO v_default_plan
  FROM plans p
  WHERE p.is_default = TRUE AND p.status = 'active'
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      p_user_id, NOT v_is_suspended,
      NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::UUID, NULL::INTEGER,
      'default'::TEXT, NULL::UUID, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ,
      v_is_suspended, NULL::TEXT;
    RETURN;
  END IF;

  SELECT pv.id, pv.version_number INTO v_version_id, v_version_num
  FROM plan_versions pv
  WHERE pv.plan_id = v_default_plan.id AND pv.status = 'published' AND pv.effective_to IS NULL;

  RETURN QUERY SELECT
    p_user_id, NOT v_is_suspended,
    v_default_plan.id, v_default_plan.code, v_default_plan.name,
    v_version_id, v_version_num,
    'default'::TEXT, NULL::UUID, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ,
    v_is_suspended, 'follow_current_published'::TEXT;
END;
$function$;
