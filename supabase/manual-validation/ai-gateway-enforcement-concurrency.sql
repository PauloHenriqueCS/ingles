-- =============================================================================
-- MANUAL VALIDATION: AI Gateway enforcement — concurrency scenarios
-- Etapa 11 (Fase 15), corrigido três vezes: redesenho atômico budget+quota,
-- FK-safety/runnability real, e agora (2026-07-18) o modelo de execução dos
-- Cenários 1/2/3/6/7 — de blocos soltos pensados para colar em staging, para
-- um único DO block transacional com ROLLBACK proposital, seguro para rodar
-- direto no Primary Database.
--
-- WHY THIS FILE EXISTS: unit tests (api/__tests__/enforcement.test.ts,
-- ai-gateway-enforcement-wrappers.test.ts) mock every repository/RPC e por
-- isso não conseguem provar atomicidade real em nível de Postgres. Este
-- arquivo prova contra um Postgres real.
--
-- PRÉ-REQUISITO OBRIGATÓRIO: 20260718020000_ai_gateway_enforcement_
-- function_ambiguity_fix.sql precisa estar aplicada antes de rodar
-- qualquer cenário abaixo. Sem ela, begin_gateway_idempotent_op_v1 e
-- reserve_gateway_usage_v1 lançam "column reference ... is ambiguous" —
-- exatamente o que a execução real dos Cenários 1-7 contra o Primary
-- Database confirmou em 2026-07-18 (2/3/7 FAIL; 1/6 PASS, que são as duas
-- funções não afetadas pelo bug). Ver o cabeçalho dessa migration para a
-- causa raiz completa.
--
-- ⚠️ Execução no Primary Database (não há projeto de staging/scratch
-- separado neste momento). A segurança não vem de isolar o projeto, vem do
-- desenho do script:
--   • Cenários 1, 2, 3, 6, 7 rodam dentro de UM ÚNICO DO block, envolto por
--     BEGIN;/ROLLBACK; explícitos neste mesmo arquivo — TUDO que o DO
--     escreve é desfeito no ROLLBACK final, sempre, PASS ou FAIL. Nenhuma
--     tabela temporária é usada; o resultado de cada cenário é reportado
--     via RAISE NOTICE (não-transacional — aparece no painel de mensagens
--     do SQL Editor mesmo com o ROLLBACK subsequente).
--   • pg_advisory_xact_lock serializa duas execuções simultâneas deste
--     bloco (mesma chave lógica 'lemon:etapa11:manual-validation-12367'),
--     liberado automaticamente no ROLLBACK.
--   • O usuário de teste é validado contra auth.users ANTES de qualquer
--     escrita — aborta tudo (RAISE EXCEPTION, que por si só já reverteria
--     a transação) se não existir.
--   • Todo identificador é um marcador sintético exclusivo — nunca colide
--     com tráfego real (ver "Isolation" de cada cenário).
--   • Cenários 4 e 5 EXIGEM duas conexões reais (não cabem em um único DO —
--     a prova de concorrência real depende de duas transações
--     independentes correndo ao mesmo tempo) — continuam em blocos
--     separados, SESSION A / SESSION B, com limpeza explícita própria.
--
-- COLE E RODE OS TRÊS COMANDOS DO BLOCO 1-2-3-6-7 JUNTOS, DE UMA VEZ
-- (BEGIN; / DO $$ ... $$; / ROLLBACK;) — rodar cada um separadamente só
-- funciona se a mesma conexão/aba permanecer aberta entre eles; se o seu
-- cliente SQL abre uma conexão nova a cada execução, o BEGIN não vale para
-- os comandos seguintes.
--
-- SETUP — read before running anything:
--   1. Cenários 4 e 5 precisam de um usuário de teste real (FK para
--      auth.users em usage_reservations.user_id /
--      ai_gateway_quota_buckets.subject_id). Crie um usuário descartável
--      (Supabase Studio → Authentication → Add user, ou
--      `supabase auth admin create-user`) e substitua abaixo:
DROP TABLE IF EXISTS pg_temp._mv_config;
CREATE TEMP TABLE _mv_config (test_user_id UUID);
INSERT INTO _mv_config VALUES ('00000000-0000-0000-0000-000000000000'); -- ← REPLACE com o UUID real, só usado pelos Cenários 4 e 5
--   Cenários 1, 2, 3, 6, 7 têm seu PRÓPRIO usuário de teste declarado
--   dentro do DO block abaixo (sem depender desta tabela temporária — ela
--   é local à conexão e não seria visível nas abas B dos Cenários 4/5 de
--   qualquer forma, então nunca foi o mecanismo certo para compartilhar um
--   valor entre duas conexões reais; mantida aqui só para os SETUPs de
--   Cenário 4/5, que rodam sempre na mesma conexão que este bloco inicial).
--
--   2. Scenarios that need a `feature_key` use REAL, already-seeded feature
--      keys (usage_reservations.feature_key and
--      ai_gateway_circuit_breakers.feature_key both have a NOT NULL foreign
--      key to ai_features — a fabricated key would be rejected). To keep
--      these scenarios from ever touching real production breaker/quota
--      state for that feature, every synthetic row additionally uses an
--      obviously-fake MODEL string (e.g. 'preflight-validation-model') or a
--      synthetic idempotency_key/period — real traffic never uses these
--      values, so no synthetic row can ever collide with a real one.
--
--   3. No scenario here ever touches pedagogical/domain tables (writing
--      entries, listening episodes, conversation sessions, etc.) — only the
--      Etapa 11 tables themselves plus one disposable auth.users row you
--      create and own, and (Cenário 7) one synthetic ai_usage_events/
--      ai_usage_event_metrics row with a fixed, obviously-synthetic UUID
--      and a period in year 2099. Real consumption/usage history is never
--      read, written, or altered by anything below.
--
--   4. PROOF OF CONCURRENCY (Cenários 4 e 5 apenas — 1/2/3/6/7 não
--      precisam disso: a atomicidade que eles provam é de uma trava de
--      linha única — INSERT...ON CONFLICT / unique index+exception /
--      SELECT...FOR UPDATE — não de uma corrida real entre duas conexões,
--      então rodar sequencialmente dentro do mesmo DO já é uma prova
--      válida e suficiente):
--        a. Open TWO real, separate DB connections (two psql processes, or
--           two browser tabs in Supabase Studio's SQL editor — NOT the same
--           tab/session reused, which would serialize them trivially and
--           prove nothing).
--        b. In psql, run `\timing on` in both sessions first. In Supabase
--           Studio, note the "Query took Xms" shown after each run.
--        c. Paste Session A's statement in tab/window A and Session B's in
--           tab/window B WITHOUT running either yet.
--        d. Execute A, then immediately (same breath, do not wait for the
--           result) execute B.
--        e. After both return, compare their start/end timestamps. CONFIRM
--           the two executions' time windows overlap — if B's start time is
--           clearly after A's end time, you ran them sequentially, not
--           concurrently, and the scenario proves nothing; re-run with
--           tighter timing.
--        f. Only once genuine overlap is confirmed do the EXPECTED results
--           below count as a real concurrency proof for that scenario.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- SCENARIOS 1, 2, 3, 6, 7 — um único DO block, ROLLBACK proposital, sem
-- tabelas temporárias, seguro para rodar direto no Primary Database.
-- ─────────────────────────────────────────────────────────────────────────────
-- Cenário 1: check_and_increment_rate_limit é atômico sob concorrência.
-- Cenário 2: begin_gateway_idempotent_op_v1 é atômico (dedupe) e o reclaim
--   de uma lock 'failed' funciona (begin -> in_progress -> fail ->
--   reclaimed) — CORRIGIDO aqui vs. versões anteriores deste arquivo: nunca
--   apaga a linha antes de tentar reclamá-la (isso faria o begin seguinte
--   inserir uma lock NOVA, outcome='started', nunca 'reclaimed').
-- Cenário 3: reserve_gateway_usage_v1 é idempotente por idempotency_key —
--   duas chamadas com a mesma chave retornam o MESMO reservation_id, nunca
--   criam uma segunda linha.
-- Cenário 6: o circuit breaker, em half_open com half_open_probe_count=1,
--   permite exatamente UMA probe concorrente.
-- Cenário 7: o primeiro touch de um quota bucket faz backfill de
--   committed_quantity a partir de eventos reais já existentes no período,
--   em vez de começar do zero.

