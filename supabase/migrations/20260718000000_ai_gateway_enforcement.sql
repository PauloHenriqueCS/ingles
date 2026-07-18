-- =============================================================================
-- MIGRATION: 20260718000000_ai_gateway_enforcement
-- Projeto: Lemon (english learning app)
--
-- Etapa 11 — camada de enforcement do AI Gateway. EXCLUSIVAMENTE ADITIVA:
-- nenhuma tabela, view, política ou função existente é removida ou tem
-- comportamento alterado para o tráfego atual (todas as features continuam
-- em legacy). Esta migration NÃO é aplicada automaticamente por esta
-- entrega — arquivo local apenas, para aplicação manual futura.
--
-- O que esta migration faz:
--   BLOCO 1: ai_gateway_decisions — log técnico de decisões do gateway
--            (kill-switch, rate limit, dedupe, entitlement, budget, breaker).
--            Nunca ai_usage_events: uma decisão bloqueada nunca foi uma
--            chamada física ao provedor.
--   BLOCO 2: ai_gateway_idempotency_locks + begin/complete/fail_gateway_
--            idempotent_op_v1 — primitivo genérico de deduplicação (Fase 4).
--   BLOCO 3: usage_reservations/usage_reservation_items (já existentes,
--            criadas vazias na fundação) ganham: índice único em
--            idempotency_key, e as funções atômicas reserve/commit/release/
--            mark_reconciliation_required (Fase 5). status ganha o valor
--            'reconciliation_required' (ampliação aditiva do CHECK).
--   BLOCO 4: ai_gateway_circuit_breakers + get/record_gateway_breaker_
--            outcome_v1 — disjuntor por provider/model/feature (Fase 8).
--   BLOCO 5: re-declaração idempotente de api_rate_limits +
--            check_and_increment_rate_limit (idêntica à migration local
--            20260714130000_api_rate_limits.sql, nunca aplicada
--            remotamente) — garante que esta entrega seja autocontida
--            independentemente de quando/se aquela migration for aplicada.
--   BLOCO 6: ai_runtime_controls.runtime_status ganha 'circuit_open' e
--            'maintenance' (ampliação aditiva do CHECK).
--
-- Nenhum gateway_mode ou runtime_status existente é alterado por esta
-- migration — apenas a FORMA (constraints/estruturas) é ampliada. Nenhuma
-- feature entra em enforce como resultado desta migration.
--
-- Todas as tabelas novas: RLS habilitado, ZERO políticas (somente service
-- role acessa). Todas as funções novas: SECURITY DEFINER, search_path fixo,
-- REVOKE de PUBLIC/anon/authenticated. Nenhum DROP, nenhum TRUNCATE, nenhum
-- histórico reescrito ou recalculado.
-- =============================================================================

BEGIN;

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
-- Nunca persiste conteúdo a deduplicar — apenas o identificador (scope +
-- idempotency_key) e um result_ref opcional (id de domínio para o chamador
-- buscar o resultado real em outro lugar). A resposta da IA nunca é
-- armazenada aqui só para replay.

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

-- begin_gateway_idempotent_op_v1: atomic claim-or-report. A brand-new row
-- returns 'started'. A row reclaimed from 'failed' or an expired lease
-- returns 'reclaimed' (xmax = 0 distinguishes a fresh INSERT from the
-- ON CONFLICT DO UPDATE branch firing — a standard, safe Postgres idiom).
-- An active in_progress lease or an already-completed op is left untouched
-- and its real status is reported back, never silently overwritten.
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

  -- Conflict existed and the WHERE guard didn't match: still-active
  -- in_progress lease, or an already-completed op.
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
-- BLOCO 3: usage_reservations / usage_reservation_items — reservas atômicas (Fase 5)
-- ─────────────────────────────────────────────────────────────────────────────
-- Tabelas já existem (fundação, BLOCO 7/8), criadas vazias. "reserved" (termo
-- da especificação da Fase 5) é o 'pending' já existente no CHECK desta
-- tabela — reaproveitado, não duplicado. 'reconciliation_required' é o único
-- valor novo, adicionado por ampliação aditiva do CHECK abaixo.

