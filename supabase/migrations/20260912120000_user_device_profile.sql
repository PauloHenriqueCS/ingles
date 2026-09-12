-- =============================================================================
-- MIGRATION: 20260912120000_user_device_profile
-- Projeto: Orodim
--
-- Aplicada automaticamente pelo pipeline de CI (supabase db push).
-- NÃO aplicar manualmente no SQL Editor.
--
-- OBJETIVO: fazer do Supabase a fonte CENTRAL de plataforma/versão por usuário,
--   detectada pelo RUNTIME do app (Capacitor.getPlatform() + @capacitor/app
--   getInfo), INDEPENDENTE do AppsFlyer. Complementa user_acquisition_attribution
--   (atribuição de marketing, essa sim via AppsFlyer): aqui é a verdade de
--   dispositivo/plataforma do próprio Orodim.
--
--   Uma linha por usuário. first_seen é write-once (nunca sobrescrito); last_seen
--   atualiza a cada sessão. platform ∈ {ios,android,web} — iOS e Android SÃO
--   diferenciados (Capacitor.getPlatform() nativo). app_version só existe no
--   nativo (@capacitor/app getInfo); na web fica NULL (sem invenção).
--
-- REGRAS atendidas:
--   * Nada é inventado/backfilled: a tabela nasce vazia e só preenche conforme os
--     usuários abrem o app pós-deploy. Usuários anteriores sem evidência ⇒ sem
--     linha ⇒ NULL/unknown nas análises (LEFT JOIN).
--   * platform inválida ⇒ NULL (nunca viola o CHECK).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.user_device_profile (
  user_id                uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  platform_first_seen    text CHECK (platform_first_seen IN ('ios', 'android', 'web')),
  platform_last_seen     text CHECK (platform_last_seen  IN ('ios', 'android', 'web')),
  app_version_first_seen text,
  app_version_last_seen  text,
  first_seen_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at           timestamptz NOT NULL DEFAULT now(),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_device_profile ENABLE ROW LEVEL SECURITY;
-- No policies: only the SECURITY DEFINER RPC below (and service_role) touch it.
REVOKE ALL ON public.user_device_profile FROM anon, authenticated;
GRANT ALL ON public.user_device_profile TO service_role;

CREATE INDEX IF NOT EXISTS idx_user_device_profile_platform_last
  ON public.user_device_profile (platform_last_seen);

CREATE OR REPLACE FUNCTION public.record_device_profile(
  p_platform    text,
  p_app_version text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_plat text := CASE WHEN p_platform IN ('ios', 'android', 'web') THEN p_platform ELSE NULL END;
  v_ver  text := NULLIF(p_app_version, '');
BEGIN
  IF v_uid IS NULL THEN
    RETURN; -- só o próprio usuário autenticado
  END IF;

  INSERT INTO public.user_device_profile AS t (
    user_id, platform_first_seen, platform_last_seen,
    app_version_first_seen, app_version_last_seen
  ) VALUES (
    v_uid, v_plat, v_plat, v_ver, v_ver
  )
  ON CONFLICT (user_id) DO UPDATE SET
    platform_last_seen     = COALESCE(EXCLUDED.platform_last_seen, t.platform_last_seen),
    app_version_last_seen  = COALESCE(EXCLUDED.app_version_last_seen, t.app_version_last_seen),
    -- first_seen write-once: só preenche se ainda estava NULL (nunca sobrescreve).
    platform_first_seen    = COALESCE(t.platform_first_seen, EXCLUDED.platform_first_seen),
    app_version_first_seen = COALESCE(t.app_version_first_seen, EXCLUDED.app_version_first_seen),
    last_seen_at           = now(),
    updated_at             = now();
END;
$$;

REVOKE ALL ON FUNCTION public.record_device_profile(text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_device_profile(text, text) TO authenticated;
