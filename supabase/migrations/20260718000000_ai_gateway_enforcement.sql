-- =============================================================================
-- MIGRATION: 20260718000000_ai_gateway_enforcement
-- Projeto: Lemon (english learning app)
--
-- Etapa 11 — camada de enforcement do AI Gateway, incluindo a correção
-- obrigatória que fecha os gaps admitidos na primeira versão desta
-- migration (quota per-call apenas, budget+reserve não atômicos, dashboard
-- não materializado). Reescrita NO MESMO ARQUIVO — nunca aplicado
-- remotamente, portanto seguro corrigir em vez de empilhar uma migration
-- corretiva. EXCLUSIVAMENTE ADITIVA: nenhuma tabela, view, política ou
-- função pré-existente (fora deste arquivo) é removida ou tem comportamento
-- alterado para o tráfego atual. Esta migration NÃO é aplicada
-- automaticamente por esta entrega — arquivo local apenas.
--
-- BLOCO 1: ai_gateway_decisions — log técnico de decisões do gateway.
-- BLOCO 2: ai_gateway_idempotency_locks + funções — dedupe genérico (Fase 4).
-- BLOCO 3: Quota acumulada por período + budget, atômicos com a reserva:
--          ai_gateway_quota_buckets, ai_gateway_budget_buckets,
--          ai_gateway_reservation_budget_links, colunas aditivas em
--          usage_reservation_items, e reserve/commit/release/mark_
--          reconciliation_required_gateway_*_v1 reescritas para validar e
--          reservar quota+budget em uma única transação com locks
--          ordenados deterministicamente.
-- BLOCO 4: ai_gateway_circuit_breakers + funções (Fase 8).
-- BLOCO 5: api_rate_limits + check_and_increment_rate_limit (Fase 3),
--          re-declaração idempotente de 20260714130000_api_rate_limits.sql.
-- BLOCO 6: ai_runtime_controls.runtime_status ganha 'circuit_open' e
--          'maintenance' (ampliação aditiva do CHECK) — nenhum valor
--          existente é alterado.
-- BLOCO 7: Publicação dashboard → runtime (materialização), via função +
--          triggers em ai_gateway_configs/ai_control_switches/
--          ai_pricing_versions. Só escreve nas colunas que o dashboard
--          realmente é autoridade de (ver comentário do bloco); nunca toca
--          gateway_mode de provider/feature (o dashboard não tem essa
--          fonte hoje) nem sobrescreve preços seedados manualmente fora
--          desta publicação (marcados por source_reference).
-- BLOCO 8: ai_gateway_concurrency_validations + record_gateway_
--          concurrency_validation_v1 — registro persistente, server-only
--          (sem policy de RLS, função revogada de anon/authenticated), do
--          resultado real da execução manual dos 7 cenários de
--          supabase/manual-validation/ai-gateway-enforcement-concurrency.sql.
--          O preflight (scripts/ai-gateway-enforce-preflight.ts) lê esta
--          tabela ao vivo para computar concurrencyValidated — nunca um
--          boolean fixo no código. Vinculado a migration_version +
--          validation_script_sha256 (hash do arquivo de validação
--          calculado em tempo real): qualquer alteração no arquivo invalida
--          automaticamente uma aprovação anterior.
--
-- Nenhum gateway_mode ou runtime_status EXISTENTE é alterado por esta
-- migration em si (os triggers do BLOCO 7 só disparam com escrita futura
-- nas tabelas do dashboard, nunca durante a aplicação desta migration).
-- Confirmado por auditoria direta: hoje existem features em legacy E em
-- observe simultaneamente — a validação final captura o estado antes/depois
-- e falha se qualquer linha existente mudar, em vez de presumir um estado
-- fixo.
-- =============================================================================

BEGIN;

-- Real before-snapshot, captured before any DDL/DML below runs — carried in
-- a TEMP TABLE (session/transaction-scoped) so the validation block at the
-- end of this file can diff against genuine "before" state instead of
-- comparing a value against itself.
CREATE TEMP TABLE _migration_arc_before AS
  SELECT id, gateway_mode, runtime_status FROM public.ai_runtime_controls;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 1: ai_gateway_decisions
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ai_gateway_decisions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  outcome         TEXT        NOT NULL,
  reason_code     TEXT        NOT NULL,
  feature_key     TEXT        NOT NULL REFERENCES public.ai_features(feature_key),
  provider        TEXT,
  user_id         UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_type      TEXT        NOT NULL,
  gateway_mode    TEXT        NOT NULL,
  policy_revision TEXT,
  correlation_id  UUID,
  metadata        JSONB       NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_agd_outcome CHECK (outcome IN ('allowed', 'blocked', 'would_block')),
  CONSTRAINT chk_agd_actor_type CHECK (actor_type IN ('user', 'system', 'cron', 'admin')),
  CONSTRAINT chk_agd_gateway_mode CHECK (gateway_mode IN ('legacy', 'observe', 'enforce')),
  CONSTRAINT chk_agd_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_agd_feature_date ON public.ai_gateway_decisions (feature_key, created_at);
CREATE INDEX IF NOT EXISTS idx_agd_user_date ON public.ai_gateway_decisions (user_id, created_at)
  WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agd_outcome_date ON public.ai_gateway_decisions (outcome, created_at);

