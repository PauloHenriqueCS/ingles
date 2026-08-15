-- =============================================================================
-- MIGRATION: 20260815121200_listening_shared_stories_version_identity
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml
-- (supabase db push). Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO (blocker 5): a migration 120500 ADICIONOU curriculum_version_id ao
-- listening_shared_stories, mas a IDENTIDADE real do cache (unique/lock/lookups)
-- ainda não a usava — English V1/A1.X.Y e English V2/A1.X.Y podiam colidir por
-- reusarem o mesmo subtopic_key semântico. Aqui curriculum_version_id passa a
-- fazer parte de TODA a identidade pedagógica do cache: unique constraint,
-- índice, advisory lock e cada lookup (reuso ready / slot morto / geração viva /
-- MAX(slot)+1 / insert). Compartilhamento entre usuários continua, porém só no
-- MESMO (learning_language, curriculum_version_id, subtopic, dia, bucket).
--
-- COMPATIBILIDADE: aditivo e seguro. NÃO apaga histórias. Linhas legadas com
-- curriculum_version_id NULL (bucket subtopic_key='') nunca são reusadas para um
-- recorte real. Preserva SECURITY DEFINER, search_path, RLS e grants.
-- =============================================================================

-- 1. Unicidade agora inclui curriculum_version_id.
ALTER TABLE public.listening_shared_stories
  DROP CONSTRAINT IF EXISTS uq_lss_lang_group_subtopic_date_slot;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.listening_shared_stories'::regclass
      AND conname = 'uq_lss_lang_version_group_subtopic_date_slot'
  ) THEN
    ALTER TABLE public.listening_shared_stories
      ADD CONSTRAINT uq_lss_lang_version_group_subtopic_date_slot
      UNIQUE (learning_language, curriculum_version_id, level_group, subtopic_key, practice_date, slot);
  END IF;
END $$;

-- 2. Índice de seleção por recorte/versão/status.
CREATE INDEX IF NOT EXISTS idx_lss_lang_version_group_subtopic_date_status
  ON public.listening_shared_stories (learning_language, curriculum_version_id, level_group, subtopic_key, practice_date, status);

-- =============================================================================
-- acquire_or_get_listening_shared_story — mesma assinatura (8 args), corpo
-- reescrito para escopar TUDO por curriculum_version_id. CREATE OR REPLACE
-- preserva a assinatura/grants; re-grant idêntico por garantia.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.acquire_or_get_listening_shared_story(
  p_user_id               uuid,
  p_learning_language     text,
  p_level_group           text,
  p_subtopic_key          text,
  p_curriculum_version_id uuid,
  p_target_level          text,
  p_practice_date         date,
  p_lock_duration_seconds integer
)
RETURNS TABLE(
  id uuid, status text, won boolean, content jsonb,
  part1_audio_path text, part2_audio_path text, audio_mime_type text, error_message text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id        UUID;
  v_next_slot smallint;
BEGIN
  -- Serializa por (idioma, VERSÃO, grupo, recorte, dia): V1 e V2 do mesmo
  -- recorte semântico nunca compartilham lock nem conteúdo.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_learning_language || '|' || COALESCE(p_curriculum_version_id::text, '') || '|' ||
    p_level_group || '|' || p_subtopic_key || '|' || p_practice_date::text, 0));

  -- (1) REUSO DE CACHE: história 'ready' do MESMO recorte E MESMA VERSÃO que
  --     ESTE usuário ainda não abriu.
  RETURN QUERY
    SELECT s.id, s.status, false, s.content, s.part1_audio_path, s.part2_audio_path, s.audio_mime_type, s.error_message
    FROM   listening_shared_stories s
    WHERE  s.learning_language = p_learning_language
      AND  s.curriculum_version_id IS NOT DISTINCT FROM p_curriculum_version_id
      AND  s.level_group = p_level_group AND s.subtopic_key = p_subtopic_key
      AND  s.practice_date = p_practice_date
      AND  s.status = 'ready'
      AND  NOT EXISTS (SELECT 1 FROM user_listening_shared_progress p
                       WHERE p.user_id = p_user_id AND p.shared_story_id = s.id)
    ORDER BY s.slot
    LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  -- (2) TOMA UM SLOT MORTO (failed, ou generating com lock expirado) do MESMO
  --     recorte E VERSÃO que o usuário ainda não abriu.
  UPDATE listening_shared_stories
     SET status          = 'generating',
         lock_expires_at = now() + make_interval(secs => p_lock_duration_seconds),
         target_level    = p_target_level,
         error_message   = NULL
   WHERE listening_shared_stories.id = (
     SELECT s.id FROM listening_shared_stories s
     WHERE  s.learning_language = p_learning_language
       AND  s.curriculum_version_id IS NOT DISTINCT FROM p_curriculum_version_id
       AND  s.level_group = p_level_group AND s.subtopic_key = p_subtopic_key
       AND  s.practice_date = p_practice_date
       AND  (s.status = 'failed' OR (s.status = 'generating' AND s.lock_expires_at < now()))
       AND  NOT EXISTS (SELECT 1 FROM user_listening_shared_progress p
                        WHERE p.user_id = p_user_id AND p.shared_story_id = s.id)
     ORDER BY s.slot
     LIMIT 1
   )
  RETURNING listening_shared_stories.id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, 'generating'::text, true, NULL::jsonb, NULL::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- (3) GERAÇÃO VIVA do MESMO recorte E VERSÃO que o usuário ainda não abriu.
  RETURN QUERY
    SELECT s.id, s.status, false, s.content, s.part1_audio_path, s.part2_audio_path, s.audio_mime_type, s.error_message
    FROM   listening_shared_stories s
    WHERE  s.learning_language = p_learning_language
      AND  s.curriculum_version_id IS NOT DISTINCT FROM p_curriculum_version_id
      AND  s.level_group = p_level_group AND s.subtopic_key = p_subtopic_key
      AND  s.practice_date = p_practice_date
      AND  s.status = 'generating' AND s.lock_expires_at >= now()
      AND  NOT EXISTS (SELECT 1 FROM user_listening_shared_progress p
                       WHERE p.user_id = p_user_id AND p.shared_story_id = s.id)
    ORDER BY s.slot
    LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  -- (4) NOVO SLOT no MESMO recorte E VERSÃO: MAX(slot)+1 escopado por versão.
  SELECT COALESCE(MAX(slot), 0) + 1 INTO v_next_slot
  FROM   listening_shared_stories
  WHERE  learning_language = p_learning_language
    AND  curriculum_version_id IS NOT DISTINCT FROM p_curriculum_version_id
    AND  level_group = p_level_group AND subtopic_key = p_subtopic_key
    AND  practice_date = p_practice_date;

  INSERT INTO listening_shared_stories
    (learning_language, curriculum_version_id, level_group, subtopic_key, target_level, practice_date, status, slot, lock_expires_at)
  VALUES
    (p_learning_language, p_curriculum_version_id, p_level_group, p_subtopic_key, p_target_level, p_practice_date, 'generating', v_next_slot,
     now() + make_interval(secs => p_lock_duration_seconds))
  RETURNING listening_shared_stories.id INTO v_id;

  RETURN QUERY SELECT v_id, 'generating'::text, true, NULL::jsonb, NULL::text, NULL::text, NULL::text, NULL::text;
END;
$$;

REVOKE ALL ON FUNCTION public.acquire_or_get_listening_shared_story(uuid, text, text, text, uuid, text, date, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acquire_or_get_listening_shared_story(uuid, text, text, text, uuid, text, date, integer) TO service_role;

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
