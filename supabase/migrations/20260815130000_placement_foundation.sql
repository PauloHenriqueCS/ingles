-- =============================================================================
-- MIGRATION: 20260815130000_placement_foundation
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml
-- (supabase db push --include-all). NÃO aplicar manualmente no SQL Editor.
--
-- OBJETIVO: Teste ADAPTATIVO de classificação de nível (placement) usado como
-- onboarding logo após o cadastro. Responde "em qual nível do curso o usuário
-- começa?" — NÃO é certificação CEFR. Estrutura 100% DATA-DRIVEN e MULTILÍNGUE:
--   * a árvore adaptativa vive nos próprios checkpoints (pass/fail → checkpoint
--     ou nível terminal), nunca em `if (checkpoint === 'B1')` no código;
--   * perguntas/alternativas/gabarito/rubrica/prompt/copy/threshold ficam no
--     banco, associados a um learning_language (target language);
--   * o GABARITO fica numa tabela PRIVADA (placement_question_keys) sem SELECT
--     para authenticated — a correção é sempre server-side (service_role).
--
-- NÍVEL OFICIAL: continua sendo user_curriculum_progress.current_level_code,
-- derivado por resync_curriculum_progress. Este placement NUNCA rebaixa: aplica
-- o resultado marcando como concluídos os recortes dos níveis ABAIXO do alvo e
-- rodando o resync (só ADICIONA completions → o ponteiro só avança). Isso dá
-- effective = max(nível_atual, resultado) sem caso especial (ver
-- placement_apply_result_v1 abaixo).
--
-- COMPATIBILIDADE: aditivo, idempotente. Não apaga dados. Preserva RLS/grants.
-- =============================================================================

-- =============================================================================
-- 1. DEFINIÇÃO DO TESTE (data-driven, por target language)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.placement_tests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                 text NOT NULL UNIQUE,
  learning_language    text NOT NULL REFERENCES public.languages(code),
  framework_id         text NOT NULL REFERENCES public.proficiency_frameworks(id),
  version              integer NOT NULL,
  title                text NOT NULL,
  is_active            boolean NOT NULL DEFAULT true,
  -- Checkpoint por onde o teste ADAPTATIVO começa (ex.: 'B1'). Dado, não código.
  start_checkpoint_key text NOT NULL,
  -- TTL de uma tentativa abandonada antes de poder recomeçar (§7). 24h default.
  attempt_ttl_seconds  integer NOT NULL DEFAULT 86400,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- Uma versão de teste por idioma estudado (troca de perguntas = nova versão).
  CONSTRAINT uq_placement_tests_lang_version UNIQUE (learning_language, version)
);
CREATE INDEX IF NOT EXISTS idx_placement_tests_active
  ON public.placement_tests (learning_language) WHERE is_active;

-- =============================================================================
-- 2. CHECKPOINTS = a ÁRVORE adaptativa (dado, não lógica no código)
-- =============================================================================
-- Cada checkpoint aponta, em caso de PASS ou FAIL, para OUTRO checkpoint
-- (continua o teste) OU para um nível terminal (resultado). Exatamente um dos
-- dois lados deve estar preenchido por resultado. Ex. inglês V1:
--   A2:  pass→level A2 | fail→level A1
--   B1:  pass→cp B2    | fail→cp A2
--   B2:  pass→cp C1    | fail→level B1
--   C1:  pass→cp C2_GATE | fail→level B2
--   C2_GATE: pass→level C2 | fail→level C1
CREATE TABLE IF NOT EXISTS public.placement_checkpoints (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_test_id       uuid NOT NULL REFERENCES public.placement_tests(id) ON DELETE CASCADE,
  checkpoint_key          text NOT NULL,          -- 'A2','B1','B2','C1','C2_GATE'
  kind                    text NOT NULL CHECK (kind IN ('objective','c2_gate')),
  sort_order              integer NOT NULL,
  -- Nº de questões principais antes de decidir PASS/FAIL/desempate (objetivo=2).
  main_question_count     integer NOT NULL DEFAULT 2,
  on_pass_checkpoint_key  text,                   -- próximo checkpoint se PASS
  on_fail_checkpoint_key  text,                   -- próximo checkpoint se FAIL
  on_pass_level_code      text,                   -- nível terminal se PASS
  on_fail_level_code      text,                   -- nível terminal se FAIL
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_placement_checkpoints_key UNIQUE (placement_test_id, checkpoint_key),
  -- PASS resolve para checkpoint OU nível (nunca ambos, nunca nenhum).
  CONSTRAINT ck_placement_pass_exactly_one
    CHECK ((on_pass_checkpoint_key IS NOT NULL) <> (on_pass_level_code IS NOT NULL)),
  CONSTRAINT ck_placement_fail_exactly_one
    CHECK ((on_fail_checkpoint_key IS NOT NULL) <> (on_fail_level_code IS NOT NULL))
);

