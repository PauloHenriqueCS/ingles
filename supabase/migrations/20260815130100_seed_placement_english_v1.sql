-- =============================================================================
-- MIGRATION: 20260815130100_seed_placement_english_v1
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml
-- (supabase db push --include-all). NÃO aplicar manualmente no SQL Editor.
--
-- OBJETIVO: semear "English Placement V1" — teste ativo para inglês, checkpoints
-- A2/B1/B2/C1 (2 principais + 1 desempate) e C2_GATE (2 tarefas abertas), com
-- alternativas visíveis, GABARITO PRIVADO, árvore adaptativa, rubrica C2, prompt
-- de avaliação e copy de interface (pt-BR). Idempotente (ON CONFLICT DO NOTHING).
--
-- Depende de 20260815130000_placement_foundation.sql. Learning language = 'en'
-- (target); interface = 'pt-BR'. A troca de perguntas no futuro = nova version,
-- preservando tentativas antigas.
-- =============================================================================

-- ── 1) Teste ────────────────────────────────────────────────────────────────
INSERT INTO public.placement_tests
  (slug, learning_language, framework_id, version, title, is_active, start_checkpoint_key, attempt_ttl_seconds)
VALUES
  ('english-placement', 'en', 'CEFR', 1, 'English Placement V1', true, 'B1', 86400)
ON CONFLICT (slug) DO NOTHING;

-- ── 2) Checkpoints = árvore adaptativa ──────────────────────────────────────
INSERT INTO public.placement_checkpoints
  (placement_test_id, checkpoint_key, kind, sort_order, main_question_count,
   on_pass_checkpoint_key, on_fail_checkpoint_key, on_pass_level_code, on_fail_level_code)
SELECT t.id, v.checkpoint_key, v.kind, v.sort_order, v.main_count,
       v.pass_cp, v.fail_cp, v.pass_lvl, v.fail_lvl
FROM public.placement_tests t
CROSS JOIN (VALUES
  --  key       kind         sort main  pass_cp     fail_cp  pass_lvl fail_lvl
  ('A2',      'objective', 1,  2,   NULL::text, NULL::text, 'A2',   'A1'),
  ('B1',      'objective', 2,  2,   'B2',       'A2',       NULL,   NULL),
  ('B2',      'objective', 3,  2,   'C1',       NULL,       NULL,   'B1'),
  ('C1',      'objective', 4,  2,   'C2_GATE',  NULL,       NULL,   'B2'),
  ('C2_GATE', 'c2_gate',   5,  2,   NULL,       NULL,       'C2',   'C1')
) AS v(checkpoint_key, kind, sort_order, main_count, pass_cp, fail_cp, pass_lvl, fail_lvl)
WHERE t.slug = 'english-placement'
ON CONFLICT (placement_test_id, checkpoint_key) DO NOTHING;

-- ── 3) Questões (single_choice) ─────────────────────────────────────────────
-- Helper de leitura: cada INSERT resolve o checkpoint pelo (slug, checkpoint_key).

-- A2.1
INSERT INTO public.placement_questions (checkpoint_id, question_key, role, sort_order, prompt_type, stem, context)
SELECT cp.id, 'A2.1', 'main', 1, 'single_choice',
  E'"Have you ever been to Argentina?"\n"Yes. I ___ there in 2024."', NULL
FROM public.placement_checkpoints cp JOIN public.placement_tests t ON t.id = cp.placement_test_id
WHERE t.slug = 'english-placement' AND cp.checkpoint_key = 'A2'
ON CONFLICT (checkpoint_id, question_key) DO NOTHING;

-- A2.2
INSERT INTO public.placement_questions (checkpoint_id, question_key, role, sort_order, prompt_type, stem, context)
SELECT cp.id, 'A2.2', 'main', 2, 'single_choice',
  'If I finish work early tonight, I ___ you.', NULL
