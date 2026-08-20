-- Writing "Versão 2" (rewrite) one-analysis-per-review guard.
--
-- Problem: V1 review is capped to a single AI analysis by an atomic reservation
-- (writing_review_reservations + reserve/complete/fail_writing_review_reservation),
-- but the V2 rewrite evaluation had NO per-review guard: editing "Sua versão 2"
-- and re-clicking "Comparar versão 2" minted a new attempt (rewrite_sequence
-- MAX+1, unbounded) and ran a fresh AI call every time — unlimited AI calls per
-- review. This mirrors the V1 pattern for V2, keyed by review_id: at most ONE
-- completed V2 evaluation per (user_id, review_id), idempotent against
-- double-click / concurrent / retry / reload / multi-device, with a genuine
-- failure releasing the reservation so the user can retry.
--
-- All functions are SECURITY DEFINER and service_role-only (callers pass the
-- authenticated p_user_id explicitly), consistent with the 2026-08-18 quota-RPC
-- hardening. The advisory lock serializes a user's concurrent reserve calls; the
-- UNIQUE (user_id, review_id) constraint is the durable one-per-review guarantee.

CREATE TABLE IF NOT EXISTS public.writing_rewrite_reservations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  review_id  uuid NOT NULL,
  status     text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, review_id)
);

-- Service-role-only table (like writing_review_reservations): RLS on, no
-- policies, so only the service role (which bypasses RLS) ever reads/writes it.
ALTER TABLE public.writing_rewrite_reservations ENABLE ROW LEVEL SECURITY;

-- ── reserve: the authoritative one-V2-per-review gate ────────────────────────
CREATE OR REPLACE FUNCTION public.reserve_writing_rewrite(
  p_user_id uuid, p_review_id uuid
) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_id     uuid;
  v_status text;
  v_found  boolean;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;
  IF p_review_id IS NULL THEN
    RETURN jsonb_build_object('error', 'INVALID_REVIEW_ID');
  END IF;

  -- Serialize this user's concurrent reserve calls so a double-click can never
  -- pass the "no reservation yet" check twice.
  PERFORM pg_advisory_xact_lock(hashtext('writing_rewrite'), hashtext(p_user_id::text));

  SELECT id, status
  INTO   v_id, v_status
  FROM   writing_rewrite_reservations
  WHERE  user_id = p_user_id AND review_id = p_review_id
  FOR UPDATE;
  v_found := FOUND;

  -- Already analyzed once → caller replays the stored evaluation, never the AI.
  IF v_found AND v_status = 'completed' THEN
    RETURN jsonb_build_object('status', 'already_evaluated', 'reservationId', v_id, 'fresh', false);
  END IF;
  -- Another evaluation for this review is in flight → caller returns 409.
  IF v_found AND v_status = 'reserved' THEN
    RETURN jsonb_build_object('status', 'in_progress', 'reservationId', v_id, 'fresh', false);
  END IF;

  INSERT INTO writing_rewrite_reservations (user_id, review_id, status)
  VALUES (p_user_id, p_review_id, 'reserved')
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('status', 'reserved', 'reservationId', v_id, 'fresh', true);
END;
$function$;

-- ── complete: mark the single evaluation consumed ────────────────────────────
CREATE OR REPLACE FUNCTION public.complete_writing_rewrite_reservation(
  p_user_id uuid, p_review_id uuid
) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE writing_rewrite_reservations
     SET status = 'completed', updated_at = now()
   WHERE user_id = p_user_id AND review_id = p_review_id AND status = 'reserved';
END;
$function$;

-- ── fail/release: a genuine failure frees the slot so retry is allowed ────────
CREATE OR REPLACE FUNCTION public.fail_writing_rewrite_reservation(
  p_user_id uuid, p_review_id uuid
) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  DELETE FROM writing_rewrite_reservations
   WHERE user_id = p_user_id AND review_id = p_review_id AND status = 'reserved';
END;
$function$;

-- Service-role-only execution (callers pass the authenticated p_user_id).
REVOKE ALL ON FUNCTION public.reserve_writing_rewrite(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_writing_rewrite(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.complete_writing_rewrite_reservation(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_writing_rewrite_reservation(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fail_writing_rewrite_reservation(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_writing_rewrite_reservation(uuid, uuid) TO service_role;
