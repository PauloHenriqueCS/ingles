-- =============================================================================
-- MIGRATION: 20260903130000_error_review_multiple_choice
-- Projeto: Orodim
--
-- Aplicada automaticamente por .github/workflows/deploy-production.yml
-- (supabase db push) após o merge na main, e por homologation.yml em develop.
-- Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO: transformar a atividade "Revisar meus erros" em MÚLTIPLA ESCOLHA.
-- O aluno não digita mais: cada erro passa a ter a forma correta + EXATAMENTE 3
-- alternativas incorretas (distratores). Os 3 distratores são gerados UMA vez,
-- na MESMA chamada de IA que já corrige a Escrita (prompt writing.correct) —
-- NUNCA numa chamada extra — e ficam persistidos no card. Revisar um erro (1ª,
-- 2ª, 3ª vez...) NÃO gera nenhuma chamada de IA.
--
-- O QUE ESTA MIGRATION FAZ:
--   1) Ensina o prompt writing.correct a devolver "distractors" dentro de cada
--      item de mainMistakes (in-place, idempotente).
--   2) Adiciona review_group_items.distractors jsonb + CHECK de 3 elementos.
--   3) APAGA todos os erros/revisões antigos (formato incompatível — sem
--      distratores), respeitando as FKs, SEM tocar em dados não relacionados.
--   4) Reescreve get_error_review_session para servir 4 alternativas embaralhadas
--      no servidor (correta + 3 distratores), SEM revelar qual é a correta.
--
-- O QUE ESTA MIGRATION NÃO FAZ (de propósito):
--   * NÃO altera submit_error_review_item. Ele continua sendo a ÚNICA autoridade:
--     recebe o TEXTO da alternativa escolhida e compara com corrected_value via
--     error_review_normalize. Selecionar a alternativa correta => v_sub = v_cor
--     => passou; selecionar um distrator (garantidamente != correta) => não
--     passou. Todo o scheduler, limite diário (teto 10, dia São Paulo), advisory
--     lock e agendamento por item ficam intactos.
--   * NÃO mantém compatibilidade com o formato antigo: os dados antigos são
--     apagados aqui, então TODO item de revisão passa a ter o novo formato.
--
-- LIMPEZA (item #6): a Escrita/histórico (english_reviews) é PAI de review_groups
-- (review_groups.source_review_id -> english_reviews.id ON DELETE CASCADE — o
-- cascade aponta de english_reviews PARA review_groups, nunca o contrário).
-- Portanto apagar review_groups e seus dependentes NÃO apaga o histórico de
-- Escrita. Apagamos apenas o subsistema "Revisar meus erros":
--   review_attempt_items, review_schedule_history, review_item_attempts,
--   review_attempts, review_group_items, review_groups.
--
-- Idempotente. Após aplicar: execute supabase/verify_schema.sql.
-- =============================================================================

-- =====================================================================
-- 1. Prompt writing.correct: exigir 3 distratores por erro (MESMA chamada)
--    In-place e idempotente (guardado por position('"distractors"') = 0), no
--    mesmo estilo de 20260818120000_prompt_templates_language_authority.
--    Injeta o campo no schema JSON de mainMistakes e anexa as regras dos
--    distratores ao fim do system_body.
-- =====================================================================

UPDATE public.prompt_templates
SET system_body =
      replace(
        system_body,
        E'      "explanation": string\n    }\n  ],',
        E'      "explanation": string,\n      "distractors": [string, string, string]\n    }\n  ],'
      )
      || E'\n\n=== ALTERNATIVAS INCORRETAS (distractors) ===\n'
      || E'Para CADA item de mainMistakes, gere também o campo "distractors": EXATAMENTE 3 alternativas INCORRETAS em {{learning_language_name}}, plausíveis para este aluno.\n'
      || E'Regras dos distractors:\n'
      || E'- Exatamente 3, todos diferentes entre si.\n'
      || E'- Nenhum pode ser igual (nem equivalente após ignorar caixa, espaços e pontuação de borda) ao campo "correct".\n'
      || E'- Devem ter formato e comprimento parecidos com "correct" (mesma estrutura de frase/expressão).\n'
      || E'- Devem representar erros que ESTE aluno cometeria de verdade, relacionados especificamente ao erro em "original" (concordância, tempo verbal, preposição, ordem das palavras, etc.).\n'
      || E'- Apenas a forma incorreta: sem explicações, comentários, aspas extras, numeração ou pontuação decorativa.\n'
      || E'- Nada de alternativas absurdas ou sem relação (ex.: "banana", "hello").\n'
      || E'Exemplo — original "I have 20 years", correct "I am 20 years old": "distractors": ["I have 20 years old", "I am have 20 years", "I am 20 year old"].',
    updated_at = now()
WHERE template_key = 'writing.correct'
  AND learning_language = 'en'
  AND interface_language = 'pt-BR'
  AND position('"distractors"' in system_body) = 0;

-- =====================================================================
-- 2. review_group_items.distractors jsonb (o card guarda os 3 distratores)
-- =====================================================================

ALTER TABLE public.review_group_items
  ADD COLUMN IF NOT EXISTS distractors jsonb;

-- =====================================================================
-- 3. LIMPEZA dos erros/revisões antigos (formato sem distratores).
--    Ordem filho -> pai (defensivo; tudo também cascatearia de review_groups).
--    NÃO tocamos em english_reviews / writing_entries (histórico da Escrita).
-- =====================================================================

DELETE FROM public.review_attempt_items;
DELETE FROM public.review_schedule_history;
DELETE FROM public.review_item_attempts;
DELETE FROM public.review_attempts;
DELETE FROM public.review_group_items;
DELETE FROM public.review_groups;

-- =====================================================================
-- 4. CHECK de integridade: todo card DEVE ter exatamente 3 distratores.
--    Adicionado APÓS a limpeza (não há linhas antigas para violar). Garante
--    "TODOS OS ITENS DE REVISÃO POSSUEM O NOVO FORMATO" no nível do banco.
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'review_group_items_distractors_check'
  ) THEN
    ALTER TABLE public.review_group_items
      ADD CONSTRAINT review_group_items_distractors_check
      CHECK (
        distractors IS NOT NULL
        AND jsonb_typeof(distractors) = 'array'
        AND jsonb_array_length(distractors) = 3
      );
  END IF;