FROM public.placement_checkpoints cp JOIN public.placement_tests t ON t.id = cp.placement_test_id
WHERE t.slug = 'english-placement' AND cp.checkpoint_key = 'A2'
ON CONFLICT (checkpoint_id, question_key) DO NOTHING;

-- A2 desempate
INSERT INTO public.placement_questions (checkpoint_id, question_key, role, sort_order, prompt_type, stem, context)
SELECT cp.id, 'A2.TB', 'tiebreaker', 1, 'single_choice',
  'Excuse me. Could you tell me where the train station ___?',
  'Você está pedindo informação em uma estação.'
FROM public.placement_checkpoints cp JOIN public.placement_tests t ON t.id = cp.placement_test_id
WHERE t.slug = 'english-placement' AND cp.checkpoint_key = 'A2'
ON CONFLICT (checkpoint_id, question_key) DO NOTHING;

-- B1.1
INSERT INTO public.placement_questions (checkpoint_id, question_key, role, sort_order, prompt_type, stem, context)
SELECT cp.id, 'B1.1', 'main', 1, 'single_choice',
  'When I arrived at the airport, the plane ___.',
  'Você está contando o que aconteceu durante uma viagem.'
FROM public.placement_checkpoints cp JOIN public.placement_tests t ON t.id = cp.placement_test_id
WHERE t.slug = 'english-placement' AND cp.checkpoint_key = 'B1'
ON CONFLICT (checkpoint_id, question_key) DO NOTHING;

-- B1.2
INSERT INTO public.placement_questions (checkpoint_id, question_key, role, sort_order, prompt_type, stem, context)
SELECT cp.id, 'B1.2', 'main', 2, 'single_choice',
  'If I ___ more free time, I would learn another language.', NULL
FROM public.placement_checkpoints cp JOIN public.placement_tests t ON t.id = cp.placement_test_id
WHERE t.slug = 'english-placement' AND cp.checkpoint_key = 'B1'
ON CONFLICT (checkpoint_id, question_key) DO NOTHING;

-- B1 desempate
INSERT INTO public.placement_questions (checkpoint_id, question_key, role, sort_order, prompt_type, stem, context)
SELECT cp.id, 'B1.TB', 'tiebreaker', 1, 'single_choice',
  'Ana said that she ___ join the meeting that day.',
  E'Ana disse: "I can''t join the meeting today." Depois você conta isso a outra pessoa:'
FROM public.placement_checkpoints cp JOIN public.placement_tests t ON t.id = cp.placement_test_id
WHERE t.slug = 'english-placement' AND cp.checkpoint_key = 'B1'
ON CONFLICT (checkpoint_id, question_key) DO NOTHING;

-- B2.1
INSERT INTO public.placement_questions (checkpoint_id, question_key, role, sort_order, prompt_type, stem, context)
SELECT cp.id, 'B2.1', 'main', 1, 'single_choice',
  'If I had known about the problem, I ___ the decision.', NULL
FROM public.placement_checkpoints cp JOIN public.placement_tests t ON t.id = cp.placement_test_id
WHERE t.slug = 'english-placement' AND cp.checkpoint_key = 'B2'
ON CONFLICT (checkpoint_id, question_key) DO NOTHING;

-- B2.2 (argumentação contextual)
INSERT INTO public.placement_questions (checkpoint_id, question_key, role, sort_order, prompt_type, stem, context)
SELECT cp.id, 'B2.2', 'main', 2, 'single_choice',
  'Which response presents the most balanced argument?',
  'Você está discutindo se carros deveriam ser proibidos no centro de uma cidade.'
FROM public.placement_checkpoints cp JOIN public.placement_tests t ON t.id = cp.placement_test_id
WHERE t.slug = 'english-placement' AND cp.checkpoint_key = 'B2'
ON CONFLICT (checkpoint_id, question_key) DO NOTHING;

-- B2 desempate
INSERT INTO public.placement_questions (checkpoint_id, question_key, role, sort_order, prompt_type, stem, context)
SELECT cp.id, 'B2.TB', 'tiebreaker', 1, 'single_choice',
  E'Daniel isn''t answering. He ___ the message, but I''m not sure.', NULL