-- =============================================================================
-- 3. QUESTÕES + ALTERNATIVAS (públicas) + GABARITO (PRIVADO)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.placement_questions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkpoint_id  uuid NOT NULL REFERENCES public.placement_checkpoints(id) ON DELETE CASCADE,
  question_key   text NOT NULL,
  role           text NOT NULL CHECK (role IN ('main','tiebreaker')),
  sort_order     integer NOT NULL,
  prompt_type    text NOT NULL CHECK (prompt_type IN ('single_choice','c2_open')),
  -- Enunciado no IDIOMA ESTUDADO (ex.: a frase em inglês a completar / a tarefa).
  stem           text NOT NULL,
  -- Moldura opcional no idioma da INTERFACE (ex.: "Você está em uma estação...").
  context        text,
  -- Extras data-driven: {time_limit_seconds, step_key} para o C2 aberto etc.
  meta           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_placement_questions_key UNIQUE (checkpoint_id, question_key)
);
CREATE INDEX IF NOT EXISTS idx_placement_questions_checkpoint
  ON public.placement_questions (checkpoint_id);

-- Alternativas VISÍVEIS. NUNCA carregam is_correct (o cliente pode ler estas).
CREATE TABLE IF NOT EXISTS public.placement_question_options (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id  uuid NOT NULL REFERENCES public.placement_questions(id) ON DELETE CASCADE,
  option_key   text NOT NULL,                     -- 'A'..'E' (E = "Não sei")
  sort_order   integer NOT NULL,
  label        text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_placement_options_key UNIQUE (question_id, option_key)
);
CREATE INDEX IF NOT EXISTS idx_placement_options_question
  ON public.placement_question_options (question_id);

-- GABARITO PRIVADO — tabela separada, sem SELECT para authenticated/anon.
-- Só service_role (correção server-side). "Não sei" (E) é sempre incorreta:
-- basta não ser a correta aqui.
CREATE TABLE IF NOT EXISTS public.placement_question_keys (
  question_id         uuid PRIMARY KEY REFERENCES public.placement_questions(id) ON DELETE CASCADE,
  correct_option_key  text NOT NULL
);

-- =============================================================================
-- 4. RUBRICA C2 (estruturada) + COPY DE INTERFACE (data-driven, por idioma)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.placement_c2_rubrics (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_test_id    uuid NOT NULL REFERENCES public.placement_tests(id) ON DELETE CASCADE,
  rubric_version       integer NOT NULL,
  -- Threshold e total máximos (0–10 → 8+ = C2, senão C1).
  pass_threshold       integer NOT NULL,
  max_total            integer NOT NULL,
  -- Template do prompt de avaliação (em public.prompt_templates).
  prompt_template_key  text NOT NULL,
  prompt_version       integer NOT NULL DEFAULT 1,
  -- Critérios: [{key,label,max_score,sort_order,descriptors:{"0","1","2"}}].
  criteria             jsonb NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_placement_rubric_version UNIQUE (placement_test_id, rubric_version)
);

-- Copy da INTERFACE por idioma (títulos, CTAs, resultado). Sem hardcode no React.
-- Placeholders permitidos no corpo: {level} e {language} (substituídos em runtime).
CREATE TABLE IF NOT EXISTS public.placement_ui_copy (
  placement_test_id   uuid NOT NULL REFERENCES public.placement_tests(id) ON DELETE CASCADE,
  interface_language  text NOT NULL REFERENCES public.languages(code),
  copy_key            text NOT NULL,
  body                text NOT NULL,
  PRIMARY KEY (placement_test_id, interface_language, copy_key)
);

