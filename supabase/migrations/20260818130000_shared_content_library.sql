-- =============================================================================
-- MIGRATION: 20260818130000_shared_content_library
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml
-- (supabase db push). NAO aplicar manualmente no SQL Editor.
--
-- OBJETIVO: biblioteca PERSISTENTE de conteudo pedagogico gerado por IA,
-- reutilizavel ENTRE usuarios quando pedagogicamente compativel — generalizando,
-- como implementacao-irma, o mecanismo ja provado do Listening
-- (listening_shared_stories + acquire_or_get_listening_shared_story). Cobre
-- Pronuncia (texto + audio TTS de referencia) e Escrita (missao/tema).
--
-- FLUXO (sempre sincrono, sob demanda; NUNCA geracao antecipada):
--   requisicao -> buscar item compativel nao-usado pelo usuario
--   -> achou (ready): reutiliza  |  nao achou: gera na hora -> persiste -> entrega
-- Sem cron, worker, fila, prefetch ou warm-up: o banco e populado organicamente.
-- O lock morto e reclamado pela PROXIMA requisicao (lock_expires_at), nunca por
-- rotina de fundo — exatamente como o Listening.
--
-- IDENTIDADE DE COMPATIBILIDADE (multilingue, sem hardcode de ingles):
--   (modality, learning_language, interface_language, curriculum_version_id,
--    subtopic_key, level_code, exercise_type, template_key, prompt_version, slot)
-- model e voz/locale de TTS NAO fazem parte da identidade de REUSO (traceados em
-- colunas proprias), espelhando a decisao do Listening.
--
-- ISOLAMENTO: esta biblioteca guarda SOMENTE o conteudo-base compartilhavel.
-- Resposta do aluno, correcao, feedback, notas, tentativas e progresso continuam
-- nas tabelas por-usuario existentes (pronunciation_training_sessions,
-- generated_themes, english_reviews, ...), inalteradas. Nada aqui toca quota:
-- um cache hit continua criando a atividade por-usuario normal (que carrega a
-- quota) — a biblioteca so evita a chamada de IA/TTS repetida.
--
-- SEGURANCA: RLS habilitada. Escrita/geracao e SEMPRE via backend (service_role);
-- o cliente nunca escreve nestas tabelas nem le o bucket de audio diretamente.
-- Aditivo e nao-destrutivo: nao apaga nem invalida historico existente.
-- =============================================================================

-- =============================================================================
-- 1. Bucket de audio compartilhado (privado) — referencia TTS de Pronuncia.
--    Bucket proprio (NAO reusa 'listening-audio', que e auditado/limpo pelos
--    scripts listening:*), protegido de leitura por usuarios autenticados.
-- =============================================================================
INSERT INTO storage.buckets (id, name, owner, public, file_size_limit, allowed_mime_types, avif_autodetection)
VALUES ('shared-content-audio', 'shared-content-audio', NULL, false, 104857600, ARRAY['audio/mpeg','audio/mp3'], false)
ON CONFLICT (id) DO NOTHING;

-- service_role tem acesso total ao bucket (todo upload/download passa pelo backend).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='service_role_all_shared_content_audio') THEN
    CREATE POLICY service_role_all_shared_content_audio ON storage.objects
      AS PERMISSIVE FOR ALL TO service_role
      USING (bucket_id = 'shared-content-audio'::text)
      WITH CHECK (bucket_id = 'shared-content-audio'::text);
  END IF;
END $$;

-- RESTRICTIVE: nenhum usuario autenticado pode ler objetos deste bucket, mesmo
-- que outra policy permissiva (ex.: deny_authed_listening_audio) conceda leitura
-- a "todos os buckets != listening-audio". Restritiva E'da com as permissivas.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='restrict_authed_shared_content_audio') THEN
    CREATE POLICY restrict_authed_shared_content_audio ON storage.objects
      AS RESTRICTIVE FOR SELECT TO authenticated
      USING (bucket_id <> 'shared-content-audio'::text);
  END IF;
END $$;