FROM public.placement_checkpoints cp JOIN public.placement_tests t ON t.id = cp.placement_test_id
WHERE t.slug = 'english-placement' AND cp.checkpoint_key = 'B2'
ON CONFLICT (checkpoint_id, question_key) DO NOTHING;

-- C1.1 (nuance / hedging)
INSERT INTO public.placement_questions (checkpoint_id, question_key, role, sort_order, prompt_type, stem, context)
SELECT cp.id, 'C1.1', 'main', 1, 'single_choice',
  'Which sentence represents the conclusion most accurately?',
  'Um estudo encontrou resultados promissores, mas a evidência ainda é insuficiente para uma conclusão definitiva.'
FROM public.placement_checkpoints cp JOIN public.placement_tests t ON t.id = cp.placement_test_id
WHERE t.slug = 'english-placement' AND cp.checkpoint_key = 'C1'
ON CONFLICT (checkpoint_id, question_key) DO NOTHING;

-- C1.2 (diplomacia profissional)
INSERT INTO public.placement_questions (checkpoint_id, question_key, role, sort_order, prompt_type, stem, context)
SELECT cp.id, 'C1.2', 'main', 2, 'single_choice',
  'Which response best fits the situation?',
  'Seu gerente propôs um prazo muito curto. Você quer discordar de forma diplomática, mas precisa deixar claro que o prazo cria um risco real.'
FROM public.placement_checkpoints cp JOIN public.placement_tests t ON t.id = cp.placement_test_id
WHERE t.slug = 'english-placement' AND cp.checkpoint_key = 'C1'
ON CONFLICT (checkpoint_id, question_key) DO NOTHING;

-- C1 desempate
INSERT INTO public.placement_questions (checkpoint_id, question_key, role, sort_order, prompt_type, stem, context)
SELECT cp.id, 'C1.TB', 'tiebreaker', 1, 'single_choice',
  'Rarely ___ such a significant change in such a short period.', NULL
FROM public.placement_checkpoints cp JOIN public.placement_tests t ON t.id = cp.placement_test_id
WHERE t.slug = 'english-placement' AND cp.checkpoint_key = 'C1'
ON CONFLICT (checkpoint_id, question_key) DO NOTHING;

-- C2 Gate — duas tarefas abertas (sem alternativas/gabarito)
INSERT INTO public.placement_questions (checkpoint_id, question_key, role, sort_order, prompt_type, stem, context, meta)
SELECT cp.id, 'C2.manager', 'main', 1, 'c2_open',
  E'You are speaking to your manager.\nSay politely that you think the current plan is too risky and should not be launched yet.',
  NULL, '{"time_limit_seconds": 60, "step_key": "manager"}'::jsonb
FROM public.placement_checkpoints cp JOIN public.placement_tests t ON t.id = cp.placement_test_id
WHERE t.slug = 'english-placement' AND cp.checkpoint_key = 'C2_GATE'
ON CONFLICT (checkpoint_id, question_key) DO NOTHING;

INSERT INTO public.placement_questions (checkpoint_id, question_key, role, sort_order, prompt_type, stem, context, meta)
SELECT cp.id, 'C2.friend', 'main', 2, 'c2_open',
  'Now say the same thing to a close friend, in a natural and informal way.',
  NULL, '{"time_limit_seconds": 45, "step_key": "friend"}'::jsonb
FROM public.placement_checkpoints cp JOIN public.placement_tests t ON t.id = cp.placement_test_id
WHERE t.slug = 'english-placement' AND cp.checkpoint_key = 'C2_GATE'
ON CONFLICT (checkpoint_id, question_key) DO NOTHING;

-- ── 4) Alternativas + gabarito privado ──────────────────────────────────────
-- Alternativas (option E = "Não sei" = sempre incorreta por não constar no key).