BEGIN;

DO $$
DECLARE
  v_user_id UUID := '00000000-0000-0000-0000-000000000000'; -- ← REPLACE com um usuário de teste real (auth.users) antes de rodar
BEGIN
  -- Impede duas execuções simultâneas deste bloco.
  PERFORM pg_advisory_xact_lock(hashtextextended('lemon:etapa11:manual-validation-12367', 0));

  -- Validação obrigatória ANTES de qualquer escrita: aborta tudo se o
  -- usuário de teste não existir em auth.users neste exato momento.
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_user_id) THEN
    RAISE EXCEPTION 'ABORTADO: usuário de teste % não existe em auth.users — nenhuma escrita foi feita.', v_user_id;
  END IF;

  ------------------------------------------------------------------
  -- Pre-cleanup defensivo — nunca deveria encontrar nada (o ROLLBACK no
  -- fim deste arquivo garante isso estruturalmente), mas protege contra
  -- resíduo de uma execução anterior a este modelo (versões passadas deste
  -- arquivo faziam COMMIT).
  ------------------------------------------------------------------
  DELETE FROM public.api_rate_limits WHERE route_key = 'manual-validation:scenario1';
  DELETE FROM public.ai_gateway_idempotency_locks WHERE scope = 'manual-validation:scenario2';
  DELETE FROM public.usage_reservation_items WHERE reservation_id IN (
    SELECT id FROM public.usage_reservations WHERE idempotency_key = 'manual-validation-scenario3');
  DELETE FROM public.usage_reservations WHERE idempotency_key = 'manual-validation-scenario3';
  DELETE FROM public.ai_gateway_circuit_breakers
    WHERE provider = 'openai' AND model = 'preflight-validation-model' AND feature_key = 'writing.correct';
  DELETE FROM public.usage_reservation_items WHERE reservation_id IN (
    SELECT id FROM public.usage_reservations WHERE idempotency_key = 'manual-validation-scenario7');
  DELETE FROM public.usage_reservations WHERE idempotency_key = 'manual-validation-scenario7';
  DELETE FROM public.ai_gateway_quota_buckets WHERE subject_id = v_user_id AND period_start = '2099-01-01T00:00:00Z';
  DELETE FROM public.ai_usage_event_metrics WHERE usage_event_id = 'aaaaaaaa-0000-0000-0000-000000000007'::uuid;
  DELETE FROM public.ai_usage_events WHERE id = 'aaaaaaaa-0000-0000-0000-000000000007'::uuid;

  ------------------------------------------------------------------
  -- SCENARIO 1 — check_and_increment_rate_limit atomic
  ------------------------------------------------------------------
  DECLARE
    v_json_a JSONB;
    v_json_b JSONB;
  BEGIN
    SELECT public.check_and_increment_rate_limit(v_user_id, 'manual-validation:scenario1', 60, 1) INTO v_json_a;
    SELECT public.check_and_increment_rate_limit(v_user_id, 'manual-validation:scenario1', 60, 1) INTO v_json_b;

    IF (v_json_a->>'allowed')::boolean IS DISTINCT FROM (v_json_b->>'allowed')::boolean THEN
      RAISE NOTICE '1_rate_limit_atomic: PASS (A=% B=%)', v_json_a, v_json_b;
    ELSE
      RAISE NOTICE '1_rate_limit_atomic: FAIL — esperado exatamente um allowed=true (A=% B=%)', v_json_a, v_json_b;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '1_rate_limit_atomic: FAIL — erro inesperado: %', SQLERRM;
  END;

  ------------------------------------------------------------------
  -- SCENARIO 2 — begin_gateway_idempotent_op_v1 dedupe + reclaim
  ------------------------------------------------------------------
  DECLARE
    v_lock_id_a UUID; v_outcome_a TEXT;
    v_lock_id_b UUID; v_outcome_b TEXT;
    v_outcome_reclaim TEXT;
  BEGIN
    SELECT lock_id, outcome INTO v_lock_id_a, v_outcome_a
      FROM public.begin_gateway_idempotent_op_v1('manual-validation:scenario2', 'idem-key-1', 30);
    SELECT lock_id, outcome INTO v_lock_id_b, v_outcome_b
      FROM public.begin_gateway_idempotent_op_v1('manual-validation:scenario2', 'idem-key-1', 30);

    IF v_outcome_a = 'started' AND v_outcome_b = 'in_progress' AND v_lock_id_b = v_lock_id_a THEN
      -- reclaim, usando o lock_id real capturado acima (nunca apagando a
      -- linha antes de tentar reclamá-la)
      PERFORM public.fail_gateway_idempotent_op_v1(v_lock_id_a);
      SELECT outcome INTO v_outcome_reclaim
        FROM public.begin_gateway_idempotent_op_v1('manual-validation:scenario2', 'idem-key-1', 30);

      IF v_outcome_reclaim = 'reclaimed' THEN
        RAISE NOTICE '2_dedupe_atomic_and_reclaim: PASS (A=started B=in_progress mesmo lock, reclaim=%)', v_outcome_reclaim;
      ELSE
        RAISE NOTICE '2_dedupe_atomic_and_reclaim: FAIL — dedupe OK mas reclaim=% (esperado reclaimed)', v_outcome_reclaim;
      END IF;
    ELSE
      RAISE NOTICE '2_dedupe_atomic_and_reclaim: FAIL — A=% B=% lock_a=% lock_b=% (esperado A=started B=in_progress mesmo lock_id)',
        v_outcome_a, v_outcome_b, v_lock_id_a, v_lock_id_b;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '2_dedupe_atomic_and_reclaim: FAIL — erro inesperado: %', SQLERRM;
  END;

  ------------------------------------------------------------------
  -- SCENARIO 3 — reserve_gateway_usage_v1 idempotency-key uniqueness
  ------------------------------------------------------------------
  DECLARE
    v_res_id_a UUID; v_res_id_b UUID;
    v_count_reservations INTEGER;
    v_count_items INTEGER;
  BEGIN
    SELECT reservation_id INTO v_res_id_a FROM public.reserve_gateway_usage_v1(
      'manual-validation-scenario3', NULL, NULL, 'writing.correct', 'openai', 'gpt-4o-mini',
      '[{"quota_key":"output_text_tokens","unit_type":"token","reserved_quantity":500,"limit_quantity":null,"period_type":null,"period_start":null,"period_end":null}]'::jsonb,
      '[]'::jsonb, NULL, 120
    );
    SELECT reservation_id INTO v_res_id_b FROM public.reserve_gateway_usage_v1(
      'manual-validation-scenario3', NULL, NULL, 'writing.correct', 'openai', 'gpt-4o-mini',
      '[{"quota_key":"output_text_tokens","unit_type":"token","reserved_quantity":500,"limit_quantity":null,"period_type":null,"period_start":null,"period_end":null}]'::jsonb,
      '[]'::jsonb, NULL, 120
    );

    SELECT count(*) INTO v_count_reservations FROM public.usage_reservations WHERE idempotency_key = 'manual-validation-scenario3';
    SELECT count(*) INTO v_count_items FROM public.usage_reservation_items ri
      JOIN public.usage_reservations r ON r.id = ri.reservation_id WHERE r.idempotency_key = 'manual-validation-scenario3';

    IF v_res_id_a = v_res_id_b AND v_count_reservations = 1 AND v_count_items = 1 THEN
      RAISE NOTICE '3_reservation_idempotency: PASS (reservation_id=% reservations=% items=%)', v_res_id_a, v_count_reservations, v_count_items;
    ELSE
      RAISE NOTICE '3_reservation_idempotency: FAIL — id_a=% id_b=% reservations=% items=% (esperado: mesmo id, 1 e 1)',
        v_res_id_a, v_res_id_b, v_count_reservations, v_count_items;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '3_reservation_idempotency: FAIL — erro inesperado: %', SQLERRM;
  END;

  ------------------------------------------------------------------
  -- SCENARIO 6 — breaker half_open probe exclusivity
  ------------------------------------------------------------------
  DECLARE
    v_state_a TEXT; v_probe_a BOOLEAN;
    v_state_b TEXT; v_probe_b BOOLEAN;
    i INTEGER;
  BEGIN
    FOR i IN 1..5 LOOP
      PERFORM public.record_gateway_breaker_outcome_v1('openai', 'preflight-validation-model', 'writing.correct', false);
    END LOOP;

    UPDATE public.ai_gateway_circuit_breakers
      SET opened_at = NOW() - INTERVAL '1 minute'
      WHERE provider = 'openai' AND model = 'preflight-validation-model' AND feature_key = 'writing.correct';

    SELECT state, probe_allowed INTO v_state_a, v_probe_a
      FROM public.get_gateway_breaker_state_v1('openai', 'preflight-validation-model', 'writing.correct');
    SELECT state, probe_allowed INTO v_state_b, v_probe_b
      FROM public.get_gateway_breaker_state_v1('openai', 'preflight-validation-model', 'writing.correct');

    IF v_state_a = 'half_open' AND v_state_b = 'half_open' AND v_probe_a IS DISTINCT FROM v_probe_b THEN
      RAISE NOTICE '6_breaker_probe_exclusivity: PASS (A=(half_open,%) B=(half_open,%))', v_probe_a, v_probe_b;
    ELSE
      RAISE NOTICE '6_breaker_probe_exclusivity: FAIL — A=(%,%) B=(%,%) (esperado: ambos half_open, exatamente um probe_allowed=true)',
        v_state_a, v_probe_a, v_state_b, v_probe_b;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '6_breaker_probe_exclusivity: FAIL — erro inesperado: %', SQLERRM;
  END;

  ------------------------------------------------------------------
  -- SCENARIO 7 — bootstrap/backfill on first bucket touch
  ------------------------------------------------------------------
  DECLARE
    v_committed NUMERIC;
    v_backfilled BOOLEAN;
  BEGIN
    INSERT INTO public.ai_usage_events (
      id, request_id, user_id, actor_type, feature_key, provider, execution_location, status, is_billable, started_at
    ) VALUES (
      'aaaaaaaa-0000-0000-0000-000000000007'::uuid, 'aaaaaaaa-0000-0000-0000-000000000007'::uuid,
      v_user_id, 'user', 'writing.correct', 'openai', 'backend', 'succeeded', true, '2099-01-15T00:00:00Z'
    );
    INSERT INTO public.ai_usage_event_metrics (usage_event_id, metric_key, unit_type, quantity, is_billable, measurement_source)
      VALUES ('aaaaaaaa-0000-0000-0000-000000000007'::uuid, 'output_text_tokens', 'token', 750, true, 'provider_response');

    PERFORM public.reserve_gateway_usage_v1(
      'manual-validation-scenario7', v_user_id, NULL, 'writing.correct', 'openai', 'preflight-validation-model',
      '[{"quota_key":"output_text_tokens","unit_type":"token","reserved_quantity":100,"limit_quantity":10000,"period_type":"month","period_start":"2099-01-01T00:00:00Z","period_end":"2099-02-01T00:00:00Z"}]'::jsonb,
      '[]'::jsonb, NULL, 120
    );

    SELECT committed_quantity, backfilled INTO v_committed, v_backfilled
      FROM public.ai_gateway_quota_buckets
      WHERE subject_id = v_user_id AND metric_key = 'output_text_tokens' AND period_start = '2099-01-01T00:00:00Z';

    IF v_committed = 750 AND v_backfilled = true THEN
      RAISE NOTICE '7_backfill_on_first_touch: PASS (committed_quantity=% backfilled=%)', v_committed, v_backfilled;
    ELSE
      RAISE NOTICE '7_backfill_on_first_touch: FAIL — committed_quantity=% backfilled=% (esperado 750/true)', v_committed, v_backfilled;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '7_backfill_on_first_touch: FAIL — erro inesperado: %', SQLERRM;
  END;

  RAISE NOTICE 'Cenários 1/2/3/6/7 concluídos — releia as mensagens NOTICE acima (uma por cenário) antes do ROLLBACK abaixo.';