ALTER TABLE public.usage_reservations DROP CONSTRAINT IF EXISTS chk_ur_status;
ALTER TABLE public.usage_reservations ADD CONSTRAINT chk_ur_status CHECK (
  status IN ('pending', 'committed', 'released', 'expired', 'cancelled', 'reconciliation_required')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ur_idempotency_key ON public.usage_reservations (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- reserve_gateway_usage_v1: idempotent-safe (a repeat call with the same
-- idempotency_key returns the existing reservation unchanged, never a
-- duplicate) and concurrency-safe (the unique index above means two
-- concurrent callers racing the same key can never both insert — the loser
-- catches unique_violation and returns the winner's row instead of erroring
-- or creating a second reservation). p_metrics is a JSONB array of
-- {quota_key, unit_type, reserved_quantity} objects.
CREATE OR REPLACE FUNCTION public.reserve_gateway_usage_v1(
  p_idempotency_key      TEXT,
  p_user_id              UUID,
  p_initiated_by_user_id UUID,
  p_feature_key          TEXT,
  p_provider             TEXT,
  p_model                TEXT,
  p_metrics              JSONB,
  p_estimated_cost_usd   NUMERIC,
  p_expires_in_seconds   INTEGER
)
RETURNS TABLE(reservation_id UUID, status TEXT, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now        TIMESTAMPTZ := NOW();
  v_expires_at TIMESTAMPTZ;
  v_id         UUID;
  v_status     TEXT;
  v_item       JSONB;
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

  SELECT id, status, usage_reservations.expires_at INTO v_id, v_status, v_expires_at
    FROM public.usage_reservations WHERE idempotency_key = p_idempotency_key;

  IF FOUND THEN
    RETURN QUERY SELECT v_id, v_status, v_expires_at;
    RETURN;
  END IF;

  v_expires_at := v_now + (p_expires_in_seconds * INTERVAL '1 second');

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
    SELECT id, status, usage_reservations.expires_at INTO v_id, v_status, v_expires_at
      FROM public.usage_reservations WHERE idempotency_key = p_idempotency_key;
    RETURN QUERY SELECT v_id, v_status, v_expires_at;
    RETURN;
  END;

  IF p_metrics IS NOT NULL AND jsonb_typeof(p_metrics) = 'array' THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_metrics)
    LOOP
      IF v_item->>'quota_key' IS NULL THEN
        RAISE EXCEPTION 'each metrics item requires quota_key';
      END IF;
      INSERT INTO public.usage_reservation_items (
        reservation_id, quota_key, unit_type, reserved_quantity
      ) VALUES (
        v_id,
        v_item->>'quota_key',
        COALESCE(v_item->>'unit_type', 'unit'),
        COALESCE((v_item->>'reserved_quantity')::NUMERIC, 0)
      );
    END LOOP;
  END IF;

  RETURN QUERY SELECT v_id, 'pending'::TEXT, v_expires_at;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_gateway_usage_v1(TEXT, UUID, UUID, TEXT, TEXT, TEXT, JSONB, NUMERIC, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_gateway_usage_v1(TEXT, UUID, UUID, TEXT, TEXT, TEXT, JSONB, NUMERIC, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.reserve_gateway_usage_v1(TEXT, UUID, UUID, TEXT, TEXT, TEXT, JSONB, NUMERIC, INTEGER) FROM authenticated;

-- commit_gateway_reservation_v1: guarded by WHERE status='pending' — a
-- second commit call (retry, race) is a safe no-op, never double-applies.
CREATE OR REPLACE FUNCTION public.commit_gateway_reservation_v1(
  p_reservation_id  UUID,
  p_usage_event_id  UUID,
  p_actual_cost_usd NUMERIC
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.usage_reservations
  SET status = 'committed', usage_event_id = p_usage_event_id, actual_cost_usd = p_actual_cost_usd,
      finalized_at = NOW(), updated_at = NOW()
  WHERE id = p_reservation_id AND status = 'pending';
$$;

REVOKE ALL ON FUNCTION public.commit_gateway_reservation_v1(UUID, UUID, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commit_gateway_reservation_v1(UUID, UUID, NUMERIC) FROM anon;
REVOKE ALL ON FUNCTION public.commit_gateway_reservation_v1(UUID, UUID, NUMERIC) FROM authenticated;

-- release_gateway_reservation_v1: only ever releases a still-pending
-- reservation (provider error before consumption was confirmed — Fase 5
-- rule) — never touches one already committed or already
-- reconciliation_required.
CREATE OR REPLACE FUNCTION public.release_gateway_reservation_v1(
  p_reservation_id UUID,
  p_reason         TEXT
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.usage_reservations
  SET status = 'released', finalized_at = NOW(), updated_at = NOW(),
      metadata = metadata || jsonb_build_object('release_reason', p_reason)
  WHERE id = p_reservation_id AND status = 'pending';
$$;

REVOKE ALL ON FUNCTION public.release_gateway_reservation_v1(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_gateway_reservation_v1(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.release_gateway_reservation_v1(UUID, TEXT) FROM authenticated;

-- mark_gateway_reservation_reconciliation_required_v1: a provider response
-- was already obtained (and possibly already committed) but something in
-- persistence failed afterward — never blindly release capacity that may
-- genuinely have been consumed (Fase 5 rule). Allowed from pending OR
-- committed, since the failure this marks can occur either before or after
-- a nominal commit attempt.
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

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 4: ai_gateway_circuit_breakers + funções (Fase 8)
-- ─────────────────────────────────────────────────────────────────────────────
-- Um disjuntor por (provider, model nullable, feature_key). Somente falhas
-- técnicas reais do provedor devem ser reportadas por quem chama
-- record_gateway_breaker_outcome_v1 — auth do usuário, validação, rate
-- limit interno, plano/quota e kill-switch nunca contam (essa filtragem é
-- responsabilidade do chamador; esta função apenas tabula o que recebe).

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
  -- Limiares configuráveis pelo dashboard; NULL = default seguro aplicado em runtime.
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

-- get_gateway_breaker_state_v1: read-mostly getter. Lazily transitions
-- open → half_open once the cooldown has elapsed (a time-based expiry
-- applied on read, the same pattern as usage_reservations' own lazy
-- expiry), and atomically claims a half_open probe slot (row-locked via
-- FOR UPDATE) so concurrent callers can never both win the same probe.
-- Returns a safe default (closed, probe_allowed=true) when no row exists
-- yet for this scope — inert until record_gateway_breaker_outcome_v1 first
-- creates one.
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

  -- half_open
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

-- record_gateway_breaker_outcome_v1: the only place state actually
-- transitions on an outcome (as opposed to the lazy cooldown-based
-- transition in the getter above). half_open: success closes (resets every
-- counter), failure reopens immediately. closed: opens once
-- consecutive_failures or the windowed failure rate crosses the configured
-- threshold. An outcome recorded while already open is tallied but never
-- re-opens an already-open breaker a second time (manual kill-switch, not
-- this function, is the only thing that ever un-opens a breaker outside its
-- own cooldown/probe cycle).
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
-- Re-declaração IDÊNTICA e idempotente da migration local
-- 20260714130000_api_rate_limits.sql (BLOCOS 1-2 apenas — nunca aplicada
-- remotamente, confirmado por auditoria direta do schema: nem a tabela nem
-- a função existem hoje). Reproduzida aqui para que esta entrega seja
-- autocontida independentemente de quando/se aquela migration for aplicada
-- separadamente; CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION
-- tornam seguro aplicar as duas migrations em qualquer ordem, ou só esta.
-- O Gateway namespacea suas próprias chamadas sob o prefixo de route_key
-- "gateway:<featureKey>" (ver rate-limiter.ts), nunca colidindo com as
-- route_keys já usadas por api/_rateLimit.ts.

CREATE TABLE IF NOT EXISTS public.api_rate_limits (
  user_id       UUID        NOT NULL,
  route_key     TEXT        NOT NULL CHECK (char_length(route_key) <= 64),
  window_start  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_count INTEGER     NOT NULL DEFAULT 1 CHECK (request_count >= 0),
  PRIMARY KEY (user_id, route_key)
);

ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;
-- Sem políticas: somente service role acessa.

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
-- Adiciona 'circuit_open' e 'maintenance' aos valores já aceitos. Nenhuma
-- linha existente é alterada — todas continuam com o valor que já tinham
-- ('enabled' em todos os 28 controles seed).

ALTER TABLE public.ai_runtime_controls DROP CONSTRAINT IF EXISTS chk_arc_runtime_status;
ALTER TABLE public.ai_runtime_controls ADD CONSTRAINT chk_arc_runtime_status CHECK (
  runtime_status IN ('enabled', 'cache_only', 'disabled', 'paused_automatically', 'circuit_open', 'maintenance')
);

-- =============================================================================
-- VALIDAÇÃO INLINE
-- =============================================================================

DO $$
DECLARE
  v_decisions_table_exists  BOOLEAN;
  v_locks_table_exists      BOOLEAN;
  v_breakers_table_exists   BOOLEAN;
  v_rate_limits_table_exists BOOLEAN;
  v_functions_count         INTEGER;
  v_decisions_rows          INTEGER;
  v_locks_rows              INTEGER;
  v_breakers_rows           INTEGER;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ai_gateway_decisions')
    INTO v_decisions_table_exists;
  SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ai_gateway_idempotency_locks')
    INTO v_locks_table_exists;
  SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ai_gateway_circuit_breakers')
    INTO v_breakers_table_exists;
  SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'api_rate_limits')
    INTO v_rate_limits_table_exists;

  SELECT COUNT(*) INTO v_functions_count FROM pg_proc
    WHERE proname IN (
      'check_and_increment_rate_limit', 'begin_gateway_idempotent_op_v1',
      'complete_gateway_idempotent_op_v1', 'fail_gateway_idempotent_op_v1',
      'reserve_gateway_usage_v1', 'commit_gateway_reservation_v1',
      'release_gateway_reservation_v1', 'mark_gateway_reservation_reconciliation_required_v1',
      'get_gateway_breaker_state_v1', 'record_gateway_breaker_outcome_v1'
    );

  SELECT COUNT(*) INTO v_decisions_rows FROM public.ai_gateway_decisions;
  SELECT COUNT(*) INTO v_locks_rows FROM public.ai_gateway_idempotency_locks;
  SELECT COUNT(*) INTO v_breakers_rows FROM public.ai_gateway_circuit_breakers;

  IF NOT v_decisions_table_exists THEN
    RAISE EXCEPTION 'VALIDATION FAILED: ai_gateway_decisions was not created';
  END IF;
  IF NOT v_locks_table_exists THEN
    RAISE EXCEPTION 'VALIDATION FAILED: ai_gateway_idempotency_locks was not created';
  END IF;
  IF NOT v_breakers_table_exists THEN
    RAISE EXCEPTION 'VALIDATION FAILED: ai_gateway_circuit_breakers was not created';
  END IF;
  IF NOT v_rate_limits_table_exists THEN
    RAISE EXCEPTION 'VALIDATION FAILED: api_rate_limits was not created';
  END IF;
  IF v_functions_count != 10 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: expected 10 gateway enforcement functions, found %', v_functions_count;
  END IF;
  IF v_decisions_rows != 0 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: ai_gateway_decisions must be empty immediately after migration, got %', v_decisions_rows;
  END IF;
  IF v_locks_rows != 0 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: ai_gateway_idempotency_locks must be empty immediately after migration, got %', v_locks_rows;
  END IF;
  IF v_breakers_rows != 0 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: ai_gateway_circuit_breakers must be empty immediately after migration, got %', v_breakers_rows;
  END IF;

  RAISE NOTICE 'VALIDATION PASSED: 4 new tables, 10 new/re-declared functions, all empty, runtime_status and usage_reservations.status CHECK constraints widened additively';
END;
$$;

COMMIT;

-- =============================================================================
-- ROLLBACK MANUAL (documentado, não executado por esta migration)
-- =============================================================================
-- Todas as reversões abaixo são seguras porque nenhuma delas apaga histórico
-- de ai_usage_events, ai_usage_event_metrics ou usage_daily — apenas
-- estruturas novas e aditivas introduzidas por esta migration.
--
--   DROP FUNCTION IF EXISTS public.record_gateway_breaker_outcome_v1(TEXT, TEXT, TEXT, BOOLEAN);
--   DROP FUNCTION IF EXISTS public.get_gateway_breaker_state_v1(TEXT, TEXT, TEXT);
--   DROP TABLE IF EXISTS public.ai_gateway_circuit_breakers;
--   DROP FUNCTION IF EXISTS public.mark_gateway_reservation_reconciliation_required_v1(UUID, TEXT);
--   DROP FUNCTION IF EXISTS public.release_gateway_reservation_v1(UUID, TEXT);
--   DROP FUNCTION IF EXISTS public.commit_gateway_reservation_v1(UUID, UUID, NUMERIC);
--   DROP FUNCTION IF EXISTS public.reserve_gateway_usage_v1(TEXT, UUID, UUID, TEXT, TEXT, TEXT, JSONB, NUMERIC, INTEGER);
--   DROP INDEX IF EXISTS public.uq_ur_idempotency_key;
--   -- usage_reservations.status: only safe to narrow back if no row has
--   -- status='reconciliation_required' — check first:
--   --   SELECT COUNT(*) FROM public.usage_reservations WHERE status = 'reconciliation_required';
--   -- then, only if zero:
--   --   ALTER TABLE public.usage_reservations DROP CONSTRAINT IF EXISTS chk_ur_status;
--   --   ALTER TABLE public.usage_reservations ADD CONSTRAINT chk_ur_status
--   --     CHECK (status IN ('pending', 'committed', 'released', 'expired', 'cancelled'));
--   DROP FUNCTION IF EXISTS public.fail_gateway_idempotent_op_v1(UUID);
--   DROP FUNCTION IF EXISTS public.complete_gateway_idempotent_op_v1(UUID, TEXT);
--   DROP FUNCTION IF EXISTS public.begin_gateway_idempotent_op_v1(TEXT, TEXT, INTEGER);
--   DROP TABLE IF EXISTS public.ai_gateway_idempotency_locks;
--   DROP TABLE IF EXISTS public.ai_gateway_decisions;
--   -- ai_runtime_controls.runtime_status: only safe to narrow back if no row
--   -- uses 'circuit_open' or 'maintenance' — check first:
--   --   SELECT COUNT(*) FROM public.ai_runtime_controls WHERE runtime_status IN ('circuit_open', 'maintenance');
--   -- then, only if zero:
--   --   ALTER TABLE public.ai_runtime_controls DROP CONSTRAINT IF EXISTS chk_arc_runtime_status;
--   --   ALTER TABLE public.ai_runtime_controls ADD CONSTRAINT chk_arc_runtime_status
--   --     CHECK (runtime_status IN ('enabled', 'cache_only', 'disabled', 'paused_automatically'));
--   -- api_rate_limits / check_and_increment_rate_limit: leave in place even
--   -- on rollback unless 20260714130000_api_rate_limits.sql is also being
--   -- rolled back — api/_rateLimit.ts depends on them independently of
--   -- this stage.
-- =============================================================================
--
-- FIM DA MIGRATION 20260718000000_ai_gateway_enforcement
-- =============================================================================
