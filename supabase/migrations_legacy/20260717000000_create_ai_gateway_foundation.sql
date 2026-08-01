-- =============================================================================
-- MIGRATION: 20260717000000_create_ai_gateway_foundation
-- Projeto: Lemon (english learning app)
--
-- Cria a fundação de banco para o futuro AI Gateway.
-- Esta migration é EXCLUSIVAMENTE aditiva: nenhuma tabela, política ou
-- função existente é modificada.
--
-- Resultado esperado:
--   • 10 novas tabelas (nenhuma tabela existente alterada)
--   • 25 features: 24 operações auditadas + 1 chave contábil (conversation.realtime_usage)
--   • 28 controles iniciais (1 global + 1 openai + 1 azure + 25 features)
--   • RLS ativo em todas as novas tabelas (service role only)
--   • Zero preços, zero eventos, zero sessões, zero métricas, zero reservas
--   • Aplicação continua sem qualquer alteração de comportamento
--
-- Modelo de correlação documentado:
--   • writing.compare_rewrite e writing.correct_v2_text → eventos separados,
--     mesmo correlation_id (chamadas paralelas da mesma ação lógica)
--   • Retries de writing.generate_topic → mesmo correlation_id e
--     idempotency_key, attempt_number incrementado a cada retry
--   • listening.story_session_tts / two_part_tts → eventos separados,
--     operation_part distingue blocos 1 e 2
--   • Sessões Realtime e Pronunciation → registradas em ai_provider_sessions
--   • idempotency_key em ai_usage_events não tem unicidade global:
--     retries legítimos compartilham a mesma chave
--
-- Precedência de controles (ai_runtime_controls):
--   global → provider → feature → user
--   Um escopo inferior NUNCA pode reativar algo bloqueado em escopo superior.
--   Limites comerciais de planos não pertencem a esta tabela.
--
-- Timestamps:
--   • Eventos brutos armazenam timestamps em UTC
--   • O agrupamento comercial diário do Lemon usará America/Sao_Paulo
--     na camada de apresentação do dashboard
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 1: ai_features — catálogo de operações monitoradas e faturáveis
-- ─────────────────────────────────────────────────────────────────────────────
-- TEXT com CHECK em vez de ENUM: evita custo de ALTER TYPE para valores futuros.
-- Novos valores de execution_location ou measurement_strategy exigem apenas
-- uma migration que amplie o CHECK constraint (NOT VALID se necessário).

