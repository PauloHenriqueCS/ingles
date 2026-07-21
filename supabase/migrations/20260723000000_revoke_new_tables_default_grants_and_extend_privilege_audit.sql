-- =============================================================================
-- MIGRATION: 20260723000000_revoke_new_tables_default_grants_and_extend_privilege_audit
-- Projeto: Lemon (english learning app)
--
-- Etapa 11 (auditoria de banco pós-homologação) — fecha um gap real
-- encontrado nas duas tabelas criadas por 20260721010000
-- (conversation_session_authorizations) e 20260722000000
-- (realtime_hard_control_validations): ambas têm RLS habilitado com ZERO
-- políticas (bloqueando acesso via PostgREST), mas nenhuma das duas
-- migrations revogou o GRANT de tabela padrão que o Supabase concede a todo
-- projeto novo (DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- para anon e authenticated) — o grant bruto continuava concedido por
-- baixo, mesma classe de gap que 20260718010000_ai_gateway_enforcement_
-- security_fix.sql já havia corrigido nas 8 tabelas originais da Etapa 11.
--
-- Pior: _gateway_audit_database_privileges_v1() (a função que o preflight
-- usa para reportar unsafe_database_privileges ao vivo) tem uma lista FIXA
-- das 8 tabelas/18 funções de 20260718000000/20260718010000 — nunca foi
-- atualizada para cobrir as 2 tabelas novas. Confirmado por leitura direta
-- do código-fonte da função (pg_get_functiondef) antes desta migration:
-- nenhuma das duas aparece no loop de auditoria. Por isso privileges.unsafe
-- reportava false mesmo com o grant bruto concedido — o gap era
-- literalmente invisível ao preflight automatizado. Confirmado por query
-- direta em information_schema.role_table_grants (fora desta função,
-- antes de qualquer correção): anon e authenticated tinham as 7 permissões
-- completas nas duas tabelas.
--
-- Esta migration é EXCLUSIVAMENTE aditiva/corretiva de privilégio:
--   • Nenhuma tabela, coluna, policy, trigger ou linha de dado é criada,
--     removida ou alterada.
--   • service_role/postgres não são tocados (já têm acesso irrestrito —
--     bypassam RLS e não dependem de GRANT explícito, mesma premissa da
--     migration 20260718010000).
--   • _gateway_audit_database_privileges_v1() é substituída (CREATE OR
--     REPLACE) para cobrir as 10 tabelas (8 originais + 2 novas) e 19
--     funções (18 originais + record_realtime_hard_control_validation_v1,
--     a única função nova desde 20260718030000 que ainda não estava na
--     lista — já tinha REVOKE correto desde sua própria migration de
--     criação, esta apenas a inclui na auditoria por completude/defesa em
--     profundidade).
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 1: revoga o grant padrão de anon/authenticated nas 2 tabelas novas
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON public.conversation_session_authorizations FROM anon;
REVOKE ALL ON public.conversation_session_authorizations FROM authenticated;
REVOKE ALL ON public.realtime_hard_control_validations   FROM anon;
REVOKE ALL ON public.realtime_hard_control_validations   FROM authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 2: estende a função de auditoria para cobrir as 2 tabelas + a função
-- realtime nova
-- ─────────────────────────────────────────────────────────────────────────────

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
      'conversation_session_authorizations', 'realtime_hard_control_validations'
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
      'record_realtime_hard_control_validation_v1(text, text, text, text, text, text)'
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

-- =============================================================================
-- VALIDAÇÃO INLINE
-- =============================================================================
-- Dupla checagem, independente da própria função sob teste: consulta
-- has_table_privilege diretamente E chama a função recém-substituída,
-- exigindo que ambas concordem em "nada inseguro" antes do COMMIT.

DO $$
DECLARE
  v_unsafe_tables TEXT[];
  v_unsafe_funcs  TEXT[];
  v_anon_csa  BOOLEAN;
  v_auth_csa  BOOLEAN;
  v_anon_rhcv BOOLEAN;
  v_auth_rhcv BOOLEAN;
BEGIN
  v_anon_csa  := has_table_privilege('anon',          'public.conversation_session_authorizations', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  v_auth_csa  := has_table_privilege('authenticated',  'public.conversation_session_authorizations', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  v_anon_rhcv := has_table_privilege('anon',          'public.realtime_hard_control_validations',   'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  v_auth_rhcv := has_table_privilege('authenticated',  'public.realtime_hard_control_validations',   'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');

  IF v_anon_csa OR v_auth_csa OR v_anon_rhcv OR v_auth_rhcv THEN
    RAISE EXCEPTION 'VALIDATION FAILED: anon/authenticated still hold a raw grant (anon_csa=%, auth_csa=%, anon_rhcv=%, auth_rhcv=%)',
      v_anon_csa, v_auth_csa, v_anon_rhcv, v_auth_rhcv;
  END IF;

  SELECT unsafe_tables, unsafe_functions INTO v_unsafe_tables, v_unsafe_funcs
  FROM public._gateway_audit_database_privileges_v1();

  IF array_length(v_unsafe_tables, 1) IS NOT NULL OR array_length(v_unsafe_funcs, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'VALIDATION FAILED: _gateway_audit_database_privileges_v1 reports unsafe_tables=% unsafe_functions=%',
      v_unsafe_tables, v_unsafe_funcs;
  END IF;

  -- RLS + zero policies still intact on both (defensive — this migration
  -- never touches either, but a silent policy addition elsewhere would be
  -- exactly the kind of drift this check is meant to catch).
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_policy p ON p.polrelid = c.oid
    WHERE c.relname IN ('conversation_session_authorizations', 'realtime_hard_control_validations')
  ) THEN
    RAISE EXCEPTION 'VALIDATION FAILED: a policy exists on one of the two tables — expected zero';
  END IF;

  RAISE NOTICE 'VALIDATION PASSED: anon/authenticated stripped of every privilege on conversation_session_authorizations and realtime_hard_control_validations; _gateway_audit_database_privileges_v1 now covers 10 tables and 19 functions and independently confirms zero unsafe grants';
END $$;

COMMIT;

-- =============================================================================
-- FIM DA MIGRATION 20260723000000_revoke_new_tables_default_grants_and_extend_privilege_audit
-- =============================================================================
