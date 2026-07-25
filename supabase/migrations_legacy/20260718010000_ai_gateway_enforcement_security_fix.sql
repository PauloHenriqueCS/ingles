-- =============================================================================
-- MIGRATION: 20260718010000_ai_gateway_enforcement_security_fix
-- Projeto: Lemon (english learning app)
--
-- Correção de segurança ADITIVA sobre 20260718000000_ai_gateway_enforcement
-- (já aplicada remotamente — não alterada, não substituída, nenhuma linha
-- dela é tocada por este arquivo). Auditoria direta na base remota
-- (information_schema.role_table_grants, has_table_privilege/
-- has_function_privilege, pg_policy, e o security advisor do Supabase)
-- confirmou dois gaps reais de privilégio, ambos fechados abaixo:
--
--   GAP 1 — as 8 tabelas internas da Etapa 11 têm RLS habilitado SEM
--   nenhuma policy (isso já bloqueia leitura/escrita via PostgREST para
--   anon/authenticated hoje — service_role/postgres são as únicas
--   conexões que a aplicação usa para elas, ver api/_ai-gateway/**), mas o
--   GRANT bruto de tabela que o Supabase concede por padrão a todo projeto
--   novo (ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon,
--   authenticated) continua presente: confirmado ao vivo que anon e
--   authenticated têm DELETE/INSERT/REFERENCES/SELECT/TRIGGER/TRUNCATE/
--   UPDATE efetivos nas 8 tabelas. RLS-sem-policy é a barreira hoje; este
--   bloco remove o GRANT redundante para que a barreira nunca dependa de
--   uma única camada (se uma policy permissiva for adicionada por engano
--   no futuro, ou RLS for desabilitado por engano, o GRANT já não existe
--   mais para ser explorado).
--
--   GAP 2 — das 18 funções da Etapa 11, 16 já tinham REVOKE explícito de
--   EXECUTE de PUBLIC/anon/authenticated na migration original, logo após
--   cada CREATE FUNCTION. As 2 exceções — _gateway_publish_pricing_trigger_v1
--   e _gateway_publish_runtime_controls_trigger_v1 — não tinham REVOKE
--   porque são funções RETURNS TRIGGER, chamadas apenas pelo mecanismo de
--   trigger do Postgres (nunca via RPC pela aplicação: grep confirma zero
--   chamadas diretas em api/ ou src/). O Postgres concede EXECUTE a PUBLIC
--   por padrão na criação de qualquer função, e como nada revogou isso
--   para essas duas, anon/authenticated herdam EXECUTE via PUBLIC — o
--   próprio security advisor do Supabase confirma isso ao vivo, sinalizando
--   as duas como anon_security_definer_function_executable /
--   authenticated_security_definer_function_executable, expostas em
--   /rest/v1/rpc/<nome>. Fechado abaixo com as assinaturas exatas da
--   migration original.
--
-- EXCLUSIVAMENTE ADITIVA: nenhuma tabela, função, policy, trigger ou linha
-- de dado é criada, removida ou alterada — apenas REVOKE de privilégios que
-- nunca deveriam ter sido concedidos a anon/authenticated, GRANT explícito
-- (idempotente) reforçando o acesso de service_role/postgres, e uma
-- validação transacional. Nenhuma tabela/função fora das 8+18 da Etapa 11 é
-- tocada (em particular, fn_gateway_version_immutable, sinalizada pelo
-- mesmo advisor por um motivo não relacionado — search_path mutável — fica
-- fora de escopo desta correção).
-- =============================================================================

BEGIN;

-- Real before-snapshot dos três fatos que esta migration está proibida de
-- alterar, capturado antes de qualquer REVOKE/GRANT abaixo, para a
-- validação final comparar contra o estado genuíno anterior em vez de se
-- comparar consigo mesma.
CREATE TEMP TABLE _security_fix_runtime_before AS
  SELECT id, gateway_mode, runtime_status FROM public.ai_runtime_controls;

CREATE TEMP TABLE _security_fix_pricing_before AS
  SELECT id, provider, model, metric_key, price_per_unit, is_active, source_reference
  FROM public.provider_pricing;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 1: revogar privilégios de tabela de PUBLIC/anon/authenticated
-- ─────────────────────────────────────────────────────────────────────────────
-- REVOKE ALL cobre DELETE/INSERT/REFERENCES/SELECT/TRIGGER/TRUNCATE/UPDATE
-- em uma única instrução. Revogar um privilégio já ausente não é erro —
-- seguro reexecutar.

REVOKE ALL ON TABLE public.ai_gateway_decisions              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.ai_gateway_idempotency_locks      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.ai_gateway_quota_buckets          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.ai_gateway_budget_buckets         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.ai_gateway_reservation_budget_links FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.ai_gateway_circuit_breakers       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.api_rate_limits                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.ai_gateway_concurrency_validations FROM PUBLIC, anon, authenticated;

-- service_role e o proprietário (postgres) continuam precisando de acesso
-- total — reforçado explicitamente aqui (idempotente) porque toda a
-- superfície server-only da Etapa 11 (api/_ai-gateway/**, este e futuros
-- crons como expire_stale_gateway_reservations_v1) sempre conecta como
-- service_role, nunca como anon/authenticated.
GRANT ALL ON TABLE public.ai_gateway_decisions              TO service_role, postgres;
GRANT ALL ON TABLE public.ai_gateway_idempotency_locks      TO service_role, postgres;
GRANT ALL ON TABLE public.ai_gateway_quota_buckets          TO service_role, postgres;
GRANT ALL ON TABLE public.ai_gateway_budget_buckets         TO service_role, postgres;
GRANT ALL ON TABLE public.ai_gateway_reservation_budget_links TO service_role, postgres;
GRANT ALL ON TABLE public.ai_gateway_circuit_breakers       TO service_role, postgres;
GRANT ALL ON TABLE public.api_rate_limits                   TO service_role, postgres;
GRANT ALL ON TABLE public.ai_gateway_concurrency_validations TO service_role, postgres;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 2: revogar EXECUTE de PUBLIC/anon/authenticated nas 18 funções
-- ─────────────────────────────────────────────────────────────────────────────
-- 16 das 18 já tinham REVOKE explícito na migration original — reafirmado
-- aqui de forma idempotente (defesa contra drift futuro). As 2 funções
-- TRIGGER (_gateway_publish_pricing_trigger_v1,
-- _gateway_publish_runtime_controls_trigger_v1) são o gap real, fechado
-- agora. Assinaturas idênticas às usadas em 20260718000000_ai_gateway_enforcement.sql.

REVOKE ALL ON FUNCTION public.begin_gateway_idempotent_op_v1(TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_gateway_idempotent_op_v1(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_gateway_idempotent_op_v1(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._gateway_touch_quota_bucket_v1(TEXT, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._gateway_touch_budget_bucket_v1(TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_gateway_usage_v1(TEXT, UUID, UUID, TEXT, TEXT, TEXT, JSONB, JSONB, NUMERIC, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commit_gateway_reservation_v1(UUID, UUID, NUMERIC, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_gateway_reservation_v1(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_gateway_reservation_reconciliation_required_v1(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.expire_stale_gateway_reservations_v1(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_gateway_breaker_state_v1(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_gateway_breaker_outcome_v1(TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.check_and_increment_rate_limit(UUID, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gateway_publish_runtime_controls_v1() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gateway_publish_pricing_v1() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._gateway_publish_runtime_controls_trigger_v1() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._gateway_publish_pricing_trigger_v1() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_gateway_concurrency_validation_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- service_role/postgres retêm EXECUTE explicitamente (idempotente). Para as
-- 2 funções TRIGGER isto não abre uma nova via de chamada: o Postgres
-- recusa qualquer invocação direta de uma função RETURNS TRIGGER fora do
-- mecanismo de trigger, para qualquer role — a concessão aqui é só para
-- manter as 18 funções simetricamente auditáveis (mesma politica de
-- privilégio, mesmo se o efeito prático já viesse do próprio Postgres).
GRANT EXECUTE ON FUNCTION public.begin_gateway_idempotent_op_v1(TEXT, TEXT, INTEGER) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.complete_gateway_idempotent_op_v1(UUID, TEXT) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.fail_gateway_idempotent_op_v1(UUID) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public._gateway_touch_quota_bucket_v1(TEXT, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public._gateway_touch_budget_bucket_v1(TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.reserve_gateway_usage_v1(TEXT, UUID, UUID, TEXT, TEXT, TEXT, JSONB, JSONB, NUMERIC, INTEGER) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.commit_gateway_reservation_v1(UUID, UUID, NUMERIC, JSONB) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.release_gateway_reservation_v1(UUID, TEXT) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.mark_gateway_reservation_reconciliation_required_v1(UUID, TEXT) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.expire_stale_gateway_reservations_v1(INTEGER) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.get_gateway_breaker_state_v1(TEXT, TEXT, TEXT) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.record_gateway_breaker_outcome_v1(TEXT, TEXT, TEXT, BOOLEAN) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.check_and_increment_rate_limit(UUID, TEXT, INTEGER, INTEGER) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.gateway_publish_runtime_controls_v1() TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.gateway_publish_pricing_v1() TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public._gateway_publish_runtime_controls_trigger_v1() TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public._gateway_publish_pricing_trigger_v1() TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.record_gateway_concurrency_validation_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role, postgres;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 3: _gateway_audit_database_privileges_v1() — checagem live, read-only
-- ─────────────────────────────────────────────────────────────────────────────
-- Não é uma das 18 funções da Etapa 11 — é um utilitário NOVO, mínimo,
-- introduzido por esta correção especificamente para que
-- scripts/ai-gateway-enforce-preflight.ts (item 7 desta correção) possa
-- perguntar ao Postgres, ao vivo, "anon/authenticated ainda têm algum
-- privilégio nas 8 tabelas ou EXECUTE em alguma das 18 funções?" sem
-- nunca invocar as funções reais da Etapa 11 para descobrir a resposta.
--
-- Isso importa porque duas delas (gateway_publish_runtime_controls_v1,
-- gateway_publish_pricing_v1) não recebem nenhum parâmetro — não existe
-- argumento malformado possível para forçar uma falha de coerção antes do
-- corpo da função rodar, então uma sonda por tentativa-de-chamada (mesmo
-- com anon) arriscaria executá-las de verdade caso o EXECUTE ainda
-- estivesse concedido (exatamente a regressão que se quer detectar). Este
-- utilitário responde com has_table_privilege/has_function_privilege —
-- builtins do Postgres, sem I/O, sem side effect algum — em vez de tentar
-- chamadas reais.
--
-- SECURITY INVOKER (não DEFINER): não precisa de privilégio elevado —
-- has_table_privilege/has_function_privilege sobre catálogos do sistema são
-- de leitura pública. REVOKE de PUBLIC/anon/authenticated abaixo pelo mesmo
-- motivo de qualquer outra função server-only desta migration: só
-- service_role (o preflight) precisa chamá-la.
CREATE OR REPLACE FUNCTION public._gateway_audit_database_privileges_v1()
RETURNS TABLE(unsafe_tables TEXT[], unsafe_functions TEXT[])
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
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
      'api_rate_limits', 'ai_gateway_concurrency_validations'
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
      'record_gateway_concurrency_validation_v1(text, text, text, text, text, text)'
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
$$;

REVOKE ALL ON FUNCTION public._gateway_audit_database_privileges_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._gateway_audit_database_privileges_v1() TO service_role, postgres;

-- =============================================================================
-- VALIDAÇÃO TRANSACIONAL — qualquer condição abaixo aborta a migration inteira
-- =============================================================================

DO $$
DECLARE
  v_table_name  TEXT;
  v_func_sig    TEXT;
  v_changed_runtime INTEGER;
  v_row_count_before INTEGER;
  v_row_count_after  INTEGER;
  v_changed_pricing  INTEGER;
BEGIN
  -- (1) anon/authenticated não podem ter mais nenhum privilégio DML efetivo
  --     nas 8 tabelas; (4) RLS deve continuar habilitado; (5) nenhuma
  --     policy pode existir; (3, parte tabelas) service_role deve manter
  --     acesso.
  FOR v_table_name IN
    SELECT unnest(ARRAY[
      'ai_gateway_decisions', 'ai_gateway_idempotency_locks', 'ai_gateway_quota_buckets',
      'ai_gateway_budget_buckets', 'ai_gateway_reservation_budget_links', 'ai_gateway_circuit_breakers',
      'api_rate_limits', 'ai_gateway_concurrency_validations'
    ])
  LOOP
    IF has_table_privilege('anon', 'public.' || v_table_name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION 'VALIDATION FAILED: anon still has an effective privilege on public.%', v_table_name;
    END IF;
    IF has_table_privilege('authenticated', 'public.' || v_table_name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION 'VALIDATION FAILED: authenticated still has an effective privilege on public.%', v_table_name;
    END IF;
    IF NOT has_table_privilege('service_role', 'public.' || v_table_name, 'SELECT,INSERT,UPDATE,DELETE') THEN
      RAISE EXCEPTION 'VALIDATION FAILED: service_role is missing a required privilege on public.%', v_table_name;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = v_table_name AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'VALIDATION FAILED: public.% no longer has row level security enabled', v_table_name;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = v_table_name
    ) THEN
      RAISE EXCEPTION 'VALIDATION FAILED: public.% has a policy — expected zero policies on this internal table', v_table_name;
    END IF;
  END LOOP;

  -- (2) anon/authenticated não podem ter mais EXECUTE em nenhuma das 18
  --     funções; (3, parte funções) service_role deve manter EXECUTE.
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
      'record_gateway_concurrency_validation_v1(text, text, text, text, text, text)'
    ])
  LOOP
    IF has_function_privilege('anon', ('public.' || v_func_sig)::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'VALIDATION FAILED: anon still has EXECUTE on public.%', v_func_sig;
    END IF;
    IF has_function_privilege('authenticated', ('public.' || v_func_sig)::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'VALIDATION FAILED: authenticated still has EXECUTE on public.%', v_func_sig;
    END IF;
    IF NOT has_function_privilege('service_role', ('public.' || v_func_sig)::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'VALIDATION FAILED: service_role is missing EXECUTE on public.%', v_func_sig;
    END IF;
  END LOOP;

  -- (6) gateway_mode / runtime_status (ai_runtime_controls) inalterados.
  SELECT COUNT(*) INTO v_row_count_before FROM _security_fix_runtime_before;
  SELECT COUNT(*) INTO v_row_count_after FROM public.ai_runtime_controls;
  IF v_row_count_before != v_row_count_after THEN
    RAISE EXCEPTION 'VALIDATION FAILED: ai_runtime_controls row count changed (% before, % after) — this migration must never add or remove rows in this table', v_row_count_before, v_row_count_after;
  END IF;

  SELECT COUNT(*) INTO v_changed_runtime
    FROM public.ai_runtime_controls arc
    JOIN _security_fix_runtime_before b ON b.id = arc.id
    WHERE arc.gateway_mode IS DISTINCT FROM b.gateway_mode
       OR arc.runtime_status IS DISTINCT FROM b.runtime_status;
  IF v_changed_runtime > 0 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: % existing ai_runtime_controls row(s) had gateway_mode/runtime_status changed by this migration — must be zero (this migration only touches privileges, never writes to this table)', v_changed_runtime;
  END IF;

  -- (6) provider_pricing inalterada.
  SELECT COUNT(*) INTO v_changed_pricing
    FROM public.provider_pricing pp
    FULL JOIN _security_fix_pricing_before b ON b.id = pp.id
    WHERE pp.id IS NULL OR b.id IS NULL
       OR pp.price_per_unit IS DISTINCT FROM b.price_per_unit
       OR pp.is_active IS DISTINCT FROM b.is_active
       OR pp.source_reference IS DISTINCT FROM b.source_reference
       OR pp.provider IS DISTINCT FROM b.provider
       OR pp.model IS DISTINCT FROM b.model
       OR pp.metric_key IS DISTINCT FROM b.metric_key;
  IF v_changed_pricing > 0 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: provider_pricing differs from its pre-migration snapshot (% row(s)) — this migration must never write to provider_pricing', v_changed_pricing;
  END IF;

  RAISE NOTICE 'VALIDATION PASSED: anon/authenticated stripped of every privilege on the 8 Etapa 11 tables and of EXECUTE on all 18 Etapa 11 functions; service_role/postgres retain required access; RLS remains enabled with zero policies on all 8 tables; gateway_mode/runtime_status/provider_pricing unchanged';
END;
$$;

COMMIT;

-- =============================================================================
-- ROLLBACK MANUAL (documentado, não executado por esta migration)
-- =============================================================================
--   Reverter esta correção significa devolver a anon/authenticated os
--   privilégios de tabela e EXECUTE removidos acima. Não recomendado — isso
--   reabre exatamente os dois gaps que esta migration fecha. Se algum dia
--   necessário (ex.: teste isolado em ambiente descartável):
--     GRANT ALL ON TABLE public.<tabela> TO anon, authenticated;              -- para cada uma das 8 tabelas
--     GRANT EXECUTE ON FUNCTION public.<assinatura> TO anon, authenticated;   -- para cada uma das 18 funções
--     DROP FUNCTION IF EXISTS public._gateway_audit_database_privileges_v1(); -- utilitário novo desta correção
--   A migration original (20260718000000_ai_gateway_enforcement) permanece
--   a autoridade sobre o schema/dados das 8 tabelas e 18 funções — esta
--   correção nunca precisa ser revertida junto com ela.
-- =============================================================================
--
-- FIM DA MIGRATION 20260718010000_ai_gateway_enforcement_security_fix
-- =============================================================================
