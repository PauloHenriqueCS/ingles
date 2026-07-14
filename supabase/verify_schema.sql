-- =============================================================================
-- VERIFICAÇÃO DO SCHEMA — Lemon (english learning app)
-- Somente leitura. Sem efeitos colaterais. Seguro para executar a qualquer momento.
--
-- Execute no Supabase SQL Editor após cada migration para confirmar o estado.
-- Cada bloco retorna uma tabela com "check" e "status".
-- Status esperado: OK. Qualquer resultado diferente indica problema.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Existência das tabelas
-- ─────────────────────────────────────────────────────────────────────────────

SELECT
  t.table_name,
  CASE WHEN t.table_name IS NOT NULL THEN 'OK' ELSE 'MISSING' END AS status
FROM (
  VALUES
    ('writing_entries'),
    ('english_reviews'),
    ('english_learning_memory'),
    ('grammar_explanations'),
    ('generated_themes'),
    ('ai_conversation_preferences'),
    ('conversation_sessions'),
    ('pronunciation_assessments'),
    ('review_groups'),
    ('review_group_items'),
    ('review_attempts'),
    ('review_attempt_items'),
    ('review_schedule_history'),
    ('user_learning_settings'),
    ('learning_day_overrides')
) AS expected(table_name)
LEFT JOIN information_schema.tables t
  ON t.table_schema = 'public'
  AND t.table_name = expected.table_name
ORDER BY expected.table_name;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. RLS habilitada nas tabelas de usuário
-- ─────────────────────────────────────────────────────────────────────────────

SELECT
  c.relname  AS table_name,
  CASE WHEN c.relrowsecurity THEN 'OK (RLS enabled)'
       ELSE 'PROBLEM: RLS disabled'
  END AS status
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname IN (
    'writing_entries', 'english_reviews', 'english_learning_memory',
    'generated_themes', 'grammar_explanations', 'ai_conversation_preferences',
    'conversation_sessions', 'pronunciation_assessments',
    'review_groups', 'review_group_items', 'review_attempts',
    'review_attempt_items', 'review_schedule_history',
    'user_learning_settings', 'learning_day_overrides'
  )
ORDER BY c.relname;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Políticas inseguras NÃO devem existir nas tabelas de usuário
--    (anon_all, authenticated_all foram políticas incorretas de versões antigas)
-- ─────────────────────────────────────────────────────────────────────────────

SELECT
  schemaname,
  tablename,
  policyname,
  'PROBLEM: insecure policy found' AS status
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'writing_entries', 'english_reviews', 'english_learning_memory',
    'generated_themes', 'ai_conversation_preferences',
    'conversation_sessions', 'pronunciation_assessments',
    'review_groups', 'review_group_items', 'review_attempts',
    'review_attempt_items', 'review_schedule_history',
    'user_learning_settings', 'learning_day_overrides'
  )
  AND policyname IN ('anon_all', 'authenticated_all')

UNION ALL

SELECT
  NULL, NULL, NULL,
  'OK: no insecure policies found'
