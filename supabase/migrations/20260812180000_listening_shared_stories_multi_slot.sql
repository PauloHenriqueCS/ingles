-- =============================================================================
-- MIGRATION: 20260812180000_listening_shared_stories_multi_slot
-- Projeto: Orodim
--
-- Aplicada automaticamente por .github/workflows/deploy-production.yml
-- (supabase db push) após o merge na main, e por homologation.yml em develop.
-- Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO: remover o teto arquitetural de UMA história compartilhada por
-- (level_group, practice_date) — hoje o cache guarda no máximo uma história por
-- grupo de nível/dia, então um plano configurado com N > 1 histórias/dia nunca
-- consegue receber N histórias DISTINTAS. Passamos a permitir várias histórias
-- por grupo/dia (uma por "slot"), servindo a cada usuário a PRÓXIMA que ele
-- ainda não abriu (reuso do cache entre usuários), e gerando uma nova só quando
-- não há elegível disponível.
--
-- O LIMITE do usuário continua sendo imposto por checkListeningCanStart (o
-- handler), contra listening.stories_per_day / .unlimited resolvido pelo
-- entitlements service — NUNCA duplicado em SQL. A RPC aqui só faz seleção/
-- alocação de slot, serializada por advisory lock para não gerar duplicatas.
--
-- COMPATIBILIDADE: aditivo. Não apaga dados. As linhas existentes recebem
-- slot=1 pelo DEFAULT (backfill sem mover dados). FKs de
-- user_listening_shared_progress referenciam listening_shared_stories(id) e não
-- mudam; o progresso existente continua válido. Áudio já é chaveado por id, então
-- cada slot tem caminho de Storage distinto automaticamente.
-- Preserva SECURITY DEFINER, search_path, RLS e os grants existentes.
-- =============================================================================

-- 1. Coluna slot (backfill implícito: linhas atuais viram slot=1).
ALTER TABLE public.listening_shared_stories
  ADD COLUMN IF NOT EXISTS slot smallint NOT NULL DEFAULT 1;

-- 2. Troca a unicidade "uma história por grupo/dia" pela unicidade por slot.
ALTER TABLE public.listening_shared_stories
  DROP CONSTRAINT IF EXISTS uq_lss_group_date;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.listening_shared_stories'::regclass
      AND conname = 'uq_lss_group_date_slot'
  ) THEN
    ALTER TABLE public.listening_shared_stories
      ADD CONSTRAINT uq_lss_group_date_slot UNIQUE (level_group, practice_date, slot);
  END IF;
END $$;

-- 3. Índice de seleção: "histórias de tal grupo/dia por status".
CREATE INDEX IF NOT EXISTS idx_lss_group_date_status
  ON public.listening_shared_stories (level_group, practice_date, status);

-- =============================================================================
-- acquire_or_get_listening_shared_story — nova assinatura (adiciona p_user_id).
-- Drop explícito da antiga (4 args) + create da nova (5 args) + re-grant idêntico
-- (service_role apenas — nunca amplia permissões; é chamada só pelo backend com
-- o service client).
-- =============================================================================
DROP FUNCTION IF EXISTS public.acquire_or_get_listening_shared_story(text, text, date, integer);

CREATE OR REPLACE FUNCTION public.acquire_or_get_listening_shared_story(
  p_user_id               uuid,
  p_level_group           text,
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
  -- Serializa seleção/alocação por (grupo, dia). Assim MAX(slot)+1 é livre de
  -- corrida e dois usuários pedindo a "próxima história" ao mesmo tempo reusam
  -- a geração em andamento (passo 3) em vez de gerar duplicatas.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_level_group || '|' || p_practice_date::text, 0));

  -- (1) REUSO DE CACHE: uma história 'ready' que ESTE usuário ainda não abriu.
  RETURN QUERY
    SELECT s.id, s.status, false, s.content, s.part1_audio_path, s.part2_audio_path, s.audio_mime_type, s.error_message
    FROM   listening_shared_stories s
    WHERE  s.level_group = p_level_group AND s.practice_date = p_practice_date
      AND  s.status = 'ready'
      AND  NOT EXISTS (SELECT 1 FROM user_listening_shared_progress p
                       WHERE p.user_id = p_user_id AND p.shared_story_id = s.id)
    ORDER BY s.slot
    LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  -- (2) TOMA UM SLOT MORTO (failed, ou generating com lock expirado) que o
  -- usuário ainda não abriu, para regenerar naquele mesmo slot.
  -- NB: this function RETURNS TABLE(id …), so bare `id` is the OUT variable —
  -- table columns in the WHERE must be qualified to avoid 42702 ambiguity.
  UPDATE listening_shared_stories
     SET status          = 'generating',
         lock_expires_at = now() + make_interval(secs => p_lock_duration_seconds),
         target_level    = p_target_level,
         error_message   = NULL
   WHERE listening_shared_stories.id = (
     SELECT s.id FROM listening_shared_stories s
     WHERE  s.level_group = p_level_group AND s.practice_date = p_practice_date
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

  -- (3) GERAÇÃO VIVA (lock não expirado) que o usuário ainda não abriu: deixa-o
  -- aguardar essa geração (reuso da geração em andamento, sem duplicar).
  RETURN QUERY
    SELECT s.id, s.status, false, s.content, s.part1_audio_path, s.part2_audio_path, s.audio_mime_type, s.error_message
    FROM   listening_shared_stories s
    WHERE  s.level_group = p_level_group AND s.practice_date = p_practice_date
      AND  s.status = 'generating' AND s.lock_expires_at >= now()
      AND  NOT EXISTS (SELECT 1 FROM user_listening_shared_progress p
                       WHERE p.user_id = p_user_id AND p.shared_story_id = s.id)
    ORDER BY s.slot
    LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  -- (4) NOVO SLOT: o usuário já consumiu tudo que havia disponível → aloca o
  -- próximo slot e gera. MAX(slot)+1 é livre de corrida sob o advisory lock.
  SELECT COALESCE(MAX(slot), 0) + 1 INTO v_next_slot
  FROM   listening_shared_stories
  WHERE  level_group = p_level_group AND practice_date = p_practice_date;

  INSERT INTO listening_shared_stories (level_group, target_level, practice_date, status, slot, lock_expires_at)
  VALUES (p_level_group, p_target_level, p_practice_date, 'generating', v_next_slot,
          now() + make_interval(secs => p_lock_duration_seconds))
  RETURNING listening_shared_stories.id INTO v_id;

  RETURN QUERY SELECT v_id, 'generating'::text, true, NULL::jsonb, NULL::text, NULL::text, NULL::text, NULL::text;
END;
$$;

REVOKE ALL ON FUNCTION public.acquire_or_get_listening_shared_story(uuid, text, text, date, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acquire_or_get_listening_shared_story(uuid, text, text, date, integer) TO service_role;

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