INSERT INTO public.placement_question_options (question_id, option_key, sort_order, label)
SELECT q.id, v.option_key, v.sort_order, v.label
FROM public.placement_questions q
JOIN public.placement_checkpoints cp ON cp.id = q.checkpoint_id
JOIN public.placement_tests t ON t.id = cp.placement_test_id
CROSS JOIN (VALUES
  ('A',1,'have gone'),('B',2,'went'),('C',3,'go'),('D',4,'was going'),('E',5,'Não sei')
) AS v(option_key, sort_order, label)
WHERE t.slug = 'english-placement' AND q.question_key = 'A2.1'
ON CONFLICT (question_id, option_key) DO NOTHING;

INSERT INTO public.placement_question_options (question_id, option_key, sort_order, label)
SELECT q.id, v.option_key, v.sort_order, v.label
FROM public.placement_questions q
JOIN public.placement_checkpoints cp ON cp.id = q.checkpoint_id
JOIN public.placement_tests t ON t.id = cp.placement_test_id
CROSS JOIN (VALUES
  ('A',1,'call'),('B',2,'called'),('C',3,'will call'),('D',4,'would call'),('E',5,'Não sei')
) AS v(option_key, sort_order, label)
WHERE t.slug = 'english-placement' AND q.question_key = 'A2.2'
ON CONFLICT (question_id, option_key) DO NOTHING;

INSERT INTO public.placement_question_options (question_id, option_key, sort_order, label)
SELECT q.id, v.option_key, v.sort_order, v.label
FROM public.placement_questions q
JOIN public.placement_checkpoints cp ON cp.id = q.checkpoint_id
JOIN public.placement_tests t ON t.id = cp.placement_test_id
CROSS JOIN (VALUES
  ('A',1,'is'),('B',2,'does'),('C',3,'is it'),('D',4,'does it be'),('E',5,'Não sei')
) AS v(option_key, sort_order, label)
WHERE t.slug = 'english-placement' AND q.question_key = 'A2.TB'
ON CONFLICT (question_id, option_key) DO NOTHING;

INSERT INTO public.placement_question_options (question_id, option_key, sort_order, label)
SELECT q.id, v.option_key, v.sort_order, v.label
FROM public.placement_questions q
JOIN public.placement_checkpoints cp ON cp.id = q.checkpoint_id
JOIN public.placement_tests t ON t.id = cp.placement_test_id
CROSS JOIN (VALUES
  ('A',1,'already left'),('B',2,'has already left'),('C',3,'had already left'),('D',4,'was already leave'),('E',5,'Não sei')
) AS v(option_key, sort_order, label)
WHERE t.slug = 'english-placement' AND q.question_key = 'B1.1'
ON CONFLICT (question_id, option_key) DO NOTHING;

INSERT INTO public.placement_question_options (question_id, option_key, sort_order, label)
SELECT q.id, v.option_key, v.sort_order, v.label
FROM public.placement_questions q
JOIN public.placement_checkpoints cp ON cp.id = q.checkpoint_id
JOIN public.placement_tests t ON t.id = cp.placement_test_id
CROSS JOIN (VALUES
  ('A',1,'have'),('B',2,'had'),('C',3,'would have'),('D',4,'will have'),('E',5,'Não sei')
) AS v(option_key, sort_order, label)
WHERE t.slug = 'english-placement' AND q.question_key = 'B1.2'
ON CONFLICT (question_id, option_key) DO NOTHING;

INSERT INTO public.placement_question_options (question_id, option_key, sort_order, label)
SELECT q.id, v.option_key, v.sort_order, v.label
FROM public.placement_questions q
JOIN public.placement_checkpoints cp ON cp.id = q.checkpoint_id
JOIN public.placement_tests t ON t.id = cp.placement_test_id
CROSS JOIN (VALUES
  ('A',1,E'can''t'),('B',2,E'couldn''t'),('C',3,E'doesn''t'),('D',4,E'hasn''t'),('E',5,'Não sei')
) AS v(option_key, sort_order, label)
WHERE t.slug = 'english-placement' AND q.question_key = 'B1.TB'
ON CONFLICT (question_id, option_key) DO NOTHING;