WHERE NOT EXISTS (
  SELECT 1 FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN (
      'writing_entries', 'english_reviews', 'english_learning_memory',
      'generated_themes', 'ai_conversation_preferences',
      'conversation_sessions', 'pronunciation_assessments',
      'review_groups', 'review_group_items', 'review_attempts',
      'review_attempt_items', 'review_schedule_history',
      'user_learning_settings', 'learning_day_overrides'
    )
    AND policyname IN ('anon_all', 'authenticated_all')
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Políticas user-specific obrigatórias
-- ─────────────────────────────────────────────────────────────────────────────

SELECT
  expected.tablename,
  expected.policyname,
  CASE WHEN p.policyname IS NOT NULL THEN 'OK' ELSE 'MISSING' END AS status
FROM (
  VALUES
    ('writing_entries', 'we_select'),
    ('writing_entries', 'we_insert'),
    ('writing_entries', 'we_update'),
    ('writing_entries', 'we_delete'),
    ('english_reviews', 'er_select'),
    ('english_reviews', 'er_insert'),
    ('english_reviews', 'er_update'),
    ('english_reviews', 'er_delete'),
    ('english_learning_memory', 'elm_select'),
    ('english_learning_memory', 'elm_insert'),
    ('english_learning_memory', 'elm_update'),
    ('english_learning_memory', 'elm_delete'),
    ('grammar_explanations', 'ge_select'),
    ('grammar_explanations', 'ge_insert'),
    ('grammar_explanations', 'ge_update'),
    ('generated_themes', 'gt_select'),
    ('generated_themes', 'gt_insert'),
    ('generated_themes', 'gt_update'),
    ('generated_themes', 'gt_delete'),
    ('ai_conversation_preferences', 'Users manage own AI preferences'),
    ('conversation_sessions', 'Users manage own conversation sessions'),
    ('pronunciation_assessments', 'pa_select'),
    ('review_groups', 'rg_select'),
    ('review_groups', 'rg_insert'),
    ('review_groups', 'rg_update'),
    ('review_groups', 'rg_delete'),
    ('review_group_items', 'rgi_select'),
    ('review_group_items', 'rgi_insert'),
    ('review_group_items', 'rgi_delete'),
    ('review_attempts', 'ra_select'),
    ('review_attempts', 'ra_insert'),
    ('review_attempts', 'ra_delete'),
    ('review_attempt_items', 'rai_select'),
    ('review_attempt_items', 'rai_insert'),
    ('review_attempt_items', 'rai_delete'),
    ('review_schedule_history', 'rsh_select'),
    ('review_schedule_history', 'rsh_insert'),
    ('review_schedule_history', 'rsh_delete'),
    ('user_learning_settings', 'uls_all'),
    ('learning_day_overrides', 'ldo_all')
) AS expected(tablename, policyname)
LEFT JOIN pg_policies p
  ON p.schemaname = 'public'
  AND p.tablename  = expected.tablename
  AND p.policyname = expected.policyname
ORDER BY expected.tablename, expected.policyname;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Índices críticos
-- ─────────────────────────────────────────────────────────────────────────────

SELECT
  expected.indexname,
  CASE WHEN i.indexname IS NOT NULL THEN 'OK' ELSE 'MISSING' END AS status
FROM (
  VALUES
    ('writing_entries_user_entry_date_unique'),
    ('writing_entries_user_id_idx'),
    ('english_reviews_user_id_idx'),
    ('english_reviews_user_created_idx'),
    ('idx_english_reviews_user_entry_date'),
    ('english_learning_memory_user_idx'),
    ('generated_themes_user_created_idx'),
    ('grammar_explanations_name_lower_idx'),
    ('idx_conversation_sessions_user_date'),   -- adicionado em 20260714120000
    ('idx_pronunciation_assessments_user'),
    ('idx_pronunciation_assessments_text_version'),
    ('review_groups_user_id_idx'),
    ('review_groups_user_next_review_idx'),
    ('review_attempts_user_id_idx'),
    ('review_attempts_group_id_idx'),
    ('review_attempt_items_attempt_idx'),
    ('review_schedule_history_user_id_idx'),
    ('review_schedule_history_group_id_idx')
) AS expected(indexname)
LEFT JOIN pg_indexes i
  ON i.schemaname = 'public'
  AND i.indexname = expected.indexname
ORDER BY expected.indexname;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Constraints de integridade (adicionadas em 20260714120000)
-- ─────────────────────────────────────────────────────────────────────────────

SELECT
  expected.conname,
  expected.tablename,
  CASE WHEN c.conname IS NOT NULL THEN 'OK'
       ELSE 'MISSING (aplique migration 20260714120000)'
  END AS status
FROM (
  VALUES
    ('review_groups_level_non_negative',  'review_groups'),
    ('pa_pronunciation_score_range',      'pronunciation_assessments'),
    ('pa_accuracy_score_range',           'pronunciation_assessments'),
    ('pa_fluency_score_range',            'pronunciation_assessments'),
    ('pa_completeness_score_range',       'pronunciation_assessments'),
    ('pa_prosody_score_range',            'pronunciation_assessments')
) AS expected(conname, tablename)
LEFT JOIN pg_constraint c
  ON c.conname   = expected.conname
  AND c.conrelid = (('public.' || expected.tablename)::regclass)
ORDER BY expected.tablename, expected.conname;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Funções RPC obrigatórias
-- ─────────────────────────────────────────────────────────────────────────────

SELECT
  expected.proname,
  CASE WHEN p.proname IS NOT NULL THEN 'OK' ELSE 'MISSING' END AS status
FROM (
  VALUES
    ('update_updated_at'),
    ('set_updated_at'),
    ('set_ai_prefs_user_id'),
    ('set_conversation_session_user_id'),
    ('reserve_pronunciation_assessment'),
    ('complete_pronunciation_assessment'),
    ('fail_pronunciation_assessment'),
    ('compensate_pronunciation_assessment'),
    ('apply_review_schedule')
) AS expected(proname)
LEFT JOIN pg_proc p
  ON p.proname = expected.proname
  AND p.pronamespace = 'public'::regnamespace
ORDER BY expected.proname;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Funções SECURITY DEFINER com search_path fixo
--    (search_path não fixado = risco de injection)
-- ─────────────────────────────────────────────────────────────────────────────

SELECT
  p.proname AS function_name,
  CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' ELSE 'SECURITY INVOKER' END AS security,
  CASE
    WHEN p.proconfig IS NOT NULL AND
         EXISTS (SELECT 1 FROM unnest(p.proconfig) AS cfg WHERE cfg LIKE 'search_path=%')
    THEN 'OK (search_path set)'
    ELSE 'WARNING: search_path not fixed'
  END AS search_path_status
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN (
    'update_updated_at',
    'set_updated_at',
    'set_ai_prefs_user_id',
    'set_conversation_session_user_id',
    'reserve_pronunciation_assessment',
    'complete_pronunciation_assessment',
    'fail_pronunciation_assessment',
    'compensate_pronunciation_assessment',
    'apply_review_schedule'
  )
ORDER BY p.proname;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Verificação rápida de sanidade de dados
--    (contagens por tabela — sem retornar dados de usuários)
-- ─────────────────────────────────────────────────────────────────────────────

SELECT
  'writing_entries'           AS table_name, COUNT(*) AS row_count FROM public.writing_entries
UNION ALL SELECT 'english_reviews',          COUNT(*) FROM public.english_reviews
UNION ALL SELECT 'english_learning_memory',  COUNT(*) FROM public.english_learning_memory
UNION ALL SELECT 'grammar_explanations',     COUNT(*) FROM public.grammar_explanations
UNION ALL SELECT 'generated_themes',         COUNT(*) FROM public.generated_themes
UNION ALL SELECT 'ai_conversation_preferences', COUNT(*) FROM public.ai_conversation_preferences
UNION ALL SELECT 'conversation_sessions',    COUNT(*) FROM public.conversation_sessions
UNION ALL SELECT 'pronunciation_assessments', COUNT(*) FROM public.pronunciation_assessments
UNION ALL SELECT 'review_groups',            COUNT(*) FROM public.review_groups
UNION ALL SELECT 'review_group_items',       COUNT(*) FROM public.review_group_items
UNION ALL SELECT 'review_attempts',          COUNT(*) FROM public.review_attempts
UNION ALL SELECT 'review_attempt_items',     COUNT(*) FROM public.review_attempt_items
UNION ALL SELECT 'review_schedule_history',  COUNT(*) FROM public.review_schedule_history
UNION ALL SELECT 'user_learning_settings',   COUNT(*) FROM public.user_learning_settings
UNION ALL SELECT 'learning_day_overrides',   COUNT(*) FROM public.learning_day_overrides
ORDER BY table_name;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. Dados que violariam as novas constraints NOT VALID
--     (execute antes de VALIDATE CONSTRAINT para confirmar que não há violações)
-- ─────────────────────────────────────────────────────────────────────────────

-- review_groups com review_level < 0 (deve retornar 0 linhas):
SELECT id, user_id, review_level
FROM public.review_groups
WHERE review_level < 0;

-- pronunciation_assessments com scores fora de 0-100 (deve retornar 0 linhas):
SELECT id, user_id, status,
  pronunciation_score, accuracy_score, fluency_score,
  completeness_score, prosody_score
FROM public.pronunciation_assessments
WHERE (pronunciation_score  IS NOT NULL AND (pronunciation_score  < 0 OR pronunciation_score  > 100))
   OR (accuracy_score       IS NOT NULL AND (accuracy_score       < 0 OR accuracy_score       > 100))
   OR (fluency_score        IS NOT NULL AND (fluency_score        < 0 OR fluency_score        > 100))
   OR (completeness_score   IS NOT NULL AND (completeness_score   < 0 OR completeness_score   > 100))
   OR (prosody_score        IS NOT NULL AND (prosody_score        < 0 OR prosody_score        > 100));

-- conversation_sessions com duration_sec <= 0 (deve retornar 0 linhas):
SELECT id, user_id, session_date, duration_sec
FROM public.conversation_sessions
WHERE duration_sec <= 0;

-- =============================================================================
-- FIM DA VERIFICAÇÃO
-- Todos os itens com status "OK" indicam que o banco está no estado esperado.
-- =============================================================================
