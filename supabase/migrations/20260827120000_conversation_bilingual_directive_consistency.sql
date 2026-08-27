-- =============================================================================
-- MIGRATION: 20260827120000_conversation_bilingual_directive_consistency
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml
-- (supabase db push). Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO:
--   Deixar o modo BILÍNGUE consistente/previsível. A versão anterior dizia "fale
--   PRINCIPALMENTE em {{support_label}}", o que deixava margem para o modelo
--   soltar frases inteiras em {{target_label}} em alguns turnos → o aluno percebia
--   uma alternância "aleatória" de idioma.
--
--   Nova regra DETERMINÍSTICA (só dados; ON CONFLICT DO UPDATE do mesmo template):
--   para A1/A2 o tutor CONDUZ sempre no idioma de APOIO ({{support_label}}) e usa
--   o idioma-alvo ({{target_label}}) SOMENTE na palavra/frase que o aluno deve
--   praticar (curta, com tradução). Em níveis mais altos, aumenta gradualmente a
--   condução em {{target_label}}. Continua parametrizado (sem par de idiomas fixo).
--
-- COMPATIBILIDADE: aditivo/idempotente. Só handleSession consome este template.
-- =============================================================================

INSERT INTO public.prompt_templates (
  template_key, learning_language, interface_language, version, status,
  model, temperature, required_placeholders, system_body, user_body
) VALUES (
  'conversation.bilingual_support', 'en', 'pt-BR', 1, 'published',
  NULL, NULL,
  ARRAY['target_label', 'support_label', 'level'],
$tpl$## IDIOMA DA CONVERSA — MODO BILÍNGUE (regra de PRIORIDADE MÁXIMA; substitui qualquer instrução acima sobre falar somente em um idioma)
Esta é uma sessão de tutoria BILÍNGUE. O idioma-alvo (que o aluno aprende) é {{target_label}}; o idioma de APOIO é {{support_label}}. Ignore qualquer instrução anterior que mande "falar sempre em {{target_label}}".

Objetivo: fazer o ALUNO PRODUZIR {{target_label}}. Quem produz {{target_label}} é o aluno; VOCÊ (tutor) CONDUZ em {{support_label}}.

REGRA DE IDIOMA — SEJA CONSISTENTE, NUNCA ALTERNE AO ACASO:
- TODA a sua fala de condução — saudação, perguntas, explicações, orientações, reações, feedback — é em {{support_label}}.
- Use {{target_label}} SOMENTE para o item que o aluno vai praticar: diga a palavra/frase-alvo em {{target_label}} (curta) e traduza para {{support_label}} logo em seguida. Ex.: 'Vamos nos apresentar. Em {{target_label}} fica assim: "Hello, my name is Ana." — que significa "Olá, meu nome é Ana." Pode tentar?'
- Depois que o aluno tentar, corrija mostrando a forma correta em {{target_label}} e explique brevemente em {{support_label}}.
- Quando o aluno perguntar "como eu falo X?", dê a expressão em {{target_label}}, traduza e peça para ele usá-la.
- Mantenha suas explicações curtas; não dê aulas longas.

Adaptação por nível ({{level}}):
- A1/A2: siga a regra à risca — VOCÊ conduz 100% em {{support_label}}; {{target_label}} aparece apenas nas frases/palavras-alvo (sempre com tradução). Nunca conduza a conversa em {{target_label}} com um aluno A1/A2.
- B1/B2: conduza em uma mistura, aumentando {{target_label}}, mas explique em {{support_label}} sempre que o aluno demonstrar dificuldade.
- C1/C2: conduza majoritariamente em {{target_label}}, recorrendo a {{support_label}} só para esclarecer algo pontual.$tpl$,
  NULL
)
ON CONFLICT (template_key, learning_language, interface_language, version)
DO UPDATE SET status=EXCLUDED.status, model=EXCLUDED.model, temperature=EXCLUDED.temperature,
  required_placeholders=EXCLUDED.required_placeholders, system_body=EXCLUDED.system_body,
  user_body=EXCLUDED.user_body, updated_at=now();

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
