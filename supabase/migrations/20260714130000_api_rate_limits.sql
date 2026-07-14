-- =============================================================================
-- MIGRATION: 20260714130000_api_rate_limits
-- Projeto: Lemon
--
-- APLICAR UMA ÚNICA VEZ no Supabase SQL Editor.
-- Esta migration NÃO modifica nem remove dados existentes.
-- Idempotente: pode ser executada novamente sem efeito colateral.
--
-- O que esta migration faz:
--   1. Cria tabela api_rate_limits com RLS habilitado e SEM políticas de
--      acesso para usuários (somente service role acessa).
--   2. Cria função RPC SECURITY DEFINER check_and_increment_rate_limit
--      com incremento atômico via INSERT ... ON CONFLICT.
--   3. Revoga acesso direto à função de anon e authenticated para que
--      usuários não possam manipular contadores via PostgREST.
--   4. Remove políticas de INSERT e UPDATE de grammar_explanations:
--      a partir de agora, somente o backend (service role) pode escrever
--      no cache de explicações gramaticais.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 1: Tabela de rate limit
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.api_rate_limits (
  user_id       UUID        NOT NULL,
  route_key     TEXT        NOT NULL CHECK (char_length(route_key) <= 64),
  window_start  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_count INTEGER     NOT NULL DEFAULT 1 CHECK (request_count >= 0),
  PRIMARY KEY (user_id, route_key)
);

ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;

-- Nenhuma política criada: RLS habilitado sem políticas = nenhum usuário
-- autenticado ou anônimo pode ler/escrever diretamente.
-- Somente o service role (backend) tem acesso.

CREATE INDEX IF NOT EXISTS idx_api_rate_limits_window_start
  ON public.api_rate_limits (window_start);

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 2: Função de rate limit atômico
-- ─────────────────────────────────────────────────────────────────────────────
-- A função usa INSERT ... ON CONFLICT para garantir atomicidade.
-- Se a janela expirou, reseta o contador. Caso contrário, incrementa.
-- Retorna { allowed: boolean, retry_after?: integer }.

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
  v_window_start  TIMESTAMPTZ;
  v_count         INTEGER;
  v_now           TIMESTAMPTZ := NOW();
  v_retry_after   INTEGER;
BEGIN
  -- Validate inputs to prevent abuse
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

-- Revoke direct call access from regular users to prevent counter manipulation
REVOKE EXECUTE ON FUNCTION public.check_and_increment_rate_limit(UUID, TEXT, INTEGER, INTEGER)
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_and_increment_rate_limit(UUID, TEXT, INTEGER, INTEGER)
  FROM anon;
REVOKE EXECUTE ON FUNCTION public.check_and_increment_rate_limit(UUID, TEXT, INTEGER, INTEGER)
  FROM authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 3: Remover acesso direto de escrita ao cache de grammar_explanations
-- ─────────────────────────────────────────────────────────────────────────────
-- A partir desta migration, somente o backend (service role) pode inserir
-- e atualizar explicações gramaticais. Usuários autenticados continuam
-- podendo ler (ge_select permanece).

DROP POLICY IF EXISTS "ge_insert" ON public.grammar_explanations;
DROP POLICY IF EXISTS "ge_update" ON public.grammar_explanations;

-- =============================================================================
-- FIM DA MIGRATION 20260714130000_api_rate_limits
--
-- Após aplicar, configure as variáveis de ambiente no Vercel:
--   SUPABASE_SERVICE_ROLE_KEY  ← obtida em Supabase → Settings → API
--
-- Sem esta variável, o rate limiting opera em modo fail-open (permite
-- todas as requisições), mas o restante da segurança continua ativo.
-- =============================================================================
