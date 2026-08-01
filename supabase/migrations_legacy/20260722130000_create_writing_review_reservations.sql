-- =============================================================================
-- MIGRATION: 20260722130000_create_writing_review_reservations
-- Projeto: Lemon (english learning app)
--
-- BUG CORRIGIDO: a funcionalidade "Revisão" (api/review-text.ts) checava
-- entitlements.writing.reviews.canStart ANTES de chamar a IA (correto), mas
-- o CONSUMO que alimenta essa checagem (contagem de linhas em
-- english_reviews) nunca era gravado pelo backend -- era gravado pelo
-- FRONTEND, depois da chamada de IA já ter terminado, via um INSERT direto
-- do cliente (src/lib/reviews.ts, saveEnglishReview), completamente
-- desacoplado do request que efetivamente consumiu a IA. Isso quebra a
-- garantia de limite de varias formas:
--   - se o insert do cliente falhar (rede, aba fechada) depois da IA já ter
--     respondido, a revisao foi paga e usada mas NUNCA contada;
--   - nada impede chamar POST /api/review-text repetidamente sem nunca
--     disparar o insert do cliente -- o limite no backend nunca avança;
--   - duas chamadas simultaneas (duplo clique, duas abas) podem ambas passar
--     no check (nenhuma ainda contou) e ambas consumirem IA;
--   - o contador exibido na tela (refetch logo apos a resposta da IA) corre
--     contra o insert assincrono do cliente e pode mostrar um numero errado.
--
-- CORRECAO: consumo passa a ser reservado ATOMICAMENTE no backend, ANTES da
-- chamada de IA (mesmo padrao reserve->complete/fail ja usado por
-- pronunciation_assessments / pronunciation_training_sessions) -- nunca
-- depois, e nunca no cliente. Tabela dedicada (nao reaproveita english_reviews,
-- que continua sendo apenas o historico de revisoes concluidas, com o mesmo
-- formato de sempre -- nenhuma tela de historico precisa mudar) para nao
-- misturar "reserva em andamento" com "revisao publicada no historico".
--
-- reserve_writing_review: chamada pelo backend ANTES de qualquer chamada de
--   IA, com o limit/unlimited ja resolvidos server-side a partir de
--   getCurrentUserPlanEntitlements (nunca um valor vindo do cliente). Conta
--   reservas 'reserved' + 'completed' de HOJE (created_at, o mesmo criterio
--   de "hoje" usado por generated_themes/pronunciation_assessments -- nao
--   mais entry_date, que representa o dia do diario sendo revisado, nao o
--   dia em que a revisao foi de fato consumida). Serializa concorrencia via
--   pg_advisory_xact_lock por usuario -- duas chamadas simultaneas nunca
--   passam ambas quando so resta 1 vaga. attempt_id (gerado pelo cliente,
--   uma vez por clique em "Revisar com IA") e unico por usuario: uma retry
--   da MESMA requisicao (mesmo attempt_id) nunca conta duas vezes.
-- complete_writing_review_reservation: chamada so depois da IA responder e o
--   resultado ser validado e salvo em english_reviews -- transforma a reserva
--   em consumo definitivo.
-- fail_writing_review_reservation: chamada quando a IA falha (timeout,
--   indisponibilidade, resposta invalida apos as tentativas) -- libera a
--   vaga sem contar, satisfazendo "falha da IA sem consumo incorreto".
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.writing_review_reservations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id),
  attempt_id  uuid NOT NULL,
  status      text NOT NULL DEFAULT 'reserved',
  review_id   uuid NULL REFERENCES public.english_reviews(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_wrr_status CHECK (status IN ('reserved', 'completed', 'failed')),
  CONSTRAINT uq_wrr_user_attempt UNIQUE (user_id, attempt_id)
);

COMMENT ON TABLE public.writing_review_reservations IS
  'Ledger de consumo do limite diario de "Revisao" (writing.reviews_per_day) -- nao e historico de conteudo (isso continua em english_reviews, inalterado). Uma linha por tentativa (attempt_id, gerado pelo cliente uma vez por clique). Nunca escrita diretamente por PostgREST; toda mutacao passa por reserve_writing_review / complete_writing_review_reservation / fail_writing_review_reservation, SECURITY DEFINER, auth.uid() validado dentro da funcao.';

CREATE INDEX IF NOT EXISTS idx_wrr_user_created_status
  ON public.writing_review_reservations (user_id, created_at, status);

DROP TRIGGER IF EXISTS trg_wrr_updated_at ON public.writing_review_reservations;
CREATE TRIGGER trg_wrr_updated_at
  BEFORE UPDATE ON public.writing_review_reservations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.writing_review_reservations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wrr_select ON public.writing_review_reservations;