INSERT INTO public.placement_question_options (question_id, option_key, sort_order, label)
SELECT q.id, v.option_key, v.sort_order, v.label
FROM public.placement_questions q
JOIN public.placement_checkpoints cp ON cp.id = q.checkpoint_id
JOIN public.placement_tests t ON t.id = cp.placement_test_id
CROSS JOIN (VALUES
  ('A',1,E'wouldn''t make'),('B',2,E'wouldn''t have made'),('C',3,E'hadn''t made'),('D',4,E'didn''t make'),('E',5,'Não sei')
) AS v(option_key, sort_order, label)
WHERE t.slug = 'english-placement' AND q.question_key = 'B2.1'
ON CONFLICT (question_id, option_key) DO NOTHING;

INSERT INTO public.placement_question_options (question_id, option_key, sort_order, label)
SELECT q.id, v.option_key, v.sort_order, v.label
FROM public.placement_questions q
JOIN public.placement_checkpoints cp ON cp.id = q.checkpoint_id
JOIN public.placement_tests t ON t.id = cp.placement_test_id
CROSS JOIN (VALUES
  ('A',1,'Cars create pollution, so banning them is clearly the best solution for every city.'),
  ('B',2,'Although a ban could reduce pollution, it might also affect people who rely on cars, so better public transport would need to come first.'),
  ('C',3,'Cars are useful for many people, and public transport is also important in large cities.'),
  ('D',4,'If cities banned cars, most people would probably support the change because cleaner streets are always better.'),
  ('E',5,'Não sei')
) AS v(option_key, sort_order, label)
WHERE t.slug = 'english-placement' AND q.question_key = 'B2.2'
ON CONFLICT (question_id, option_key) DO NOTHING;

INSERT INTO public.placement_question_options (question_id, option_key, sort_order, label)
SELECT q.id, v.option_key, v.sort_order, v.label
FROM public.placement_questions q
JOIN public.placement_checkpoints cp ON cp.id = q.checkpoint_id
JOIN public.placement_tests t ON t.id = cp.placement_test_id
CROSS JOIN (VALUES
  ('A',1,'mustn''t see'),('B',2,'might not have seen'),('C',3,'shouldn''t see'),('D',4,'can''t saw'),('E',5,'Não sei')
) AS v(option_key, sort_order, label)
WHERE t.slug = 'english-placement' AND q.question_key = 'B2.TB'
ON CONFLICT (question_id, option_key) DO NOTHING;

INSERT INTO public.placement_question_options (question_id, option_key, sort_order, label)
SELECT q.id, v.option_key, v.sort_order, v.label
FROM public.placement_questions q
JOIN public.placement_checkpoints cp ON cp.id = q.checkpoint_id
JOIN public.placement_tests t ON t.id = cp.placement_test_id
CROSS JOIN (VALUES
  ('A',1,'The findings strongly indicate that the strategy is effective, although further research would help confirm the result.'),
  ('B',2,'The findings appear to suggest that the strategy may be effective, although the evidence is not yet conclusive.'),
  ('C',3,'The findings demonstrate that the strategy is likely to be effective, even though the sample was relatively limited.'),
  ('D',4,'The findings seem encouraging enough to support the conclusion that the strategy is effective in most cases.'),
  ('E',5,'Não sei')
) AS v(option_key, sort_order, label)
WHERE t.slug = 'english-placement' AND q.question_key = 'C1.1'
ON CONFLICT (question_id, option_key) DO NOTHING;