-- =============================================================================
-- 2. shared_content_items — a biblioteca persistente (conteudo GLOBAL, sem user_id).
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.shared_content_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  modality              text NOT NULL CHECK (modality IN ('pronunciation','writing')),

  -- Identidade curricular/pedagogica (chave de compatibilidade) --------------
  learning_language     text NOT NULL,
  interface_language    text NOT NULL,
  curriculum_version_id uuid,                       -- parte da identidade (IS NOT DISTINCT FROM / COALESCE)
  subtopic_key          text NOT NULL DEFAULT '',
  level_code            text NOT NULL DEFAULT '',
  exercise_type         text NOT NULL DEFAULT '',
  template_key          text NOT NULL DEFAULT '',
  prompt_version        integer NOT NULL DEFAULT 0,
  slot                  smallint NOT NULL DEFAULT 1, -- N itens compativeis por identidade (rotacao por-usuario)

  -- Ciclo de vida do CONTEUDO (texto/missao) --------------------------------
  status                text NOT NULL DEFAULT 'generating' CHECK (status IN ('generating','ready','failed')),
  content               jsonb,
  error_message         text,
  lock_expires_at       timestamptz,                -- lock de geracao; reclamado pela proxima requisicao (sem cron)
  generator_model       text,                       -- rastreabilidade (NAO faz parte da identidade de reuso)

  -- AUDIO TTS de referencia (opcional; 'none' quando a modalidade nao tem audio)
  audio_status          text NOT NULL DEFAULT 'none' CHECK (audio_status IN ('none','pending','ready','failed')),
  audio_path            text,                        -- caminho no Storage (nunca o blob)
  audio_mime_type       text,
  audio_voice           text,
  audio_locale          text,
  audio_lock_expires_at timestamptz,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Unicidade da identidade + slot (null-safe no curriculum_version_id).
CREATE UNIQUE INDEX IF NOT EXISTS uq_sci_identity_slot
  ON public.shared_content_items (
    modality, learning_language, interface_language,
    COALESCE(curriculum_version_id, '00000000-0000-0000-0000-000000000000'::uuid),
    subtopic_key, level_code, exercise_type, template_key, prompt_version, slot
  );

-- Indice de selecao por identidade + status (reuso / slot morto / geracao viva).
CREATE INDEX IF NOT EXISTS idx_sci_identity_status
  ON public.shared_content_items (
    modality, learning_language, curriculum_version_id,
    subtopic_key, level_code, exercise_type, template_key, prompt_version, status
  );

DROP TRIGGER IF EXISTS tg_shared_content_items_updated_at ON public.shared_content_items;
CREATE TRIGGER tg_shared_content_items_updated_at
  BEFORE UPDATE ON public.shared_content_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE public.shared_content_items ENABLE ROW LEVEL SECURITY;
-- Sem policies para anon/authenticated: TODO acesso e via backend (service_role,
-- que ignora RLS). Cliente nunca le nem escreve conteudo compartilhado direto.
REVOKE ALL ON public.shared_content_items FROM anon, authenticated;

-- =============================================================================
-- 3. user_shared_content_usage — ledger por-usuario de "ja recebeu este item".
--    So existe para evitar repeticao excessiva (NOT EXISTS no acquire). NAO
--    guarda desempenho: notas/tentativas/progresso continuam nas tabelas proprias.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.user_shared_content_usage (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  shared_item_id uuid NOT NULL REFERENCES public.shared_content_items(id) ON DELETE CASCADE,
  modality       text NOT NULL,
  source_ref     text,           -- id da atividade por-usuario (traceabilidade; opcional)
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_uscu_user_item UNIQUE (user_id, shared_item_id)
);

CREATE INDEX IF NOT EXISTS idx_uscu_user_modality
  ON public.user_shared_content_usage (user_id, modality);

ALTER TABLE public.user_shared_content_usage ENABLE ROW LEVEL SECURITY;
-- Leitura apenas das proprias linhas; escrita SOMENTE via service_role (RPC/servico).
DROP POLICY IF EXISTS uscu_select_own ON public.user_shared_content_usage;
CREATE POLICY uscu_select_own ON public.user_shared_content_usage
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
REVOKE INSERT, UPDATE, DELETE ON public.user_shared_content_usage FROM anon, authenticated;

-- Colunas de rastreabilidade (aditivas, nullable, sem cascade) nas tabelas
-- por-usuario que passam a consumir a biblioteca. Nao alteram comportamento.
ALTER TABLE public.pronunciation_training_sessions
  ADD COLUMN IF NOT EXISTS shared_content_item_id uuid REFERENCES public.shared_content_items(id) ON DELETE SET NULL;
ALTER TABLE public.generated_themes
  ADD COLUMN IF NOT EXISTS shared_content_item_id uuid REFERENCES public.shared_content_items(id) ON DELETE SET NULL;