CREATE TABLE public.ai_features (
  feature_key             TEXT        PRIMARY KEY,
  display_name            TEXT        NOT NULL,
  category                TEXT        NOT NULL,
  provider                TEXT,
  execution_location      TEXT        NOT NULL,
  is_billable             BOOLEAN     NOT NULL,
  primary_billing_metric  TEXT,
  measurement_strategy    TEXT        NOT NULL,
  is_active               BOOLEAN     NOT NULL DEFAULT TRUE,
  metadata                JSONB       NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_af_execution_location CHECK (
    execution_location IN ('backend', 'frontend', 'mixed', 'system')
  ),
  CONSTRAINT chk_af_measurement_strategy CHECK (
    measurement_strategy IN (
      'provider_usage', 'input_derived', 'duration_derived',
      'session_derived', 'non_billable', 'unavailable', 'mixed'
    )
  ),
  CONSTRAINT chk_af_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

ALTER TABLE public.ai_features ENABLE ROW LEVEL SECURITY;
-- RLS ativo sem políticas = service role only. Authenticated e anon não acessam.

CREATE TRIGGER trg_ai_features_updated_at
  BEFORE UPDATE ON public.ai_features
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 2: provider_pricing — tabela versionada de preços por métrica
-- ─────────────────────────────────────────────────────────────────────────────
-- Nenhum preço inserido nesta migration.
-- valid_until NULL significa "vigente até nova entrada".

CREATE TABLE public.provider_pricing (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider         TEXT        NOT NULL,
  service          TEXT        NOT NULL,
  model            TEXT,
  region           TEXT,
  metric_key       TEXT        NOT NULL,
  currency         TEXT        NOT NULL DEFAULT 'USD',
  unit_size        NUMERIC     NOT NULL,
  price_per_unit   NUMERIC     NOT NULL,
  valid_from       TIMESTAMPTZ NOT NULL,
  valid_until      TIMESTAMPTZ,
  is_active        BOOLEAN     NOT NULL DEFAULT TRUE,
  source_reference TEXT,
  metadata         JSONB       NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_pp_unit_size_positive       CHECK (unit_size > 0),
  CONSTRAINT chk_pp_price_non_negative       CHECK (price_per_unit >= 0),
  CONSTRAINT chk_pp_currency_length          CHECK (char_length(currency) = 3),
  CONSTRAINT chk_pp_valid_until_after_from   CHECK (valid_until IS NULL OR valid_until > valid_from),
  CONSTRAINT chk_pp_metadata_object         CHECK (jsonb_typeof(metadata) = 'object')
);

-- Preços ativos consultados com frequência pelo gateway no momento de calcular custo
CREATE INDEX idx_pp_active ON public.provider_pricing (provider, service, metric_key)
  WHERE is_active = TRUE;

ALTER TABLE public.provider_pricing ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_provider_pricing_updated_at
  BEFORE UPDATE ON public.provider_pricing
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 3: ai_runtime_controls — controles globais, por provedor, feature e usuário
-- ─────────────────────────────────────────────────────────────────────────────
-- Precedência: global → provider → feature → user.
-- Um escopo inferior nunca pode reativar algo bloqueado em escopo superior.
-- Limites comerciais de planos NÃO pertencem a esta tabela.
--
-- scope_key para cada scope_type:
--   global   → 'global'
--   provider → nome do provedor (ex: 'openai', 'azure')
--   feature  → feature_key
--   user     → user_id::TEXT

CREATE TABLE public.ai_runtime_controls (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type                TEXT        NOT NULL,
  scope_key                 TEXT        NOT NULL,
  provider                  TEXT,
  feature_key               TEXT        REFERENCES public.ai_features(feature_key) ON DELETE SET NULL,
  user_id                   UUID        REFERENCES auth.users(id) ON DELETE CASCADE,
  runtime_status            TEXT        NOT NULL DEFAULT 'enabled',
  gateway_mode              TEXT        NOT NULL DEFAULT 'legacy',
  daily_budget_usd          NUMERIC,
  monthly_budget_usd        NUMERIC,
  max_concurrent_requests   INTEGER,
  rate_limit_requests       INTEGER,
  rate_limit_window_seconds INTEGER,
  reason                    TEXT,
  updated_by                UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata                  JSONB       NOT NULL DEFAULT '{}',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_arc_scope UNIQUE (scope_type, scope_key),

  CONSTRAINT chk_arc_scope_type CHECK (
    scope_type IN ('global', 'provider', 'feature', 'user')
  ),
  CONSTRAINT chk_arc_runtime_status CHECK (
    runtime_status IN ('enabled', 'cache_only', 'disabled', 'paused_automatically')
  ),
  CONSTRAINT chk_arc_gateway_mode CHECK (
    gateway_mode IN ('legacy', 'observe', 'enforce')
  ),
  CONSTRAINT chk_arc_daily_budget_non_negative CHECK (
    daily_budget_usd IS NULL OR daily_budget_usd >= 0
  ),
  CONSTRAINT chk_arc_monthly_budget_non_negative CHECK (
    monthly_budget_usd IS NULL OR monthly_budget_usd >= 0
  ),
  CONSTRAINT chk_arc_max_concurrent_positive CHECK (
    max_concurrent_requests IS NULL OR max_concurrent_requests > 0
  ),
  CONSTRAINT chk_arc_rate_limit_positive CHECK (
    rate_limit_requests IS NULL OR rate_limit_requests > 0
  ),
  CONSTRAINT chk_arc_rate_window_positive CHECK (
    rate_limit_window_seconds IS NULL OR rate_limit_window_seconds > 0
  ),
  -- Escopo provider exige provider preenchido
  CONSTRAINT chk_arc_provider_scope CHECK (
    scope_type != 'provider' OR provider IS NOT NULL
  ),
  -- Escopo feature exige feature_key preenchido
  CONSTRAINT chk_arc_feature_scope CHECK (
    scope_type != 'feature' OR feature_key IS NOT NULL
  ),
  -- Escopo user exige user_id preenchido
  CONSTRAINT chk_arc_user_scope CHECK (
    scope_type != 'user' OR user_id IS NOT NULL
  ),
  CONSTRAINT chk_arc_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

-- O UNIQUE (scope_type, scope_key) já cobre lookups por escopo.
-- Índice adicional para consultas por feature_key (ex: bloquear feature específica)
CREATE INDEX idx_arc_feature_key ON public.ai_runtime_controls (feature_key)
  WHERE feature_key IS NOT NULL;

-- Índice para consultas por user_id (controles de usuário específico)
CREATE INDEX idx_arc_user_id ON public.ai_runtime_controls (user_id)
  WHERE user_id IS NOT NULL;

ALTER TABLE public.ai_runtime_controls ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_ai_runtime_controls_updated_at
  BEFORE UPDATE ON public.ai_runtime_controls
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 4: ai_provider_sessions — ponte central para sessões com token efêmero
-- ─────────────────────────────────────────────────────────────────────────────
-- Necessária porque dois fluxos chamam provedores diretamente pelo navegador:
--   • conversation.webrtc_connect  (OpenAI Realtime — token efêmero via /session)
--   • pronunciation.assess_text    (Azure — token via Cognitive Services)
--
-- NUNCA armazenar o token efêmero. Se necessário, armazenar apenas
-- authorization_fingerprint como SHA-256 do token original.
--
-- Esta tabela NÃO substitui conversation_sessions nem pronunciation_assessments.
-- Ela cria a ponte de medição central para correlacionar autorização backend
-- com uso real no frontend.

CREATE TABLE public.ai_provider_sessions (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  initiated_by_user_id      UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  feature_key               TEXT        NOT NULL REFERENCES public.ai_features(feature_key),
  provider                  TEXT        NOT NULL,
  internal_session_type     TEXT,
  internal_session_id       TEXT,
  provider_session_id       TEXT,
  authorization_fingerprint TEXT,   -- SHA-256 do token efêmero, se necessário; nunca o token
  authorization_expires_at  TIMESTAMPTZ,
  status                    TEXT        NOT NULL DEFAULT 'authorized',
  measurement_source        TEXT,
  started_at                TIMESTAMPTZ,
  ended_at                  TIMESTAMPTZ,
  duration_seconds          NUMERIC,
  metadata                  JSONB       NOT NULL DEFAULT '{}',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_aps_status CHECK (
    status IN ('authorized', 'connecting', 'active', 'completed', 'failed', 'expired', 'cancelled')
  ),
  CONSTRAINT chk_aps_duration_non_negative CHECK (
    duration_seconds IS NULL OR duration_seconds >= 0
  ),
  CONSTRAINT chk_aps_ended_after_started CHECK (
    ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at
  ),
  CONSTRAINT chk_aps_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

-- Lookup por sessão do provedor (ex: OpenAI session_id retornado pelo Realtime)
CREATE INDEX idx_aps_provider_session_id ON public.ai_provider_sessions (provider_session_id)
  WHERE provider_session_id IS NOT NULL;

-- Lookup por sessão interna do domínio (ex: conversation_sessions.id)
CREATE INDEX idx_aps_internal_session ON public.ai_provider_sessions (internal_session_type, internal_session_id)
  WHERE internal_session_type IS NOT NULL AND internal_session_id IS NOT NULL;

-- Lookup por usuário e status (ex: sessões ativas de um usuário)
CREATE INDEX idx_aps_user_status ON public.ai_provider_sessions (user_id, status)
  WHERE user_id IS NOT NULL;

-- Expiração de autorizações pendentes
CREATE INDEX idx_aps_auth_expiry ON public.ai_provider_sessions (authorization_expires_at)
  WHERE status IN ('authorized', 'connecting') AND authorization_expires_at IS NOT NULL;

ALTER TABLE public.ai_provider_sessions ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_ai_provider_sessions_updated_at
  BEFORE UPDATE ON public.ai_provider_sessions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 5: ai_usage_events — registro de cada chamada real ao provedor
-- ─────────────────────────────────────────────────────────────────────────────
-- Uma ação lógica pode produzir vários eventos ligados pelo mesmo correlation_id.
-- Retries compartilham correlation_id e idempotency_key; attempt_number distingue.
-- idempotency_key NÃO tem unicidade global: retries são eventos físicos separados.
--
-- user_id     = usuário ao qual o consumo é atribuído (pode ser NULL para sistema/cron)
-- initiated_by_user_id = quem iniciou a operação (pode ser usuário mesmo para cron/sistema)
--
-- resource_type/resource_id permitem relacionar o evento a entidades do domínio:
--   writing_entry, listening_episode, conversation_session, pronunciation_assessment, etc.
--
-- Custos NULL significam "desconhecido" — não converter para 0.
-- O dashboard diferencia NULL (custo desconhecido) de 0 (custo confirmado zero).

CREATE TABLE public.ai_usage_events (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id                  UUID        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  correlation_id              UUID,
  parent_event_id             UUID        REFERENCES public.ai_usage_events(id) ON DELETE SET NULL,
  provider_session_record_id  UUID        REFERENCES public.ai_provider_sessions(id) ON DELETE SET NULL,
  idempotency_key             TEXT,   -- sem unicidade: retries compartilham a mesma chave
  user_id                     UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  initiated_by_user_id        UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_type                  TEXT        NOT NULL DEFAULT 'user',
  feature_key                 TEXT        NOT NULL REFERENCES public.ai_features(feature_key),
  provider                    TEXT        NOT NULL,
  service                     TEXT,
  model                       TEXT,
  provider_request_id         TEXT,
  execution_location          TEXT        NOT NULL,
  status                      TEXT        NOT NULL,
  attempt_number              INTEGER     NOT NULL DEFAULT 1,
  call_sequence               INTEGER     NOT NULL DEFAULT 1,
  operation_part              TEXT,   -- ex: 'block_1', 'block_2' para TTS de Listening
  is_billable                 BOOLEAN     NOT NULL,
  cost_status                 TEXT        NOT NULL DEFAULT 'pending',
  estimated_cost_usd          NUMERIC,    -- NULL = desconhecido, não zero
  calculated_cost_usd         NUMERIC,    -- NULL = desconhecido, não zero
  reconciled_cost_usd         NUMERIC,    -- NULL = desconhecido, não zero
  cache_hit                   BOOLEAN     NOT NULL DEFAULT FALSE,
  latency_ms                  INTEGER,
  http_status                 INTEGER,
  error_code                  TEXT,
  error_category              TEXT,
  sanitized_error_message     TEXT,   -- mensagem sanitizada, sem dados pessoais
  block_reason                TEXT,
  resource_type               TEXT,   -- 'writing_entry' | 'listening_episode' | etc.
  resource_id                 TEXT,
  metadata                    JSONB       NOT NULL DEFAULT '{}',
  started_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at                TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_aue_actor_type CHECK (
    actor_type IN ('user', 'system', 'cron', 'admin')
  ),
  CONSTRAINT chk_aue_execution_location CHECK (
    execution_location IN ('backend', 'frontend', 'mixed', 'system')
  ),
  CONSTRAINT chk_aue_status CHECK (
    status IN ('started', 'succeeded', 'failed', 'blocked', 'cancelled', 'expired')
  ),
  CONSTRAINT chk_aue_cost_status CHECK (
    cost_status IN ('pending', 'not_applicable', 'estimated', 'calculated', 'reconciled', 'unavailable')
  ),
  CONSTRAINT chk_aue_attempt_number CHECK (attempt_number >= 1),
  CONSTRAINT chk_aue_call_sequence   CHECK (call_sequence >= 1),
  CONSTRAINT chk_aue_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

-- Eventos por usuário/data (dashboard por usuário, billing)
CREATE INDEX idx_aue_user_date ON public.ai_usage_events (user_id, started_at)
  WHERE user_id IS NOT NULL;

-- Eventos por iniciador/data (auditoria de quem disparou calls de sistema)
CREATE INDEX idx_aue_initiator_date ON public.ai_usage_events (initiated_by_user_id, started_at)
  WHERE initiated_by_user_id IS NOT NULL;

-- Feature/data (monitoramento por funcionalidade)
CREATE INDEX idx_aue_feature_date ON public.ai_usage_events (feature_key, started_at);

-- Provider/data (monitoramento por provedor)
CREATE INDEX idx_aue_provider_date ON public.ai_usage_events (provider, started_at);

-- Status/data (monitoramento de erros e falhas)
CREATE INDEX idx_aue_status_date ON public.ai_usage_events (status, started_at);

-- cost_status (reconciliação de custos pendentes)
CREATE INDEX idx_aue_cost_status ON public.ai_usage_events (cost_status)
  WHERE cost_status NOT IN ('reconciled', 'not_applicable');

-- correlation_id (agrupar chamadas relacionadas)
CREATE INDEX idx_aue_correlation ON public.ai_usage_events (correlation_id)
  WHERE correlation_id IS NOT NULL;

-- parent_event_id (navegar hierarquia de subchamadas)
CREATE INDEX idx_aue_parent ON public.ai_usage_events (parent_event_id)
  WHERE parent_event_id IS NOT NULL;

-- idempotency_key (deduplicação e rastreamento de retries)
CREATE INDEX idx_aue_idempotency ON public.ai_usage_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- provider_request_id (correlacionar com logs do provedor)
CREATE INDEX idx_aue_provider_request ON public.ai_usage_events (provider_request_id)
  WHERE provider_request_id IS NOT NULL;

-- provider_session_record_id (vincular eventos a sessões Realtime/Pronunciation)
CREATE INDEX idx_aue_provider_session ON public.ai_usage_events (provider_session_record_id)
  WHERE provider_session_record_id IS NOT NULL;

-- resource_type + resource_id (vincular evento a entidade do domínio)
CREATE INDEX idx_aue_resource ON public.ai_usage_events (resource_type, resource_id)
  WHERE resource_type IS NOT NULL;

ALTER TABLE public.ai_usage_events ENABLE ROW LEVEL SECURITY;
-- Sem políticas: somente service role acessa dados brutos de eventos.
-- Gateway e dashboard lêem via backend server-side.

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 6: ai_usage_event_metrics — métricas normalizadas por evento
-- ─────────────────────────────────────────────────────────────────────────────
-- Tabela normalizada para suportar múltiplas modalidades de billing:
--   input_text_tokens, output_text_tokens, cached_input_tokens,
--   input_audio_tokens, output_audio_tokens, tts_characters,
--   audio_seconds, session_seconds, audio_bytes,
--   provider_requests, tokens_issued
--
-- Novas métricas podem ser adicionadas sem migration estrutural.
--
-- is_final = TRUE indica que o registro é o total definitivo para a
-- combinação (usage_event_id, metric_key, unit_type). Permite métricas
-- intermediárias (ex: streaming parcial) e exatamente um total final.

CREATE TABLE public.ai_usage_event_metrics (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  usage_event_id      UUID        NOT NULL REFERENCES public.ai_usage_events(id) ON DELETE CASCADE,
  metric_key          TEXT        NOT NULL,
  unit_type           TEXT        NOT NULL,
  quantity            NUMERIC     NOT NULL,
  billable_quantity   NUMERIC,
  is_billable         BOOLEAN     NOT NULL,
  is_final            BOOLEAN     NOT NULL DEFAULT TRUE,
  measurement_source  TEXT        NOT NULL,
  pricing_id          UUID        REFERENCES public.provider_pricing(id) ON DELETE SET NULL,
  calculated_cost_usd NUMERIC,
  metadata            JSONB       NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_auem_quantity_non_negative CHECK (quantity >= 0),
  CONSTRAINT chk_auem_billable_qty_non_negative CHECK (
    billable_quantity IS NULL OR billable_quantity >= 0
  ),
  CONSTRAINT chk_auem_cost_non_negative CHECK (
    calculated_cost_usd IS NULL OR calculated_cost_usd >= 0
  ),
  CONSTRAINT chk_auem_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

-- Impede duplicação do total final por (evento, métrica, unidade)
CREATE UNIQUE INDEX uq_auem_final_metric
  ON public.ai_usage_event_metrics (usage_event_id, metric_key, unit_type)
  WHERE is_final = TRUE;

-- Lookup de métricas por evento (carregamento do breakdown de custo)
CREATE INDEX idx_auem_event ON public.ai_usage_event_metrics (usage_event_id);

ALTER TABLE public.ai_usage_event_metrics ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 7: usage_reservations — reservas de orçamento pré-chamada
-- ─────────────────────────────────────────────────────────────────────────────
-- A lógica de reserva não é implementada nesta migration.
-- A estrutura é criada para suportar futuro controle de orçamento em tempo real.

CREATE TABLE public.usage_reservations (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id                 UUID        NOT NULL,
  correlation_id             UUID,
  provider_session_record_id UUID        REFERENCES public.ai_provider_sessions(id) ON DELETE SET NULL,
  idempotency_key            TEXT,
  user_id                    UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  initiated_by_user_id       UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  feature_key                TEXT        NOT NULL REFERENCES public.ai_features(feature_key),
  status                     TEXT        NOT NULL DEFAULT 'pending',
  estimated_cost_usd         NUMERIC,
  actual_cost_usd            NUMERIC,
  usage_event_id             UUID        REFERENCES public.ai_usage_events(id) ON DELETE SET NULL,
  expires_at                 TIMESTAMPTZ NOT NULL,
  finalized_at               TIMESTAMPTZ,
  metadata                   JSONB       NOT NULL DEFAULT '{}',
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_ur_status CHECK (
    status IN ('pending', 'committed', 'released', 'expired', 'cancelled')
  ),
  CONSTRAINT chk_ur_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

-- Reservas pendentes (verificação de orçamento antes de chamar provedor)
CREATE INDEX idx_ur_pending ON public.usage_reservations (user_id, feature_key)
  WHERE status = 'pending';

-- Reservas expiradas para limpeza periódica
CREATE INDEX idx_ur_expiry ON public.usage_reservations (expires_at)
  WHERE status = 'pending';

ALTER TABLE public.usage_reservations ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_usage_reservations_updated_at
  BEFORE UPDATE ON public.usage_reservations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 8: usage_reservation_items — itens de reserva por quota
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE public.usage_reservation_items (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id    UUID        NOT NULL REFERENCES public.usage_reservations(id) ON DELETE CASCADE,
  quota_key         TEXT        NOT NULL,
  unit_type         TEXT        NOT NULL,
  reserved_quantity NUMERIC     NOT NULL,
  consumed_quantity NUMERIC     NOT NULL DEFAULT 0,
  released_quantity NUMERIC     NOT NULL DEFAULT 0,
  metadata          JSONB       NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_uri_reservation_quota UNIQUE (reservation_id, quota_key, unit_type),
  CONSTRAINT chk_uri_reserved_non_negative  CHECK (reserved_quantity  >= 0),
  CONSTRAINT chk_uri_consumed_non_negative  CHECK (consumed_quantity  >= 0),
  CONSTRAINT chk_uri_released_non_negative  CHECK (released_quantity  >= 0),
  CONSTRAINT chk_uri_metadata_object        CHECK (jsonb_typeof(metadata) = 'object')
);

ALTER TABLE public.usage_reservation_items ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 9: usage_daily — resumo diário para o dashboard
-- ─────────────────────────────────────────────────────────────────────────────
-- Agregação não implementada nesta migration: tabela criada para uso futuro.
--
-- Unicidade lógica: (data, usuário-ou-sistema, actor_type, feature, provider, model)
-- NULL user_id representa eventos de sistema/cron.
-- COALESCE no índice trata NULL como sentinela '00000000-0000-0000-0000-000000000000'
-- para garantir unicidade de linha de sistema.

CREATE TABLE public.usage_daily (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  usage_date            DATE        NOT NULL,
  user_id               UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_type            TEXT        NOT NULL,
  feature_key           TEXT        NOT NULL REFERENCES public.ai_features(feature_key),
  provider              TEXT        NOT NULL,
  model                 TEXT,
  total_requests        BIGINT      NOT NULL DEFAULT 0,
  successful_requests   BIGINT      NOT NULL DEFAULT 0,
  failed_requests       BIGINT      NOT NULL DEFAULT 0,
  blocked_requests      BIGINT      NOT NULL DEFAULT 0,
  cache_hits            BIGINT      NOT NULL DEFAULT 0,
  unpriced_events       BIGINT      NOT NULL DEFAULT 0,
  estimated_cost_usd    NUMERIC     NOT NULL DEFAULT 0,
  calculated_cost_usd   NUMERIC     NOT NULL DEFAULT 0,
  reconciled_cost_usd   NUMERIC     NOT NULL DEFAULT 0,
  last_event_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_ud_actor_type CHECK (
    actor_type IN ('user', 'system', 'cron', 'admin')
  )
);

-- Unicidade composta incluindo NULL user_id (sistema/cron)
CREATE UNIQUE INDEX uq_usage_daily_composite ON public.usage_daily (
  usage_date,
  COALESCE(user_id::TEXT, '00000000-0000-0000-0000-000000000000'),
  actor_type,
  feature_key,
  provider,
  COALESCE(model, '')
);

-- Lookup para dashboard (agregação por data e usuário)
CREATE INDEX idx_ud_date_user ON public.usage_daily (usage_date, user_id);

-- Lookup para análise por feature
CREATE INDEX idx_ud_feature_date ON public.usage_daily (feature_key, usage_date);

ALTER TABLE public.usage_daily ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_usage_daily_updated_at
  BEFORE UPDATE ON public.usage_daily
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 10: usage_daily_metrics — breakdown de métricas do resumo diário
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE public.usage_daily_metrics (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  usage_daily_id        UUID        NOT NULL REFERENCES public.usage_daily(id) ON DELETE CASCADE,
  metric_key            TEXT        NOT NULL,
  unit_type             TEXT        NOT NULL,
  total_quantity        NUMERIC     NOT NULL DEFAULT 0,
  billable_quantity     NUMERIC     NOT NULL DEFAULT 0,
  calculated_cost_usd   NUMERIC     NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_udm_daily_metric UNIQUE (usage_daily_id, metric_key, unit_type)
);

CREATE INDEX idx_udm_daily ON public.usage_daily_metrics (usage_daily_id);

ALTER TABLE public.usage_daily_metrics ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_usage_daily_metrics_updated_at
  BEFORE UPDATE ON public.usage_daily_metrics
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- =============================================================================
-- CATÁLOGO: 25 features auditadas
-- =============================================================================
-- Legenda de campos:
--   execution_location: backend | frontend | mixed | system
--   measurement_strategy: provider_usage | input_derived | duration_derived |
--                         session_derived | non_billable | unavailable | mixed
--   is_billable: FALSE para operações de infra/autorização sem custo direto
--
-- conversation.webrtc_connect: NÃO registra custo diretamente.
--   O consumo faturável da sessão Realtime será atribuído a
--   conversation.realtime_usage (chave contábil separada).
-- =============================================================================

INSERT INTO public.ai_features (
  feature_key, display_name, category, provider,
  execution_location, is_billable, primary_billing_metric, measurement_strategy
) VALUES

-- ── Conversation ──────────────────────────────────────────────────────────────

(
  'conversation.preview_tts',
  'Conversation — Preview TTS',
  'conversation', 'openai',
  'backend', TRUE, 'tts_characters', 'input_derived'
),
(
  'conversation.create_session',
  'Conversation — Create Realtime Session',
  'conversation', 'openai',
  'backend', FALSE, NULL, 'non_billable'
  -- Cria o token efêmero no backend; custo faturável vai para realtime_usage
),
(
  'conversation.webrtc_connect',
  'Conversation — WebRTC Connect (Frontend)',
  'conversation', 'openai',
  'frontend', FALSE, NULL, 'non_billable'
  -- Chamada direta do navegador; custo atribuído a conversation.realtime_usage
),
(
  'conversation.realtime_usage',
  'Conversation — Realtime Session Usage (Billing)',
  'conversation', 'openai',
  'mixed', TRUE, NULL, 'mixed'
  -- Chave contábil: agrega tokens de áudio/texto da sessão Realtime.
  -- Não corresponde a uma terceira chamada de frontend; é a unidade de billing.
),

-- ── Writing ───────────────────────────────────────────────────────────────────

(
  'writing.correct',
  'Writing — Correct Entry',
  'writing', 'openai',
  'backend', TRUE, 'output_text_tokens', 'provider_usage'
),
(
  'writing.correct_review',
  'Writing — Correct Review',
  'writing', 'openai',
  'backend', TRUE, 'output_text_tokens', 'provider_usage'
),
(
  'writing.compare_rewrite',
  'Writing — Compare Rewrite',
  'writing', 'openai',
  'backend', TRUE, 'output_text_tokens', 'provider_usage'
  -- Gerado com correlation_id compartilhado com writing.correct_v2_text
),
(
  'writing.correct_v2_text',
  'Writing — Correct V2 Text',
  'writing', 'openai',
  'backend', TRUE, 'output_text_tokens', 'provider_usage'
  -- Gerado com correlation_id compartilhado com writing.compare_rewrite
),
(
  'writing.generate_topic',
  'Writing — Generate Topic',
  'writing', 'openai',
  'backend', TRUE, 'output_text_tokens', 'provider_usage'
  -- Retries compartilham correlation_id e idempotency_key; attempt_number distingue
),
(
  'writing.explain_grammar',
  'Writing — Explain Grammar',
  'writing', 'openai',
  'backend', TRUE, 'output_text_tokens', 'provider_usage'
),
(
  'writing.evaluate_rewrite',
  'Writing — Evaluate Rewrite',
  'writing', 'openai',
  'backend', TRUE, 'output_text_tokens', 'provider_usage'
),

-- ── Pronunciation ─────────────────────────────────────────────────────────────

(
  'pronunciation.generate_text',
  'Pronunciation — Generate Practice Text',
  'pronunciation', 'openai',
  'backend', TRUE, 'output_text_tokens', 'provider_usage'
),
(
  'pronunciation.get_azure_token',
  'Pronunciation — Get Azure Token',
  'pronunciation', 'azure',
  'backend', FALSE, NULL, 'non_billable'
  -- Emissão do token de acesso ao Cognitive Services; sem custo direto de uso
),
(
  'pronunciation.start_assessment',
  'Pronunciation — Start Assessment (Backend)',
  'pronunciation', 'azure',
  'backend', FALSE, NULL, 'non_billable'
  -- Inicialização do recognizer no backend; custo faturável vai para assess_text
),
(
  'pronunciation.assess_text',
  'Pronunciation — Assess Text (Frontend)',
  'pronunciation', 'azure',
  'frontend', TRUE, 'audio_seconds', 'duration_derived'
  -- Chamada direta do navegador via Azure SDK; medido por duração do áudio
),

-- ── TTS ───────────────────────────────────────────────────────────────────────

(
  'tts.synthesize',
  'TTS — Synthesize Audio',
  'tts', NULL,
  'backend', TRUE, 'tts_characters', 'input_derived'
  -- Provider NULL: pode ser OpenAI ou Azure dependendo da configuração em runtime
),

-- ── Listening — story sessions (geração sob demanda) ─────────────────────────

(
  'listening.story_session_generate',
  'Listening — Story Session Generate',
  'listening', 'openai',
  'system', TRUE, 'output_text_tokens', 'provider_usage'
),
(
  'listening.story_session_tts',
  'Listening — Story Session TTS',
  'listening', NULL,
  'system', TRUE, 'tts_characters', 'input_derived'
  -- operation_part distingue blocos 1 e 2 quando há múltiplos eventos
),

-- ── Listening — two-part pipeline ────────────────────────────────────────────

(
  'listening.two_part_generate',
  'Listening — Two-Part Generate',
  'listening', 'openai',
  'system', TRUE, 'output_text_tokens', 'provider_usage'
),
(
  'listening.two_part_tts',
  'Listening — Two-Part TTS',
  'listening', NULL,
  'system', TRUE, 'tts_characters', 'input_derived'
),

-- ── Listening — episode pipeline (cron/system) ────────────────────────────────

(
  'listening.episode_generate_story',
  'Listening — Episode Generate Story',
  'listening', 'openai',
  'system', TRUE, 'output_text_tokens', 'provider_usage'
),
(
  'listening.episode_generate_questions',
  'Listening — Episode Generate Questions',
  'listening', 'openai',
  'system', TRUE, 'output_text_tokens', 'provider_usage'
),
(
  'listening.episode_translate_synopsis',
  'Listening — Episode Translate Synopsis',
  'listening', 'openai',
  'system', TRUE, 'output_text_tokens', 'provider_usage'
),
(
  'listening.episode_translate_subtitles',
  'Listening — Episode Translate Subtitles',
  'listening', 'openai',
  'system', TRUE, 'output_text_tokens', 'provider_usage'
),
(
  'listening.episode_synthesize_audio',
  'Listening — Episode Synthesize Audio',
  'listening', NULL,
  'system', TRUE, 'tts_characters', 'input_derived'
);

-- =============================================================================
-- SEEDS: 28 controles iniciais em ai_runtime_controls
-- =============================================================================
-- Todos os controles iniciam em modo legacy + enabled.
-- Nenhum limite ou orçamento ativado.
-- Controles de usuário não são criados nesta etapa.
-- =============================================================================

INSERT INTO public.ai_runtime_controls (
  scope_type, scope_key, provider, feature_key, user_id,
  runtime_status, gateway_mode,
  daily_budget_usd, monthly_budget_usd,
  max_concurrent_requests, rate_limit_requests, rate_limit_window_seconds,
  reason
) VALUES

-- ── 1 controle global ─────────────────────────────────────────────────────────
(
  'global', 'global', NULL, NULL, NULL,
  'enabled', 'legacy',
  NULL, NULL, NULL, NULL, NULL,
  'Controle raiz do AI Gateway — modo legacy enquanto gateway não é implementado'
),

-- ── 1 controle por provedor: OpenAI ───────────────────────────────────────────
(
  'provider', 'openai', 'openai', NULL, NULL,
  'enabled', 'legacy',
  NULL, NULL, NULL, NULL, NULL,
  'Controle agregado para todas as chamadas OpenAI'
),

-- ── 1 controle por provedor: Azure ────────────────────────────────────────────
(
  'provider', 'azure', 'azure', NULL, NULL,
  'enabled', 'legacy',
  NULL, NULL, NULL, NULL, NULL,
  'Controle agregado para todas as chamadas Azure Cognitive Services'
),

-- ── 25 controles por feature ──────────────────────────────────────────────────

('feature', 'conversation.preview_tts',              NULL, 'conversation.preview_tts',              NULL, 'enabled', 'legacy', NULL, NULL, NULL, NULL, NULL, NULL),
('feature', 'conversation.create_session',           NULL, 'conversation.create_session',           NULL, 'enabled', 'legacy', NULL, NULL, NULL, NULL, NULL, NULL),
('feature', 'conversation.webrtc_connect',           NULL, 'conversation.webrtc_connect',           NULL, 'enabled', 'legacy', NULL, NULL, NULL, NULL, NULL, NULL),
('feature', 'conversation.realtime_usage',           NULL, 'conversation.realtime_usage',           NULL, 'enabled', 'legacy', NULL, NULL, NULL, NULL, NULL, NULL),
('feature', 'writing.correct',                       NULL, 'writing.correct',                       NULL, 'enabled', 'legacy', NULL, NULL, NULL, NULL, NULL, NULL),
('feature', 'writing.correct_review',                NULL, 'writing.correct_review',                NULL, 'enabled', 'legacy', NULL, NULL, NULL, NULL, NULL, NULL),
('feature', 'writing.compare_rewrite',               NULL, 'writing.compare_rewrite',               NULL, 'enabled', 'legacy', NULL, NULL, NULL, NULL, NULL, NULL),
('feature', 'writing.correct_v2_text',               NULL, 'writing.correct_v2_text',               NULL, 'enabled', 'legacy', NULL, NULL, NULL, NULL, NULL, NULL),
('feature', 'writing.generate_topic',                NULL, 'writing.generate_topic',                NULL, 'enabled', 'legacy', NULL, NULL, NULL, NULL, NULL, NULL),
('feature', 'writing.explain_grammar',               NULL, 'writing.explain_grammar',               NULL, 'enabled', 'legacy', NULL, NULL, NULL, NULL, NULL, NULL),
('feature', 'writing.evaluate_rewrite',              NULL, 'writing.evaluate_rewrite',              NULL, 'enabled', 'legacy', NULL, NULL, NULL, NULL, NULL, NULL),
('feature', 'pronunciation.generate_text',           NULL, 'pronunciation.generate_text',           NULL, 'enabled', 'legacy', NULL, NULL, NULL, NULL, NULL, NULL),
('feature', 'pronunciation.get_azure_token',         NULL, 'pronunciation.get_azure_token',         NULL, 'enabled', 'legacy', NULL, NULL, NULL, NULL, NULL, NULL),
('feature', 'pronunciation.start_assessment',        NULL, 'pronunciation.start_assessment',        NULL, 'enabled', 'legacy', NULL, NULL, NULL, NULL, NULL, NULL),
('feature', 'pronunciation.assess_text',             NULL, 'pronunciation.assess_text',             NULL, 'enabled', 'legacy', NULL, NULL, NULL, NULL, NULL, NULL),
('feature', 'tts.synthesize',                        NULL, 'tts.synthesize',                        NULL, 'enabled', 'legacy', NULL, NULL, NULL, NULL, NULL, NULL),
('feature', 'listening.story_session_generate',      NULL, 'listening.story_session_generate',      NULL, 'enabled', 'legacy', NULL, NULL, NULL, NULL, NULL, NULL),
('feature', 'listening.story_session_tts',           NULL, 'listening.story_session_tts',           NULL, 'enabled', 'legacy', NULL, NULL, NULL, NULL, NULL, NULL),
('feature', 'listening.two_part_generate',           NULL, 'listening.two_part_generate',           NULL, 'enabled', 'legacy', NULL, NULL, NULL, NULL, NULL, NULL),
('feature', 'listening.two_part_tts',                NULL, 'listening.two_part_tts',                NULL, 'enabled', 'legacy', NULL, NULL, NULL, NULL, NULL, NULL),
('feature', 'listening.episode_generate_story',      NULL, 'listening.episode_generate_story',      NULL, 'enabled', 'legacy', NULL, NULL, NULL, NULL, NULL, NULL),
('feature', 'listening.episode_generate_questions',  NULL, 'listening.episode_generate_questions',  NULL, 'enabled', 'legacy', NULL, NULL, NULL, NULL, NULL, NULL),
('feature', 'listening.episode_translate_synopsis',  NULL, 'listening.episode_translate_synopsis',  NULL, 'enabled', 'legacy', NULL, NULL, NULL, NULL, NULL, NULL),
('feature', 'listening.episode_translate_subtitles', NULL, 'listening.episode_translate_subtitles', NULL, 'enabled', 'legacy', NULL, NULL, NULL, NULL, NULL, NULL),
('feature', 'listening.episode_synthesize_audio',    NULL, 'listening.episode_synthesize_audio',    NULL, 'enabled', 'legacy', NULL, NULL, NULL, NULL, NULL, NULL);

-- =============================================================================
-- VALIDAÇÃO INLINE
-- =============================================================================
-- As queries abaixo levantam exceção se qualquer contagem estiver incorreta,
-- garantindo que a migration falhe atomicamente em vez de silenciosamente.

DO $$
DECLARE
  v_features_count  INTEGER;
  v_controls_count  INTEGER;
  v_legacy_count    INTEGER;
  v_enabled_count   INTEGER;
  v_pricing_count   INTEGER;
  v_events_count    INTEGER;
  v_sessions_count  INTEGER;
  v_metrics_count   INTEGER;
  v_reservations_count INTEGER;
  v_daily_count     INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_features_count     FROM public.ai_features;
  SELECT COUNT(*) INTO v_controls_count     FROM public.ai_runtime_controls;
  SELECT COUNT(*) INTO v_legacy_count       FROM public.ai_runtime_controls WHERE gateway_mode = 'legacy';
  SELECT COUNT(*) INTO v_enabled_count      FROM public.ai_runtime_controls WHERE runtime_status = 'enabled';
  SELECT COUNT(*) INTO v_pricing_count      FROM public.provider_pricing;
  SELECT COUNT(*) INTO v_events_count       FROM public.ai_usage_events;
  SELECT COUNT(*) INTO v_sessions_count     FROM public.ai_provider_sessions;
  SELECT COUNT(*) INTO v_metrics_count      FROM public.ai_usage_event_metrics;
  SELECT COUNT(*) INTO v_reservations_count FROM public.usage_reservations;
  SELECT COUNT(*) INTO v_daily_count        FROM public.usage_daily;

  IF v_features_count != 25 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: expected 25 ai_features, got %', v_features_count;
  END IF;

  IF v_controls_count != 28 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: expected 28 ai_runtime_controls, got %', v_controls_count;
  END IF;

  IF v_legacy_count != 28 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: all 28 controls must be in legacy mode, got %', v_legacy_count;
  END IF;

  IF v_enabled_count != 28 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: all 28 controls must be enabled, got %', v_enabled_count;
  END IF;

  IF v_pricing_count != 0 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: provider_pricing must be empty, got %', v_pricing_count;
  END IF;

  IF v_events_count != 0 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: ai_usage_events must be empty, got %', v_events_count;
  END IF;

  IF v_sessions_count != 0 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: ai_provider_sessions must be empty, got %', v_sessions_count;
  END IF;

  IF v_metrics_count != 0 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: ai_usage_event_metrics must be empty, got %', v_metrics_count;
  END IF;

  IF v_reservations_count != 0 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: usage_reservations must be empty, got %', v_reservations_count;
  END IF;

  IF v_daily_count != 0 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: usage_daily must be empty, got %', v_daily_count;
  END IF;

  RAISE NOTICE 'VALIDATION PASSED: % features, % controls (all legacy + enabled), 0 prices, 0 events, 0 sessions, 0 metrics, 0 reservations, 0 daily aggregates',
    v_features_count, v_controls_count;
END;
$$;

COMMIT;

-- =============================================================================
-- FIM DA MIGRATION 20260717000000_create_ai_gateway_foundation
-- =============================================================================
