-- =============================================================================
-- MIGRATION: 20260827130000_conversation_guided_progression
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml
-- (supabase db push). Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO:
--   Corrigir o tutor GUIADO que ficava preso repetindo a MESMA frase-alvo (ex.:
--   pedir "Hello, I'm Paulo, I'm from Brazil, nice to meet you" repetidamente) e
--   não fazia a conversa avançar. Faltava uma regra explícita de PROGRESSÃO /
--   ANTI-REPETIÇÃO no template conversation.tutor.
--
--   Adiciona (via replace() na frase exata; só dados; vale para inglês E
--   bilíngue, pois é o template base do modo guiado) a instrução de: assim que
--   o aluno produzir o alvo, reconhecer e AVANÇAR — variar contexto, fazer
--   pergunta de acompanhamento ou introduzir a próxima estrutura útil — e NUNCA
--   repetir a mesma frase/pedido.
--
-- COMPATIBILIDADE: aditivo/idempotente (se já aplicado, o replace não encontra a
--   frase original e não altera nada). Só handleSession consome este template.
-- =============================================================================

UPDATE public.prompt_templates SET
  system_body = replace(
    system_body,
    $from$Keep it level-appropriate for {{level}}. Provoke situations that require the target capability.$from$,
    $to$Keep it level-appropriate for {{level}}. Provoke situations that require the target capability.

Keep the conversation MOVING FORWARD. As soon as the learner produces the target (even imperfectly), briefly acknowledge it and ADVANCE — vary the context, ask a natural follow-up question, or introduce the next useful phrase within this capability. Build on what the learner just said. NEVER repeat the same sentence or ask for the same thing over and over; each of your turns must bring something new. Do not get stuck drilling a single phrase.$to$
  ),
  updated_at = now()
WHERE template_key = 'conversation.tutor'
  AND learning_language = 'en' AND interface_language = 'pt-BR';

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