-- =============================================================================
-- 4. acquire_or_get_shared_content_item — get-or-create atomico do CONTEUDO,
--    espelhando acquire_or_get_listening_shared_story. Serializa por identidade
--    (advisory xact lock), reusa item pronto que o usuario ainda nao recebeu,
--    reclama slot morto (failed/lock expirado) ou aloca um novo slot para gerar.
--    NAO bloqueia o usuario numa geracao viva alheia: aloca novo slot (§8 —
--    duplicacao semantica pontual e aceitavel; nunca 409/500 na UX sincrona).
--    O AUDIO e responsabilidade da camada de servico (colunas audio_*), nao deste
--    RPC de conteudo.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.acquire_or_get_shared_content_item(
  p_user_id               uuid,
  p_modality              text,
  p_learning_language     text,
  p_interface_language    text,
  p_curriculum_version_id uuid,
  p_subtopic_key          text,
  p_level_code            text,
  p_exercise_type         text,
  p_template_key          text,
  p_prompt_version        integer,
  p_lock_duration_seconds integer
)
RETURNS TABLE(
  id uuid, status text, won boolean, content jsonb,
  audio_status text, audio_path text, audio_mime_type text, audio_voice text, audio_locale text,
  error_message text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id        uuid;
  v_next_slot smallint;
BEGIN
  -- Serializa por identidade pedagogica completa: modalidades/idiomas/versoes/
  -- recortes/templates diferentes nunca compartilham lock nem conteudo.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_modality || '|' || p_learning_language || '|' || p_interface_language || '|' ||
    COALESCE(p_curriculum_version_id::text, '') || '|' || p_subtopic_key || '|' ||
    p_level_code || '|' || p_exercise_type || '|' || p_template_key || '|' ||
    p_prompt_version::text, 0));

  -- (1) REUSO: item 'ready' da MESMA identidade que ESTE usuario ainda nao recebeu.
  RETURN QUERY
    SELECT s.id, s.status, false, s.content,
           s.audio_status, s.audio_path, s.audio_mime_type, s.audio_voice, s.audio_locale, s.error_message
    FROM   shared_content_items s
    WHERE  s.modality = p_modality
      AND  s.learning_language = p_learning_language
      AND  s.interface_language = p_interface_language
      AND  s.curriculum_version_id IS NOT DISTINCT FROM p_curriculum_version_id
      AND  s.subtopic_key = p_subtopic_key
      AND  s.level_code = p_level_code
      AND  s.exercise_type = p_exercise_type
      AND  s.template_key = p_template_key
      AND  s.prompt_version = p_prompt_version
      AND  s.status = 'ready'
      AND  NOT EXISTS (SELECT 1 FROM user_shared_content_usage u
                       WHERE u.user_id = p_user_id AND u.shared_item_id = s.id)
    ORDER BY s.slot
    LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  -- (2) SLOT MORTO: 'failed' ou 'generating' com lock expirado, mesma identidade,
  --     que o usuario ainda nao recebeu -> retoma para (re)gerar.
  UPDATE shared_content_items
     SET status          = 'generating',
         lock_expires_at = now() + make_interval(secs => p_lock_duration_seconds),
         error_message   = NULL
   WHERE shared_content_items.id = (
     SELECT s.id FROM shared_content_items s
     WHERE  s.modality = p_modality
       AND  s.learning_language = p_learning_language
       AND  s.interface_language = p_interface_language
       AND  s.curriculum_version_id IS NOT DISTINCT FROM p_curriculum_version_id
       AND  s.subtopic_key = p_subtopic_key
       AND  s.level_code = p_level_code
       AND  s.exercise_type = p_exercise_type
       AND  s.template_key = p_template_key
       AND  s.prompt_version = p_prompt_version
       AND  (s.status = 'failed' OR (s.status = 'generating' AND s.lock_expires_at < now()))
       AND  NOT EXISTS (SELECT 1 FROM user_shared_content_usage u
                        WHERE u.user_id = p_user_id AND u.shared_item_id = s.id)
     ORDER BY s.slot
     LIMIT 1
   )
  RETURNING shared_content_items.id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, 'generating'::text, true,
                        NULL::jsonb, 'none'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- (3) NOVO SLOT: MAX(slot)+1 escopado na identidade -> gera agora.
  SELECT COALESCE(MAX(slot), 0) + 1 INTO v_next_slot
  FROM   shared_content_items
  WHERE  modality = p_modality
    AND  learning_language = p_learning_language
    AND  interface_language = p_interface_language
    AND  curriculum_version_id IS NOT DISTINCT FROM p_curriculum_version_id
    AND  subtopic_key = p_subtopic_key
    AND  level_code = p_level_code
    AND  exercise_type = p_exercise_type
    AND  template_key = p_template_key
    AND  prompt_version = p_prompt_version;

  INSERT INTO shared_content_items
    (modality, learning_language, interface_language, curriculum_version_id, subtopic_key,
     level_code, exercise_type, template_key, prompt_version, status, slot, lock_expires_at)
  VALUES
    (p_modality, p_learning_language, p_interface_language, p_curriculum_version_id, p_subtopic_key,
     p_level_code, p_exercise_type, p_template_key, p_prompt_version, 'generating', v_next_slot,
     now() + make_interval(secs => p_lock_duration_seconds))
  RETURNING shared_content_items.id INTO v_id;

  RETURN QUERY SELECT v_id, 'generating'::text, true,
                      NULL::jsonb, 'none'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text;
END;
$$;

REVOKE ALL ON FUNCTION public.acquire_or_get_shared_content_item(uuid, text, text, text, uuid, text, text, text, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acquire_or_get_shared_content_item(uuid, text, text, text, uuid, text, text, text, text, integer, integer) TO service_role;

-- Apos aplicar: execute supabase/verify_schema.sql para verificar o estado.
