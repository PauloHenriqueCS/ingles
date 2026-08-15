-- =============================================================================
-- MIGRATION: 20260815121100_curriculum_progress_resync_and_activity_identity
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml
-- (supabase db push). Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO (blockers 3, 8, 10, 11):
--   (A) resync_curriculum_progress: recomputo ATÔMICO e idempotente do progresso
--       curricular a partir dos FATOS persistidos (práticas por recorte + menu de
--       modalidades atual). Serve tanto ao registro de prática quanto à mudança de
--       preferências, e é seguro sob concorrência (advisory lock por user+versão).
--       Regra (espelha src/domain/curriculum-engine/progression.ts): um recorte é
--       concluído quando TODAS as modalidades atualmente selecionadas têm prática;
--       conclusões anteriores nunca regridem; o ponteiro é o primeiro recorte não
--       concluído na ordem (nível, módulo.sort_order, recorte.sort_order); sem
--       recorte pendente ⇒ curriculum_completed (sem reset, sem C3).
--   (B) Identidade curricular nas ATIVIDADES (curriculum_version_id +
--       curriculum_subtopic_key), para que a conclusão de uma atividade seja
--       gravada no recorte em que ela foi ORIGINADA — nunca no recorte "atual" se
--       o usuário avançou nesse meio-tempo.
--
-- COMPATIBILIDADE: aditivo, idempotente. Preserva dados, RLS, grants,
-- SECURITY DEFINER e search_path.
-- =============================================================================

-- ── (A) Recomputo atômico da progressão ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.resync_curriculum_progress(
  p_user_id               uuid,
  p_curriculum_version_id uuid
)
RETURNS TABLE(current_subtopic_id uuid, current_module_id uuid, current_level_code text, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_writing        boolean;
  v_listening      boolean;
  v_pronunciation  boolean;
  v_conversation   boolean;
  v_next_subtopic  uuid;
  v_next_module    uuid;
  v_next_level     text;
  v_status         text;
BEGIN
  -- Serializa TODO o recomputo por (user, versão): dois completions simultâneos,
  -- duas abas, retry ou dois devices nunca avançam dois recortes nem perdem uma
  -- conclusão — cada um recomputa sobre o estado persistido, sob o mesmo lock.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || '|' || p_curriculum_version_id::text, 0));

  SELECT practice_writing, practice_listening, practice_pronunciation, practice_conversation
    INTO v_writing, v_listening, v_pronunciation, v_conversation
  FROM user_curriculum_preferences
  WHERE user_id = p_user_id AND curriculum_version_id = p_curriculum_version_id;

  v_writing       := COALESCE(v_writing, false);
  v_listening     := COALESCE(v_listening, false);
  v_pronunciation := COALESCE(v_pronunciation, false);
  v_conversation  := COALESCE(v_conversation, false);

  -- Marca como concluídos os recortes ainda não concluídos cujas modalidades
  -- SELECIONADAS já foram todas praticadas. Idempotente (ON CONFLICT DO NOTHING).
  -- Se nenhuma modalidade está selecionada, nenhum recorte pode concluir (guard).
  IF (v_writing OR v_listening OR v_pronunciation OR v_conversation) THEN
    INSERT INTO user_subtopic_completion (user_id, subtopic_id)
    SELECT p_user_id, s.id
    FROM curriculum_subtopics s
    WHERE s.curriculum_version_id = p_curriculum_version_id
      AND NOT EXISTS (SELECT 1 FROM user_subtopic_completion c
                      WHERE c.user_id = p_user_id AND c.subtopic_id = s.id)
      AND (NOT v_writing OR EXISTS (SELECT 1 FROM user_subtopic_modality_progress m
             WHERE m.user_id = p_user_id AND m.subtopic_id = s.id AND m.modality = 'writing'))
      AND (NOT v_listening OR EXISTS (SELECT 1 FROM user_subtopic_modality_progress m
             WHERE m.user_id = p_user_id AND m.subtopic_id = s.id AND m.modality = 'listening'))
      AND (NOT v_pronunciation OR EXISTS (SELECT 1 FROM user_subtopic_modality_progress m
             WHERE m.user_id = p_user_id AND m.subtopic_id = s.id AND m.modality = 'pronunciation'))
      AND (NOT v_conversation OR EXISTS (SELECT 1 FROM user_subtopic_modality_progress m
             WHERE m.user_id = p_user_id AND m.subtopic_id = s.id AND m.modality = 'conversation'))
    ON CONFLICT (user_id, subtopic_id) DO NOTHING;
  END IF;

  -- Ponteiro = primeiro recorte NÃO concluído na ordem curricular (dado, não
  -- lógica): nível (A1<A2<B1<B2<C1<C2 lexicográfico), módulo.sort_order,
  -- recorte.sort_order — a MESMA ordem de listOrderedSubtopics.
  SELECT s.id, s.module_id, s.level_code
    INTO v_next_subtopic, v_next_module, v_next_level
  FROM curriculum_subtopics s
  JOIN curriculum_modules mo ON mo.id = s.module_id
  WHERE s.curriculum_version_id = p_curriculum_version_id
    AND NOT EXISTS (SELECT 1 FROM user_subtopic_completion c
                    WHERE c.user_id = p_user_id AND c.subtopic_id = s.id)
  ORDER BY s.level_code, mo.sort_order, s.sort_order
  LIMIT 1;

  v_status := CASE WHEN v_next_subtopic IS NULL THEN 'curriculum_completed' ELSE 'active' END;

  UPDATE user_curriculum_progress
     SET current_subtopic_id = v_next_subtopic,
         current_module_id   = v_next_module,
         -- Mantém o último nível conhecido quando concluído (sem reset a A1).
         current_level_code  = COALESCE(v_next_level, current_level_code),
         status              = v_status,
         updated_at          = now()
   WHERE user_id = p_user_id AND curriculum_version_id = p_curriculum_version_id;

  RETURN QUERY SELECT v_next_subtopic, v_next_module, v_next_level, v_status;
END;
$$;

REVOKE ALL ON FUNCTION public.resync_curriculum_progress(uuid, uuid) FROM PUBLIC;
-- Só o service-role (servidor) recompõe progresso; SECURITY DEFINER ignora RLS,
-- então nunca exponha ao cliente (evita passar p_user_id arbitrário).
GRANT EXECUTE ON FUNCTION public.resync_curriculum_progress(uuid, uuid) TO service_role;

-- ── (B) Identidade curricular nas atividades ────────────────────────────────
-- A conclusão lê essa identidade (server-side, do recurso que o usuário possui)
-- e registra a prática no recorte de ORIGEM da atividade — nunca no ponteiro
-- atual, evitando que uma atividade antiga marque o próximo recorte.
ALTER TABLE public.pronunciation_training_sessions
  ADD COLUMN IF NOT EXISTS curriculum_version_id uuid,
  ADD COLUMN IF NOT EXISTS curriculum_subtopic_key text;

ALTER TABLE public.english_reviews
  ADD COLUMN IF NOT EXISTS curriculum_version_id uuid,
  ADD COLUMN IF NOT EXISTS curriculum_subtopic_key text;

ALTER TABLE public.conversation_session_authorizations
  ADD COLUMN IF NOT EXISTS curriculum_version_id uuid,
  ADD COLUMN IF NOT EXISTS curriculum_subtopic_key text;

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
