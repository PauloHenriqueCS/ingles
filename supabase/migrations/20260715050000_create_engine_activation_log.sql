-- =============================================================================
-- MIGRATION: 20260715050000_create_engine_activation_log
-- Projeto: Lemon (english learning app)
--
-- Idempotente: pode ser aplicada múltiplas vezes sem efeito colateral.
--
-- O que esta migration faz:
--   1. Cria a tabela engine_activation_log para rastrear ativações do motor V2,
--      recalibrações e operações de rollback. Usada para:
--        - Idempotência da recalibração (chave v2-recalibration:{userId}:{version})
--        - Auditoria de quando o V2 foi ativado e quais dados foram migrados
--        - Lock advisory para evitar duas recalibrações simultâneas
--   2. Aplica RLS: apenas o service role pode ler e inserir.
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Tabela principal de log
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.engine_activation_log (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Quem executou e quando
  user_id           UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  executed_by       TEXT        NOT NULL,       -- 'admin', 'system', 'migration'

  -- O que foi feito
  operation         TEXT        NOT NULL,       -- 'v2_activation', 'v2_recalibration', 'v1_rollback', 'v2_restore'
  engine_version    TEXT        NOT NULL,       -- 'v2', 'v1'
  idempotency_key   TEXT        NOT NULL UNIQUE, -- v2-recalibration:{userId}:v2 | global:v2_activation

  -- Estado e resultado
  status            TEXT        NOT NULL DEFAULT 'pending',  -- pending, completed, failed, skipped
  result_json       JSONB,                     -- Resultado completo (níveis, skills afetadas, etc.)
  error_message     TEXT,                      -- Mensagem de erro se falhou
  duration_ms       INTEGER,                   -- Duração da operação

  -- Timestamps
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);

-- Índices para buscas frequentes
CREATE INDEX IF NOT EXISTS engine_activation_log_user_op
  ON public.engine_activation_log (user_id, operation);

CREATE INDEX IF NOT EXISTS engine_activation_log_idempotency
  ON public.engine_activation_log (idempotency_key);

CREATE INDEX IF NOT EXISTS engine_activation_log_status
  ON public.engine_activation_log (status, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS: apenas service role (sem acesso pelo anon/autenticado)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.engine_activation_log ENABLE ROW LEVEL SECURITY;

-- Nenhuma política pública → bloqueia anon e usuários autenticados via JWT
-- O service role ignora RLS por definição

-- ─────────────────────────────────────────────────────────────────────────────
-- Registro inicial da ativação do V2 (idempotente via ON CONFLICT DO NOTHING)
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.engine_activation_log
  (executed_by, operation, engine_version, idempotency_key, status, result_json, completed_at)
VALUES
  (
    'migration',
    'v2_activation',
    'v2',
    'global:v2_activation:20260715',
    'completed',
    jsonb_build_object(
      'note', 'V2 ativado como padrão via engineVersion.ts (LEARNING_ENGINE_VERSION defaults to v2)',
      'engines', jsonb_build_array(
        'grammar_evidence_engine:full',
        'vocabulary_review_engine:full',
        'writing_rewrite_v2:full',
        'canonical_mission_state:enabled',
        'pedagogical_planner:enabled',
        'generator_integration:enabled',
        'mission_validator:enforce'
      )
    ),
    NOW()
  )
ON CONFLICT (idempotency_key) DO NOTHING;

COMMIT;
