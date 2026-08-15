-- =============================================================================
-- MIGRATION: 20260815121700_conversation_free_context_framing
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml
-- (supabase db push). Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO (blocker 2): agora que buildConversationContextSection emite APENAS
-- DADOS (mission_title / student_text / recent_mistakes / remaining_minutes…), o
-- ENQUADRAMENTO natural ("fale primeiro", "não mencione briefing", como abrir/
-- encerrar) — que antes vivia no TypeScript — passa a viver no TEMPLATE de
-- conversa livre (dado, por interface_language). Aqui injetamos esse
-- enquadramento imediatamente ANTES do {{session_context}} da linha en/pt-BR.
--
-- COMPATIBILIDADE: aditivo, idempotente (só injeta se o marcador ainda não
-- existir). O enquadramento aqui é em PORTUGUÊS, então SÓ se aplica às linhas de
-- interface pt-BR (blocker 9). Uma futura linha de interface=en (ou outra) traz
-- o seu próprio enquadramento no seed do template, nunca PT por este UPDATE.
-- =============================================================================

UPDATE public.prompt_templates
   SET system_body = replace(
         system_body,
         '{{session_context}}',
         E'## Contexto da sessão (dados)\n'
         || E'Os itens abaixo são DADOS da sessão de hoje. Use-os de forma orgânica, como sua memória natural — NUNCA diga ao aprendiz que possui um "contexto" ou "briefing".\n'
         || E'Você DEVE falar primeiro, no idioma-alvo, e iniciar imediatamente ao conectar. Se houver `student_text`, comece referenciando-o (comente algo específico e peça mais sobre um aspecto concreto) e depois migre para hipóteses, conflitos, roleplay e opiniões; senão, se houver `mission_title`, comece pelo tema da missão de forma acolhedora e convide a opinião; senão, comece com uma saudação breve e uma pergunta aberta sobre o dia.\n'
         || E'Use `mandatory_words` naturalmente (nunca as liste). Trabalhe `recent_mistakes` e `grammar_objectives` sem anunciá-los. Se `remaining_minutes` estiver baixo, comece a encerrar naturalmente, no idioma-alvo.\n\n'
         || '{{session_context}}'
       ),
       updated_at = now()
 WHERE template_key = 'conversation.free'
   AND interface_language = 'pt-BR'
   AND system_body LIKE '%{{session_context}}%'
   AND system_body NOT LIKE '%## Contexto da sessão (dados)%';

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