CREATE POLICY wrr_select
  ON public.writing_review_reservations
  FOR SELECT
  TO public
  USING (auth.uid() = user_id);

REVOKE ALL ON public.writing_review_reservations FROM anon;

-- =============================================================================
-- reserve_writing_review — reserva atomica de uma vaga de revisao do dia
-- =============================================================================
CREATE OR REPLACE FUNCTION public.reserve_writing_review(
  p_attempt_id uuid,
  p_unlimited boolean,
  p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id      UUID;
  v_id           UUID;
  v_status       TEXT;
  v_review_id    UUID;
  v_found        BOOLEAN;
  v_today_start  TIMESTAMPTZ;
  v_today_end    TIMESTAMPTZ;
  v_consumed     INTEGER;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  IF p_attempt_id IS NULL THEN
    RETURN jsonb_build_object('error', 'INVALID_ATTEMPT_ID');
  END IF;

  -- Defense-in-depth: a NULL from either parameter must never be read as
  -- "unlimited" / "no cap" — the caller (api/review-text.ts) always sends
  -- real booleans/numbers from the resolved entitlements snapshot, but a
  -- NULL here must fail closed (blocked), never open.
  p_unlimited := coalesce(p_unlimited, false);
  p_limit := coalesce(p_limit, 0);

  -- Lock BEFORE the first read of this attempt's row (not after, and not
  -- only around the count check). Security review finding fixed here: an
  -- earlier version read status/id once before acquiring the lock, then
  -- acted on that value after acquiring it — two truly concurrent retries of
  -- the SAME attempt_id (both starting from a 'failed' row) could both pass
  -- the pre-lock read, and the second to run its post-lock UPDATE would
  -- clobber whatever the first had just done (including resetting an
  -- already-'completed' row back to 'reserved' with review_id wiped to
  -- NULL — a duplicate-completion / lost-consumption bug). Locking first and
  -- reading exactly once, under FOR UPDATE, means every branch below acts on
  -- one consistent, already-serialized snapshot — never a stale one.
  PERFORM pg_advisory_xact_lock(hashtext('writing_review'), hashtext(v_user_id::text));

  SELECT id, status, review_id
  INTO   v_id, v_status, v_review_id
  FROM   writing_review_reservations
  WHERE  user_id = v_user_id AND attempt_id = p_attempt_id
  FOR UPDATE;
  v_found := FOUND;

  -- Idempotent retry of the exact same attempt: never re-count, never call
  -- the AI provider twice. `fresh: false` tells the caller this reservation
  -- pre-existed — it must NOT proceed to call the AI provider itself.
  IF v_found AND v_status = 'completed' THEN
    RETURN jsonb_build_object('status', 'completed', 'reservationId', v_id, 'reviewId', v_review_id, 'fresh', false);
  END IF;
  IF v_found AND v_status = 'reserved' THEN
    -- A request with this exact attempt_id is already in flight (e.g. a
    -- genuine concurrent duplicate submission) — never a second AI call for
    -- the same logical attempt.
    RETURN jsonb_build_object('status', 'in_progress', 'reservationId', v_id, 'fresh', false);
  END IF;
  -- v_found and status = 'failed' (a prior attempt with this exact id was
  -- released) falls through to the normal reservation path below,
  -- re-checking the limit — the row is reused in place (UPDATE) rather than
  -- inserted again, since (user_id, attempt_id) is unique.

  IF NOT p_unlimited THEN
    v_today_start := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    v_today_end   := v_today_start + interval '1 day';

    SELECT count(*) INTO v_consumed
    FROM   writing_review_reservations
    WHERE  user_id = v_user_id
      AND  status IN ('reserved', 'completed')
      AND  created_at >= v_today_start
      AND  created_at < v_today_end;

    IF v_consumed >= p_limit THEN
      RETURN jsonb_build_object('error', 'DAILY_LIMIT_REACHED');
    END IF;
  END IF;

  IF v_found THEN
    -- Reusing a previously-failed reservation for this exact attempt_id.
    UPDATE writing_review_reservations
       SET status = 'reserved', review_id = NULL, updated_at = now()
     WHERE id = v_id;
  ELSE
    INSERT INTO writing_review_reservations (user_id, attempt_id, status)
    VALUES (v_user_id, p_attempt_id, 'reserved')
    RETURNING id INTO v_id;
  END IF;

  RETURN jsonb_build_object('status', 'reserved', 'reservationId', v_id, 'fresh', true);
