-- =============================================================================
-- MIGRATION: 20260815140000_fix_resync_ambiguous_level_code
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml
-- (supabase db push --include-all). NÃO aplicar manualmente no SQL Editor.
--
-- BUGFIX (causa raiz): resync_curriculum_progress declara `current_level_code`
-- como COLUNA DE SAÍDA no RETURNS TABLE. Dentro do UPDATE, ao usar o nome
-- `current_level_code` sem qualificar no lado direito da atribuição, ele fica
-- AMBÍGUO entre a variável de saída e a coluna da tabela, e o Postgres (com
-- plpgsql.variable_conflict = error, o padrão) aborta em runtime com:
--   ERROR 42702: column reference "current_level_code" is ambiguous
-- Isso quebra QUALQUER chamada que execute o UPDATE — inclusive
-- placement_apply_result_v1 (que delega a esta função ao concluir o placement
-- num nível terminal, ex.: B2 FAIL → B1) e a própria progressão do currículo.
--
-- CORREÇÃO CIRÚRGICA: qualifica o RHS como
-- user_curriculum_progress.current_level_code (a intenção documentada: "mantém
-- o último nível conhecido quando concluído"). Nenhuma outra mudança de
-- comportamento. CREATE OR REPLACE preserva grants/owner existentes. Idempotente.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.resync_curriculum_progress(p_user_id uuid, p_curriculum_version_id uuid)
 RETURNS TABLE(current_subtopic_id uuid, current_module_id uuid, current_level_code text, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
         -- Qualificado (user_curriculum_progress.current_level_code) para não
         -- colidir com a coluna de saída homônima do RETURNS TABLE (bug 42702).
         current_level_code  = COALESCE(v_next_level, user_curriculum_progress.current_level_code),
         status              = v_status,
         updated_at          = now()
   WHERE user_id = p_user_id AND curriculum_version_id = p_curriculum_version_id;

  RETURN QUERY SELECT v_next_subtopic, v_next_module, v_next_level, v_status;
END;
$function$;
