-- =============================================================================
-- MIGRATION: 20260815120200_seed_prompt_templates_english_v1
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml.
-- Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO: mover os PROMPTS pedagógicos de runtime para o banco (data-driven).
-- Estes templates são para (learning_language='en', interface_language='pt-BR'),
-- a configuração atual do produto. Cadastrar outra língua = inserir novas linhas
-- aqui com outro (learning_language, interface_language) — SEM tocar no código.
--
-- Placeholders {{...}} são interpolados pelo compositor genérico
-- (src/domain/curriculum-engine/prompt-composer.ts). Valores disponíveis:
--   learning_language, interface_language, level, module_key, module_title,
--   module_capability, subtopic_key, subtopic_capability, language_targets,
--   transversal_targets, rule.<chave da regra de nível>, + contexto do usuário.
--
-- IMPORTANTE: nenhum fallback de inglês hardcoded no código. Template ausente
-- ou placeholder obrigatório vazio => erro operacional explícito (ver
-- CurriculumConfigError / TemplateValidationError). Idempotente (ON CONFLICT).
-- =============================================================================

-- writing.generate_topic ------------------------------------------------------
INSERT INTO public.prompt_templates (
  template_key, learning_language, interface_language, version, status,
  model, temperature, required_placeholders, system_body, user_body
) VALUES (
  'writing.generate_topic', 'en', 'pt-BR', 1, 'published',
  NULL, 0.88,
  ARRAY['learning_language','level','subtopic_capability'],
$tpl$Você é um professor particular de {{learning_language}} para alunos cujo idioma de interface é {{interface_language}}.

Crie uma MISSÃO DE ESCRITA de nível {{level}} que leve o aluno a praticar naturalmente a seguinte capacidade comunicativa (NÃO é um exercício de gramática isolada):

CAPACIDADE ALVO: {{subtopic_capability}}
CONTEXTO DO MÓDULO: {{module_capability}}
SUPORTE LINGUÍSTICO (use como apoio, não como tema): {{language_targets}}

Regras:
- A situação deve exigir naturalmente a capacidade alvo.
- A gramática é suporte para a capacidade, nunca o objetivo declarado.
- Adeque vocabulário e complexidade ao nível {{level}}.
- Nunca peça explicitamente ao aluno para "usar" uma estrutura gramatical.
- Escreva a instrução ao aluno em {{interface_language}}; o texto a ser produzido é em {{learning_language}}.
Responda apenas com o JSON da missão.$tpl$,
  $tpl$Gere a missão de escrita agora.$tpl$
)
ON CONFLICT (template_key, learning_language, interface_language, version)
DO UPDATE SET status=EXCLUDED.status, model=EXCLUDED.model, temperature=EXCLUDED.temperature,
  required_placeholders=EXCLUDED.required_placeholders, system_body=EXCLUDED.system_body,
  user_body=EXCLUDED.user_body, updated_at=now();

-- pronunciation.generate_text -------------------------------------------------
INSERT INTO public.prompt_templates (
  template_key, learning_language, interface_language, version, status,
  model, temperature, required_placeholders, system_body, user_body
) VALUES (
  'pronunciation.generate_text', 'en', 'pt-BR', 1, 'published',
  NULL, 0.9,
  ARRAY['learning_language','level','subtopic_capability'],
$tpl$You write short texts in {{learning_language}} for pronunciation practice at CEFR level {{level}}.

The text must let the learner naturally practise this communicative capability:
CAPABILITY: {{subtopic_capability}}
SUPPORTING LANGUAGE: {{language_targets}}

Rules:
- Write a vivid, specific scenario appropriate to level {{level}}.
- Keep vocabulary and grammar level-appropriate; do not inflate difficulty.
- Output only the text to be read aloud, in {{learning_language}}.$tpl$,
  $tpl$Write the text now.$tpl$
)
ON CONFLICT (template_key, learning_language, interface_language, version)
DO UPDATE SET status=EXCLUDED.status, model=EXCLUDED.model, temperature=EXCLUDED.temperature,
  required_placeholders=EXCLUDED.required_placeholders, system_body=EXCLUDED.system_body,
  user_body=EXCLUDED.user_body, updated_at=now();

-- listening.two_part_generate -------------------------------------------------
INSERT INTO public.prompt_templates (
  template_key, learning_language, interface_language, version, status,
  model, temperature, required_placeholders, system_body, user_body
) VALUES (
  'listening.two_part_generate', 'en', 'pt-BR', 1, 'published',
  NULL, 0.8,
  ARRAY['learning_language','level','subtopic_capability'],
$tpl$Generate a listening comprehension activity in {{learning_language}} for a CEFR {{level}} learner.

The story must let the learner practise this communicative capability:
CAPABILITY: {{subtopic_capability}}
SUPPORTING LANGUAGE: {{language_targets}}

The activity is ONE continuous story divided into exactly 2 parts, each followed by one comprehension question with 5 options. Explanations must be written in {{interface_language}}. Vocabulary and grammar appropriate for {{level}}. Do NOT include a translation of the story text.$tpl$,
  $tpl$Generate the listening activity now.$tpl$
)
ON CONFLICT (template_key, learning_language, interface_language, version)
DO UPDATE SET status=EXCLUDED.status, model=EXCLUDED.model, temperature=EXCLUDED.temperature,
  required_placeholders=EXCLUDED.required_placeholders, system_body=EXCLUDED.system_body,
  user_body=EXCLUDED.user_body, updated_at=now();

-- conversation.tutor (guided curricular practice) -----------------------------
INSERT INTO public.prompt_templates (
  template_key, learning_language, interface_language, version, status,
  model, temperature, required_placeholders, system_body, user_body
) VALUES (
  'conversation.tutor', 'en', 'pt-BR', 1, 'published',
  NULL, NULL,
  ARRAY['learning_language','level','subtopic_capability'],
$tpl$You are a conversation tutor helping the user practise {{learning_language}} at CEFR level {{level}}.

Guide the conversation so the user must practise this communicative capability:
CAPABILITY: {{subtopic_capability}}
SUPPORTING LANGUAGE: {{language_targets}}

Speak in {{learning_language}}. Keep it level-appropriate for {{level}}. Provoke situations that require the target capability. Correction explanations may be given in {{interface_language}}.$tpl$,
  NULL
)
ON CONFLICT (template_key, learning_language, interface_language, version)
DO UPDATE SET status=EXCLUDED.status, model=EXCLUDED.model, temperature=EXCLUDED.temperature,
  required_placeholders=EXCLUDED.required_placeholders, system_body=EXCLUDED.system_body,
  user_body=EXCLUDED.user_body, updated_at=now();

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