ALTER TABLE public.ai_gateway_decisions ENABLE ROW LEVEL SECURITY;
-- Sem políticas: somente service role acessa.

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 2: ai_gateway_idempotency_locks + funções (Fase 4)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ai_gateway_idempotency_locks (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scope           TEXT        NOT NULL CHECK (char_length(scope) BETWEEN 1 AND 128),
  idempotency_key TEXT        NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 256),
  status          TEXT        NOT NULL DEFAULT 'in_progress',
  result_ref      TEXT,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_agil_scope_key UNIQUE (scope, idempotency_key),
  CONSTRAINT chk_agil_status CHECK (status IN ('in_progress', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_agil_expiry ON public.ai_gateway_idempotency_locks (expires_at)
  WHERE status = 'in_progress';

ALTER TABLE public.ai_gateway_idempotency_locks ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_ai_gateway_idempotency_locks_updated_at ON public.ai_gateway_idempotency_locks;
CREATE TRIGGER trg_ai_gateway_idempotency_locks_updated_at
  BEFORE UPDATE ON public.ai_gateway_idempotency_locks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE OR REPLACE FUNCTION public.begin_gateway_idempotent_op_v1(
  p_scope           TEXT,
  p_idempotency_key TEXT,
  p_lease_seconds   INTEGER
)
RETURNS TABLE(lock_id UUID, outcome TEXT, result_ref TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now        TIMESTAMPTZ := NOW();
  v_id         UUID;
  v_status     TEXT;
  v_result_ref TEXT;
  v_was_insert BOOLEAN;
BEGIN
  IF p_scope IS NULL OR char_length(p_scope) = 0 OR char_length(p_scope) > 128 THEN
    RAISE EXCEPTION 'invalid scope';
  END IF;
  IF p_idempotency_key IS NULL OR char_length(p_idempotency_key) = 0 OR char_length(p_idempotency_key) > 256 THEN
    RAISE EXCEPTION 'invalid idempotency_key';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds <= 0 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'lease_seconds must be between 1 and 3600';
  END IF;

  INSERT INTO public.ai_gateway_idempotency_locks (scope, idempotency_key, status, expires_at)
  VALUES (p_scope, p_idempotency_key, 'in_progress', v_now + (p_lease_seconds * INTERVAL '1 second'))
  ON CONFLICT (scope, idempotency_key) DO UPDATE
    SET status     = 'in_progress',
        result_ref = NULL,
        expires_at = v_now + (p_lease_seconds * INTERVAL '1 second'),
        updated_at = v_now
    WHERE public.ai_gateway_idempotency_locks.status = 'failed'
       OR public.ai_gateway_idempotency_locks.expires_at <= v_now
  RETURNING id, status, result_ref, (xmax = 0) INTO v_id, v_status, v_result_ref, v_was_insert;

  IF FOUND THEN
    RETURN QUERY SELECT v_id, (CASE WHEN v_was_insert THEN 'started' ELSE 'reclaimed' END), v_result_ref;
    RETURN;
  END IF;

  SELECT id, status, result_ref INTO v_id, v_status, v_result_ref
    FROM public.ai_gateway_idempotency_locks
    WHERE scope = p_scope AND idempotency_key = p_idempotency_key;

  RETURN QUERY SELECT v_id, v_status, v_result_ref;
END;
$$;

REVOKE ALL ON FUNCTION public.begin_gateway_idempotent_op_v1(TEXT, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.begin_gateway_idempotent_op_v1(TEXT, TEXT, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.begin_gateway_idempotent_op_v1(TEXT, TEXT, INTEGER) FROM authenticated;

CREATE OR REPLACE FUNCTION public.complete_gateway_idempotent_op_v1(
  p_lock_id    UUID,
  p_result_ref TEXT
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.ai_gateway_idempotency_locks
  SET status = 'completed', result_ref = p_result_ref, updated_at = NOW()
  WHERE id = p_lock_id AND status = 'in_progress';
$$;

REVOKE ALL ON FUNCTION public.complete_gateway_idempotent_op_v1(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_gateway_idempotent_op_v1(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.complete_gateway_idempotent_op_v1(UUID, TEXT) FROM authenticated;

CREATE OR REPLACE FUNCTION public.fail_gateway_idempotent_op_v1(p_lock_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.ai_gateway_idempotency_locks
  SET status = 'failed', updated_at = NOW()
  WHERE id = p_lock_id AND status = 'in_progress';
$$;

REVOKE ALL ON FUNCTION public.fail_gateway_idempotent_op_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fail_gateway_idempotent_op_v1(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.fail_gateway_idempotent_op_v1(UUID) FROM authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 3: Quota acumulada por período + budget, atômicos com a reserva (Fase 5)
-- ─────────────────────────────────────────────────────────────────────────────
-- "reserved" (termo da especificação da Fase 5) é o 'pending' já existente
-- no CHECK de usage_reservations — reaproveitado, não duplicado.
--
-- Modelo: um "bucket" de quota é a projeção reconciliável (nunca a fonte de
-- verdade — ai_usage_events/ai_usage_event_metrics continuam sendo) do
-- consumo acumulado de UMA métrica, para UM sujeito (usuário ou sistema),
-- em UMA feature, em UM período. committed_quantity = uso já confirmado
-- (de eventos reais); reserved_quantity = soma das reservas 'pending' ainda
-- não resolvidas. Um "bucket" de budget é o equivalente em USD, por escopo
-- (user/plan/feature/provider/global) em vez de por sujeito+feature+métrica.
--
-- period_start/period_end são SEMPRE recebidos do chamador (TypeScript),
-- nunca calculados aqui — quem sabe resolver "mês calendário UTC" vs.
-- "ciclo do assignment do usuário" vs. "trial" é a camada de entitlements,
-- que já tem acesso a user_plan_assignments; a função SQL só tranca, lê,
-- valida e incrementa o bucket correspondente à janela exata que recebeu.

CREATE TABLE IF NOT EXISTS public.ai_gateway_quota_buckets (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type       TEXT        NOT NULL,
  subject_id         UUID        REFERENCES auth.users(id) ON DELETE CASCADE,
  feature_key        TEXT        NOT NULL REFERENCES public.ai_features(feature_key),
  metric_key         TEXT        NOT NULL,
  period_type        TEXT        NOT NULL,
  period_start       TIMESTAMPTZ NOT NULL,
  period_end         TIMESTAMPTZ NOT NULL,
  committed_quantity NUMERIC     NOT NULL DEFAULT 0,
  reserved_quantity  NUMERIC     NOT NULL DEFAULT 0,
  backfilled         BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_agqb_subject_type CHECK (subject_type IN ('user', 'system')),
  CONSTRAINT chk_agqb_subject_user CHECK (subject_type != 'user' OR subject_id IS NOT NULL),
  CONSTRAINT chk_agqb_committed_non_negative CHECK (committed_quantity >= 0),
  CONSTRAINT chk_agqb_reserved_non_negative CHECK (reserved_quantity >= 0),
  CONSTRAINT chk_agqb_period_valid CHECK (period_end > period_start)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agqb_key ON public.ai_gateway_quota_buckets (
  subject_type, (COALESCE(subject_id::TEXT, 'system')), feature_key, metric_key, period_type, period_start
);
CREATE INDEX IF NOT EXISTS idx_agqb_period_end ON public.ai_gateway_quota_buckets (period_end);

ALTER TABLE public.ai_gateway_quota_buckets ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_ai_gateway_quota_buckets_updated_at ON public.ai_gateway_quota_buckets;
CREATE TRIGGER trg_ai_gateway_quota_buckets_updated_at
  BEFORE UPDATE ON public.ai_gateway_quota_buckets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TABLE IF NOT EXISTS public.ai_gateway_budget_buckets (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type         TEXT        NOT NULL,
  scope_key          TEXT        NOT NULL,
  period_type        TEXT        NOT NULL,
  period_start       TIMESTAMPTZ NOT NULL,
  period_end         TIMESTAMPTZ NOT NULL,
  committed_cost_usd NUMERIC     NOT NULL DEFAULT 0,
  reserved_cost_usd  NUMERIC     NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_agbb_scope_type CHECK (scope_type IN ('user', 'plan', 'feature', 'provider', 'global')),
  CONSTRAINT chk_agbb_committed_non_negative CHECK (committed_cost_usd >= 0),
  CONSTRAINT chk_agbb_reserved_non_negative CHECK (reserved_cost_usd >= 0),
  CONSTRAINT chk_agbb_period_valid CHECK (period_end > period_start)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agbb_key ON public.ai_gateway_budget_buckets (
  scope_type, scope_key, period_type, period_start
);

ALTER TABLE public.ai_gateway_budget_buckets ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_ai_gateway_budget_buckets_updated_at ON public.ai_gateway_budget_buckets;
CREATE TRIGGER trg_ai_gateway_budget_buckets_updated_at
  BEFORE UPDATE ON public.ai_gateway_budget_buckets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Junction: which budget buckets a reservation touched, and how much USD it
-- reserved against each (the SAME estimated_cost_usd counts fully against
-- every applicable scope simultaneously — a hierarchy of overlapping caps,
-- not a partition of the amount).
CREATE TABLE IF NOT EXISTS public.ai_gateway_reservation_budget_links (
  id                 UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id     UUID    NOT NULL REFERENCES public.usage_reservations(id) ON DELETE CASCADE,
  budget_bucket_id   UUID    NOT NULL REFERENCES public.ai_gateway_budget_buckets(id),
  reserved_cost_usd  NUMERIC NOT NULL CHECK (reserved_cost_usd >= 0),

  CONSTRAINT uq_agrbl_reservation_bucket UNIQUE (reservation_id, budget_bucket_id)
);

CREATE INDEX IF NOT EXISTS idx_agrbl_reservation ON public.ai_gateway_reservation_budget_links (reservation_id);

ALTER TABLE public.ai_gateway_reservation_budget_links ENABLE ROW LEVEL SECURITY;

-- usage_reservation_items gains a link back to the exact quota bucket it
-- reserved against (so commit/release know precisely which bucket to
-- adjust, without re-deriving subject/period), plus an overage flag set at
-- commit time when real usage exceeded what was reserved.
ALTER TABLE public.usage_reservation_items
  ADD COLUMN IF NOT EXISTS quota_bucket_id UUID REFERENCES public.ai_gateway_quota_buckets(id);
ALTER TABLE public.usage_reservation_items
  ADD COLUMN IF NOT EXISTS overage BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.usage_reservations DROP CONSTRAINT IF EXISTS chk_ur_status;
ALTER TABLE public.usage_reservations ADD CONSTRAINT chk_ur_status CHECK (
  status IN ('pending', 'committed', 'released', 'expired', 'cancelled', 'reconciliation_required')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ur_idempotency_key ON public.usage_reservations (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- _gateway_touch_quota_bucket_v1: get-or-create-and-lock a single quota
-- bucket. On first creation, backfills committed_quantity from real raw
-- events already in this exact period window (ai_usage_event_metrics /
-- ai_usage_events), so a bucket created mid-period is never blind to
-- consumption that happened before Etapa 11 started tracking it. Internal
-- helper — never called directly from the TS layer.
CREATE OR REPLACE FUNCTION public._gateway_touch_quota_bucket_v1(
  p_subject_type TEXT, p_subject_id UUID, p_feature_key TEXT, p_metric_key TEXT,
  p_period_type TEXT, p_period_start TIMESTAMPTZ, p_period_end TIMESTAMPTZ
)
RETURNS public.ai_gateway_quota_buckets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row      public.ai_gateway_quota_buckets;
  v_backfill NUMERIC;
BEGIN
  SELECT * INTO v_row FROM public.ai_gateway_quota_buckets
    WHERE subject_type = p_subject_type
      AND COALESCE(subject_id::TEXT, 'system') = COALESCE(p_subject_id::TEXT, 'system')
      AND feature_key = p_feature_key AND metric_key = p_metric_key
      AND period_type = p_period_type AND period_start = p_period_start
    FOR UPDATE;

  IF FOUND THEN RETURN v_row; END IF;

  SELECT COALESCE(SUM(m.quantity), 0) INTO v_backfill
    FROM public.ai_usage_event_metrics m
    JOIN public.ai_usage_events e ON e.id = m.usage_event_id
    WHERE e.feature_key = p_feature_key AND m.metric_key = p_metric_key
      AND e.status = 'succeeded'
      AND e.started_at >= p_period_start AND e.started_at < p_period_end
      AND (
        (p_subject_type = 'user' AND e.user_id = p_subject_id)
        OR (p_subject_type = 'system' AND e.user_id IS NULL)
      );

  INSERT INTO public.ai_gateway_quota_buckets (
    subject_type, subject_id, feature_key, metric_key, period_type, period_start, period_end,
    committed_quantity, reserved_quantity, backfilled
  ) VALUES (
    p_subject_type, p_subject_id, p_feature_key, p_metric_key, p_period_type, p_period_start, p_period_end,
    v_backfill, 0, TRUE
  )
  ON CONFLICT (subject_type, (COALESCE(subject_id::TEXT, 'system')), feature_key, metric_key, period_type, period_start)
  DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN RETURN v_row; END IF;

  SELECT * INTO v_row FROM public.ai_gateway_quota_buckets
    WHERE subject_type = p_subject_type
      AND COALESCE(subject_id::TEXT, 'system') = COALESCE(p_subject_id::TEXT, 'system')
      AND feature_key = p_feature_key AND metric_key = p_metric_key
      AND period_type = p_period_type AND period_start = p_period_start
    FOR UPDATE;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public._gateway_touch_quota_bucket_v1(TEXT, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._gateway_touch_quota_bucket_v1(TEXT, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM anon;
REVOKE ALL ON FUNCTION public._gateway_touch_quota_bucket_v1(TEXT, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM authenticated;

-- _gateway_touch_budget_bucket_v1: same pattern for a USD budget bucket.
-- No backfill from raw events here (usage_daily/calculated_cost_usd already
-- has its own reconciliation path — see cost-calculator.ts — mixing two
-- backfill sources for the same dollars would risk double counting).
CREATE OR REPLACE FUNCTION public._gateway_touch_budget_bucket_v1(
  p_scope_type TEXT, p_scope_key TEXT, p_period_type TEXT, p_period_start TIMESTAMPTZ, p_period_end TIMESTAMPTZ
)
RETURNS public.ai_gateway_budget_buckets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.ai_gateway_budget_buckets;
BEGIN
  SELECT * INTO v_row FROM public.ai_gateway_budget_buckets
    WHERE scope_type = p_scope_type AND scope_key = p_scope_key
      AND period_type = p_period_type AND period_start = p_period_start
    FOR UPDATE;

  IF FOUND THEN RETURN v_row; END IF;

  INSERT INTO public.ai_gateway_budget_buckets (scope_type, scope_key, period_type, period_start, period_end)
  VALUES (p_scope_type, p_scope_key, p_period_type, p_period_start, p_period_end)
  ON CONFLICT (scope_type, scope_key, period_type, period_start) DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN RETURN v_row; END IF;

  SELECT * INTO v_row FROM public.ai_gateway_budget_buckets
    WHERE scope_type = p_scope_type AND scope_key = p_scope_key
      AND period_type = p_period_type AND period_start = p_period_start
    FOR UPDATE;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public._gateway_touch_budget_bucket_v1(TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._gateway_touch_budget_bucket_v1(TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM anon;
REVOKE ALL ON FUNCTION public._gateway_touch_budget_bucket_v1(TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM authenticated;

-- reserve_gateway_usage_v1 — THE single atomic operation (Fase 5 + the
-- correction's §2). One call validates AND reserves quota (per metric) and
-- budget (per scope) together, under row locks acquired in a deterministic
-- order (metrics sorted by metric_key, budget scopes sorted by a fixed
-- scope_type precedence then scope_key) so two concurrent transactions
-- touching overlapping buckets can never deadlock each other. If ANY
-- metric or budget check fails, the function returns a 'blocked' row and
-- the transaction commits having changed nothing (no partial reservation
-- ever exists) — no exception is raised for an ordinary business-rule
-- block, only for malformed input.
--
-- p_metrics: JSONB array of
--   {quota_key, unit_type, reserved_quantity, limit_quantity, period_type, period_start, period_end}
--   limit_quantity/period_* may be null together — a metric with no
--   configured limit skips the quota-bucket check entirely (still creates
--   a usage_reservation_items row, just with quota_bucket_id NULL).
-- p_budget_scopes: JSONB array of
--   {scope_type, scope_key, period_type, period_start, period_end, limit_usd}
--   limit_usd null skips that scope's budget check entirely.
CREATE OR REPLACE FUNCTION public.reserve_gateway_usage_v1(
  p_idempotency_key      TEXT,
  p_user_id              UUID,
  p_initiated_by_user_id UUID,
  p_feature_key          TEXT,
  p_provider             TEXT,
  p_model                TEXT,
  p_metrics              JSONB,
  p_budget_scopes        JSONB,
  p_estimated_cost_usd   NUMERIC,
  p_expires_in_seconds   INTEGER
)
RETURNS TABLE(reservation_id UUID, status TEXT, expires_at TIMESTAMPTZ, blocked_reason TEXT, blocked_detail TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now             TIMESTAMPTZ := NOW();
  v_expires_at      TIMESTAMPTZ;
  v_id              UUID;
  v_status          TEXT;
  v_subject_type    TEXT;
  v_item            JSONB;
  v_bucket          public.ai_gateway_quota_buckets;
  v_budget_bucket   public.ai_gateway_budget_buckets;
  v_available       NUMERIC;
  v_blocked_reason  TEXT := NULL;
  v_blocked_detail  TEXT := NULL;
  v_scope_priority  INTEGER;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(p_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'idempotency_key is required';
  END IF;
  IF p_feature_key IS NULL OR p_provider IS NULL THEN
    RAISE EXCEPTION 'feature_key and provider are required';
  END IF;
  IF p_expires_in_seconds IS NULL OR p_expires_in_seconds <= 0 OR p_expires_in_seconds > 3600 THEN
    RAISE EXCEPTION 'expires_in_seconds must be between 1 and 3600';
  END IF;
  IF p_estimated_cost_usd IS NOT NULL AND p_estimated_cost_usd < 0 THEN
    RAISE EXCEPTION 'estimated_cost_usd must not be negative';
  END IF;

  -- Idempotent retry: an existing reservation for this key (any status,
  -- including a prior block — a blocked attempt is never persisted as a
  -- row, so FOUND here always means a real prior reservation) is returned
  -- unchanged.
  SELECT id, status, usage_reservations.expires_at INTO v_id, v_status, v_expires_at
    FROM public.usage_reservations WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN QUERY SELECT v_id, v_status, v_expires_at, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  v_subject_type := CASE WHEN p_user_id IS NOT NULL THEN 'user' ELSE 'system' END;
  v_expires_at := v_now + (p_expires_in_seconds * INTERVAL '1 second');

  -- ── Phase 1: lock + validate every quota bucket, deterministic order ──────
  -- (sorted by quota_key — jsonb_array_elements over a value produced by
  -- `jsonb_agg(... ORDER BY ...)` on the TS side is not guaranteed to
  -- preserve order through JSON transport in every driver, so we re-sort
  -- here explicitly rather than trust input ordering.)
  FOR v_item IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_metrics, '[]'::jsonb)) AS value
    ORDER BY (value->>'quota_key')
  LOOP
    IF v_item->>'quota_key' IS NULL THEN
      RAISE EXCEPTION 'each metrics item requires quota_key';
    END IF;

    IF v_item->'limit_quantity' IS NOT NULL AND jsonb_typeof(v_item->'limit_quantity') != 'null' THEN
      v_bucket := public._gateway_touch_quota_bucket_v1(
        v_subject_type, p_user_id, p_feature_key, v_item->>'quota_key',
        v_item->>'period_type', (v_item->>'period_start')::TIMESTAMPTZ, (v_item->>'period_end')::TIMESTAMPTZ
      );
      v_available := (v_item->>'limit_quantity')::NUMERIC - v_bucket.committed_quantity - v_bucket.reserved_quantity;
      IF (v_item->>'reserved_quantity')::NUMERIC > GREATEST(v_available, 0) THEN
        v_blocked_reason := 'QUOTA_EXCEEDED';
        v_blocked_detail := v_item->>'quota_key';
        EXIT;
      END IF;
    END IF;
  END LOOP;

  -- ── Phase 2: lock + validate every budget scope, deterministic order ──────
  IF v_blocked_reason IS NULL THEN
    FOR v_item IN
      SELECT value FROM jsonb_array_elements(COALESCE(p_budget_scopes, '[]'::jsonb)) AS value
      ORDER BY
        (CASE value->>'scope_type'
          WHEN 'user' THEN 1 WHEN 'plan' THEN 2 WHEN 'feature' THEN 3 WHEN 'provider' THEN 4 WHEN 'global' THEN 5 ELSE 6
        END),
        (value->>'scope_key')
    LOOP
      IF v_item->'limit_usd' IS NULL OR jsonb_typeof(v_item->'limit_usd') = 'null' THEN
        CONTINUE;
      END IF;

      v_budget_bucket := public._gateway_touch_budget_bucket_v1(
        v_item->>'scope_type', v_item->>'scope_key', v_item->>'period_type',
        (v_item->>'period_start')::TIMESTAMPTZ, (v_item->>'period_end')::TIMESTAMPTZ
      );
      v_available := (v_item->>'limit_usd')::NUMERIC - v_budget_bucket.committed_cost_usd - v_budget_bucket.reserved_cost_usd;
      IF COALESCE(p_estimated_cost_usd, 0) > GREATEST(v_available, 0) THEN
        v_blocked_reason := 'BUDGET_EXCEEDED';
        v_blocked_detail := v_item->>'scope_type' || ':' || (v_item->>'scope_key');
        EXIT;
      END IF;
    END LOOP;
  END IF;

  IF v_blocked_reason IS NOT NULL THEN
    -- Nothing was written — the locks acquired above are released when this
    -- function returns and the enclosing (single-statement RPC) transaction
    -- commits, with no row ever modified.
    RETURN QUERY SELECT NULL::UUID, 'blocked'::TEXT, NULL::TIMESTAMPTZ, v_blocked_reason, v_blocked_detail;
    RETURN;
  END IF;

  -- ── Phase 3: everything validated — create the reservation and apply increments ──
  BEGIN
    INSERT INTO public.usage_reservations (
      request_id, idempotency_key, user_id, initiated_by_user_id,
      feature_key, status, estimated_cost_usd, expires_at, metadata
    ) VALUES (
      gen_random_uuid(), p_idempotency_key, p_user_id, p_initiated_by_user_id,
      p_feature_key, 'pending', p_estimated_cost_usd, v_expires_at,
      jsonb_build_object('provider', p_provider, 'model', p_model)
    )
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    -- Lost the idempotency-key race to a concurrent identical retry (the
    -- buckets above were touched but not incremented by either racer until
    -- this point, so no double-increment risk) — return the winner's row.
    SELECT id, status, usage_reservations.expires_at INTO v_id, v_status, v_expires_at
      FROM public.usage_reservations WHERE idempotency_key = p_idempotency_key;
    RETURN QUERY SELECT v_id, v_status, v_expires_at, NULL::TEXT, NULL::TEXT;
    RETURN;
  END;

  FOR v_item IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_metrics, '[]'::jsonb)) AS value
    ORDER BY (value->>'quota_key')
  LOOP
    v_bucket.id := NULL;
    IF v_item->'limit_quantity' IS NOT NULL AND jsonb_typeof(v_item->'limit_quantity') != 'null' THEN
      v_bucket := public._gateway_touch_quota_bucket_v1(
        v_subject_type, p_user_id, p_feature_key, v_item->>'quota_key',
        v_item->>'period_type', (v_item->>'period_start')::TIMESTAMPTZ, (v_item->>'period_end')::TIMESTAMPTZ
      );
      UPDATE public.ai_gateway_quota_buckets
        SET reserved_quantity = reserved_quantity + (v_item->>'reserved_quantity')::NUMERIC, updated_at = v_now
        WHERE id = v_bucket.id;
    END IF;

    INSERT INTO public.usage_reservation_items (
      reservation_id, quota_key, unit_type, reserved_quantity, quota_bucket_id
    ) VALUES (
      v_id, v_item->>'quota_key', COALESCE(v_item->>'unit_type', 'unit'),
      COALESCE((v_item->>'reserved_quantity')::NUMERIC, 0), v_bucket.id
    );
  END LOOP;

  FOR v_item IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_budget_scopes, '[]'::jsonb)) AS value
  LOOP
    IF v_item->'limit_usd' IS NULL OR jsonb_typeof(v_item->'limit_usd') = 'null' THEN
      CONTINUE;
    END IF;
    v_budget_bucket := public._gateway_touch_budget_bucket_v1(
      v_item->>'scope_type', v_item->>'scope_key', v_item->>'period_type',
      (v_item->>'period_start')::TIMESTAMPTZ, (v_item->>'period_end')::TIMESTAMPTZ
    );
    UPDATE public.ai_gateway_budget_buckets
      SET reserved_cost_usd = reserved_cost_usd + COALESCE(p_estimated_cost_usd, 0), updated_at = v_now
      WHERE id = v_budget_bucket.id;
    INSERT INTO public.ai_gateway_reservation_budget_links (reservation_id, budget_bucket_id, reserved_cost_usd)
      VALUES (v_id, v_budget_bucket.id, COALESCE(p_estimated_cost_usd, 0))
      ON CONFLICT (reservation_id, budget_bucket_id) DO NOTHING;
  END LOOP;

  RETURN QUERY SELECT v_id, 'pending'::TEXT, v_expires_at, NULL::TEXT, NULL::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_gateway_usage_v1(TEXT, UUID, UUID, TEXT, TEXT, TEXT, JSONB, JSONB, NUMERIC, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_gateway_usage_v1(TEXT, UUID, UUID, TEXT, TEXT, TEXT, JSONB, JSONB, NUMERIC, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.reserve_gateway_usage_v1(TEXT, UUID, UUID, TEXT, TEXT, TEXT, JSONB, JSONB, NUMERIC, INTEGER) FROM authenticated;

-- commit_gateway_reservation_v1 — real usage now known. For each reserved
-- metric: releases the originally-reserved amount from reserved_quantity
-- (floored at 0) and adds the REAL amount to committed_quantity — if real >
-- reserved, the overage is still fully committed (never silently dropped)
-- and the item is flagged overage=true. p_actual_metrics (nullable): JSONB
-- array of {quota_key, actual_quantity}; a metric present in the
-- reservation but absent from p_actual_metrics conservatively uses its own
-- reserved_quantity as the actual (no silent release, no invented number).
CREATE OR REPLACE FUNCTION public.commit_gateway_reservation_v1(
  p_reservation_id  UUID,
  p_usage_event_id  UUID,
  p_actual_cost_usd NUMERIC,
  p_actual_metrics  JSONB DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now  TIMESTAMPTZ := NOW();
  v_item RECORD;
  v_actual NUMERIC;
BEGIN
  PERFORM 1 FROM public.usage_reservations WHERE id = p_reservation_id AND status = 'pending' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  FOR v_item IN
    SELECT id, quota_key, reserved_quantity, quota_bucket_id
      FROM public.usage_reservation_items
      WHERE reservation_id = p_reservation_id AND quota_bucket_id IS NOT NULL
      ORDER BY quota_bucket_id
  LOOP
    v_actual := v_item.reserved_quantity;
    IF p_actual_metrics IS NOT NULL THEN
      SELECT (elem->>'actual_quantity')::NUMERIC INTO v_actual
        FROM jsonb_array_elements(p_actual_metrics) elem
        WHERE elem->>'quota_key' = v_item.quota_key
        LIMIT 1;
      v_actual := COALESCE(v_actual, v_item.reserved_quantity);
    END IF;

    UPDATE public.ai_gateway_quota_buckets
      SET reserved_quantity = GREATEST(0, reserved_quantity - v_item.reserved_quantity),
          committed_quantity = committed_quantity + v_actual,
          updated_at = v_now
      WHERE id = v_item.quota_bucket_id;

    UPDATE public.usage_reservation_items
      SET consumed_quantity = v_actual,
          released_quantity = GREATEST(0, v_item.reserved_quantity - v_actual),
          overage = (v_actual > v_item.reserved_quantity)
      WHERE id = v_item.id;
  END LOOP;

  FOR v_item IN
    SELECT budget_bucket_id, reserved_cost_usd FROM public.ai_gateway_reservation_budget_links
      WHERE reservation_id = p_reservation_id ORDER BY budget_bucket_id
  LOOP
    UPDATE public.ai_gateway_budget_buckets
      SET reserved_cost_usd = GREATEST(0, reserved_cost_usd - v_item.reserved_cost_usd),
          committed_cost_usd = committed_cost_usd + COALESCE(p_actual_cost_usd, 0),
          updated_at = v_now
      WHERE id = v_item.budget_bucket_id;
  END LOOP;

  UPDATE public.usage_reservations
    SET status = 'committed', usage_event_id = p_usage_event_id, actual_cost_usd = p_actual_cost_usd,
        finalized_at = v_now, updated_at = v_now
    WHERE id = p_reservation_id AND status = 'pending';
END;
$$;

REVOKE ALL ON FUNCTION public.commit_gateway_reservation_v1(UUID, UUID, NUMERIC, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commit_gateway_reservation_v1(UUID, UUID, NUMERIC, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.commit_gateway_reservation_v1(UUID, UUID, NUMERIC, JSONB) FROM authenticated;

-- release_gateway_reservation_v1 — provider error before consumption was
-- ever confirmed: releases the full reserved amount from every touched
-- bucket (never negative — GREATEST(0, ...)), commits nothing. Idempotent
-- via the WHERE status='pending' guard (a second call finds nothing to
-- update on either the reservation or, transitively, the buckets).
CREATE OR REPLACE FUNCTION public.release_gateway_reservation_v1(
  p_reservation_id UUID,
  p_reason         TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now  TIMESTAMPTZ := NOW();
  v_item RECORD;
BEGIN
  PERFORM 1 FROM public.usage_reservations WHERE id = p_reservation_id AND status = 'pending' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  FOR v_item IN
    SELECT reserved_quantity, quota_bucket_id FROM public.usage_reservation_items
      WHERE reservation_id = p_reservation_id AND quota_bucket_id IS NOT NULL
      ORDER BY quota_bucket_id
  LOOP
    UPDATE public.ai_gateway_quota_buckets
      SET reserved_quantity = GREATEST(0, reserved_quantity - v_item.reserved_quantity), updated_at = v_now
      WHERE id = v_item.quota_bucket_id;
  END LOOP;

  FOR v_item IN
    SELECT budget_bucket_id, reserved_cost_usd FROM public.ai_gateway_reservation_budget_links
      WHERE reservation_id = p_reservation_id ORDER BY budget_bucket_id
  LOOP
    UPDATE public.ai_gateway_budget_buckets
      SET reserved_cost_usd = GREATEST(0, reserved_cost_usd - v_item.reserved_cost_usd), updated_at = v_now
      WHERE id = v_item.budget_bucket_id;
  END LOOP;

  UPDATE public.usage_reservations
    SET status = 'released', finalized_at = v_now, updated_at = v_now,
        metadata = metadata || jsonb_build_object('release_reason', p_reason)
    WHERE id = p_reservation_id AND status = 'pending';
END;
$$;

REVOKE ALL ON FUNCTION public.release_gateway_reservation_v1(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_gateway_reservation_v1(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.release_gateway_reservation_v1(UUID, TEXT) FROM authenticated;

-- mark_gateway_reservation_reconciliation_required_v1 — a provider response
-- was already obtained (and possibly already committed) but something in
-- persistence failed afterward. Deliberately touches NO bucket at all —
-- capacity stays counted as consumed/reserved (the conservative balance)
-- until a human/reconciliation job resolves it; never blindly released.
CREATE OR REPLACE FUNCTION public.mark_gateway_reservation_reconciliation_required_v1(
  p_reservation_id UUID,
  p_reason         TEXT
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.usage_reservations
  SET status = 'reconciliation_required', updated_at = NOW(),
      metadata = metadata || jsonb_build_object('reconciliation_reason', p_reason)
  WHERE id = p_reservation_id AND status IN ('pending', 'committed');
$$;

REVOKE ALL ON FUNCTION public.mark_gateway_reservation_reconciliation_required_v1(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_gateway_reservation_reconciliation_required_v1(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.mark_gateway_reservation_reconciliation_required_v1(UUID, TEXT) FROM authenticated;

-- expire_stale_gateway_reservations_v1: lazy-cleanup sweep for reservations
-- whose expires_at has passed while still 'pending' (the caller never
-- committed or released — e.g. the process died mid-flight). Releases the
-- same bucket amounts release_gateway_reservation_v1 would, then marks the
-- reservation 'expired' instead of 'released' so the two are distinguishable
-- in the audit trail. Idempotent (only touches rows still 'pending' past
-- their expiry) and safe to run repeatedly or on a schedule — no orphaned
-- reservation can block a user indefinitely once this runs. Not wired to an
-- automatic cron/schedule in this delivery (out of scope — no Vercel cron
-- config changes made); callable directly or from a future protected
-- endpoint/cron. Bounded by p_limit per call so a large backlog can be swept
-- incrementally rather than in one unbounded transaction.
CREATE OR REPLACE FUNCTION public.expire_stale_gateway_reservations_v1(p_limit INTEGER DEFAULT 500)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_reservation_id UUID;
  v_count INTEGER := 0;
  v_item RECORD;
BEGIN
  FOR v_reservation_id IN
    SELECT id FROM public.usage_reservations
      WHERE status = 'pending' AND expires_at < v_now
      ORDER BY expires_at
      LIMIT GREATEST(1, LEAST(p_limit, 5000))
      FOR UPDATE SKIP LOCKED
  LOOP
    FOR v_item IN
      SELECT reserved_quantity, quota_bucket_id FROM public.usage_reservation_items
        WHERE reservation_id = v_reservation_id AND quota_bucket_id IS NOT NULL
        ORDER BY quota_bucket_id
    LOOP
      UPDATE public.ai_gateway_quota_buckets
        SET reserved_quantity = GREATEST(0, reserved_quantity - v_item.reserved_quantity), updated_at = v_now
        WHERE id = v_item.quota_bucket_id;
    END LOOP;

    FOR v_item IN
      SELECT budget_bucket_id, reserved_cost_usd FROM public.ai_gateway_reservation_budget_links
        WHERE reservation_id = v_reservation_id ORDER BY budget_bucket_id
    LOOP
      UPDATE public.ai_gateway_budget_buckets
        SET reserved_cost_usd = GREATEST(0, reserved_cost_usd - v_item.reserved_cost_usd), updated_at = v_now
        WHERE id = v_item.budget_bucket_id;
    END LOOP;

    UPDATE public.usage_reservations
      SET status = 'expired', finalized_at = v_now, updated_at = v_now
      WHERE id = v_reservation_id AND status = 'pending';

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_stale_gateway_reservations_v1(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_stale_gateway_reservations_v1(INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.expire_stale_gateway_reservations_v1(INTEGER) FROM authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 4: ai_gateway_circuit_breakers + funções (Fase 8)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ai_gateway_circuit_breakers (
  id                              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider                        TEXT        NOT NULL,
  model                           TEXT,
  feature_key                     TEXT        NOT NULL REFERENCES public.ai_features(feature_key),
  state                           TEXT        NOT NULL DEFAULT 'closed',
  consecutive_failures            INTEGER     NOT NULL DEFAULT 0,
  window_started_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  window_failure_count            INTEGER     NOT NULL DEFAULT 0,
  window_sample_count             INTEGER     NOT NULL DEFAULT 0,
  opened_at                       TIMESTAMPTZ,
  half_open_at                    TIMESTAMPTZ,
  half_open_probes_used           INTEGER     NOT NULL DEFAULT 0,
  min_samples                     INTEGER,
  failure_rate_threshold          NUMERIC,
  consecutive_failure_threshold   INTEGER,
  cooldown_seconds                INTEGER,
  half_open_probe_count           INTEGER,
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_agcb_state CHECK (state IN ('closed', 'open', 'half_open')),
  CONSTRAINT chk_agcb_consecutive_non_negative CHECK (consecutive_failures >= 0),
  CONSTRAINT chk_agcb_window_counts_non_negative CHECK (window_failure_count >= 0 AND window_sample_count >= 0),
  CONSTRAINT chk_agcb_half_open_probes_non_negative CHECK (half_open_probes_used >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agcb_scope
  ON public.ai_gateway_circuit_breakers (provider, (COALESCE(model, '')), feature_key);

ALTER TABLE public.ai_gateway_circuit_breakers ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_ai_gateway_circuit_breakers_updated_at ON public.ai_gateway_circuit_breakers;
CREATE TRIGGER trg_ai_gateway_circuit_breakers_updated_at
  BEFORE UPDATE ON public.ai_gateway_circuit_breakers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE OR REPLACE FUNCTION public.get_gateway_breaker_state_v1(
  p_provider    TEXT,
  p_model       TEXT,
  p_feature_key TEXT
)
RETURNS TABLE(state TEXT, probe_allowed BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row         public.ai_gateway_circuit_breakers%ROWTYPE;
  v_now         TIMESTAMPTZ := NOW();
  v_cooldown    INTEGER;
  v_probe_limit INTEGER;
BEGIN
  SELECT * INTO v_row FROM public.ai_gateway_circuit_breakers
    WHERE provider = p_provider AND COALESCE(model, '') = COALESCE(p_model, '') AND feature_key = p_feature_key
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'closed'::TEXT, TRUE;
    RETURN;
  END IF;

  IF v_row.state = 'closed' THEN
    RETURN QUERY SELECT 'closed'::TEXT, TRUE;
    RETURN;
  END IF;

  v_cooldown    := COALESCE(v_row.cooldown_seconds, 30);
  v_probe_limit := COALESCE(v_row.half_open_probe_count, 1);

  IF v_row.state = 'open' THEN
    IF v_row.opened_at IS NOT NULL AND v_now >= v_row.opened_at + (v_cooldown * INTERVAL '1 second') THEN
      UPDATE public.ai_gateway_circuit_breakers
      SET state = 'half_open', half_open_at = v_now, half_open_probes_used = 1, updated_at = v_now
      WHERE id = v_row.id;
      RETURN QUERY SELECT 'half_open'::TEXT, TRUE;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'open'::TEXT, FALSE;
    RETURN;
  END IF;

  IF v_row.half_open_probes_used < v_probe_limit THEN
    UPDATE public.ai_gateway_circuit_breakers
    SET half_open_probes_used = half_open_probes_used + 1, updated_at = v_now
    WHERE id = v_row.id;
    RETURN QUERY SELECT 'half_open'::TEXT, TRUE;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'half_open'::TEXT, FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.get_gateway_breaker_state_v1(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_gateway_breaker_state_v1(TEXT, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.get_gateway_breaker_state_v1(TEXT, TEXT, TEXT) FROM authenticated;

CREATE OR REPLACE FUNCTION public.record_gateway_breaker_outcome_v1(
  p_provider    TEXT,
  p_model       TEXT,
  p_feature_key TEXT,
  p_success     BOOLEAN
)
RETURNS TABLE(state TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row           public.ai_gateway_circuit_breakers%ROWTYPE;
  v_now           TIMESTAMPTZ := NOW();
  v_min_samples   INTEGER;
  v_fail_thresh   NUMERIC;
  v_consec_thresh INTEGER;
BEGIN
  IF p_provider IS NULL OR p_feature_key IS NULL OR p_success IS NULL THEN
    RAISE EXCEPTION 'provider, feature_key and success are required';
  END IF;

  INSERT INTO public.ai_gateway_circuit_breakers (provider, model, feature_key)
  VALUES (p_provider, p_model, p_feature_key)
  ON CONFLICT (provider, (COALESCE(model, '')), feature_key) DO NOTHING;

  SELECT * INTO v_row FROM public.ai_gateway_circuit_breakers
    WHERE provider = p_provider AND COALESCE(model, '') = COALESCE(p_model, '') AND feature_key = p_feature_key
    FOR UPDATE;

  v_min_samples   := COALESCE(v_row.min_samples, 20);
  v_fail_thresh   := COALESCE(v_row.failure_rate_threshold, 0.5);
  v_consec_thresh := COALESCE(v_row.consecutive_failure_threshold, 5);

  IF v_row.state = 'half_open' THEN
    IF p_success THEN
      UPDATE public.ai_gateway_circuit_breakers
      SET state = 'closed', consecutive_failures = 0, window_failure_count = 0, window_sample_count = 0,
          window_started_at = v_now, opened_at = NULL, half_open_at = NULL, half_open_probes_used = 0,
          updated_at = v_now
      WHERE id = v_row.id;
      RETURN QUERY SELECT 'closed'::TEXT;
    ELSE
      UPDATE public.ai_gateway_circuit_breakers
      SET state = 'open', opened_at = v_now, half_open_at = NULL, half_open_probes_used = 0, updated_at = v_now
      WHERE id = v_row.id;
      RETURN QUERY SELECT 'open'::TEXT;
    END IF;
    RETURN;
  END IF;

  UPDATE public.ai_gateway_circuit_breakers
  SET consecutive_failures = CASE WHEN p_success THEN 0 ELSE consecutive_failures + 1 END,
      window_sample_count  = window_sample_count + 1,
      window_failure_count = window_failure_count + (CASE WHEN p_success THEN 0 ELSE 1 END),
      updated_at = v_now
  WHERE id = v_row.id
  RETURNING * INTO v_row;

  IF v_row.state = 'closed'
     AND (v_row.consecutive_failures >= v_consec_thresh
          OR (v_row.window_sample_count >= v_min_samples
              AND v_row.window_failure_count::NUMERIC / v_row.window_sample_count >= v_fail_thresh))
  THEN
    UPDATE public.ai_gateway_circuit_breakers
    SET state = 'open', opened_at = v_now, updated_at = v_now
    WHERE id = v_row.id;
    RETURN QUERY SELECT 'open'::TEXT;
    RETURN;
  END IF;

  RETURN QUERY SELECT v_row.state;
END;
$$;

REVOKE ALL ON FUNCTION public.record_gateway_breaker_outcome_v1(TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_gateway_breaker_outcome_v1(TEXT, TEXT, TEXT, BOOLEAN) FROM anon;
REVOKE ALL ON FUNCTION public.record_gateway_breaker_outcome_v1(TEXT, TEXT, TEXT, BOOLEAN) FROM authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 5: api_rate_limits + check_and_increment_rate_limit (Fase 3)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.api_rate_limits (
  user_id       UUID        NOT NULL,
  route_key     TEXT        NOT NULL CHECK (char_length(route_key) <= 64),
  window_start  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_count INTEGER     NOT NULL DEFAULT 1 CHECK (request_count >= 0),
  PRIMARY KEY (user_id, route_key)
);

ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_api_rate_limits_window_start
  ON public.api_rate_limits (window_start);

CREATE OR REPLACE FUNCTION public.check_and_increment_rate_limit(
  p_user_id        UUID,
  p_route_key      TEXT,
  p_window_seconds INTEGER,
  p_max_requests   INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_count        INTEGER;
  v_now          TIMESTAMPTZ := NOW();
  v_retry_after  INTEGER;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'retry_after', 60);
  END IF;
  IF char_length(p_route_key) > 64 THEN
    RETURN jsonb_build_object('allowed', false, 'retry_after', 60);
  END IF;
  IF p_window_seconds <= 0 OR p_window_seconds > 86400 THEN
    RETURN jsonb_build_object('allowed', false, 'retry_after', 60);
  END IF;
  IF p_max_requests <= 0 OR p_max_requests > 10000 THEN
    RETURN jsonb_build_object('allowed', false, 'retry_after', 60);
  END IF;

  INSERT INTO public.api_rate_limits (user_id, route_key, window_start, request_count)
  VALUES (p_user_id, p_route_key, v_now, 1)
  ON CONFLICT (user_id, route_key) DO UPDATE
    SET
      window_start  = CASE
                        WHEN public.api_rate_limits.window_start
                             + (p_window_seconds * INTERVAL '1 second') <= v_now
                        THEN v_now
                        ELSE public.api_rate_limits.window_start
                      END,
      request_count = CASE
                        WHEN public.api_rate_limits.window_start
                             + (p_window_seconds * INTERVAL '1 second') <= v_now
                        THEN 1
                        ELSE public.api_rate_limits.request_count + 1
                      END
  RETURNING window_start, request_count
    INTO v_window_start, v_count;

  IF v_count > p_max_requests THEN
    v_retry_after := GREATEST(
      1,
      EXTRACT(EPOCH FROM (
        v_window_start + (p_window_seconds * INTERVAL '1 second') - v_now
      ))::INTEGER
    );
    RETURN jsonb_build_object('allowed', false, 'retry_after', v_retry_after);
  END IF;

  RETURN jsonb_build_object('allowed', true);
END;
$$;

REVOKE ALL ON FUNCTION public.check_and_increment_rate_limit(UUID, TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_and_increment_rate_limit(UUID, TEXT, INTEGER, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.check_and_increment_rate_limit(UUID, TEXT, INTEGER, INTEGER) FROM authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 6: ai_runtime_controls.runtime_status — ampliação aditiva (Fase 2)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.ai_runtime_controls DROP CONSTRAINT IF EXISTS chk_arc_runtime_status;
ALTER TABLE public.ai_runtime_controls ADD CONSTRAINT chk_arc_runtime_status CHECK (
  runtime_status IN ('enabled', 'cache_only', 'disabled', 'paused_automatically', 'circuit_open', 'maintenance')
);

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 7: Publicação dashboard → runtime (materialização)
-- ─────────────────────────────────────────────────────────────────────────────
-- Autoria continua 100% no dashboard (ai_gateway_configs, ai_control_switches,
-- ai_pricing_versions/ai_pricing_rates) — este bloco só LÊ essas tabelas e
-- ESCREVE na projeção hot-path (ai_runtime_controls, provider_pricing) que o
-- Gateway já consulta. O dashboard nunca precisa ser alterado.
--
-- gateway_publish_runtime_controls_v1(): full-resync idempotente.
--   • ai_gateway_configs (production) → ai_runtime_controls scope='global':
--     gateway_mode + runtime_status (emergency_stop OR NOT ai_enabled →
--     'disabled', senão 'enabled'). Esta é a ÚNICA fonte dashboard hoje para
--     gateway_mode — não existe fonte dashboard para gateway_mode por
--     provider/feature, então esta função NUNCA escreve gateway_mode nas
--     linhas provider/feature (só runtime_status), preservando o que já
--     está lá hoje (incluindo as features atualmente em observe).
--   • ai_control_switches (scope IN ('provider','feature'), enabled,
--     dentro de starts_at/ends_at, não revogado) → ai_runtime_controls
--     runtime_status ('enabled' se o switch aprova, 'disabled' caso
--     contrário). scope IN ('model','route') não tem equivalente em
--     ai_runtime_controls hoje (fora do escopo desta correção — documentado,
--     não fingido) e é ignorado por esta função.
--   • Nunca insere uma linha nova em ai_runtime_controls (essa tabela já
--     tem os 28 controles seed da fundação) — só faz UPDATE de linhas
--     existentes, então nenhuma feature nova aparece/desaparece por conta
--     desta função.
CREATE OR REPLACE FUNCTION public.gateway_publish_runtime_controls_v1()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now    TIMESTAMPTZ := NOW();
  v_config RECORD;
  v_switch RECORD;
BEGIN
  SELECT gateway_mode, ai_enabled, emergency_stop INTO v_config
    FROM public.ai_gateway_configs WHERE environment = 'production';

  IF FOUND THEN
    UPDATE public.ai_runtime_controls
    SET gateway_mode = v_config.gateway_mode,
        runtime_status = CASE WHEN v_config.emergency_stop OR NOT v_config.ai_enabled THEN 'disabled' ELSE 'enabled' END,
        updated_at = v_now
    WHERE scope_type = 'global' AND scope_key = 'global';
  END IF;

  FOR v_switch IN
    SELECT scope, provider, feature_key, bool_and(effective_enabled) AS all_enabled
    FROM (
      SELECT scope, provider, feature_key,
             (enabled AND revoked_at IS NULL AND starts_at <= v_now AND (ends_at IS NULL OR ends_at > v_now)) AS effective_enabled
      FROM public.ai_control_switches
      WHERE environment = 'production' AND scope IN ('provider', 'feature')
    ) s
    GROUP BY scope, provider, feature_key
  LOOP
    IF v_switch.scope = 'provider' THEN
      UPDATE public.ai_runtime_controls
      SET runtime_status = CASE WHEN v_switch.all_enabled THEN 'enabled' ELSE 'disabled' END, updated_at = v_now
      WHERE scope_type = 'provider' AND scope_key = v_switch.provider;
    ELSIF v_switch.scope = 'feature' THEN
      UPDATE public.ai_runtime_controls
      SET runtime_status = CASE WHEN v_switch.all_enabled THEN 'enabled' ELSE 'disabled' END, updated_at = v_now
      WHERE scope_type = 'feature' AND scope_key = v_switch.feature_key;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.gateway_publish_runtime_controls_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gateway_publish_runtime_controls_v1() FROM anon;
REVOKE ALL ON FUNCTION public.gateway_publish_runtime_controls_v1() FROM authenticated;

CREATE OR REPLACE FUNCTION public._gateway_publish_runtime_controls_trigger_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.gateway_publish_runtime_controls_v1();
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_publish_runtime_controls_on_config ON public.ai_gateway_configs;
CREATE TRIGGER trg_publish_runtime_controls_on_config
  AFTER INSERT OR UPDATE ON public.ai_gateway_configs
  FOR EACH ROW EXECUTE FUNCTION public._gateway_publish_runtime_controls_trigger_v1();

DROP TRIGGER IF EXISTS trg_publish_runtime_controls_on_switch ON public.ai_control_switches;
CREATE TRIGGER trg_publish_runtime_controls_on_switch
  AFTER INSERT OR UPDATE ON public.ai_control_switches
  FOR EACH ROW EXECUTE FUNCTION public._gateway_publish_runtime_controls_trigger_v1();

-- gateway_publish_pricing_v1(): full-resync of provider_pricing from the
-- single currently-published ai_pricing_versions row (per environment=
-- 'production'), for ai_pricing_rates whose metric_key maps confidently to
-- this Gateway's own metric vocabulary (see the CASE below — an unmapped
-- metric_key is skipped, never guessed, and logged via RAISE NOTICE).
-- Every row this function writes is tagged source_reference =
-- 'dashboard_publish:<version_id>' so it can deactivate ONLY rows it owns
-- on the next publish/rollback — the manually-seeded Etapa 10 price rows
-- (gpt-4o / gpt-4o-mini / gpt-realtime-2.1-mini, source_reference NULL or
-- something else) are never touched by this function.
CREATE OR REPLACE FUNCTION public.gateway_publish_pricing_v1()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_version RECORD;
  v_rate    RECORD;
  v_mapped_metric TEXT;
  v_tag     TEXT;
BEGIN
  SELECT id, effective_from, effective_to INTO v_version
    FROM public.ai_pricing_versions
    WHERE environment = 'production' AND state = 'published'
    ORDER BY version_number DESC LIMIT 1;

  -- Deactivate every previously-published row this function owns — a
  -- full resync, so a rollback (a different/no version now published)
  -- correctly stops applying a superseded/discarded version's prices
  -- without leaving stale active rows behind.
  UPDATE public.provider_pricing
    SET is_active = FALSE, updated_at = NOW()
    WHERE source_reference LIKE 'dashboard_publish:%' AND is_active = TRUE;

  IF NOT FOUND OR v_version.id IS NULL THEN
    RETURN; -- nothing published — provider_pricing keeps only the
             -- manually-seeded rows, which this function never touched.
  END IF;

  v_tag := 'dashboard_publish:' || v_version.id::TEXT;

  FOR v_rate IN
    SELECT provider, model, metric_key, feature_key, unit_type, unit_size, unit_price, currency
    FROM public.ai_pricing_rates WHERE version_id = v_version.id
  LOOP
    v_mapped_metric := CASE v_rate.metric_key
      WHEN 'tokens_input'       THEN 'input_text_tokens'
      WHEN 'tokens_output'      THEN 'output_text_tokens'
      WHEN 'tokens_cached'      THEN 'cached_input_tokens'
      WHEN 'chars_tts_billed'   THEN 'tts_characters'
      WHEN 'audio_input_seconds' THEN 'audio_seconds'
      WHEN 'realtime_seconds'   THEN 'session_seconds'
      ELSE NULL
    END;

    IF v_mapped_metric IS NULL THEN
      RAISE NOTICE 'gateway_publish_pricing_v1: skipping unmapped metric_key % (provider=%, model=%)', v_rate.metric_key, v_rate.provider, v_rate.model;
      CONTINUE;
    END IF;

    INSERT INTO public.provider_pricing (
      provider, service, model, metric_key, currency, unit_size, price_per_unit,
      valid_from, valid_until, is_active, source_reference
    ) VALUES (
      v_rate.provider, NULL, v_rate.model, v_mapped_metric, v_rate.currency, v_rate.unit_size, v_rate.unit_price,
      COALESCE(v_version.effective_from, NOW()), v_version.effective_to, TRUE, v_tag
    );
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.gateway_publish_pricing_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gateway_publish_pricing_v1() FROM anon;
REVOKE ALL ON FUNCTION public.gateway_publish_pricing_v1() FROM authenticated;

CREATE OR REPLACE FUNCTION public._gateway_publish_pricing_trigger_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.gateway_publish_pricing_v1();
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_publish_pricing_on_version ON public.ai_pricing_versions;
CREATE TRIGGER trg_publish_pricing_on_version
  AFTER INSERT OR UPDATE ON public.ai_pricing_versions
  FOR EACH ROW EXECUTE FUNCTION public._gateway_publish_pricing_trigger_v1();

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 8: ai_gateway_concurrency_validations — registro de validação humana
-- ─────────────────────────────────────────────────────────────────────────────
-- Correction requirement: concurrencyValidated can never be a hardcoded
-- boolean in application code — it must be a persistent, server-only fact
-- tied to exactly which migration version and which validation script
-- content was actually exercised. This table is that fact. It is never
-- writable by anon/authenticated (REVOKE below + no RLS policy at all —
-- RLS enabled with zero policies means only service_role bypasses), so no
-- ordinary user or frontend code path can ever record an approval; only
-- someone with direct service-role/DB access (the same access level
-- required to apply a migration in the first place) can call
-- record_gateway_concurrency_validation_v1.
--
-- validation_script_sha256 is compared against a LIVE hash of
-- supabase/manual-validation/ai-gateway-enforcement-concurrency.sql,
-- computed by the preflight script at run time — if that file changes by
-- even one byte after a validation was recorded, the hash no longer
-- matches any row here and concurrencyValidated reverts to false
-- automatically, with no manual "invalidate" step required.
CREATE TABLE IF NOT EXISTS public.ai_gateway_concurrency_validations (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_version         TEXT        NOT NULL,
  validation_script_path    TEXT        NOT NULL,
  validation_script_sha256  TEXT        NOT NULL CHECK (validation_script_sha256 ~ '^[0-9a-f]{64}$'),
  status                    TEXT        NOT NULL,
  executed_at               TIMESTAMPTZ NOT NULL,
  executed_by               TEXT        NOT NULL CHECK (char_length(executed_by) BETWEEN 1 AND 200),
  notes                     TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_agcv_status CHECK (status IN ('passed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_agcv_lookup ON public.ai_gateway_concurrency_validations
  (migration_version, validation_script_sha256, status, executed_at DESC);

ALTER TABLE public.ai_gateway_concurrency_validations ENABLE ROW LEVEL SECURITY;
-- Sem políticas: somente service role acessa (leitura E escrita) — nem
-- authenticated nem anon podem ler ou escrever esta tabela diretamente.

-- record_gateway_concurrency_validation_v1: the ONLY way to write a row,
-- and even this function is REVOKEd from anon/authenticated below — it is
-- reachable only via direct service-role DB access (psql / SQL editor with
-- the service role, the same channel used to apply the migration itself),
-- never through any HTTP route this application exposes. Append-only by
-- design (no UPDATE/DELETE function is provided) — a stale or superseded
-- validation is superseded by a NEWER row, never edited in place, so the
-- audit trail is never rewritten.
CREATE OR REPLACE FUNCTION public.record_gateway_concurrency_validation_v1(
  p_migration_version        TEXT,
  p_validation_script_path   TEXT,
  p_validation_script_sha256 TEXT,
  p_status                   TEXT,
  p_executed_by              TEXT,
  p_notes                    TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_migration_version IS NULL OR char_length(p_migration_version) = 0 THEN
    RAISE EXCEPTION 'migration_version is required';
  END IF;
  IF p_validation_script_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'validation_script_sha256 must be a 64-char lowercase hex SHA-256 digest';
  END IF;
  IF p_status NOT IN ('passed', 'failed') THEN
    RAISE EXCEPTION 'status must be passed or failed';
  END IF;
  IF p_executed_by IS NULL OR char_length(p_executed_by) = 0 THEN
    RAISE EXCEPTION 'executed_by is required (a technical identifier for audit — who actually ran the scenarios)';
  END IF;

  INSERT INTO public.ai_gateway_concurrency_validations (
    migration_version, validation_script_path, validation_script_sha256, status, executed_at, executed_by, notes
  ) VALUES (
    p_migration_version, p_validation_script_path, p_validation_script_sha256, p_status, NOW(), p_executed_by, p_notes
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_gateway_concurrency_validation_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_gateway_concurrency_validation_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.record_gateway_concurrency_validation_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM authenticated;

-- =============================================================================
-- VALIDAÇÃO INLINE — captura estado ANTES, aplica, compara DEPOIS
-- =============================================================================
-- Nunca presume um valor fixo de gateway_mode/runtime_status: hoje existem
-- features em legacy E em observe simultaneamente (confirmado por auditoria
-- direta antes de escrever esta migration) — a validação correta é "zero
-- linhas existentes mudaram", não "todas estão em algum estado específico".

DO $$
DECLARE
  v_changed_rows INTEGER;
  v_row_count_before INTEGER;
  v_row_count_after INTEGER;
  v_diff_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_row_count_before FROM _migration_arc_before;
  SELECT COUNT(*) INTO v_row_count_after FROM public.ai_runtime_controls;
  IF v_row_count_before != v_row_count_after THEN
    RAISE EXCEPTION 'VALIDATION FAILED: ai_runtime_controls row count changed (% before, % after) — this migration must never add or remove rows in this table', v_row_count_before, v_row_count_after;
  END IF;

  SELECT COUNT(*) INTO v_changed_rows
    FROM public.ai_runtime_controls arc
    JOIN _migration_arc_before b ON b.id = arc.id
    WHERE arc.gateway_mode IS DISTINCT FROM b.gateway_mode
       OR arc.runtime_status IS DISTINCT FROM b.runtime_status;

  IF v_changed_rows > 0 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: % existing ai_runtime_controls row(s) had gateway_mode/runtime_status changed by this migration — must be zero (this migration only widens CHECK constraints, it never writes to existing rows)', v_changed_rows;
  END IF;

  SELECT COUNT(*) INTO v_diff_count FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'ai_gateway_decisions', 'ai_gateway_idempotency_locks', 'ai_gateway_circuit_breakers', 'api_rate_limits',
        'ai_gateway_quota_buckets', 'ai_gateway_budget_buckets', 'ai_gateway_reservation_budget_links',
        'ai_gateway_concurrency_validations'
      );
  IF v_diff_count != 8 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: expected 8 new tables, found %', v_diff_count;
  END IF;

  SELECT COUNT(*) INTO v_diff_count FROM pg_proc
    WHERE proname IN (
      'check_and_increment_rate_limit', 'begin_gateway_idempotent_op_v1',
      'complete_gateway_idempotent_op_v1', 'fail_gateway_idempotent_op_v1',
      'reserve_gateway_usage_v1', 'commit_gateway_reservation_v1',
      'release_gateway_reservation_v1', 'mark_gateway_reservation_reconciliation_required_v1',
      'get_gateway_breaker_state_v1', 'record_gateway_breaker_outcome_v1',
      '_gateway_touch_quota_bucket_v1', '_gateway_touch_budget_bucket_v1',
      'gateway_publish_runtime_controls_v1', 'gateway_publish_pricing_v1',
      '_gateway_publish_runtime_controls_trigger_v1', '_gateway_publish_pricing_trigger_v1',
      'expire_stale_gateway_reservations_v1', 'record_gateway_concurrency_validation_v1'
    );
  IF v_diff_count != 18 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: expected 18 gateway functions, found %', v_diff_count;
  END IF;

  RAISE NOTICE 'VALIDATION PASSED: 8 new tables, 18 new/re-declared functions, zero changes to existing ai_runtime_controls rows, runtime_status and usage_reservations.status CHECK constraints widened additively';
END;
$$;

COMMIT;

-- =============================================================================
-- ROLLBACK MANUAL (documentado, não executado por esta migration)
-- =============================================================================
--   DROP FUNCTION IF EXISTS public.record_gateway_concurrency_validation_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);
--   DROP TABLE IF EXISTS public.ai_gateway_concurrency_validations;
--   DROP TRIGGER IF EXISTS trg_publish_pricing_on_version ON public.ai_pricing_versions;
--   DROP FUNCTION IF EXISTS public._gateway_publish_pricing_trigger_v1();
--   DROP FUNCTION IF EXISTS public.gateway_publish_pricing_v1();
--   DROP TRIGGER IF EXISTS trg_publish_runtime_controls_on_switch ON public.ai_control_switches;
--   DROP TRIGGER IF EXISTS trg_publish_runtime_controls_on_config ON public.ai_gateway_configs;
--   DROP FUNCTION IF EXISTS public._gateway_publish_runtime_controls_trigger_v1();
--   DROP FUNCTION IF EXISTS public.gateway_publish_runtime_controls_v1();
--   DROP FUNCTION IF EXISTS public.record_gateway_breaker_outcome_v1(TEXT, TEXT, TEXT, BOOLEAN);
--   DROP FUNCTION IF EXISTS public.get_gateway_breaker_state_v1(TEXT, TEXT, TEXT);
--   DROP TABLE IF EXISTS public.ai_gateway_circuit_breakers;
--   DROP FUNCTION IF EXISTS public.expire_stale_gateway_reservations_v1(INTEGER);
--   DROP FUNCTION IF EXISTS public.mark_gateway_reservation_reconciliation_required_v1(UUID, TEXT);
--   DROP FUNCTION IF EXISTS public.release_gateway_reservation_v1(UUID, TEXT);
--   DROP FUNCTION IF EXISTS public.commit_gateway_reservation_v1(UUID, UUID, NUMERIC, JSONB);
--   DROP FUNCTION IF EXISTS public.reserve_gateway_usage_v1(TEXT, UUID, UUID, TEXT, TEXT, TEXT, JSONB, JSONB, NUMERIC, INTEGER);
--   DROP FUNCTION IF EXISTS public._gateway_touch_budget_bucket_v1(TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ);
--   DROP FUNCTION IF EXISTS public._gateway_touch_quota_bucket_v1(TEXT, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ);
--   DROP TABLE IF EXISTS public.ai_gateway_reservation_budget_links;
--   DROP TABLE IF EXISTS public.ai_gateway_budget_buckets;
--   DROP TABLE IF EXISTS public.ai_gateway_quota_buckets;
--   ALTER TABLE public.usage_reservation_items DROP COLUMN IF EXISTS quota_bucket_id;
--   ALTER TABLE public.usage_reservation_items DROP COLUMN IF EXISTS overage;
--   DROP INDEX IF EXISTS public.uq_ur_idempotency_key;
--   -- usage_reservations.status / ai_runtime_controls.runtime_status: only
--   -- narrow back after confirming zero rows use the new values (see the
--   -- original version of this comment in git history for the exact
--   -- verification queries).
--   DROP FUNCTION IF EXISTS public.fail_gateway_idempotent_op_v1(UUID);
--   DROP FUNCTION IF EXISTS public.complete_gateway_idempotent_op_v1(UUID, TEXT);
--   DROP FUNCTION IF EXISTS public.begin_gateway_idempotent_op_v1(TEXT, TEXT, INTEGER);
--   DROP TABLE IF EXISTS public.ai_gateway_idempotency_locks;
--   DROP TABLE IF EXISTS public.ai_gateway_decisions;
--   -- api_rate_limits / check_and_increment_rate_limit: leave in place even
--   -- on rollback unless 20260714130000_api_rate_limits.sql is also being
--   -- rolled back — api/_rateLimit.ts depends on them independently.
-- =============================================================================
--
-- FIM DA MIGRATION 20260718000000_ai_gateway_enforcement
-- =============================================================================