END;
$$;

-- REVOKE ... FROM PUBLIC alone is not enough in this project: public schema
-- has an ALTER DEFAULT PRIVILEGES rule granting EXECUTE on new functions to
-- anon directly (confirmed via pg_default_acl — the same gap silently exists
-- on the pre-existing pronunciation RPCs this migration's pattern mirrors).
-- REVOKE FROM PUBLIC only removes the implicit PUBLIC-wide grant, not that
-- separate direct grant, so anon must be revoked explicitly. auth.uid() IS
-- NULL inside the function body already stops anon from doing anything even
-- without this, but the grant itself should never have been there.
REVOKE ALL ON FUNCTION public.reserve_writing_review(uuid, boolean, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_writing_review(uuid, boolean, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.reserve_writing_review(uuid, boolean, integer) TO authenticated;

-- =============================================================================
-- complete_writing_review_reservation
-- =============================================================================
CREATE OR REPLACE FUNCTION public.complete_writing_review_reservation(
  p_attempt_id uuid,
  p_review_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id UUID;
  v_id      UUID;
  v_status  TEXT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  SELECT id, status
  INTO   v_id, v_status
  FROM   writing_review_reservations
  WHERE  user_id = v_user_id AND attempt_id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'NOT_FOUND');
  END IF;

  IF v_status = 'completed' THEN
    RETURN jsonb_build_object('action', 'already_completed', 'reservationId', v_id);
  END IF;

  IF v_status <> 'reserved' THEN
    RETURN jsonb_build_object('error', 'RESERVATION_NOT_ACTIVE', 'currentStatus', v_status);
  END IF;

  UPDATE writing_review_reservations
     SET status = 'completed', review_id = p_review_id, updated_at = now()
   WHERE id = v_id;

  RETURN jsonb_build_object('action', 'completed', 'reservationId', v_id);
END;
$$;

REVOKE ALL ON FUNCTION public.complete_writing_review_reservation(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_writing_review_reservation(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.complete_writing_review_reservation(uuid, uuid) TO authenticated;

-- =============================================================================
-- fail_writing_review_reservation — releases the slot without counting it
-- =============================================================================
CREATE OR REPLACE FUNCTION public.fail_writing_review_reservation(
  p_attempt_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id UUID;
  v_id      UUID;
  v_status  TEXT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  SELECT id, status
  INTO   v_id, v_status
  FROM   writing_review_reservations
  WHERE  user_id = v_user_id AND attempt_id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('action', 'no_op', 'reason', 'not_found');
  END IF;

  IF v_status <> 'reserved' THEN
    RETURN jsonb_build_object('action', 'no_op', 'reason', v_status);
  END IF;

  UPDATE writing_review_reservations
     SET status = 'failed', updated_at = now()
   WHERE id = v_id;

  RETURN jsonb_build_object('action', 'failed', 'reservationId', v_id);
END;
$$;

REVOKE ALL ON FUNCTION public.fail_writing_review_reservation(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fail_writing_review_reservation(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fail_writing_review_reservation(uuid) TO authenticated;

-- =============================================================================
-- VALIDACAO INLINE
-- =============================================================================

DO $$
DECLARE
  v_anon BOOLEAN;
BEGIN
  v_anon := has_table_privilege('anon', 'public.writing_review_reservations', 'SELECT,INSERT,UPDATE,DELETE');
  IF v_anon THEN
    RAISE EXCEPTION 'VALIDATION FAILED: anon still holds a table privilege on writing_review_reservations';
  END IF;

  IF has_function_privilege('anon', 'public.reserve_writing_review(uuid, boolean, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.complete_writing_review_reservation(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fail_writing_review_reservation(uuid)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'VALIDATION FAILED: anon still holds EXECUTE on a writing_review_reservations RPC';
  END IF;

  IF NOT (
    has_function_privilege('authenticated', 'public.reserve_writing_review(uuid, boolean, integer)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.complete_writing_review_reservation(uuid, uuid)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.fail_writing_review_reservation(uuid)', 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'VALIDATION FAILED: authenticated is missing EXECUTE on a writing_review_reservations RPC';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.relname = 'writing_review_reservations' AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'VALIDATION FAILED: RLS is not enabled on writing_review_reservations';
  END IF;

  RAISE NOTICE 'VALIDATION PASSED: writing_review_reservations created with RLS, anon stripped from table AND all three RPCs, authenticated retains EXECUTE';
END $$;

COMMIT;

-- =============================================================================
-- FIM DA MIGRATION 20260722130000_create_writing_review_reservations
-- =============================================================================