-- =============================================================================
-- 5. TENTATIVAS + RESPOSTAS + C2 (estado do usuário)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.placement_attempts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL,
  placement_test_id     uuid NOT NULL REFERENCES public.placement_tests(id),
  test_version          integer NOT NULL,
  learning_language     text NOT NULL REFERENCES public.languages(code),
  -- not_started é a AUSÊNCIA de tentativa; os estados persistidos são estes:
  status                text NOT NULL DEFAULT 'in_progress'
                          CHECK (status IN ('in_progress','skipped','completed','pending_evaluation','abandoned')),
  current_checkpoint_key text,
  raw_result_level_code  text,                    -- resultado bruto do placement
  effective_level_code   text,                    -- nível oficial após max() na conclusão
  started_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  expires_at            timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_placement_attempts_user
  ON public.placement_attempts (user_id, placement_test_id);
-- CONCLUSÃO ÚNICA (§ "Conclusão única"): no máximo UMA tentativa 'completed' por
-- (usuário, teste) — garantido no banco, não só na rota.
CREATE UNIQUE INDEX IF NOT EXISTS uq_placement_one_completed
  ON public.placement_attempts (user_id, placement_test_id) WHERE status = 'completed';
-- No máximo UMA tentativa aberta (in_progress/pending_evaluation) por (user,teste)
-- — evita duplicação em reload/multi-aba.
CREATE UNIQUE INDEX IF NOT EXISTS uq_placement_one_open
  ON public.placement_attempts (user_id, placement_test_id)
  WHERE status IN ('in_progress','pending_evaluation');

-- Respostas objetivas. PRIVADA (sem SELECT para authenticated): guarda is_correct
-- calculado server-side; o cliente nunca lê o gabarito nem "acertou/errou".
-- Uma resposta por questão (não permite voltar e alterar — §16).
CREATE TABLE IF NOT EXISTS public.placement_attempt_answers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id       uuid NOT NULL REFERENCES public.placement_attempts(id) ON DELETE CASCADE,
  question_id      uuid NOT NULL REFERENCES public.placement_questions(id),
  checkpoint_key   text NOT NULL,
  selected_option_key text NOT NULL,
  is_correct       boolean NOT NULL,
  answered_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_placement_answer_once UNIQUE (attempt_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_placement_answers_attempt
  ON public.placement_attempt_answers (attempt_id);

-- Respostas abertas do C2 Gate (texto do próprio usuário — dono pode ler).
CREATE TABLE IF NOT EXISTS public.placement_c2_responses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id     uuid NOT NULL REFERENCES public.placement_attempts(id) ON DELETE CASCADE,
  step_key       text NOT NULL,                   -- 'manager' | 'friend'
  response_text  text NOT NULL,
  submitted_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_placement_c2_step UNIQUE (attempt_id, step_key)
);

-- Avaliação estruturada do C2 (privada — só service_role).
CREATE TABLE IF NOT EXISTS public.placement_c2_evaluations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id     uuid NOT NULL UNIQUE REFERENCES public.placement_attempts(id) ON DELETE CASCADE,
  rubric_version integer NOT NULL,
  prompt_version integer NOT NULL,
  scores         jsonb NOT NULL,
  total          integer NOT NULL,
  decision       text NOT NULL,                   -- 'C1' | 'C2'
  reason_codes   jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider       text,
  model          text,
  raw_output     jsonb,
  evaluated_at   timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- 6. RLS + GRANTS (mesmo padrão da foundation do currículo)
-- =============================================================================

-- --- Conteúdo do teste: leitura autenticada (SEM gabarito) ---
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'placement_tests','placement_checkpoints','placement_questions',
    'placement_question_options','placement_c2_rubrics','placement_ui_copy'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon;', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated;', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role;', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS placement_content_read ON public.placement_tests;
CREATE POLICY placement_content_read ON public.placement_tests FOR SELECT TO authenticated USING (is_active);
DROP POLICY IF EXISTS placement_content_read ON public.placement_checkpoints;
CREATE POLICY placement_content_read ON public.placement_checkpoints FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS placement_content_read ON public.placement_questions;
CREATE POLICY placement_content_read ON public.placement_questions FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS placement_content_read ON public.placement_question_options;
CREATE POLICY placement_content_read ON public.placement_question_options FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS placement_content_read ON public.placement_c2_rubrics;
CREATE POLICY placement_content_read ON public.placement_c2_rubrics FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS placement_content_read ON public.placement_ui_copy;
CREATE POLICY placement_content_read ON public.placement_ui_copy FOR SELECT TO authenticated USING (true);

-- --- GABARITO: PRIVADO. RLS on, sem GRANT/policy para authenticated. ---
ALTER TABLE public.placement_question_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.placement_question_keys FROM anon;
REVOKE ALL ON public.placement_question_keys FROM authenticated;
GRANT ALL ON public.placement_question_keys TO service_role;
-- Nenhuma policy criada → RLS nega SELECT a qualquer authenticated. A correção
-- ocorre SEMPRE server-side (service_role), nunca no cliente.

