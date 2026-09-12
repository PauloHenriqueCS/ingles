-- =============================================================================
-- MIGRATION: 20260911150000_user_acquisition_attribution
-- Projeto: Orodim
--
-- Aplicada automaticamente pelo pipeline de CI (supabase db push).
-- NÃO aplicar manualmente no SQL Editor.
--
-- OBJETIVO (item 2 — atribuição de aquisição):
--   Persistir a atribuição de instalação do AppsFlyer (media_source, campaign,
--   adset, ad, af_status, install_time, ...) VINCULADA ao UUID Supabase, para
--   ligar: canal/campanha → instalação → usuário → atividades → pagamento.
--
--   O cliente captura a conversion-data do AppsFlyer (registerConversionListener)
--   e chama record_acquisition_attribution() já autenticado. A função usa
--   auth.uid() (o cliente não passa user_id). Uma linha por usuário.
--
-- REGRAS:
--   * Nunca inventa valores: campo ausente na conversion-data → NULL.
--   * Orgânico SÓ com evidência EXPLÍCITA: is_organic=true apenas quando
--     af_status='Organic' (ou media_source='organic' literal). Sem af_status e
--     sem media_source → NULL (desconhecido). NUNCA infere orgânico apenas pela
--     ausência de media_source.
--   * Não faz "downgrade" de uma atribuição paga já conhecida (is_organic=false)
--     para orgânica/desconhecida numa re-leitura posterior.
--   * Sem PII — a conversion-data do AppsFlyer só carrega campos de atribuição.
--
-- ESCOPO: aditivo — 1 tabela + 1 RPC SECURITY DEFINER. RLS on, sem policies
--   (só os RPCs / service_role tocam a tabela).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.user_acquisition_attribution (
  user_id          uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  af_id            text,          -- AppsFlyer device UID (getAppsFlyerUID)
  platform         text,          -- 'ios' | 'android' | 'web'
  af_status        text,          -- 'Organic' | 'Non-organic'
  is_organic       boolean,       -- derivado de af_status (NULL se desconhecido)
  media_source     text,
  campaign         text,
  campaign_id      text,
  adset            text,
  adset_id         text,
  ad               text,
  ad_id            text,
  af_channel       text,
  install_time_raw text,          -- string crua do AppsFlyer (formato próprio)
  install_time     timestamptz,   -- best-effort cast (NULL se não parseável)
  is_first_launch  boolean,
  raw              jsonb,          -- payload completo (só atribuição, sem PII)
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_acquisition_attribution ENABLE ROW LEVEL SECURITY;
-- No policies: only the SECURITY DEFINER RPC below (and service_role) touch it.
REVOKE ALL ON public.user_acquisition_attribution FROM anon, authenticated;
GRANT ALL ON public.user_acquisition_attribution TO service_role;

CREATE INDEX IF NOT EXISTS idx_user_acq_attr_media_source
  ON public.user_acquisition_attribution (media_source);
CREATE INDEX IF NOT EXISTS idx_user_acq_attr_is_organic
  ON public.user_acquisition_attribution (is_organic);

CREATE OR REPLACE FUNCTION public.record_acquisition_attribution(
  p_af_id      text  DEFAULT NULL,
  p_platform   text  DEFAULT NULL,
  p_conversion jsonb DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_uid         uuid  := auth.uid();
  c             jsonb := COALESCE(p_conversion, '{}'::jsonb);
  v_status      text;
  v_media       text;
  v_is_org      boolean;
  v_install_raw text;
  v_install_ts  timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RETURN; -- só o próprio usuário autenticado; nada a fazer sem sessão
  END IF;

  v_status := NULLIF(c->>'af_status', '');
  v_media  := NULLIF(c->>'media_source', '');

  -- Orgânico SÓ com evidência explícita: af_status='Organic', ou media_source
  -- literalmente 'organic'. media_source paga (ex.: googleadwords_int) → false.
  -- Sem af_status e sem media_source → NULL. Nunca infere orgânico pela mera
  -- ausência de media_source.
  v_is_org := CASE
    WHEN v_status IS NOT NULL THEN lower(v_status) = 'organic'
    WHEN v_media  IS NOT NULL THEN lower(v_media) = 'organic'
    ELSE NULL
  END;

  v_install_raw := NULLIF(c->>'install_time', '');
  BEGIN
    v_install_ts := v_install_raw::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    v_install_ts := NULL; -- formato não parseável → guarda só o texto cru
  END;

  INSERT INTO public.user_acquisition_attribution AS t (
    user_id, af_id, platform, af_status, is_organic, media_source, campaign,
    campaign_id, adset, adset_id, ad, ad_id, af_channel,
    install_time_raw, install_time, is_first_launch, raw
  ) VALUES (
    v_uid,
    NULLIF(p_af_id, ''),
    NULLIF(p_platform, ''),
    v_status,
    v_is_org,
    v_media,
    NULLIF(c->>'campaign', ''),
    COALESCE(NULLIF(c->>'campaign_id', ''), NULLIF(c->>'af_c_id', '')),
    COALESCE(NULLIF(c->>'adset', ''), NULLIF(c->>'af_adset', '')),
    COALESCE(NULLIF(c->>'adset_id', ''), NULLIF(c->>'af_adset_id', '')),
    COALESCE(NULLIF(c->>'ad', ''), NULLIF(c->>'af_ad', ''), NULLIF(c->>'adgroup', '')),
    COALESCE(NULLIF(c->>'ad_id', ''), NULLIF(c->>'af_ad_id', ''), NULLIF(c->>'adgroup_id', '')),
    NULLIF(c->>'af_channel', ''),
    v_install_raw,
    v_install_ts,
    CASE WHEN c ? 'is_first_launch' THEN (lower(c->>'is_first_launch') IN ('true','t','1')) ELSE NULL END,
    CASE WHEN p_conversion IS NULL OR p_conversion = '{}'::jsonb THEN NULL ELSE p_conversion END
  )
  ON CONFLICT (user_id) DO UPDATE SET
    af_id      = COALESCE(EXCLUDED.af_id, t.af_id),
    platform   = COALESCE(EXCLUDED.platform, t.platform),
    -- Não rebaixar uma atribuição paga já conhecida para orgânica/desconhecida.
    af_status    = CASE WHEN t.is_organic IS FALSE THEN t.af_status    ELSE COALESCE(EXCLUDED.af_status, t.af_status) END,
    is_organic   = CASE WHEN t.is_organic IS FALSE THEN t.is_organic   ELSE COALESCE(EXCLUDED.is_organic, t.is_organic) END,
    media_source = CASE WHEN t.is_organic IS FALSE THEN t.media_source ELSE COALESCE(EXCLUDED.media_source, t.media_source) END,
    campaign     = CASE WHEN t.is_organic IS FALSE THEN t.campaign     ELSE COALESCE(EXCLUDED.campaign, t.campaign) END,
    campaign_id  = CASE WHEN t.is_organic IS FALSE THEN t.campaign_id  ELSE COALESCE(EXCLUDED.campaign_id, t.campaign_id) END,
    adset        = CASE WHEN t.is_organic IS FALSE THEN t.adset        ELSE COALESCE(EXCLUDED.adset, t.adset) END,
    adset_id     = CASE WHEN t.is_organic IS FALSE THEN t.adset_id     ELSE COALESCE(EXCLUDED.adset_id, t.adset_id) END,
    ad           = CASE WHEN t.is_organic IS FALSE THEN t.ad           ELSE COALESCE(EXCLUDED.ad, t.ad) END,
    ad_id        = CASE WHEN t.is_organic IS FALSE THEN t.ad_id        ELSE COALESCE(EXCLUDED.ad_id, t.ad_id) END,
    af_channel       = COALESCE(EXCLUDED.af_channel, t.af_channel),
    install_time_raw = COALESCE(t.install_time_raw, EXCLUDED.install_time_raw),
    install_time     = COALESCE(t.install_time, EXCLUDED.install_time),
    is_first_launch  = COALESCE(t.is_first_launch, EXCLUDED.is_first_launch),
    raw              = COALESCE(EXCLUDED.raw, t.raw),
    updated_at       = now();
END;
$$;

REVOKE ALL ON FUNCTION public.record_acquisition_attribution(text, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_acquisition_attribution(text, text, jsonb) TO authenticated;
