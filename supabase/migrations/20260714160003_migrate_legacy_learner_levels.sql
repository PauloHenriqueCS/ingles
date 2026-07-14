-- =============================================================================
-- MIGRATION: 20260714160003_migrate_legacy_learner_levels
-- Projeto: Lemon (english learning app)
--
-- Idempotente: pode ser aplicada múltiplas vezes sem efeito colateral.
--
-- O que esta migration faz:
--   1. Para cada usuário em english_learning_memory com current_level válido:
--      - Insere perfil de WRITING com status provisional, confiança 0.35
--        e source legacy_migration.
--      - NÃO cria perfis para pronunciation, conversation ou listening
--        (o nível legado era derivado de textos escritos, não de outras habilidades).
--   2. Para TODOS os usuários em auth.users sem perfil de writing:
--      - Insere perfil unknown (nível null, confiança 0).
--   3. Para todos os perfis de skills restantes (pronunciation, conversation,
--      listening) ainda não existentes:
--      - Insere perfis unknown (nível null, confiança 0).
--   4. Usa INSERT ... ON CONFLICT DO NOTHING para idempotência total.
--
-- ATENÇÃO (produção): execute o SELECT de verificação antes de rodar:
--
--   SELECT current_level, COUNT(*) FROM public.english_learning_memory
--   WHERE current_level NOT IN ('A1','A2','B1','B2','C1','C2')
--   GROUP BY current_level;
--
-- Linhas com current_level inválido são ignoradas (WHERE filtra).
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- PASSO 1: Migrar nível legado de writing (apenas usuários com nível válido)
-- ─────────────────────────────────────────────────────────────────────────────
-- confidence = 0.35 (LEGACY_MIGRATION_CONFIDENCE do código TypeScript).
-- status = 'provisional': dado legado, não confirmado por diagnóstico real.
-- source = 'legacy_migration': auditável.

INSERT INTO public.learner_skill_profiles
  (user_id, skill, cefr_level, assessment_status, confidence, source,
   evidence_count, catalog_version, assessed_at, calibrated_at, created_at, updated_at)
SELECT
  m.user_id,
  'writing'::public.learning_skill,
  m.current_level::TEXT,
  'provisional'::public.skill_assessment_status,
  0.350,
  'legacy_migration'::public.skill_level_source,
  0,
  1,
  NULL,
  NULL,
  NOW(),
  NOW()
FROM public.english_learning_memory m
WHERE m.user_id IS NOT NULL
  AND m.current_level IN ('A1','A2','B1','B2','C1','C2')
ON CONFLICT (user_id, skill) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- PASSO 2: Garantir que todos os usuários tenham perfil de writing
-- (inclui usuários sem registro em english_learning_memory)
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.learner_skill_profiles
  (user_id, skill, cefr_level, assessment_status, confidence, source,
   evidence_count, catalog_version, assessed_at, calibrated_at, created_at, updated_at)
SELECT
  u.id,
  'writing'::public.learning_skill,
  NULL,
  'unknown'::public.skill_assessment_status,
  0.000,
  'system_default'::public.skill_level_source,
  0,
  1,
  NULL,
  NULL,
  NOW(),
  NOW()
FROM auth.users u
ON CONFLICT (user_id, skill) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- PASSO 3: Criar perfis unknown para pronunciation, conversation, listening
-- ─────────────────────────────────────────────────────────────────────────────
-- Pronunciation e conversation NÃO herdam o nível de writing.
-- Listening permanece unknown (funcionalidade futura).

INSERT INTO public.learner_skill_profiles
  (user_id, skill, cefr_level, assessment_status, confidence, source,
   evidence_count, catalog_version, assessed_at, calibrated_at, created_at, updated_at)
SELECT
  u.id,
  s.skill::public.learning_skill,
  NULL,
  'unknown'::public.skill_assessment_status,
  0.000,
  'system_default'::public.skill_level_source,
  0,
  1,
  NULL,
  NULL,
  NOW(),
  NOW()
FROM auth.users u
CROSS JOIN (
  VALUES ('pronunciation'), ('conversation'), ('listening')
) AS s(skill)
ON CONFLICT (user_id, skill) DO NOTHING;

COMMIT;
