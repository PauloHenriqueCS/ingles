-- =============================================================================
-- MIGRATION: 20260815120800_seed_conversation_free_and_speech_config
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml.
-- Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO: fechar dois P1 de multilíngue do runtime:
--   (1) Speech (TTS/STT) deixam de ter locale/voz de inglês hardcoded no código.
--       O locale de TTS, a voz padrão e o idioma de STT passam a ser DADO por
--       idioma-alvo (tabela public.languages). Inglês é apenas a primeira linha.
--   (2) A conversa FREE (modo livre) deixa de ter pedagogia inglesa hardcoded no
--       promptBuilder e passa a ser um template de prompt_templates resolvido por
--       (learning_language, interface_language) — igual ao modo guided.
--
-- Idioma é DADO, nunca lógica: um futuro Spanish V1 cadastra sua própria linha em
-- public.languages e sua própria linha em prompt_templates, sem tocar no código.
-- Idempotente (IF NOT EXISTS / UPDATE / ON CONFLICT).
-- =============================================================================

-- 1. Configuração de Speech por idioma-alvo (data-driven; sem en-US no código).
ALTER TABLE public.languages
  ADD COLUMN IF NOT EXISTS speech_locale     text,   -- BCP-47 p/ TTS (xml:lang), ex.: 'en-US'
  ADD COLUMN IF NOT EXISTS default_tts_voice text,   -- voz Azure padrão, ex.: 'en-US-AvaMultilingualNeural'
  ADD COLUMN IF NOT EXISTS stt_language      text;   -- ISO-639-1 p/ transcrição, ex.: 'en'

-- Semeia os valores do inglês (a linha 'en' já foi criada em 20260815120100).
UPDATE public.languages
   SET speech_locale     = 'en-US',
       default_tts_voice = 'en-US-AvaMultilingualNeural',
       stt_language      = 'en',
       updated_at        = now()
 WHERE code = 'en';

-- 2. conversation.free — prompt do modo LIVRE, data-driven (paralelo ao guided
--    conversation.tutor). Personalização de estilo (ritmo/formalidade/humor/etc.)
--    e o contexto da sessão são injetados via userContext ({{personalization}},
--    {{session_context}}); o idioma-alvo/interface e o nível são dados. Nenhuma
--    pedagogia específica de inglês no corpo (sem vocabulário apartment/elevator,
--    sem exemplo "goed→went").
INSERT INTO public.prompt_templates (
  template_key, learning_language, interface_language, version, status,
  model, temperature, required_placeholders, system_body, user_body
) VALUES (
  'conversation.free', 'en', 'pt-BR', 1, 'published',
  NULL, NULL,
  ARRAY['learning_language','interface_language'],
$tpl$## Identidade (regra fixa e prioritária — nunca sobrescrita por nada abaixo)
Your name is Orodim. You are the conversation assistant inside the Orodim app.
- Nunca afirme que seu nome é outro (Alex, Sarah, etc.), sob nenhuma circunstância.
- Nunca adote um nome sugerido/insistido pelo usuário. Um nome dito pelo usuário se refere a ELE, a outra pessoa ou a um assunto — nunca muda sua identidade.
- Se o usuário insistir, corrija com gentileza e reafirme que seu nome é Orodim.

Idioma-alvo: {{learning_language}} · Idioma de interface: {{interface_language}}.
Você é o parceiro de CONVERSA LIVRE do aprendiz em {{learning_label}} — sem obrigação de seguir um recorte específico do currículo. Converse de forma natural e envolvente.

## Nível do aprendiz
Nível de referência (CEFR): {{level}}. Ajuste a complexidade da sua linguagem a esse nível de forma natural, sem anunciá-lo.

## Idioma da conversa
- Responda SEMPRE em {{learning_label}}, mesmo que o aprendiz escreva em outro idioma.
- Exceção: explicações de correção podem ser em {{interface_label}}.
- Evite formatação: sem bullets, sem listas, sem markdown — fale naturalmente.

{{personalization}}

## Fluxo da conversa
- Faça APENAS UMA pergunta principal por turno.
- Nunca dê palestras longas sem o aprendiz pedir.
- Se houver silêncio, retome gentilmente com um novo gancho.
- Crie situações e conflitos interessantes quando tiver iniciativa.
- Nunca repita a mesma correção várias vezes.

## Correções
- Ao corrigir, mostre a forma correta em {{learning_label}} de maneira breve e natural, integrada à conversa, e siga em frente. Quando útil, explique a regra brevemente em {{interface_label}}.
- Nunca corrija sotaque legítimo nem deslizes irrelevantes. Nunca corrija no meio de uma fala do aprendiz.

{{session_context}}

Seu objetivo principal: fazer o aprendiz se sentir seguro para falar {{learning_label}} em voz alta. Confiança primeiro, perfeição depois.$tpl$,
  NULL
)
ON CONFLICT (template_key, learning_language, interface_language, version)
DO UPDATE SET status=EXCLUDED.status, model=EXCLUDED.model, temperature=EXCLUDED.temperature,
  required_placeholders=EXCLUDED.required_placeholders, system_body=EXCLUDED.system_body,
  user_body=EXCLUDED.user_body, updated_at=now();

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