-- --- Tentativas: dono lê a própria. Escritas server-authoritative. ---
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['placement_attempts','placement_c2_responses'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon;', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated;', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role;', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS placement_owns_row ON public.placement_attempts;
CREATE POLICY placement_owns_row ON public.placement_attempts
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
-- c2_responses: dono lê via join à sua tentativa.
DROP POLICY IF EXISTS placement_owns_row ON public.placement_c2_responses;
CREATE POLICY placement_owns_row ON public.placement_c2_responses
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.placement_attempts a
            WHERE a.id = attempt_id AND a.user_id = auth.uid())
  );

-- --- Respostas objetivas + avaliação C2: PRIVADAS (só service_role). ---
-- placement_attempt_answers carrega is_correct → nunca exposto ao cliente
-- (evita inferir o gabarito). placement_c2_evaluations idem (scores/decisão
-- chegam ao cliente apenas pela rota, agregados).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['placement_attempt_answers','placement_c2_evaluations'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon;', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM authenticated;', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role;', t);
  END LOOP;
END $$;

-- =============================================================================
-- 7. RPC: aplicar o resultado do placement SEM NUNCA rebaixar (monotônico)
-- =============================================================================
-- Posiciona o usuário no INÍCIO do nível alvo marcando como CONCLUÍDOS todos os
-- recortes dos níveis ABAIXO do alvo (proficiency_levels.sort_order) e rodando
-- resync_curriculum_progress. Só INSERE completions (ON CONFLICT DO NOTHING) —
-- nunca remove — então o ponteiro só avança. Se o usuário já está acima do alvo,
-- nada muda: effective = max(nível_atual, alvo), sem caso especial.
-- SECURITY DEFINER + advisory lock por (user,versão), coerente com resync.
CREATE OR REPLACE FUNCTION public.placement_apply_result_v1(
  p_user_id uuid,
  p_curriculum_version_id uuid,
  p_target_level_code text
) RETURNS TABLE(effective_level_code text, current_subtopic_id uuid, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_framework   text;
  v_target_sort integer;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_user_id::text || '|' || p_curriculum_version_id::text, 0)
  );

  SELECT c.framework_id INTO v_framework
  FROM curriculum_versions cv
  JOIN curricula c ON c.id = cv.curriculum_id
  WHERE cv.id = p_curriculum_version_id;

  IF v_framework IS NULL THEN
    RAISE EXCEPTION 'placement_apply_result_v1: unknown curriculum_version %', p_curriculum_version_id;
  END IF;

  SELECT pl.sort_order INTO v_target_sort
  FROM proficiency_levels pl
  WHERE pl.framework_id = v_framework AND pl.code = p_target_level_code;

  IF v_target_sort IS NULL THEN
    RAISE EXCEPTION 'placement_apply_result_v1: unknown level % for framework %',
      p_target_level_code, v_framework;
  END IF;

  -- MONOTÔNICO: só ADICIONA completions dos recortes cujos níveis estão
  -- ESTRITAMENTE abaixo do alvo. Nunca remove nada.
  INSERT INTO user_subtopic_completion (user_id, subtopic_id)
  SELECT p_user_id, s.id
  FROM curriculum_subtopics s
  JOIN proficiency_levels pl
    ON pl.framework_id = v_framework AND pl.code = s.level_code
  WHERE s.curriculum_version_id = p_curriculum_version_id
    AND pl.sort_order < v_target_sort
  ON CONFLICT (user_id, subtopic_id) DO NOTHING;

  -- Recomputa ponteiro + nível oficial a partir das completions persistidas
  -- (aditivo; nunca regride). Reusa a mesma autoridade do currículo.
  PERFORM public.resync_curriculum_progress(p_user_id, p_curriculum_version_id);

  RETURN QUERY
    SELECT g.current_level_code, g.current_subtopic_id, g.status
    FROM user_curriculum_progress g
    WHERE g.user_id = p_user_id AND g.curriculum_version_id = p_curriculum_version_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.placement_apply_result_v1(uuid, uuid, text) FROM public;
REVOKE ALL ON FUNCTION public.placement_apply_result_v1(uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.placement_apply_result_v1(uuid, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.placement_apply_result_v1(uuid, uuid, text) TO service_role;

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
