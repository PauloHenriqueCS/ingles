-- =============================================================================
-- MIGRATION: 20260911140000_appsflyer_activity_include_pronunciation_assessments
-- Projeto: Orodim
--
-- Aplicada automaticamente pelo pipeline de CI (supabase db push).
-- NÃO aplicar manualmente no SQL Editor.
--
-- OBJETIVO (AppsFlyer GAP A — lado servidor):
--   A verificação de "histórico pré-boundary" em claim_appsflyer_activity_events
--   (migration 20260825120000) só olhava pronunciation_TRAINING_sessions para a
--   modalidade 'pronunciation'. A pronúncia do DIÁRIO / frase da Escrita grava em
--   public.pronunciation_ASSESSMENTS — invisível ao funil tanto no gatilho
--   (corrigido no cliente: PronunciationRecorder passa a chamar
--   trackActivityCompleted('pronunciation')) quanto aqui, na elegibilidade.
--
--   Consequência do bug: um usuário pré-boundary cuja única atividade anterior
--   era uma pronúncia de diário NÃO seria reconhecido como "usuário antigo" e
--   poderia disparar first_activity_completed indevidamente. Esta migration
--   inclui pronunciation_assessments concluídas antes do boundary na checagem.
--
-- ESCOPO: puramente aditivo — CREATE OR REPLACE da função existente, mantendo
--   TODA a lógica anterior; apenas adiciona um ramo OR EXISTS. Idempotência,
--   boundary, gate ever-paid e grants permanecem idênticos.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.claim_appsflyer_activity_events(p_activity_type text)
RETURNS TABLE (
  first_activity boolean,
  learning_day boolean,
  days_since_registration integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_uid          uuid := auth.uid();
  v_cutoff       timestamptz := TIMESTAMPTZ '2026-08-25 00:00:00+00';
  v_sp_today     date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_created      timestamptz;
  v_has_pre      boolean;
  v_first_claim  boolean := false;
  v_day_claim    boolean := false;
BEGIN
  first_activity := false;
  learning_day := false;
  days_since_registration := NULL;

  IF v_uid IS NULL
     OR p_activity_type IS NULL
     OR p_activity_type NOT IN ('writing', 'pronunciation', 'listening', 'review', 'conversation') THEN
    RETURN NEXT; RETURN;
  END IF;

  -- Acquisition events stop forever after the first payment.
  IF public.appsflyer_user_has_ever_paid(v_uid) THEN
    RETURN NEXT; RETURN;
  END IF;

  SELECT created_at INTO v_created FROM auth.users WHERE id = v_uid;
  IF v_created IS NOT NULL THEN
    days_since_registration := GREATEST(
      0, (v_sp_today - (v_created AT TIME ZONE 'America/Sao_Paulo')::date)
    );
  END IF;

  -- first_activity: claim once per lifetime. Suppress (but still claim, so we
  -- never re-scan) for users who already had completions before the boundary.
  IF NOT EXISTS (
    SELECT 1 FROM public.appsflyer_events
    WHERE user_id = v_uid AND event_key = 'first_activity'
  ) THEN
    v_has_pre := (
      EXISTS (SELECT 1 FROM public.english_reviews
              WHERE user_id = v_uid AND created_at < v_cutoff)
      OR EXISTS (SELECT 1 FROM public.pronunciation_training_sessions
                 WHERE user_id = v_uid AND status = 'completed' AND completed_at < v_cutoff)
      -- GAP A: a pronúncia do diário / frase da Escrita grava aqui e antes era
      -- ignorada — inclua-a para não tratar um usuário antigo como novo.
      OR EXISTS (SELECT 1 FROM public.pronunciation_assessments
                 WHERE user_id = v_uid AND status = 'completed' AND completed_at < v_cutoff)
      OR EXISTS (SELECT 1 FROM public.user_listening_assignments
                 WHERE user_id = v_uid AND status = 'completed' AND completed_at < v_cutoff)
      OR EXISTS (SELECT 1 FROM public.review_item_attempts
                 WHERE user_id = v_uid AND created_at < v_cutoff)
      OR EXISTS (SELECT 1 FROM public.conversation_sessions
                 WHERE user_id = v_uid AND created_at < v_cutoff)
    );

    INSERT INTO public.appsflyer_events (user_id, event_key, fired)
    VALUES (v_uid, 'first_activity', NOT v_has_pre)
    ON CONFLICT (user_id, event_key, event_date) DO NOTHING;
    v_first_claim := FOUND AND NOT v_has_pre;
  END IF;

  -- learning_day: first genuine completion of this SP day.
  INSERT INTO public.appsflyer_events (user_id, event_key, event_date)
  VALUES (v_uid, 'learning_day', v_sp_today)
  ON CONFLICT (user_id, event_key, event_date) DO NOTHING;
  v_day_claim := FOUND;

  first_activity := v_first_claim;
  learning_day := v_day_claim;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_appsflyer_activity_events(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.claim_appsflyer_activity_events(text) TO authenticated;