INSERT INTO public.placement_question_options (question_id, option_key, sort_order, label)
SELECT q.id, v.option_key, v.sort_order, v.label
FROM public.placement_questions q
JOIN public.placement_checkpoints cp ON cp.id = q.checkpoint_id
JOIN public.placement_tests t ON t.id = cp.placement_test_id
CROSS JOIN (VALUES
  ('A',1,'I understand the need to move quickly, but I don''t think this deadline is realistic given the testing that still needs to be completed.'),
  ('B',2,'I appreciate the urgency, and perhaps we could keep the deadline while asking the team to work around the remaining risks.'),
  ('C',3,'I can see why the deadline is attractive, although the team may simply need to prioritize the remaining work more carefully.'),
  ('D',4,'I understand the reasoning behind the deadline, but I would personally prefer a different date because the current one isn''t ideal.'),
  ('E',5,'Não sei')
) AS v(option_key, sort_order, label)
WHERE t.slug = 'english-placement' AND q.question_key = 'C1.2'
ON CONFLICT (question_id, option_key) DO NOTHING;

INSERT INTO public.placement_question_options (question_id, option_key, sort_order, label)
SELECT q.id, v.option_key, v.sort_order, v.label
FROM public.placement_questions q
JOIN public.placement_checkpoints cp ON cp.id = q.checkpoint_id
JOIN public.placement_tests t ON t.id = cp.placement_test_id
CROSS JOIN (VALUES
  ('A',1,'I have seen'),('B',2,'have I seen'),('C',3,'I saw'),('D',4,'did I have seen'),('E',5,'Não sei')
) AS v(option_key, sort_order, label)
WHERE t.slug = 'english-placement' AND q.question_key = 'C1.TB'
ON CONFLICT (question_id, option_key) DO NOTHING;

-- Gabarito PRIVADO (uma linha por questão objetiva).
INSERT INTO public.placement_question_keys (question_id, correct_option_key)
SELECT q.id, v.correct_option_key
FROM public.placement_questions q
JOIN public.placement_checkpoints cp ON cp.id = q.checkpoint_id
JOIN public.placement_tests t ON t.id = cp.placement_test_id
JOIN (VALUES
  ('A2.1','B'),('A2.2','C'),('A2.TB','A'),
  ('B1.1','C'),('B1.2','B'),('B1.TB','B'),
  ('B2.1','B'),('B2.2','B'),('B2.TB','B'),
  ('C1.1','B'),('C1.2','A'),('C1.TB','B')
) AS v(question_key, correct_option_key) ON v.question_key = q.question_key
WHERE t.slug = 'english-placement'
ON CONFLICT (question_id) DO NOTHING;

-- ── 5) Rubrica C2 (0–2 por critério; total 0–10; 8+ = C2, senão C1) ─────────
INSERT INTO public.placement_c2_rubrics
  (placement_test_id, rubric_version, pass_threshold, max_total, prompt_template_key, prompt_version, criteria)
SELECT t.id, 1, 8, 10, 'placement.c2_evaluation', 1, $json$[
  {"key":"meaning_preservation","label":"Preservação do significado","max_score":2,"sort_order":1,
   "descriptors":{
     "0":"Perde ou altera a ideia central (não mantém claramente risco e recomendação de não lançar ainda).",
     "1":"Mantém a maior parte da mensagem, mas perde alguma nuance.",
     "2":"Mantém claramente: plano atual, risco excessivo e recomendação de adiar/não lançar ainda."}},
  {"key":"register_adaptation","label":"Adaptação de registro","max_score":2,"sort_order":2,
   "descriptors":{
     "0":"Usa praticamente o mesmo registro com gerente e amigo.",
     "1":"Existe alguma mudança de tom, mas limitada ou artificial.",
     "2":"Primeira resposta naturalmente profissional/diplomática e a segunda claramente casual/natural."}},
  {"key":"naturalness","label":"Naturalidade","max_score":2,"sort_order":3,
   "descriptors":{
     "0":"Frase muito artificial, tradução literal ou construção inadequada.",
     "1":"Compreensível e correta, mas com alguma rigidez ou escolha pouco idiomática.",
     "2":"Fluente, idiomática e natural para o contexto."}},
  {"key":"precision_nuance","label":"Precisão e nuance","max_score":2,"sort_order":4,
   "descriptors":{
     "0":"Vago ou semanticamente impreciso.",
     "1":"Comunica corretamente, mas sem grande controle de nuance.",
     "2":"Escolhe linguagem precisa e controla força, cautela e intenção."}},
  {"key":"reformulation_flexibility","label":"Flexibilidade de reformulação","max_score":2,"sort_order":5,
   "descriptors":{
     "0":"Segunda resposta é praticamente a primeira com pequenas substituições.",
     "1":"Há alguma reorganização de estrutura e vocabulário.",
     "2":"Expressa a mesma ideia com construção, vocabulário e tom diferentes sem perder significado."}}
]$json$::jsonb
FROM public.placement_tests t
WHERE t.slug = 'english-placement'
ON CONFLICT (placement_test_id, rubric_version) DO NOTHING;