END $$;

-- =====================================================================
-- 5. get_error_review_session — agora serve as 4 alternativas embaralhadas.
--    Mesma assinatura, mesma autoridade de dia/limite (São Paulo, teto 10),
--    NÃO consome nada. Cada item retorna "choices": um array de 4 strings
--    (corrected_value + os 3 distractors) EMBARALHADO NO SERVIDOR por item, a
--    cada chamada — a posição da correta não é fixa nem previsível. Nenhum
--    correctIndex / correctOption / passed / flag é retornado: a autoridade
--    continua exclusivamente no submit_error_review_item.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.get_error_review_session(
  p_activity_date date,
  p_daily_limit   integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user      uuid;
  v_day       date;
  v_limit     integer;
  v_consumed  integer;
  v_due_total integer;
  v_available integer;
  v_items     jsonb;
BEGIN
  v_user := auth.uid();
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  -- Dia autoritativo (São Paulo) e limite autoritativo (teto duro de 10).
  v_day   := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_limit := greatest(0, least(COALESCE(p_daily_limit, 10), 10));

  SELECT count(*) INTO v_consumed
  FROM public.review_item_attempts
  WHERE user_id = v_user AND activity_date = v_day;

  SELECT count(*) INTO v_due_total
  FROM public.review_group_items
  WHERE user_id = v_user
    AND status = 'scheduled'
    AND next_review_at IS NOT NULL
    AND next_review_at <= now();

  v_available := greatest(0, v_limit - v_consumed);
  v_available := least(v_available, v_due_total);

  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) INTO v_items
  FROM (
    SELECT rgi.id,
           rgi.original_value    AS "originalValue",
           rgi.original_sentence AS "originalSentence",
           ch.choices
    FROM public.review_group_items rgi
    -- Embaralha, POR ITEM, a forma correta + os 3 distratores em 4 alternativas.
    -- Sem revelar a posição da correta (ORDER BY random() no servidor).
    CROSS JOIN LATERAL (
      SELECT jsonb_agg(c.val ORDER BY random()) AS choices
      FROM jsonb_array_elements_text(
             jsonb_build_array(rgi.corrected_value) || rgi.distractors
           ) AS c(val)
    ) ch
    WHERE rgi.user_id = v_user
      AND rgi.status = 'scheduled'
      AND rgi.next_review_at IS NOT NULL
      AND rgi.next_review_at <= now()
    ORDER BY rgi.next_review_at ASC, rgi.created_at ASC
    LIMIT v_available
  ) t;

  RETURN jsonb_build_object(
    'available',  v_available,
    'dueTotal',   v_due_total,
    'consumed',   v_consumed,
    'dailyLimit', v_limit,
    'items',      v_items
  );
END $$;

REVOKE ALL ON FUNCTION public.get_error_review_session(date, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_error_review_session(date, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_error_review_session(date, integer) TO service_role;

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