END;
$$;

ROLLBACK;

-- Confira acima, no painel de mensagens/NOTICE do seu cliente SQL (não em
-- uma grade de resultado — não existe tabela para consultar depois do
-- ROLLBACK, de propósito), uma linha PASS ou FAIL para cada um dos 5
-- cenários. Nenhuma linha foi persistida em nenhuma tabela.

-- ─────────────────────────────────────────────────────────────────────────────
-- SCENARIO 4: mandatory acceptance test — 600 session_seconds/month quota
-- ─────────────────────────────────────────────────────────────────────────────
-- Etapa 11's own required acceptance case. Proves quota is accumulated
-- (committed + reserved vs. limit), not just a per-call ceiling, and that
-- two concurrent calls near the remaining balance cannot both win.
--
-- Isolation: subject_id is your disposable test user (see SETUP) — the
-- bucket this creates is keyed to (that user, conversation.realtime_usage,
-- session_seconds, month, this exact period_start), so it can never be the
-- same row as a real user's real monthly bucket. period_start is also
-- deliberately set to a date far outside any real billing period
-- (year 2099) so it can never overlap even hypothetically.
--
-- Setup: a bucket already at committed=300, reserved=250 (out of a 600
-- limit — 50 remaining) is seeded directly (simulating prior real usage +
-- an existing in-flight reservation), then two concurrent 40-second
-- attempts race the remaining 50.
--
-- THIS IS A REAL TWO-TRANSACTION CONCURRENCY TEST, not two sequential calls
-- in one script — follow the PROOF OF CONCURRENCY protocol in SETUP item 4
-- above exactly:
--   Step 1: open Session A's connection, paste its statement below, do NOT run it yet.
--   Step 2: open Session B's connection (separate tab/process), paste its statement, do NOT run it yet.
--   Step 3: execute Session A.
--   Step 4: WITHOUT reading Session A's result, immediately execute Session B.
--   Step 5: only now read both results and confirm the timing overlap per SETUP item 4(e).
-- Do not mark this scenario passed if you ran B only after seeing A's output.

