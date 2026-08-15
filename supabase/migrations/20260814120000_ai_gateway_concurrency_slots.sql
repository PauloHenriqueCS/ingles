-- =============================================================================
-- MIGRATION: 20260814120000_ai_gateway_concurrency_slots
-- Projeto: Orodim
--
-- Aplicada automaticamente por .github/workflows/deploy-production.yml e
-- homologation.yml (supabase db push). NÃO aplicar manualmente no SQL Editor —
-- isso desalinha o histórico de `supabase migration list`.
--
-- OBJETIVO: transformar ai_runtime_controls.max_concurrent_requests, hoje
-- CONFIGURAÇÃO MORTA (resolvida em policy-resolver.ts mas nunca consumida por
-- enforcement algum), num limite REAL de chamadas pagas de IA simultaneamente
-- "em voo" por usuário — atômico e compartilhado entre TODAS as instâncias
-- serverless da Vercel (o Postgres é o único ponto de coordenação, exatamente
-- como reserve_gateway_usage_v1 / check_and_increment_rate_limit já fazem).
--
-- POR QUE POSTGRES (e não Map em memória / Redis / KV): cada instância da
-- Vercel tem sua própria memória; um contador em processo não vê as chamadas
-- em outra instância. Um advisory lock transacional serializa a contagem por
-- escopo entre instâncias, e um lease (expires_at) recupera slots de processos
-- que morreram no meio da chamada (o finally do enforcement libera no caminho
-- normal; o lease cobre crash/abort/timeout).
--
-- SEMÂNTICA: rejeição imediata (CONCURRENCY_LIMITED), NUNCA fila silenciosa.
-- Rate limit (requests/janela) e concorrência (em voo simultâneo) são
-- mecanismos DISTINTOS — este arquivo só implementa concorrência.
--
-- ESCOPO: puramente ADITIVO. Uma tabela nova, três funções novas, extensão do
-- audit de privilégios e UM seed idempotente (só onde já é NULL). Não remove
-- nem altera nenhuma tabela/coluna/função/limite existente.
-- =============================================================================

-- ── Tabela de slots de concorrência ──────────────────────────────────────────
-- Uma linha 'active' == uma chamada paga em voo. scope_key carrega usuário +
-- dimensão do limite (ver resolveConcurrencyScope em enforcement.ts), p.ex.
-- 'u:<uuid>|global' ou 'u:<uuid>|feature:listening.two_part_tts'.
CREATE TABLE IF NOT EXISTS public.ai_gateway_concurrency_slots (
  id             uuid        DEFAULT gen_random_uuid() NOT NULL,
  scope_key      text        NOT NULL,
  user_id        uuid,
  feature_key    text        NOT NULL,
  provider       text        NOT NULL,
  status         text        NOT NULL DEFAULT 'active',
  acquired_at    timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  released_at    timestamptz,
  release_reason text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_gateway_concurrency_slots_pkey PRIMARY KEY (id),
  CONSTRAINT chk_agcs_status CHECK (status = ANY (ARRAY['active'::text, 'released'::text, 'expired'::text])),
  CONSTRAINT chk_agcs_scope_key_len CHECK (char_length(scope_key) BETWEEN 1 AND 200)
);

-- Caminho quente: contar os 'active' de um escopo. Índice parcial mantém o
-- índice pequeno (apenas slots vivos).
CREATE INDEX IF NOT EXISTS idx_agcs_active_scope
  ON public.ai_gateway_concurrency_slots (scope_key)
  WHERE status = 'active';

-- Varredura de slots com lease expirado (recuperação defensiva via cron).
CREATE INDEX IF NOT EXISTS idx_agcs_active_expires
  ON public.ai_gateway_concurrency_slots (expires_at)
  WHERE status = 'active';