-- ── 6) Prompt de avaliação C2 (data-driven, em prompt_templates) ────────────
INSERT INTO public.prompt_templates
  (template_key, learning_language, interface_language, version, status, model, temperature,
   system_body, user_body, required_placeholders, metadata)
VALUES (
  'placement.c2_evaluation', 'en', 'pt-BR', 1, 'published', 'gpt-4o-mini', 0,
  E'Você é um examinador de inglês avaliando um teste de reformulação e mudança de registro (nível C2).\n\n'
  || E'O candidato recebeu DUAS tarefas:\n'
  || E'1) Para o gerente: {{task_manager}}\n'
  || E'2) Para um amigo próximo: {{task_friend}}\n\n'
  || E'Respostas do candidato:\n'
  || E'[MANAGER]: {{response_manager}}\n'
  || E'[FRIEND]: {{response_friend}}\n\n'
  || E'Avalie usando EXATAMENTE estes critérios (cada um vale 0, 1 ou 2):\n{{rubric_criteria}}\n\n'
  || E'Regras:\n'
  || E'- Pontue cada critério apenas com 0, 1 ou 2 segundo os descritores.\n'
  || E'- Não invente critérios nem pontue fora da escala.\n'
  || E'- Responda SOMENTE com JSON válido, sem texto adicional, no formato:\n'
  || E'{"scores":{"meaning_preservation":0,"register_adaptation":0,"naturalness":0,"precision_nuance":0,"reformulation_flexibility":0},"reason_codes":[]}\n'
  || E'reason_codes é uma lista curta e opcional de rótulos em snake_case explicando penalizações.',
  NULL,
  ARRAY['task_manager','task_friend','response_manager','response_friend','rubric_criteria'],
  '{"purpose":"placement_c2_gate"}'::jsonb
)
ON CONFLICT DO NOTHING;

-- ── 7) Copy de interface (pt-BR). Placeholders {level} e {language}. ────────
INSERT INTO public.placement_ui_copy (placement_test_id, interface_language, copy_key, body)
SELECT t.id, 'pt-BR', v.copy_key, v.body
FROM public.placement_tests t
CROSS JOIN (VALUES
  ('onboarding_title',    'Descubra seu nível de {language}'),
  ('onboarding_subtitle', 'Responda algumas perguntas rápidas para começarmos no ponto mais adequado para você.'),
  ('cta_start',           'Começar teste'),
  ('cta_skip',            'Pular teste'),
  ('c2_intro',            'Duas tarefas rápidas de escrita. Responda dentro do tempo indicado.'),
  ('result_headline',     'Seu nível inicial: {level}'),
  ('result_body',         'Você está pronto para começar o curso a partir do nível {level}.'),
  ('result_cta',          'Começar no {level}'),
  ('pending_title',       'Estamos avaliando suas respostas'),
  ('pending_body',        'Você já pode usar o app normalmente. Vamos concluir sua avaliação em instantes.')
) AS v(copy_key, body)
WHERE t.slug = 'english-placement'
ON CONFLICT (placement_test_id, interface_language, copy_key) DO NOTHING;
