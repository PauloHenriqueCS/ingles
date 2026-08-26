-- =============================================================================
-- MIGRATION: 20260826140000_conversation_language_mode_generalize
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml
-- (supabase db push). Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO:
--   Generalizar conversation_language_mode para NÃO codificar um par de idiomas
--   específico e mover a diretriz pedagógica bilíngue do TypeScript para a
--   arquitetura data-driven de templates (public.prompt_templates), como
--   conversation.tutor / conversation.free.
--
--   Valores generalizados:
--     - 'target_only'        (equivalente ao antigo 'english_only')
--     - 'bilingual_support'  (equivalente ao antigo 'bilingual_pt_en')
--
--   1. Relaxa o CHECK das duas colunas para aceitar os valores NOVOS e os
--      LEGADOS (união), sem quebrar linhas/histórico existentes.
--   2. Normaliza APENAS a PREFERÊNCIA do usuário (ai_conversation_preferences —
--      última escolha, mutável) do legado para o formato generalizado. As linhas
--      de conversation_session_authorizations (registro/histórico de sessão) NÃO
--      são reescritas; o CHECK em união mantém-nas válidas e o resolver aceita
--      legado na leitura.
--   3. Semeia o template conversa-suporte-bilíngue (conversation.bilingual_support)
--      no MESMO mecanismo dos demais: o servidor compõe base (tutor/free) +
--      este complemento. O par de idiomas e os nomes amigáveis são
--      interpolados pelo backend ({{target_label}}, {{support_label}}, {{level}}).
--      Idiomas futuros = mais uma linha de template (data), sem mudar código.
--
-- Não altera contabilização de minutos, crédito curricular, retomada nem
-- histórico. Aditivo/retrocompatível.
-- =============================================================================

-- 1. Relaxar os CHECKs (drop de QUALQUER check da coluna, depois recriar em união)
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT rel.relname AS table_name, con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname IN ('conversation_session_authorizations', 'ai_conversation_preferences')
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%conversation_language_mode%'
  LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', r.table_name, r.conname);
  END LOOP;
END $$;

ALTER TABLE public.conversation_session_authorizations
  ADD CONSTRAINT conversation_session_authorizations_conversation_language_mode_check
  CHECK (
    conversation_language_mode IS NULL
    OR conversation_language_mode IN (
      'target_only', 'bilingual_support',      -- generalizado (formato final)
      'english_only', 'bilingual_pt_en'        -- legado (compat. temporária)
    )
  );

ALTER TABLE public.ai_conversation_preferences
  ADD CONSTRAINT ai_conversation_preferences_conversation_language_mode_check
  CHECK (
    conversation_language_mode IS NULL
    OR conversation_language_mode IN (
      'target_only', 'bilingual_support',
      'english_only', 'bilingual_pt_en'
    )
  );

-- 2. Normalizar a PREFERÊNCIA (mutável) para o formato generalizado.
--    Não tocamos nas autorizações (histórico) — o CHECK em união as mantém válidas.
UPDATE public.ai_conversation_preferences
  SET conversation_language_mode = 'target_only'
  WHERE conversation_language_mode = 'english_only';
UPDATE public.ai_conversation_preferences
  SET conversation_language_mode = 'bilingual_support'
  WHERE conversation_language_mode = 'bilingual_pt_en';

-- 3. Template data-driven do COMPLEMENTO bilíngue. O corpo é escrito no idioma de
--    APOIO (aqui pt-BR) e parametrizado pelos rótulos ({{target_label}} =
--    idioma-alvo, {{support_label}} = idioma-base) e pelo nível ({{level}}), de
--    modo que NENHUM par de idiomas fica codificado no texto. O backend anexa
--    este bloco às instruções base (tutor/free) apenas em bilingual_support;
--    target_only não resolve nem anexa nada (comportamento histórico intacto).
INSERT INTO public.prompt_templates (
  template_key, learning_language, interface_language, version, status,
  model, temperature, required_placeholders, system_body, user_body
) VALUES (
  'conversation.bilingual_support', 'en', 'pt-BR', 1, 'published',
  NULL, NULL,
  ARRAY['target_label', 'support_label', 'level'],
$tpl$## Modo bilíngue (ATUALIZAÇÃO DA REGRA DE IDIOMA ACIMA — tem prioridade sobre ela)
Esta é uma sessão de tutoria BILÍNGUE {{support_label}}–{{target_label}}. Qualquer instrução anterior de "responder sempre em {{target_label}}" fica AJUSTADA por esta seção. Você é um tutor bilíngue e pode usar {{support_label}} como idioma de APOIO.

Objetivo pedagógico (inalterado): fazer o aluno PRODUZIR {{target_label}}. {{support_label}} é apoio, nunca o idioma predominante da atividade.

Você PODE usar {{support_label}} para:
- explicar uma pergunta que o aluno não entendeu;
- explicar vocabulário, gramática ou uma correção;
- responder quando o aluno disser que não entendeu;
- ajudar o aluno a construir uma frase;
- explicar as instruções da atividade.

Regras:
- Depois de explicar em {{support_label}}, sempre reconduza o aluno a responder em {{target_label}} (ex.: "Agora tente responder em {{target_label}}: …").
- Prefira {{target_label}} durante a prática; use {{support_label}} apenas quando ajudar de fato. Não responda longamente em {{support_label}} quando uma explicação curta resolver, e nunca conduza a atividade inteira em {{support_label}}.
- Exemplos, frases sugeridas, vocabulário-alvo e as respostas que o aluno deve praticar permanecem em {{target_label}}.
- Correções devem mostrar claramente a forma correta em {{target_label}}; a explicação da correção pode ser em {{support_label}}.
- Quando o aluno perguntar "como eu falo X?", forneça a expressão em {{target_label}} e incentive-o a usá-la.
- Adapte a complexidade e a velocidade ao nível do aluno ({{level}}): em níveis iniciais (A1/A2), use frases curtas, explicações breves e mais apoio em {{support_label}}; em níveis mais altos, reduza progressivamente a dependência de {{support_label}} e prefira {{target_label}}.$tpl$,
  NULL
)
ON CONFLICT (template_key, learning_language, interface_language, version)
DO UPDATE SET status=EXCLUDED.status, model=EXCLUDED.model, temperature=EXCLUDED.temperature,
  required_placeholders=EXCLUDED.required_placeholders, system_body=EXCLUDED.system_body,
  user_body=EXCLUDED.user_body, updated_at=now();

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
