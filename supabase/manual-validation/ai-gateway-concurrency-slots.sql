-- =============================================================================
-- MANUAL VALIDATION: AI Gateway concurrency slots
-- (migration 20260814120000_ai_gateway_concurrency_slots.sql)
--
-- WHY THIS FILE EXISTS: the unit tests in
-- api/__tests__/concurrency-limiter.test.ts and the enforce-pipeline wiring
-- tests in api/__tests__/enforcement.test.ts mock the RPC, so they cannot
-- prove the REAL cross-instance atomic guarantee (advisory lock + count-then-
-- insert in acquire_gateway_concurrency_slot_v1). This file proves it against
-- a real Postgres — run it in HOMOLOG first, never seed prod from here.
--
-- PRÉ-REQUISITO: a migration 20260814120000 aplicada (via `supabase db push`,
-- NUNCA manualmente). Cenários 1–5 rodam num único bloco com ROLLBACK
-- proposital (não deixam resíduo). Cenário 6 (corrida real) exige duas
-- sessões — instruções ao final.
--
-- Chave de teste: scope_key 'test:concurrency:<uuid>' para não colidir com
-- tráfego real. max=2, lease curto.
-- =============================================================================

DO $$
DECLARE
  v_user_a UUID := '00000000-0000-0000-0000-0000000000aa';
  v_user_b UUID := '00000000-0000-0000-0000-0000000000bb';
  v_scope_a TEXT := 'test:conc:u:aa|global';
  v_scope_b TEXT := 'test:conc:u:bb|global';
  r RECORD;
  v_slot1 UUID; v_slot2 UUID;
  v_pass BOOLEAN := true;
BEGIN
  -- ── Cenário 1: adquire até o teto (max=2), 3ª é negada ──────────────────
  SELECT * INTO r FROM public.acquire_gateway_concurrency_slot_v1(v_scope_a, v_user_a, 'writing.correct', 'openai', 2, 60);
  IF NOT r.acquired OR r.active_count <> 1 THEN v_pass := false; RAISE WARNING 'C1a FAIL: %', r; END IF;
  v_slot1 := r.slot_id;

  SELECT * INTO r FROM public.acquire_gateway_concurrency_slot_v1(v_scope_a, v_user_a, 'writing.correct', 'openai', 2, 60);
  IF NOT r.acquired OR r.active_count <> 2 THEN v_pass := false; RAISE WARNING 'C1b FAIL: %', r; END IF;
  v_slot2 := r.slot_id;

  SELECT * INTO r FROM public.acquire_gateway_concurrency_slot_v1(v_scope_a, v_user_a, 'writing.correct', 'openai', 2, 60);
  IF r.acquired OR r.slot_id IS NOT NULL OR r.active_count <> 2 THEN v_pass := false; RAISE WARNING 'C1c FAIL (3rd should be denied): %', r; END IF;

  -- ── Cenário 2: liberar um slot libera capacidade ────────────────────────
  PERFORM public.release_gateway_concurrency_slot_v1(v_slot1, 'test_release');
  SELECT * INTO r FROM public.acquire_gateway_concurrency_slot_v1(v_scope_a, v_user_a, 'writing.correct', 'openai', 2, 60);
  IF NOT r.acquired OR r.active_count <> 2 THEN v_pass := false; RAISE WARNING 'C2 FAIL (should re-acquire after release): %', r; END IF;

  -- ── Cenário 3: isolamento por usuário (escopo distinto) ─────────────────
  -- user_a está no teto; user_b (outro scope_key) tem seu próprio balde.
  SELECT * INTO r FROM public.acquire_gateway_concurrency_slot_v1(v_scope_b, v_user_b, 'writing.correct', 'openai', 2, 60);
  IF NOT r.acquired OR r.active_count <> 1 THEN v_pass := false; RAISE WARNING 'C3 FAIL (user B must not see user A slots): %', r; END IF;

  -- ── Cenário 4: dimensão por feature é independente da global ────────────
  SELECT * INTO r FROM public.acquire_gateway_concurrency_slot_v1('test:conc:u:aa|feature:tts.synthesize', v_user_a, 'tts.synthesize', 'azure', 2, 60);
  IF NOT r.acquired OR r.active_count <> 1 THEN v_pass := false; RAISE WARNING 'C4 FAIL (feature dimension independent): %', r; END IF;

  -- ── Cenário 5: recuperação por lease vencido ────────────────────────────
  -- Força um slot 'active' com expires_at no passado e confirma que o próximo
  -- acquire o expira preguiçosamente e reaproveita a vaga.
  UPDATE public.ai_gateway_concurrency_slots
    SET expires_at = NOW() - INTERVAL '1 minute'
    WHERE scope_key = v_scope_a AND status = 'active';
  SELECT * INTO r FROM public.acquire_gateway_concurrency_slot_v1(v_scope_a, v_user_a, 'writing.correct', 'openai', 2, 60);
  IF NOT r.acquired OR r.active_count <> 1 THEN v_pass := false; RAISE WARNING 'C5 FAIL (expired lease must be reclaimed): %', r; END IF;

  IF v_pass THEN RAISE NOTICE 'PASS: concurrency scenarios 1-5';
  ELSE RAISE EXCEPTION 'FAIL: one or more concurrency scenarios failed (see warnings above)';
  END IF;

  ROLLBACK;  -- proposital: não deixa resíduo de teste
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CENÁRIO 6 (corrida real — duas sessões): prova que o advisory lock impede
-- ultrapassar o teto sob concorrência verdadeira. NÃO roda no bloco acima.
--
--   SETUP: max=1, scope 'test:conc:race'. Deixe UMA vaga.
--
--   Sessão 1:
--     BEGIN;
--     SELECT * FROM acquire_gateway_concurrency_slot_v1('test:conc:race',
--       '00000000-0000-0000-0000-0000000000cc', 'writing.correct', 'openai', 1, 60);
--     -- NÃO commite ainda: o pg_advisory_xact_lock fica retido, segurando o escopo.
--
--   Sessão 2 (em paralelo, enquanto a Sessão 1 está aberta):
--     SELECT * FROM acquire_gateway_concurrency_slot_v1('test:conc:race',
--       '00000000-0000-0000-0000-0000000000cc', 'writing.correct', 'openai', 1, 60);
--     -- Deve BLOQUEAR esperando a trava. Ao a Sessão 1 dar COMMIT, a Sessão 2
--     -- prossegue e retorna acquired=false (o teto de 1 já está ocupado).
--
--   RESULTADO ESPERADO: exatamente 1 acquired=true no total; a corrida nunca
--   produz 2 slots ativos. Depois: DELETE FROM ai_gateway_concurrency_slots
--   WHERE scope_key='test:conc:race';
-- =============================================================================
