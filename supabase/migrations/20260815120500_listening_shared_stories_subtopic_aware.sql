-- =============================================================================
-- MIGRATION: 20260815120500_listening_shared_stories_subtopic_aware
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml
-- (supabase db push). Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO: fechar o cutover data-driven do Listening. O CONTEÚDO da história já
-- é gerado alinhado ao recorte atual (template data-driven listening.two_part_
-- generate), mas o cache/compartilhamento (listening_shared_stories) era chaveado
-- só por (level_group, practice_date, slot) — então dois usuários no mesmo grupo
-- de nível, porém em RECORTES diferentes, podiam receber a MESMA história em
-- cache, incoerente com o recorte do segundo. Passa a identificar o conteúdo
-- curricular por (learning_language, curriculum_version, subtopic/recorte),
-- preservando cache e compartilhamento ENTRE usuários do MESMO recorte.
--
-- COMPATIBILIDADE: aditivo. Não apaga dados. Linhas existentes recebem
-- learning_language='en' e subtopic_key='' (bucket legado, nunca reusado para um
-- recorte real). Preserva SECURITY DEFINER, search_path, RLS e grants.
-- =============================================================================

-- 1. Colunas de identidade curricular.
ALTER TABLE public.listening_shared_stories
  ADD COLUMN IF NOT EXISTS learning_language     text  NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS curriculum_version_id uuid,
  ADD COLUMN IF NOT EXISTS subtopic_key          text  NOT NULL DEFAULT '';

-- 2. Unicidade por (idioma, grupo de nível, recorte, dia, slot) — reuso de cache
--    fica escopado ao mesmo recorte, nunca cruza recortes.
ALTER TABLE public.listening_shared_stories
  DROP CONSTRAINT IF EXISTS uq_lss_group_date_slot;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.listening_shared_stories'::regclass
      AND conname = 'uq_lss_lang_group_subtopic_date_slot'
  ) THEN
    ALTER TABLE public.listening_shared_stories
      ADD CONSTRAINT uq_lss_lang_group_subtopic_date_slot
      UNIQUE (learning_language, level_group, subtopic_key, practice_date, slot);
  END IF;
END $$;

-- 3. Índice de seleção por recorte/status.
CREATE INDEX IF NOT EXISTS idx_lss_lang_group_subtopic_date_status
  ON public.listening_shared_stories (learning_language, level_group, subtopic_key, practice_date, status);

-- =============================================================================
-- acquire_or_get_listening_shared_story — nova assinatura (adiciona idioma,
-- versão do currículo e recorte). Reuso/lock/alocação passam a ser escopados por
-- (learning_language, level_group, subtopic_key, practice_date). Drop da versão
-- de 5 args + create da de 8 + re-grant idêntico (service_role apenas).
-- =============================================================================
DROP FUNCTION IF EXISTS public.acquire_or_get_listening_shared_story(uuid, text, text, date, integer);

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
  -- Serializa seleção/alocação por (idioma, grupo, recorte, dia). MAX(slot)+1
  -- fica livre de corrida e dois usuários no MESMO recorte pedindo a "próxima
  -- história" ao mesmo tempo reusam a geração em andamento em vez de duplicar.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_learning_language || '|' || p_level_group || '|' || p_subtopic_key || '|' || p_practice_date::text, 0));

  -- (1) REUSO DE CACHE: história 'ready' do MESMO recorte que ESTE usuário ainda
  --     não abriu.
  RETURN QUERY
    SELECT s.id, s.status, false, s.content, s.part1_audio_path, s.part2_audio_path, s.audio_mime_type, s.error_message
    FROM   listening_shared_stories s
    WHERE  s.learning_language = p_learning_language
      AND  s.level_group = p_level_group AND s.subtopic_key = p_subtopic_key
      AND  s.practice_date = p_practice_date
      AND  s.status = 'ready'
      AND  NOT EXISTS (SELECT 1 FROM user_listening_shared_progress p
                       WHERE p.user_id = p_user_id AND p.shared_story_id = s.id)
    ORDER BY s.slot
    LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  -- (2) TOMA UM SLOT MORTO (failed, ou generating com lock expirado) do MESMO
  --     recorte que o usuário ainda não abriu, para regenerar naquele slot.
  UPDATE listening_shared_stories
     SET status          = 'generating',
         lock_expires_at = now() + make_interval(secs => p_lock_duration_seconds),
         target_level    = p_target_level,
         curriculum_version_id = p_curriculum_version_id,
         error_message   = NULL
   WHERE listening_shared_stories.id = (
     SELECT s.id FROM listening_shared_stories s
     WHERE  s.learning_language = p_learning_language
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

  -- (3) GERAÇÃO VIVA do MESMO recorte que o usuário ainda não abriu: aguarda.
  RETURN QUERY
    SELECT s.id, s.status, false, s.content, s.part1_audio_path, s.part2_audio_path, s.audio_mime_type, s.error_message
    FROM   listening_shared_stories s
    WHERE  s.learning_language = p_learning_language
      AND  s.level_group = p_level_group AND s.subtopic_key = p_subtopic_key
      AND  s.practice_date = p_practice_date
      AND  s.status = 'generating' AND s.lock_expires_at >= now()
      AND  NOT EXISTS (SELECT 1 FROM user_listening_shared_progress p
                       WHERE p.user_id = p_user_id AND p.shared_story_id = s.id)
    ORDER BY s.slot
    LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  -- (4) NOVO SLOT no recorte atual: aloca o próximo slot e gera.
  SELECT COALESCE(MAX(slot), 0) + 1 INTO v_next_slot
  FROM   listening_shared_stories
  WHERE  learning_language = p_learning_language
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
