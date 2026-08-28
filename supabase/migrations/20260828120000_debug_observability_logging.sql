-- =============================================================================
-- MIGRATION: 20260828120000_debug_observability_logging
-- Projeto: Orodim
--
-- Aplicada automaticamente por .github/workflows/homologation.yml e
-- deploy-production.yml (supabase db push). Não aplicar manualmente no SQL
-- Editor — isso desalinha o histórico de `supabase migration list`.
--
-- OBJETIVO: infra de DIAGNÓSTICO on-demand para achar gargalos de latência em
-- produção (suspeita: o front carrega mas a API fica esperando o banco). Duas
-- tabelas, deliberadamente DESACOPLADAS do product_config (app_config_*), para
-- que um erro/bug aqui NUNCA afete o gating de features (features.pronunciation
-- etc.) nem a config crítica do app.
--
--   1. app_debug_logging_config — o "botão" com NÍVEIS, uma linha por ambiente.
--      O dashboard (ingles-dashboad) escreve o nível; o app lê server-side (via
--      service_role, com cache curto em memória) e decide o quanto logar. OFF é
--      o default → custo zero e nada escrito enquanto ninguém liga.
--
--   2. debug_request_logs — os registros por REQUISIÇÃO/ESTÁGIO. Guarda timings
--      (inclusive tempo gasto no banco), status, código de erro, tamanhos e um
--      `detail` jsonb pequeno. NUNCA guarda áudio, PII, tokens nem texto de
--      referência. Só escrito quando o nível do ambiente permite.
--
-- NÍVEIS (ordem crescente de verbosidade):
--   off(0) nada · error(1) só falhas · info(2) resumo por request ·
--   debug(3) + timings por estágio (incl. db_ms) · trace(4) + granular (cada RPC,
--   tamanhos, chamadas de provider).
--
-- ESCOPO: puramente aditivo — 2 tabelas novas + RLS service_role-only + índices
-- + seed. Nada aqui toca em planos, assinatura, currículo, conversação,
-- listening, escrita, pronúncia, RevenueCat, quotas ou no product_config.
-- =============================================================================

-- ── Config do nível de log: uma linha por ambiente ──────────────────────────
CREATE TABLE IF NOT EXISTS public.app_debug_logging_config (
  environment text PRIMARY KEY
    CHECK (environment IN ('development', 'staging', 'production')),
  -- Nível efetivo. OFF = não gravar nada (default seguro).
  level       text NOT NULL DEFAULT 'off'
    CHECK (level IN ('off', 'error', 'info', 'debug', 'trace')),
  -- Amostragem opcional (0..100). 100 = loga tudo dentro do nível; valores
  -- menores logam só uma fração das requisições (para não lotar sob carga).
  sample_rate smallint NOT NULL DEFAULT 100
    CHECK (sample_rate BETWEEN 0 AND 100),
  -- Desliga sozinho neste horário (UTC), para não esquecer ligado. NULL = manual.
  auto_off_at timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid
);

COMMENT ON TABLE public.app_debug_logging_config IS
  'Botão de DIAGNÓSTICO com níveis (off/error/info/debug/trace), uma linha por ambiente. Escrito pelo dashboard (ingles-dashboad), lido server-side pelo app. Desacoplado do product_config de propósito. auto_off_at desliga sozinho.';

DROP TRIGGER IF EXISTS trg_app_debug_logging_config_updated_at
  ON public.app_debug_logging_config;
CREATE TRIGGER trg_app_debug_logging_config_updated_at
  BEFORE UPDATE ON public.app_debug_logging_config
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Seed: uma linha por ambiente, todas OFF. Idempotente.
INSERT INTO public.app_debug_logging_config (environment, level)
VALUES ('development', 'off'), ('staging', 'off'), ('production', 'off')
ON CONFLICT (environment) DO NOTHING;

-- ── Registros de diagnóstico por requisição/estágio ─────────────────────────
CREATE TABLE IF NOT EXISTS public.debug_request_logs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment    text NOT NULL DEFAULT 'production',
  -- 'server' | 'client' — de onde veio a medição.
  surface        text NOT NULL DEFAULT 'server',
  -- Agrupa todos os estágios de UMA requisição (mesmo id no cliente e no servidor).
  correlation_id text,
  -- Rota lógica: '/api/pronunciation/assess', 'client:conversation-load', etc.
  endpoint       text,
  -- Estágio dentro da requisição: 'total', 'auth', 'entitlements',
  -- 'db:reserve_rpc', 'azure:assess', 'openai:chat', 'client:wait_response'…
  stage          text,
  -- Nível em que este registro foi emitido (para filtrar depois).
  level          text NOT NULL DEFAULT 'info'
    CHECK (level IN ('error', 'info', 'debug', 'trace')),
  status_code    integer,
  error_code     text,
  -- Duração do estágio (ms) e, quando aplicável, quanto disso foi banco.
  duration_ms    integer,
  db_ms          integer,
  provider       text,           -- 'supabase' | 'azure' | 'openai' | null
  bytes          integer,        -- tamanho de payload/áudio, quando relevante
  user_id        uuid,           -- sem FK: log não deve bloquear delete de usuário
  -- Extras estruturados PEQUENOS. NUNCA áudio, PII, tokens ou reference text.
  detail         jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.debug_request_logs IS
  'Diagnóstico on-demand de latência (timings por estágio, incl. db_ms). Só escrito quando app_debug_logging_config.level permite. Nunca contém áudio/PII/tokens/reference text. Retenção via limpeza posterior.';

-- Consultas típicas do dashboard: por tempo, por correlação, por rota lenta.
CREATE INDEX IF NOT EXISTS idx_debug_request_logs_created_at
  ON public.debug_request_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_debug_request_logs_correlation
  ON public.debug_request_logs (correlation_id);
CREATE INDEX IF NOT EXISTS idx_debug_request_logs_endpoint_created
  ON public.debug_request_logs (endpoint, created_at DESC);

-- ── RLS: SERVICE_ROLE only (defense in depth) ───────────────────────────────
-- Nem o app cliente nem o anon tocam estas tabelas diretamente:
--   * o app SERVIDOR lê o nível e grava logs via service client;
--   * o dashboard lê/escreve via service_role.
-- Tabela nova não herda privilégio neste banco; ainda assim habilitamos RLS e
-- revogamos tudo de PUBLIC/anon/authenticated explicitamente.
ALTER TABLE public.app_debug_logging_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.debug_request_logs       ENABLE ROW LEVEL SECURITY;

-- Sem policies para authenticated/anon → nenhum acesso por esses papéis.
REVOKE ALL ON public.app_debug_logging_config FROM PUBLIC;
REVOKE ALL ON public.app_debug_logging_config FROM anon;
REVOKE ALL ON public.app_debug_logging_config FROM authenticated;
GRANT  SELECT, INSERT, UPDATE, DELETE ON public.app_debug_logging_config TO service_role;

REVOKE ALL ON public.debug_request_logs FROM PUBLIC;
REVOKE ALL ON public.debug_request_logs FROM anon;
REVOKE ALL ON public.debug_request_logs FROM authenticated;
GRANT  SELECT, INSERT, DELETE ON public.debug_request_logs TO service_role;