INSERT INTO public.ai_gateway_quota_buckets (
  subject_type, subject_id, feature_key, metric_key, period_type, period_start, period_end,
  committed_quantity, reserved_quantity
) VALUES (
  'user', (SELECT test_user_id FROM _mv_config), 'conversation.realtime_usage', 'session_seconds', 'month',
  '2099-01-01T00:00:00Z', '2099-02-01T00:00:00Z', 300, 250
);

-- SESSION A (Step 3 — paste in connection/tab #1, execute first):
SELECT * FROM public.reserve_gateway_usage_v1(
  'manual-validation-scenario4-a', (SELECT test_user_id FROM _mv_config), NULL,
  'conversation.realtime_usage', 'openai', 'preflight-validation-model',
  '[{"quota_key":"session_seconds","unit_type":"second","reserved_quantity":40,"limit_quantity":600,"period_type":"month","period_start":"2099-01-01T00:00:00Z","period_end":"2099-02-01T00:00:00Z"}]'::jsonb,
  '[]'::jsonb, NULL, 120
);

-- SESSION B (Step 4 — paste in connection/tab #2 BEFORE running Session A;
-- execute immediately after Session A, without waiting for or reading A's result):
SELECT * FROM public.reserve_gateway_usage_v1(
  'manual-validation-scenario4-b', (SELECT test_user_id FROM _mv_config), NULL,
  'conversation.realtime_usage', 'openai', 'preflight-validation-model',
  '[{"quota_key":"session_seconds","unit_type":"second","reserved_quantity":40,"limit_quantity":600,"period_type":"month","period_start":"2099-01-01T00:00:00Z","period_end":"2099-02-01T00:00:00Z"}]'::jsonb,
  '[]'::jsonb, NULL, 120
);

-- EXPECTED: exactly one of A/B has status='pending' (a real reservation_id);
-- the other has status='blocked', blocked_reason='QUOTA_EXCEEDED',
-- blocked_detail='session_seconds' — because 250 (already reserved) + 40
-- (the winner's new reservation) = 290, leaving only 10 of the original 50
-- remaining, and 40 > 10 for the loser. If both show status='pending', the
-- claim is FALSE and the row-lock ordering in reserve_gateway_usage_v1 must
-- be re-examined.

SELECT reserved_quantity, committed_quantity FROM public.ai_gateway_quota_buckets
  WHERE subject_id = (SELECT test_user_id FROM _mv_config) AND metric_key = 'session_seconds' AND period_start = '2099-01-01T00:00:00Z';
-- EXPECTED: reserved_quantity = 290 (250 + exactly one winning 40), never 330.

-- Finalize the winning reservation with real usage of 20 (less than the 40
-- reserved) — proves the 20-second difference is returned to the bucket.
-- Replace <winning_reservation_id> with the reservation_id A or B actually
-- returned with status='pending':
--
-- SELECT public.commit_gateway_reservation_v1(
--   '<winning_reservation_id>'::uuid, gen_random_uuid(), NULL,
--   '[{"quota_key":"session_seconds","actual_quantity":20}]'::jsonb
-- );
-- SELECT reserved_quantity, committed_quantity FROM public.ai_gateway_quota_buckets
--   WHERE subject_id = (SELECT test_user_id FROM _mv_config) AND metric_key = 'session_seconds' AND period_start = '2099-01-01T00:00:00Z';
-- EXPECTED: reserved_quantity back down to 250 (290 - 40 released), committed_quantity = 320 (300 + 20 real).

-- Cleanup:
DELETE FROM public.usage_reservation_items WHERE reservation_id IN (
  SELECT id FROM public.usage_reservations WHERE idempotency_key LIKE 'manual-validation-scenario4-%'
);
DELETE FROM public.usage_reservations WHERE idempotency_key LIKE 'manual-validation-scenario4-%';
DELETE FROM public.ai_gateway_quota_buckets
  WHERE subject_id = (SELECT test_user_id FROM _mv_config) AND period_start = '2099-01-01T00:00:00Z';

-- ─────────────────────────────────────────────────────────────────────────────
-- SCENARIO 5: budget last-dollar race — CLOSED by the Etapa 11 correction
-- ─────────────────────────────────────────────────────────────────────────────
-- The first version of this delivery admitted this as a known, unfixed gap
-- (budget check and reserve were two separate round trips). The correction
-- folds budget validation into the SAME atomic reserve_gateway_usage_v1
-- transaction as quota, under the same deterministic lock ordering — this
-- scenario proves it.
--
-- Isolation: scope_key uses a synthetic feature-scope marker
-- ('manual-validation-scenario5') for the BUDGET bucket (ai_gateway_
-- budget_buckets.scope_key has no foreign key — it is validated
-- structurally by reserve_gateway_usage_v1, not by a DB constraint), so
-- this never touches a real feature's real budget bucket. The
-- reservation's own feature_key is still a real one (FK requirement) but
-- carries no quota limit, so it never touches any quota bucket either.
--
-- Setup: a budget bucket already at committed=0.90, reserved=0.00 against a
-- $1.00 daily limit ($0.10 remaining). Two concurrent calls each estimate
-- $0.08 — individually within budget (0.90+0.08=0.98<=1.00) but not
-- together (0.90+0.08+0.08=1.06>1.00).
--
-- THIS IS A REAL TWO-TRANSACTION CONCURRENCY TEST — follow the PROOF OF
-- CONCURRENCY protocol in SETUP item 4 exactly, same as Scenario 4: paste
-- both statements first without running either, execute A, then
-- immediately execute B without reading A's result, then verify timing
-- overlap before trusting the outcome.

INSERT INTO public.ai_gateway_budget_buckets (scope_type, scope_key, period_type, period_start, period_end, committed_cost_usd, reserved_cost_usd)
VALUES ('feature', 'manual-validation-scenario5', 'day', '2099-01-01T00:00:00Z', '2099-01-02T00:00:00Z', 0.90, 0.00);

-- SESSION A (execute first, in connection/tab #1):
SELECT * FROM public.reserve_gateway_usage_v1(
  'manual-validation-scenario5-a', NULL, NULL, 'writing.correct', 'openai', 'preflight-validation-model',
  '[{"quota_key":"provider_requests","unit_type":"request","reserved_quantity":1,"limit_quantity":null,"period_type":null,"period_start":null,"period_end":null}]'::jsonb,
  '[{"scope_type":"feature","scope_key":"manual-validation-scenario5","period_type":"day","period_start":"2099-01-01T00:00:00Z","period_end":"2099-01-02T00:00:00Z","limit_usd":"1.00"}]'::jsonb,
  '0.08', 120
);

-- SESSION B (execute immediately after A, in connection/tab #2, WITHOUT
-- reading A's result first):
SELECT * FROM public.reserve_gateway_usage_v1(
  'manual-validation-scenario5-b', NULL, NULL, 'writing.correct', 'openai', 'preflight-validation-model',
  '[{"quota_key":"provider_requests","unit_type":"request","reserved_quantity":1,"limit_quantity":null,"period_type":null,"period_start":null,"period_end":null}]'::jsonb,
  '[{"scope_type":"feature","scope_key":"manual-validation-scenario5","period_type":"day","period_start":"2099-01-01T00:00:00Z","period_end":"2099-01-02T00:00:00Z","limit_usd":"1.00"}]'::jsonb,
  '0.08', 120
);

-- EXPECTED: exactly one of A/B has status='pending'; the other has
-- status='blocked', blocked_reason='BUDGET_EXCEEDED'. The budget can no
-- longer be oversubscribed by a concurrent pair — this scenario is expected
-- to PASS (unlike in the first delivery, where it was documented as a known
-- failure).

SELECT reserved_cost_usd FROM public.ai_gateway_budget_buckets WHERE scope_key = 'manual-validation-scenario5';
-- EXPECTED: 0.08 (only the winner's estimate), never 0.16.

-- Cleanup:
DELETE FROM public.usage_reservation_items WHERE reservation_id IN (
  SELECT id FROM public.usage_reservations WHERE idempotency_key LIKE 'manual-validation-scenario5-%'
);
DELETE FROM public.ai_gateway_reservation_budget_links WHERE reservation_id IN (
  SELECT id FROM public.usage_reservations WHERE idempotency_key LIKE 'manual-validation-scenario5-%'
);
DELETE FROM public.usage_reservations WHERE idempotency_key LIKE 'manual-validation-scenario5-%';
DELETE FROM public.ai_gateway_budget_buckets WHERE scope_key = 'manual-validation-scenario5' AND scope_type = 'feature';

-- ─────────────────────────────────────────────────────────────────────────────
-- FINAL CLEANUP (Cenários 4/5 apenas — 1/2/3/6/7 já se desfazem sozinhos
-- no ROLLBACK acima)
-- ─────────────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS pg_temp._mv_config;
-- If you created a disposable auth.users row solely for this file, delete
-- it now via Supabase Studio / `supabase auth admin delete-user` — this
-- script never deletes auth.users rows itself (too destructive to automate
-- blindly against a table it doesn't own).

-- ─────────────────────────────────────────────────────────────────────────────
-- RECORD THE VALIDATION — run this ONLY after you have personally observed
-- all seven scenarios' real results (per the PROOF OF CONCURRENCY protocol
-- for scenarios 4/5, and reading the NOTICE messages for 1/2/3/6/7) and
-- confirmed every EXPECTED outcome above actually happened. This INSERT is
-- what scripts/ai-gateway-enforce-preflight.ts reads to compute
-- concurrencyValidated — do not run it speculatively, and do not run it if
-- any scenario's real result diverged from EXPECTED (call
-- record_gateway_concurrency_validation_v1 with p_status='failed' and
-- explain in p_notes instead — a record of a real failure is still real
-- data, never delete/hide a bad result).
--
-- Step 1 — compute the CURRENT hash of this exact file (from your shell,
-- not from inside SQL — the file must be hashed as it exists on disk right
-- now, byte for byte):
--   macOS/Linux:  shasum -a 256 supabase/manual-validation/ai-gateway-enforcement-concurrency.sql
--   Windows:      Get-FileHash supabase\manual-validation\ai-gateway-enforcement-concurrency.sql -Algorithm SHA256
--   or simply run the preflight script itself — it prints this same hash:
--     npx tsx scripts/ai-gateway-enforce-preflight.ts | grep "validation script hash"
--
-- Step 2 — call the function with that exact hash (this function is
-- reachable only via direct service-role DB access — REVOKEd from
-- anon/authenticated — so no ordinary user or frontend code path can ever
-- call it):
--
-- SELECT public.record_gateway_concurrency_validation_v1(
--   '20260718020000_ai_gateway_enforcement_function_ambiguity_fix',      -- p_migration_version — must match api/_ai-gateway/enforce-readiness.ts's MIGRATION_VERSION constant (the LATEST Etapa 11 migration, not the original 20260718000000 one — see that constant's comment for why)
--   'supabase/manual-validation/ai-gateway-enforcement-concurrency.sql',  -- p_validation_script_path
--   '<paste the sha256 hex digest from Step 1 here>',                    -- p_validation_script_sha256
--   'passed',                                                            -- or 'failed' — never omit a bad result
--   '<your name/handle — technical audit identifier, not a user_id>',    -- p_executed_by
--   'Ran all 7 scenarios on <date> against Primary Database. Scenarios 1/2/3/6/7 via single DO+ROLLBACK. Scenarios 4/5 confirmed real overlapping execution via \timing.' -- p_notes
-- );
--
-- If this file is edited after recording a validation (even a single
-- character), the hash changes and the row above no longer matches —
-- concurrencyValidated automatically reverts to false for the new file
-- content, with no separate "invalidate" step required.

-- =============================================================================
-- SUMMARY — fill in after actually running the above against a real Postgres.
-- CONCURRENCY IS NOT VALIDATED. Every line below must stay "NOT EXECUTED"
-- until a human (or CI with a real disposable database) actually runs this
-- file and records the real result — do not edit this section to claim a
-- pass without having run it.
-- =============================================================================
-- Scenario 1 (rate limit atomic):                    NOT EXECUTED.
-- Scenario 2 (dedupe atomic + reclaim):               NOT EXECUTED.
-- Scenario 3 (reservation idempotency):               NOT EXECUTED.
-- Scenario 4 (600 session_seconds/month acceptance):  NOT EXECUTED.
-- Scenario 5 (budget last-dollar race — now atomic):  NOT EXECUTED.
-- Scenario 6 (breaker probe exclusivity):             NOT EXECUTED.
-- Scenario 7 (backfill on first bucket touch):        NOT EXECUTED.
--
-- Execução real anterior (2026-07-18, Primary Database, modelo antigo
-- baseado em tabela temporária + COMMIT implícito, rollback proposital
-- manual do operador): 1 e 6 PASS; 2, 3 e 7 FAIL com "column reference ...
-- is ambiguous" — causa raiz corrigida por
-- 20260718020000_ai_gateway_enforcement_function_ambiguity_fix.sql. Os
-- sete cenários precisam ser re-executados do zero com essa migration
-- aplicada antes que qualquer linha acima possa virar PASS de verdade.
--
-- All seven scenarios' SQL was written and reasoned through against the
-- exact function bodies in 20260718000000_ai_gateway_enforcement.sql
-- (single-statement INSERT ... ON CONFLICT / unique-index-plus-exception /
-- SELECT ... FOR UPDATE row-lock patterns — each a well-established
-- Postgres atomicity idiom, and scenarios 4/5 specifically exercise the
-- deterministic lock ordering — metrics sorted by quota_key, budget scopes
-- sorted by a fixed scope_type precedence — that prevents two concurrent
-- transactions from deadlocking each other while both hold multiple row
-- locks), but "reasoned through" is not the same as "proven by execution."
-- No feature may be classified enforce_ready, and enforce must not be
-- activated for any feature, until this file has actually been run against
-- a real Postgres and every scenario above is updated from "NOT EXECUTED"
-- to a real PASS/FAIL with the actual output attached.
-- =============================================================================
