-- =============================================================================
-- MIGRATION: 20260815121900_conversation_personality_and_variants
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml
-- (supabase db push). Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO:
--   (blocker 4) O preset de PERSONALIDADE (patient/friend/teacher/
--   unfiltered_friend/custom) — que o builder antigo aplicava e a migração
--   data-driven havia perdido — volta como DADO em conversation_pref_fragments
--   (dimension='personality'), localizado por interface_language. Nenhum texto
--   pedagógico dependente de idioma volta ao TypeScript.
--   (blocker 5) A VARIANTE/sotaque deixa de ser um catálogo inglês fixo e passa
--   a ser DADO por learning_language em conversation_language_variants. Inglês
--   mantém american/british/neutral; um futuro Spanish cadastra as SUAS
--   variantes por dados, sem tocar em union/switch/validator/builder. (Aqui só
--   semeamos inglês — a fixture de espanhol vive nos testes, nunca em produção.)
--
-- COMPATIBILIDADE: aditivo, idempotente. RLS de leitura para authenticated.
-- =============================================================================

-- ── (4) Fragmentos de personalidade (a identidade "Orodim" é regra de produto) ─
INSERT INTO public.conversation_pref_fragments (dimension, value, interface_language, label, text) VALUES
('personality','patient','pt-BR',NULL,'Você é Orodim, um tutor calmo e acolhedor. Celebre o progresso. Use reforço positivo. Nunca infantilize o aprendiz — trate-o como adulto capaz.'),
('personality','patient','en',NULL,'You are Orodim, a calm, welcoming tutor. Celebrate progress. Use positive reinforcement. Never infantilise the learner — treat them as a capable adult.'),
('personality','friend','pt-BR',NULL,'Você é Orodim, um amigo próximo com quem o aprendiz pratica o idioma-alvo. Seja informal, espontâneo e animado. Convide para histórias e situações interessantes.'),
('personality','friend','en',NULL,'You are Orodim, a close friend the learner practises the target language with. Be informal, spontaneous and lively. Invite stories and interesting situations.'),
('personality','teacher','pt-BR',NULL,'Você é Orodim, um professor dedicado. Seja didático e organizado. Mantenha o foco pedagógico sem deixar de ser humano.'),
('personality','teacher','en',NULL,'You are Orodim, a dedicated teacher. Be didactic and organised. Keep the pedagogical focus while staying human.'),
('personality','unfiltered_friend','pt-BR',NULL,'Você é Orodim, o amigo sem filtro do aprendiz. Zoação alta, linguagem crua, zero formalidade — mas NUNCA humilhação real, ataques pessoais, preconceito ou agressividade de verdade. Corrija erros de forma breve, engraçada e integrada à conversa. Crie situações, conflitos e assuntos interessantes com alta iniciativa.'),
('personality','unfiltered_friend','en',NULL,'You are Orodim, the learner''s no-filter friend. High teasing, raw language, zero formality — but NEVER real humiliation, personal attacks, prejudice or genuine aggression. Correct mistakes briefly, funnily and woven into the chat. Create situations, conflicts and interesting topics with high initiative.'),
('personality','custom','pt-BR',NULL,'Você é Orodim, tutor personalizado do aprendiz.'),
('personality','custom','en',NULL,'You are Orodim, the learner''s personalised tutor.')
ON CONFLICT (dimension, value, interface_language) DO UPDATE SET label = EXCLUDED.label, text = EXCLUDED.text;

-- ── (5) Variante/sotaque como dado por learning_language ─────────────────────
CREATE TABLE IF NOT EXISTS public.conversation_language_variants (
  learning_language  text NOT NULL REFERENCES public.languages(code),
  variant_key        text NOT NULL,      -- casado com a preferência de sotaque do usuário
  interface_language text NOT NULL,
  display_label      text NOT NULL,      -- rótulo para a UI (interface language)
  prompt_text        text NOT NULL,      -- instrução para o modelo
  sort_order         integer NOT NULL DEFAULT 0,
  is_default         boolean NOT NULL DEFAULT false,
  PRIMARY KEY (learning_language, variant_key, interface_language)
);
ALTER TABLE public.conversation_language_variants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conv_lang_variants_read ON public.conversation_language_variants;
CREATE POLICY conv_lang_variants_read ON public.conversation_language_variants
  FOR SELECT TO authenticated USING (true);

-- Inglês: retrocompatível com o enum atual (american/british/neutral). SÓ inglês
-- é semeado aqui — uma futura língua traz suas variantes por dados.
INSERT INTO public.conversation_language_variants (learning_language, variant_key, interface_language, display_label, prompt_text, sort_order, is_default) VALUES
('en','american','pt-BR','Americano','Prefira o vocabulário e as expressões da variante norte-americana do inglês, quando naturais.',1,false),
('en','american','en','American','Prefer North-American English vocabulary and expressions, when natural.',1,false),
('en','british','pt-BR','Britânico','Prefira o vocabulário e as expressões da variante britânica do inglês, quando naturais.',2,false),
('en','british','en','British','Prefer British English vocabulary and expressions, when natural.',2,false),
('en','neutral','pt-BR','Neutro','Use o inglês de forma internacional e clara, sem regionalismos marcados; prefira vocabulário amplamente compreendido.',3,true),
('en','neutral','en','Neutral','Use clear, international English, without marked regionalisms; prefer widely understood vocabulary.',3,true)
ON CONFLICT (learning_language, variant_key, interface_language) DO UPDATE SET display_label = EXCLUDED.display_label, prompt_text = EXCLUDED.prompt_text, sort_order = EXCLUDED.sort_order, is_default = EXCLUDED.is_default;

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
