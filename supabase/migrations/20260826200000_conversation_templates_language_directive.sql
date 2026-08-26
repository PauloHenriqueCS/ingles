-- =============================================================================
-- MIGRATION: 20260826200000_conversation_templates_language_directive
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml
-- (supabase db push). Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO:
--   Fazer a escolha de idioma (target_only vs bilingual_support) REALMENTE
--   chegar ao agente no modo GUIADO. O template conversation.tutor tinha uma
--   regra de idioma HARDCODED e não-negociável ("=== OUTPUT LANGUAGE
--   (NON-NEGOTIABLE) === ... Never switch the conversation itself to
--   {{interface_language_name}}"), que sobrepunha o complemento bilíngue anexado
--   → no bilíngue o tutor continuava só em inglês.
--
--   Substitui a regra de idioma hardcoded (em conversation.tutor E
--   conversation.free) por um único placeholder data-driven
--   {{conversation_language_directive}}, preenchido pelo backend conforme o modo:
--     - target_only  → a MESMA regra forte "somente no idioma-alvo" (comportamento
--                      atual preservado);
--     - bilingual_support → a diretriz proativa bilíngue (conversation.bilingual_support).
--   Assim há UMA única regra de idioma coerente, sem contradição.
--
--   Usa replace() sobre o texto exato atual (idempotente: se já aplicado, o
--   replace não encontra nada). required_placeholders só passa a exigir o novo
--   placeholder QUANDO o corpo realmente o contém (guarda contra divergência).
--
-- COMPATIBILIDADE: aditivo/idempotente. Só handleSession consome estes templates.
-- =============================================================================

-- conversation.tutor (guided): remove a frase "Speak in ..." e o bloco
-- NON-NEGOTIABLE; ambos viram {{conversation_language_directive}}.
UPDATE public.prompt_templates SET
  system_body = replace(
    replace(
      system_body,
      $from1$Speak in {{learning_language_name}}. Keep it level-appropriate for {{level}}. Provoke situations that require the target capability. Correction explanations may be given in {{interface_language_name}}.$from1$,
      $to1$Keep it level-appropriate for {{level}}. Provoke situations that require the target capability.$to1$
    ),
    $from2$=== OUTPUT LANGUAGE (NON-NEGOTIABLE) ===
Speak to the learner only in {{learning_language_name}}. Only brief correction explanations may use {{interface_language_name}}. Never switch the conversation itself to {{interface_language_name}}.$from2$,
    $to2${{conversation_language_directive}}$to2$
  ),
  updated_at = now()
WHERE template_key = 'conversation.tutor'
  AND learning_language = 'en' AND interface_language = 'pt-BR';

-- conversation.free: as duas linhas de "## Idioma da conversa" viram o placeholder
-- (mantém a linha "Evite formatação").
UPDATE public.prompt_templates SET
  system_body = replace(
    system_body,
    $ff$- Responda SEMPRE em {{learning_label}}, mesmo que o aprendiz escreva em outro idioma.
- Exceção: explicações de correção podem ser em {{interface_label}}.$ff$,
    $ft${{conversation_language_directive}}$ft$
  ),
  updated_at = now()
WHERE template_key = 'conversation.free'
  AND learning_language = 'en' AND interface_language = 'pt-BR';

-- Exigir o novo placeholder APENAS onde o corpo realmente passou a contê-lo.
UPDATE public.prompt_templates
  SET required_placeholders =
    (SELECT array_agg(DISTINCT p) FROM unnest(
       required_placeholders || ARRAY['conversation_language_directive']
     ) AS p),
    updated_at = now()
WHERE template_key IN ('conversation.tutor', 'conversation.free')
  AND learning_language = 'en' AND interface_language = 'pt-BR'
  AND system_body LIKE '%{{conversation_language_directive}}%'
  AND NOT ('conversation_language_directive' = ANY(required_placeholders));

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
