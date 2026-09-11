-- =============================================================================
-- MIGRATION: 20260911160000_paywall_checkout_events
-- Projeto: Orodim
--
-- Aplicada automaticamente pelo pipeline de CI (supabase db push).
-- NÃO aplicar manualmente no SQL Editor.
--
-- OBJETIVO (item 3 — telemetria de paywall/checkout no BANCO):
--   paywall_viewed e af_initiated_checkout JÁ são enviados ao AppsFlyer
--   (SubscriptionView / revenueCatClient), mas NÃO existiam no banco — por isso
--   não eram mensuráveis. Esta tabela registra, no nosso próprio banco, TODAS as
--   visualizações de paywall e inícios de checkout (append-only), para permitir:
--     usuário → paywall_viewed → checkout_started → trial/subscription → purchase
--   Onde trial/subscription/purchase já vivem em user_plan_assignments e
--   revenuecat_webhook_events (join por user_id).
--
-- DIFERENÇA vs appsflyer_events: aquele ledger é one-shot/one-per-day (PK
--   user_id+event_key+event_date) e some após o primeiro pagamento (gate
--   ever-paid). Paywall/checkout são multi-fire e devem ser registrados SEMPRE
--   (inclusive de quem já pagou) — por isso uma tabela append-only separada.
--
-- SEM dados sensíveis de pagamento — apenas surface/plano/loja/plataforma.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.paywall_checkout_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  event_type  text NOT NULL CHECK (event_type IN ('paywall_viewed', 'checkout_started')),
  source      text,   -- surface/limite que levou ao paywall (ex.: 'menu', 'listening_limit')
  plan        text,   -- 'essential' | 'plus' (checkout_started)
  store       text,   -- 'app_store' | 'play_store'
  platform    text,   -- 'ios' | 'android' | 'web'
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.paywall_checkout_events ENABLE ROW LEVEL SECURITY;
-- No policies: only the SECURITY DEFINER RPCs below (and service_role) touch it.
REVOKE ALL ON public.paywall_checkout_events FROM anon, authenticated;
GRANT ALL ON public.paywall_checkout_events TO service_role;

CREATE INDEX IF NOT EXISTS idx_paywall_checkout_user_time
  ON public.paywall_checkout_events (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_paywall_checkout_type_time
  ON public.paywall_checkout_events (event_type, created_at);

-- paywall_viewed — a tela de planos ficou visível. Multi-fire (uma por visita).
CREATE OR REPLACE FUNCTION public.record_paywall_viewed(
  p_source   text DEFAULT NULL,
  p_platform text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO public.paywall_checkout_events (user_id, event_type, source, platform)
  VALUES (v_uid, 'paywall_viewed', NULLIF(p_source, ''), NULLIF(p_platform, ''));
END;
$$;

-- checkout_started — o fluxo de compra na loja está começando (assinaturas).
CREATE OR REPLACE FUNCTION public.record_checkout_started(
  p_plan     text,
  p_store    text DEFAULT NULL,
  p_platform text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO public.paywall_checkout_events (user_id, event_type, plan, store, platform)
  VALUES (v_uid, 'checkout_started', NULLIF(p_plan, ''), NULLIF(p_store, ''), NULLIF(p_platform, ''));
END;
$$;

REVOKE ALL ON FUNCTION public.record_paywall_viewed(text, text) FROM anon;
REVOKE ALL ON FUNCTION public.record_checkout_started(text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_paywall_viewed(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_checkout_started(text, text, text) TO authenticated;