-- Segurança: apenas service_role (backend) — igual às demais tabelas do
-- gateway. RLS habilitado sem policy => anon/authenticated não enxergam nada;
-- o backend acessa via funções SECURITY DEFINER.
ALTER TABLE public.ai_gateway_concurrency_slots ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.ai_gateway_concurrency_slots FROM anon, authenticated, PUBLIC;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_gateway_concurrency_slots TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_gateway_concurrency_slots TO service_role;

-- ── acquire: reserva atômica de um slot ──────────────────────────────────────
-- Retorna acquired=false (sem inserir) quando o escopo já está no teto. O
-- advisory lock transacional por escopo garante que N chamadas concorrentes
-- para o MESMO escopo serializam a contagem+inserção — nunca ultrapassam o
-- teto, mesmo distribuídas por várias instâncias da Vercel. Escopos distintos
-- não contendem entre si (chave de lock derivada do scope_key).
CREATE OR REPLACE FUNCTION public.acquire_gateway_concurrency_slot_v1(
  p_scope_key      text,
  p_user_id        uuid,
  p_feature_key    text,
  p_provider       text,
  p_max_concurrent integer,
  p_lease_seconds  integer
)
RETURNS TABLE(slot_id uuid, acquired boolean, active_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_now    TIMESTAMPTZ := NOW();
  v_active INTEGER;
  v_id     UUID;
BEGIN
  IF p_scope_key IS NULL OR char_length(p_scope_key) = 0 OR char_length(p_scope_key) > 200 THEN
    RAISE EXCEPTION 'scope_key is required (1..200 chars)';
  END IF;
  IF p_feature_key IS NULL OR p_provider IS NULL THEN
    RAISE EXCEPTION 'feature_key and provider are required';
  END IF;
  IF p_max_concurrent IS NULL OR p_max_concurrent <= 0 OR p_max_concurrent > 100000 THEN
    RAISE EXCEPTION 'max_concurrent must be between 1 and 100000';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds <= 0 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'lease_seconds must be between 1 and 3600';
  END IF;

  -- Serializa contagem+inserção deste escopo por toda a transação (uma chamada
  -- RPC = uma transação). Liberado no commit. Chaves de escopo distintas usam
  -- chaves de lock distintas, então não há contenção cross-usuário.
  PERFORM pg_advisory_xact_lock(hashtext('gwconc:' || p_scope_key));

  -- Expira preguiçosamente slots abandonados (lease vencido) DESTE escopo — um
  -- processo que morreu no meio da chamada não deve prender capacidade para
  -- sempre.
  UPDATE public.ai_gateway_concurrency_slots
    SET status = 'expired', released_at = v_now, release_reason = 'lease_expired'
    WHERE scope_key = p_scope_key AND status = 'active' AND expires_at <= v_now;

  SELECT count(*) INTO v_active
    FROM public.ai_gateway_concurrency_slots
    WHERE scope_key = p_scope_key AND status = 'active';

  IF v_active >= p_max_concurrent THEN
    RETURN QUERY SELECT NULL::UUID, false, v_active;
    RETURN;
  END IF;

  INSERT INTO public.ai_gateway_concurrency_slots (
    scope_key, user_id, feature_key, provider, status, acquired_at, expires_at
  ) VALUES (
    p_scope_key, p_user_id, p_feature_key, p_provider, 'active', v_now,
    v_now + (p_lease_seconds * INTERVAL '1 second')
  ) RETURNING id INTO v_id;

  RETURN QUERY SELECT v_id, true, v_active + 1;
END;
$function$;

-- ── release: devolve um slot ─────────────────────────────────────────────────
-- Idempotente: liberar um slot já liberado/expirado/inexistente é no-op. Não
-- precisa do advisory lock (UPDATE por PK é atômico e não altera a contagem de
-- forma que exija serialização com acquire — acquire recomeça a contagem sob o
-- lock a cada chamada).
CREATE OR REPLACE FUNCTION public.release_gateway_concurrency_slot_v1(
  p_slot_id uuid,
  p_reason  text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF p_slot_id IS NULL THEN
    RETURN;
  END IF;
  UPDATE public.ai_gateway_concurrency_slots
    SET status = 'released', released_at = NOW(),
        release_reason = COALESCE(NULLIF(left(p_reason, 100), ''), 'released')
    WHERE id = p_slot_id AND status = 'active';
END;
$function$;

-- ── expire sweep: recuperação em lote (cron defensivo, opcional) ─────────────
-- O acquire já expira preguiçosamente o próprio escopo; esta função existe
-- para um cron varrer escopos que ninguém mais toca (usuário sumiu). SKIP
-- LOCKED para não brigar com acquire.
CREATE OR REPLACE FUNCTION public.expire_stale_gateway_concurrency_slots_v1(
  p_limit integer DEFAULT 1000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_now   TIMESTAMPTZ := NOW();
  v_count INTEGER := 0;
BEGIN
  WITH stale AS (
    SELECT id FROM public.ai_gateway_concurrency_slots
      WHERE status = 'active' AND expires_at <= v_now
      ORDER BY expires_at
      LIMIT GREATEST(1, LEAST(p_limit, 10000))
      FOR UPDATE SKIP LOCKED
  )
  UPDATE public.ai_gateway_concurrency_slots s
    SET status = 'expired', released_at = v_now, release_reason = 'lease_expired'
    FROM stale WHERE s.id = stale.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

-- Grants das funções: somente backend (service_role). Revoga o EXECUTE padrão
-- de PUBLIC para que anon/authenticated jamais possam invocá-las diretamente
-- (o audit de privilégios abaixo passa a verificar isso).
REVOKE ALL ON FUNCTION public.acquire_gateway_concurrency_slot_v1(text, uuid, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_gateway_concurrency_slot_v1(text, uuid, text, text, integer, integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.acquire_gateway_concurrency_slot_v1(text, uuid, text, text, integer, integer) TO service_role;

REVOKE ALL ON FUNCTION public.release_gateway_concurrency_slot_v1(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_gateway_concurrency_slot_v1(uuid, text) TO postgres;
GRANT EXECUTE ON FUNCTION public.release_gateway_concurrency_slot_v1(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.expire_stale_gateway_concurrency_slots_v1(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_gateway_concurrency_slots_v1(integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.expire_stale_gateway_concurrency_slots_v1(integer) TO service_role;

-- ── Extensão do audit de privilégios ─────────────────────────────────────────
-- Adiciona a tabela e as funções novas ao _gateway_audit_database_privileges_v1
-- para que a checagem de segurança (enforce-readiness/preflight) verifique que
-- anon/authenticated NÃO têm acesso a elas. CREATE OR REPLACE preservando toda
-- a lista existente e apenas ANEXANDO os objetos novos.
CREATE OR REPLACE FUNCTION public._gateway_audit_database_privileges_v1()
RETURNS TABLE(unsafe_tables text[], unsafe_functions text[])
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_table          TEXT;
  v_func_sig       TEXT;
  v_unsafe_tables  TEXT[] := '{}';
  v_unsafe_funcs   TEXT[] := '{}';
BEGIN
  FOR v_table IN
    SELECT unnest(ARRAY[
      'ai_gateway_decisions', 'ai_gateway_idempotency_locks', 'ai_gateway_quota_buckets',
      'ai_gateway_budget_buckets', 'ai_gateway_reservation_budget_links', 'ai_gateway_circuit_breakers',
      'api_rate_limits', 'ai_gateway_concurrency_validations',
      'conversation_session_authorizations', 'realtime_hard_control_validations',
      'ai_gateway_concurrency_slots'
    ])
  LOOP
    IF has_table_privilege('anon', 'public.' || v_table, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR has_table_privilege('authenticated', 'public.' || v_table, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    THEN
      v_unsafe_tables := array_append(v_unsafe_tables, v_table);
    END IF;
  END LOOP;

  FOR v_func_sig IN
    SELECT * FROM unnest(ARRAY[
      'begin_gateway_idempotent_op_v1(text, text, integer)',
      'complete_gateway_idempotent_op_v1(uuid, text)',
      'fail_gateway_idempotent_op_v1(uuid)',
      '_gateway_touch_quota_bucket_v1(text, uuid, text, text, text, timestamp with time zone, timestamp with time zone)',
      '_gateway_touch_budget_bucket_v1(text, text, text, timestamp with time zone, timestamp with time zone)',
      'reserve_gateway_usage_v1(text, uuid, uuid, text, text, text, jsonb, jsonb, numeric, integer)',
      'commit_gateway_reservation_v1(uuid, uuid, numeric, jsonb)',
      'release_gateway_reservation_v1(uuid, text)',
      'mark_gateway_reservation_reconciliation_required_v1(uuid, text)',
      'expire_stale_gateway_reservations_v1(integer)',
      'get_gateway_breaker_state_v1(text, text, text)',
      'record_gateway_breaker_outcome_v1(text, text, text, boolean)',
      'check_and_increment_rate_limit(uuid, text, integer, integer)',
      'gateway_publish_runtime_controls_v1()',
      'gateway_publish_pricing_v1()',
      '_gateway_publish_runtime_controls_trigger_v1()',
      '_gateway_publish_pricing_trigger_v1()',
      'record_gateway_concurrency_validation_v1(text, text, text, text, text, text)',
      'record_realtime_hard_control_validation_v1(text, text, text, text, text, jsonb, text, text, jsonb)',
      'acquire_gateway_concurrency_slot_v1(text, uuid, text, text, integer, integer)',
      'release_gateway_concurrency_slot_v1(uuid, text)',
      'expire_stale_gateway_concurrency_slots_v1(integer)'
    ])
  LOOP
    IF has_function_privilege('anon', ('public.' || v_func_sig)::regprocedure, 'EXECUTE')
       OR has_function_privilege('authenticated', ('public.' || v_func_sig)::regprocedure, 'EXECUTE')
    THEN
      v_unsafe_funcs := array_append(v_unsafe_funcs, v_func_sig);
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_unsafe_tables, v_unsafe_funcs;
END;
$function$;

-- ── Seed seguro e idempotente do limite global por usuário ───────────────────
-- Ativa a concorrência em produção com um teto GENEROSO por usuário, aplicado
-- GLOBALMENTE (a chave de escopo inclui o user_id — ver resolveConcurrencyScope;
-- 'global' aqui significa "N chamadas pagas simultâneas por usuário, somando
-- todas as features", NÃO um balde único compartilhado por todos os usuários).
--
-- POR QUE 8 (valor NOVO — documentado): o maior fan-out paralelo legítimo
-- observado numa única ação de usuário é 2 blocos de TTS simultâneos na geração
-- de listening (Promise.all em get-or-create-shared-listening-story.ts /
-- advance-listening-pipeline.ts). 8 dá ~3x de folga para essa geração acontecer
-- junto de outra atividade paga (pronúncia, conversação) sem NUNCA bloquear uso
-- legítimo, enquanto ainda barra abuso patológico (script abrindo dezenas de
-- sessões pagas em paralelo). O rate limit horário continua sendo a proteção
-- primária contra martelar o endpoint; isto cobre o "em voo simultâneo".
--
-- Idempotente e não-destrutivo: só escreve onde ainda é NULL. Um administrador
-- pode sobrescrever por scope (global/provider/feature/user) a qualquer momento
-- pelo dashboard; a precedência most-specific-wins do policy-resolver respeita.
UPDATE public.ai_runtime_controls
  SET max_concurrent_requests = 8, updated_at = NOW()
  WHERE scope_type = 'global' AND scope_key = 'global'
    AND max_concurrent_requests IS NULL;
