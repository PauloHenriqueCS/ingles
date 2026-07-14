-- =============================================================================
-- MIGRATION: 20260714170000_create_writing_diagnostic_missions
-- Projeto: Lemon (english learning app) — Tarefa 7: Diagnóstico invisível
--
-- Idempotente: pode ser aplicada múltiplas vezes sem efeito colateral.
--
-- O que esta migration faz:
--   1. Cria a tabela writing_diagnostic_missions.
--   2. Habilita RLS com SELECT apenas para o próprio usuário.
--   3. Cria índice parcial único para garantir idempotência:
--      no máximo uma missão diagnóstica ativa por (user_id, diagnostic_sequence).
--   4. Cria índice de performance por user_id.
--
-- Princípios:
--   - Dados internos (diagnostic_plan, objective_ids) nunca saem para o browser.
--   - Writes ocorrem apenas via service role (API serverless).
--   - Regenerações não criam duplicatas: missão antiga é marcada 'superseded'.
--   - Um texto original elegível concluído por sequência avança o diagnóstico.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 1: Tabela writing_diagnostic_missions
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.writing_diagnostic_missions (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Referência ao tema gerado (gerado_themes). Nullable: preenchido ao salvar.
  theme_id              UUID        REFERENCES public.generated_themes(id) ON DELETE SET NULL,

  -- 1 = primeira missão diagnóstica; 2 = segunda missão diagnóstica.
  diagnostic_sequence   SMALLINT    NOT NULL CHECK (diagnostic_sequence IN (1, 2)),

  -- Versão do catálogo gramatical usado na geração do plano.
  catalog_version       INTEGER     NOT NULL DEFAULT 1 CHECK (catalog_version > 0),

  -- Plano diagnóstico completo (objetivos, restrições, estratégias).
  -- NUNCA exposto ao browser. Lido apenas server-side para Task 8.
  diagnostic_plan       JSONB       NOT NULL DEFAULT '{}',

  -- Array de IDs canônicos dos objetivos diagnósticos.
  -- Congelado após a missão ser aceita pelo usuário.
  objective_ids         TEXT[]      NOT NULL DEFAULT '{}',

  -- Estado da missão diagnóstica.
  -- generated: gerada, aguardando uso
  -- superseded: substituída por regeneração ("Gerar outro tema")
  -- completed: texto original elegível submetido com sucesso
  status                TEXT        NOT NULL DEFAULT 'generated'
                        CHECK (status IN ('generated', 'superseded', 'completed')),

  -- Quantas vezes o usuário regenerou (clicou "Gerar outro tema") nesta sequência.
  regeneration_count    INTEGER     NOT NULL DEFAULT 0 CHECK (regeneration_count >= 0),

  -- Log de rejeições durante geração (tentativas que falharam na validação).
  -- Array de objetos: [{attempt, rejectionCode, rejectionDetail, timestamp}].
  -- NUNCA exposto ao browser.
  rejection_log         JSONB       NOT NULL DEFAULT '[]',

  -- Versão do prompt do gerador diagnóstico usado.
  prompt_version        TEXT        NOT NULL DEFAULT 'v1',

  -- Versão do validador diagnóstico usado.
  validator_version     TEXT        NOT NULL DEFAULT 'v1',

  -- Momento em que a missão foi aceita pelo usuário (não pode mais ser substituída).
  -- NULL = aguardando aceitação.
  accepted_at           TIMESTAMPTZ,

  -- Momento em que um texto original elegível foi submetido com sucesso.
  completed_at          TIMESTAMPTZ,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.writing_diagnostic_missions ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 2: Políticas RLS
-- ─────────────────────────────────────────────────────────────────────────────

-- SELECT: usuário lê apenas as próprias missões diagnósticas.
-- Campos internos (diagnostic_plan, objective_ids) chegam ao cliente via esta
-- política, mas os DTOs do servidor nunca os incluem na resposta HTTP.
DROP POLICY IF EXISTS "wdm_select" ON public.writing_diagnostic_missions;
CREATE POLICY "wdm_select" ON public.writing_diagnostic_missions
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- INSERT/UPDATE/DELETE: sem políticas para usuários autenticados.
-- RLS habilitado sem políticas = browser não pode escrever diretamente.
-- Todas as escritas diagnósticas ocorrem via service role (API serverless).

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 3: Índice parcial único — garantia de idempotência
-- ─────────────────────────────────────────────────────────────────────────────

-- Garante: no máximo uma missão diagnóstica ativa (não superseded) por sequência.
-- Permite múltiplos registros 'superseded' (histórico de regenerações).
-- Erro de unicidade em 'generated'/'completed' impede clique duplo.
DROP INDEX IF EXISTS uq_wdm_user_sequence_active;
CREATE UNIQUE INDEX uq_wdm_user_sequence_active
  ON public.writing_diagnostic_missions (user_id, diagnostic_sequence)
  WHERE status != 'superseded';

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 4: Índices de performance
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_wdm_user_id
  ON public.writing_diagnostic_missions (user_id);

CREATE INDEX IF NOT EXISTS idx_wdm_user_sequence
  ON public.writing_diagnostic_missions (user_id, diagnostic_sequence);

CREATE INDEX IF NOT EXISTS idx_wdm_theme_id
  ON public.writing_diagnostic_missions (theme_id)
  WHERE theme_id IS NOT NULL;
