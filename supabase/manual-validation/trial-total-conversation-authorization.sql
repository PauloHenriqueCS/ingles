-- =============================================================================
-- MANUAL VALIDATION (NÃO EXECUTADO NESTA TAREFA): Etapa 2A — limite total de
-- Conversação no Trial. Roteiro transacional para lemon-homolog
-- (ahszqexfzpbirdlkmdci), cobrindo os 10 itens pedidos na revisão final:
--   1. publicação do draft do trial
--   2. criação de usuário e assignment de teste descartáveis
--   3. autorização com 900s disponíveis
--   4. consumo parcial
--   5. saldo esgotado
--   6. duas autorizações concorrentes
--   7. repetição da mesma idempotency key
--   8. tentativa com outro usuário
--   9. trial expirado
--   10. cleanup de todos os dados descartáveis
--
-- WHY THIS FILE EXISTS: os testes automatizados (api/__tests__/
-- authorize-trial-conversation-session.test.ts, supabase/migrations/
-- __tests__/authorize-trial-conversation-session.test.ts) mockam o Supabase
-- client ou fazem apenas análise estática de texto SQL — nenhum dos dois
-- prova pg_advisory_xact_lock, FKs reais ou concorrência real de duas
-- conexões contra um Postgres de verdade. Este arquivo prova isso.
--
-- Mesma postura de segurança do precedente desta pasta
-- (ai-gateway-enforcement-concurrency.sql): nenhum projeto de staging
-- separado além de lemon-homolog neste momento — a segurança vem do desenho
-- do script (marcadores sintéticos exclusivos, usuário descartável, tudo
-- dentro de transações com ROLLBACK quando possível, cleanup explícito no
-- final quando não é possível usar ROLLBACK).
--
-- PRÉ-REQUISITOS OBRIGATÓRIOS (nesta ordem, nenhum aplicado nesta tarefa):
--   1. supabase/migrations/20260727224000_conversation_trial_total_capability_definitions.sql
--   2. supabase/migrations/20260727224100_publish_plan_version_trial_total_capability.sql
--   3. supabase/migrations/20260727224200_authorize_trial_conversation_session.sql
--   4. o draft do trial já existente em lemon-homolog (criado por
--      20260727223126_trial_plan_and_capability_reconciliation, do
--      ingles-dashboad) precisa estar PUBLICADO — ver item 1 abaixo.
--
-- Não usa nenhum usuário real do aplicativo. Todo identificador é
-- sintético e criado por este próprio script.
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- ITEM 1 — Publicar o draft do trial (pré-requisito de todo o resto)
-- ─────────────────────────────────────────────────────────────────────────────
-- Rodar via RPC, com um admin real autenticado (mesmo fluxo que a tela
-- "Teste gratuito" do dashboard usaria) — NUNCA um UPDATE direto em
-- plan_versions.status. Substitua os UUIDs pelos reais do seu ambiente
-- (plan_id do plano 'trial', a versão draft, o admin autenticado, e o
-- config_hash calculado pelo dashboard — ver computeConfigHash).
--
--   SELECT public.publish_plan_version(
--     p_plan_id           := (SELECT id FROM public.plans WHERE code = 'trial'),
--     p_draft_version_id  := (SELECT id FROM public.plan_versions pv
--                              JOIN public.plans p ON p.id = pv.plan_id
--                              WHERE p.code = 'trial' AND pv.status = 'draft'),
--     p_client_revision   := (SELECT revision FROM public.plan_versions pv
--                              JOIN public.plans p ON p.id = pv.plan_id
--                              WHERE p.code = 'trial' AND pv.status = 'draft'),
--     p_publication_notes := 'Validação manual Etapa 2A',
--     p_change_summary    := 'Publica limite lifetime de Conversação do trial',
--     p_config_hash       := '<hash real calculado pelo dashboard>',
--     p_actor_user_id     := '<uuid de um admin_users ativo com role owner/admin>',
--     p_activate_plan     := true
--   );
--
-- Verificar success=true na resposta antes de prosseguir. Se success=false
-- com missing_capabilities, o draft ainda está incompleto — não é problema
-- deste roteiro, é problema de configuração no dashboard.


-- ─────────────────────────────────────────────────────────────────────────────
-- ITEM 2 — Usuário e assignment de teste descartáveis
-- ─────────────────────────────────────────────────────────────────────────────
-- auth.users exige uma linha real (FK de user_plan_assignments.user_id e de
-- conversation_session_authorizations.user_id). Crie via Supabase Studio
-- (Authentication → Add user) ou `supabase auth admin create-user`, nunca
-- via INSERT direto em auth.users. Anote o UUID gerado.

DROP TABLE IF EXISTS pg_temp._mv_trial_config;
CREATE TEMP TABLE _mv_trial_config (
  test_user_id       UUID,
  other_user_id      UUID, -- item 8 — um SEGUNDO usuário descartável, diferente do primeiro
  trial_plan_id      UUID,
  assignment_id      UUID,
  expired_assignment_id UUID
);
INSERT INTO _mv_trial_config (test_user_id, other_user_id) VALUES
  ('00000000-0000-0000-0000-000000000000', -- ← REPLACE com o UUID real do 1º usuário descartável
   '00000000-0000-0000-0000-000000000001'  -- ← REPLACE com o UUID real do 2º usuário descartável
  );

DO $$
DECLARE
  v_trial_plan_id UUID;
  v_test_user     UUID;
  v_assignment_id UUID;
BEGIN
  SELECT test_user_id INTO v_test_user FROM pg_temp._mv_trial_config;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_test_user) THEN
    RAISE EXCEPTION 'test_user_id % não existe em auth.users — crie o usuário descartável primeiro (ver comentário acima)', v_test_user;
  END IF;

  SELECT id INTO v_trial_plan_id FROM public.plans WHERE code = 'trial';
  IF v_trial_plan_id IS NULL THEN
    RAISE EXCEPTION 'plano trial não encontrado — ITEM 1 (publicação) precisa rodar primeiro';
  END IF;
  UPDATE pg_temp._mv_trial_config SET trial_plan_id = v_trial_plan_id;

  -- Atribuição de teste: starts_at agora, ends_at em 7 dias (mesma duração
  -- do plan_trial_policies.duration_days default) — origin='trial' aqui
  -- por clareza do roteiro, mas lembre-se (ver decisão documentada em
  -- plan-entitlements-service.ts): origin NÃO é o que importa para a
  -- semântica lifetime, só plans.code o é. Um segundo teste com
  -- origin='manual' produziria exatamente o mesmo resultado nos itens 3-9.
  INSERT INTO public.user_plan_assignments (
    user_id, plan_id, version_policy, origin, starts_at, ends_at, status, created_by, reason
  ) VALUES (
    v_test_user, v_trial_plan_id, 'follow_current_published', 'trial',
    now(), now() + interval '7 days', 'active', v_test_user,
    'Validação manual Etapa 2A — descartável'
  )
  RETURNING id INTO v_assignment_id;

  UPDATE pg_temp._mv_trial_config SET assignment_id = v_assignment_id;
  RAISE NOTICE 'assignment de teste criado: %', v_assignment_id;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- ITEM 3 — Autorização com 900s disponíveis (0 consumido)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_user UUID; v_result RECORD;
BEGIN
  SELECT test_user_id INTO v_user FROM pg_temp._mv_trial_config;

  SELECT * INTO v_result FROM public.authorize_trial_conversation_session_v1(
    v_user, 900, current_date, NULL, NULL, 'mv-item3-' || gen_random_uuid()::text
  );

  IF v_result.blocked OR v_result.authorized_max_seconds <> 900 THEN
    RAISE EXCEPTION 'FAIL item 3: esperado authorized_max_seconds=900/blocked=false, obtido authorized_max_seconds=%, blocked=%, reason=%',
      v_result.authorized_max_seconds, v_result.blocked, v_result.blocked_reason;
  END IF;
  RAISE NOTICE 'PASS item 3: authorization_id=%, authorized_max_seconds=%', v_result.authorization_id, v_result.authorized_max_seconds;

  -- Fecha esta autorização como 'completed' com 300s reais consumidos, para
  -- servir de base ao item 4 (consumo parcial).
  UPDATE public.conversation_session_authorizations
  SET status = 'completed', completed_at = now(), duration_seconds = 300
  WHERE id = v_result.authorization_id;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- ITEM 4 — Consumo parcial: 300 já consumidos → uma nova sessão não recebe
-- mais que 600
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_user UUID; v_result RECORD;
BEGIN
  SELECT test_user_id INTO v_user FROM pg_temp._mv_trial_config;

  -- Pede 700 — só deve receber 600 (900 - 300 já fechados no item 3).
  SELECT * INTO v_result FROM public.authorize_trial_conversation_session_v1(
    v_user, 700, current_date, NULL, NULL, 'mv-item4-' || gen_random_uuid()::text
  );

  IF v_result.blocked OR v_result.authorized_max_seconds <> 600 THEN
    RAISE EXCEPTION 'FAIL item 4: esperado authorized_max_seconds=600, obtido %, blocked=%', v_result.authorized_max_seconds, v_result.blocked;
  END IF;
  RAISE NOTICE 'PASS item 4: capped at % (esperado 600)', v_result.authorized_max_seconds;

  -- Fecha com o restante consumido (600s) para deixar o saldo em 0 para o item 5.
  UPDATE public.conversation_session_authorizations
  SET status = 'completed', completed_at = now(), duration_seconds = 600
  WHERE id = v_result.authorization_id;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- ITEM 5 — Saldo esgotado (900 já consumidos ao todo) → blocked=true,
-- reason='balance_exhausted', nenhuma linha inserida
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_user UUID; v_result RECORD; v_rows_before INT; v_rows_after INT;
BEGIN
  SELECT test_user_id INTO v_user FROM pg_temp._mv_trial_config;
  SELECT count(*) INTO v_rows_before FROM public.conversation_session_authorizations WHERE user_id = v_user;

  SELECT * INTO v_result FROM public.authorize_trial_conversation_session_v1(
    v_user, 30, current_date, NULL, NULL, 'mv-item5-' || gen_random_uuid()::text
  );

  SELECT count(*) INTO v_rows_after FROM public.conversation_session_authorizations WHERE user_id = v_user;

  IF NOT v_result.blocked OR v_result.blocked_reason IS DISTINCT FROM 'balance_exhausted' OR v_result.authorization_id IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL item 5: esperado blocked=true/reason=balance_exhausted/authorization_id=NULL, obtido blocked=%, reason=%, authorization_id=%',
      v_result.blocked, v_result.blocked_reason, v_result.authorization_id;
  END IF;
  IF v_rows_after <> v_rows_before THEN
    RAISE EXCEPTION 'FAIL item 5: uma linha foi inserida mesmo com blocked=true (% antes, % depois)', v_rows_before, v_rows_after;
  END IF;
  RAISE NOTICE 'PASS item 5: blocked=true, reason=balance_exhausted, nenhuma linha inserida';
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- ITEM 6 — Duas autorizações concorrentes (saldo esgotado do item 5 impede
-- observar isto sobre o MESMO assignment — crie um segundo assignment
-- descartável primeiro, com saldo fresco de 900s)
-- ─────────────────────────────────────────────────────────────────────────────
-- 6a. Encerre o assignment usado nos itens 3-5 e crie um NOVO, com saldo
-- fresco (900s), para isolar o teste de concorrência:
DO $$
DECLARE v_user UUID; v_plan UUID; v_new_assignment UUID;
BEGIN
  SELECT test_user_id, trial_plan_id INTO v_user, v_plan FROM pg_temp._mv_trial_config;
  UPDATE public.user_plan_assignments SET status = 'replaced', cancelled_at = now(), cancel_reason = 'mv item 6 setup'
  WHERE id = (SELECT assignment_id FROM pg_temp._mv_trial_config);

  INSERT INTO public.user_plan_assignments (user_id, plan_id, version_policy, origin, starts_at, ends_at, status, created_by, reason)
  VALUES (v_user, v_plan, 'follow_current_published', 'trial', now(), now() + interval '7 days', 'active', v_user, 'mv item 6 — concorrência')
  RETURNING id INTO v_new_assignment;

  UPDATE pg_temp._mv_trial_config SET assignment_id = v_new_assignment;
  RAISE NOTICE 'novo assignment (saldo fresco) para o teste de concorrência: %', v_new_assignment;
END $$;

-- 6b. SESSION A — cole e rode em uma aba/conexão. Segura o advisory lock por
-- 20s (a transação envolvente só faz COMMIT depois do pg_sleep), para dar
-- tempo da Sessão B (6c) tentar durante a posse do lock:
--
--   BEGIN;
--   SELECT * FROM public.authorize_trial_conversation_session_v1(
--     '<test_user_id>', 600, current_date, NULL, NULL, 'mv-item6-session-a'
--   ); -- esperado: blocked=false, authorized_max_seconds=600
--   SELECT pg_sleep(20);
--   COMMIT;
--
-- 6c. SESSION B — em uma SEGUNDA aba/conexão, rode isto ENQUANTO a Sessão A
-- ainda está no pg_sleep (nos primeiros ~20s depois de rodar 6b):
--
--   SELECT clock_timestamp() AS started_waiting;
--   SELECT * FROM public.authorize_trial_conversation_session_v1(
--     '<test_user_id>', 600, current_date, NULL, NULL, 'mv-item6-session-b'
--   ); -- esperado: BLOQUEIA ~20s (esperando o lock), depois retorna
--      -- authorized_max_seconds=300 (900 - 600 já autorizados pela Sessão A),
--      -- nunca 600 — prova que o recálculo de consumo só acontece DEPOIS
--      -- que a Sessão A commitou.
--   SELECT clock_timestamp() AS finished_waiting;
--
-- 6d. Verificação final (qualquer conexão, depois que A e B terminaram):
--
--   SELECT sum(authorized_max_seconds) FROM public.conversation_session_authorizations
--   WHERE user_id = '<test_user_id>' AND authorized_at >= now() - interval '5 minutes';
--   -- esperado: exatamente 900 (600 + 300), nunca 1200 (600 + 600).


-- ─────────────────────────────────────────────────────────────────────────────
-- ITEM 7 — Repetição da mesma idempotency key → mesma autorização, sem
-- reservar saldo duas vezes
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_user UUID; v_first RECORD; v_second RECORD; v_count INT;
  v_key TEXT := 'mv-item7-' || gen_random_uuid()::text;
BEGIN
  SELECT test_user_id INTO v_user FROM pg_temp._mv_trial_config;

  SELECT * INTO v_first FROM public.authorize_trial_conversation_session_v1(
    v_user, 45, current_date, NULL, NULL, v_key
  );
  SELECT * INTO v_second FROM public.authorize_trial_conversation_session_v1(
    v_user, 45, current_date, NULL, NULL, v_key -- MESMA chave
  );

  IF v_first.authorization_id IS DISTINCT FROM v_second.authorization_id THEN
    RAISE EXCEPTION 'FAIL item 7: chamadas com a mesma idempotency_key retornaram authorization_id diferentes (% vs %)',
      v_first.authorization_id, v_second.authorization_id;
  END IF;

  SELECT count(*) INTO v_count FROM public.conversation_session_authorizations WHERE idempotency_key = v_key;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL item 7: esperado exatamente 1 linha para a chave, encontrado %', v_count;
  END IF;
  RAISE NOTICE 'PASS item 7: mesma authorization_id (%) em ambas as chamadas, 1 única linha', v_first.authorization_id;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- ITEM 8 — Tentativa com outro usuário (sem assignment de trial) → rejeitada
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE v_other UUID; v_result RECORD;
BEGIN
  SELECT other_user_id INTO v_other FROM pg_temp._mv_trial_config;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_other) THEN
    RAISE EXCEPTION 'other_user_id % não existe em auth.users — crie o 2º usuário descartável primeiro', v_other;
  END IF;
  -- Nenhum assignment de trial para este usuário — deve resolver para o
  -- plano padrão (ou nenhum plano) e ser rejeitado como no_active_trial.

  SELECT * INTO v_result FROM public.authorize_trial_conversation_session_v1(
    v_other, 30, current_date, NULL, NULL, 'mv-item8-' || gen_random_uuid()::text
  );

  IF NOT v_result.blocked OR v_result.blocked_reason IS DISTINCT FROM 'no_active_trial' THEN
    RAISE EXCEPTION 'FAIL item 8: esperado blocked=true/reason=no_active_trial, obtido blocked=%, reason=%', v_result.blocked, v_result.blocked_reason;
  END IF;
  RAISE NOTICE 'PASS item 8: usuário sem atribuição de trial rejeitado (no_active_trial)';
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- ITEM 9 — Trial expirado (ends_at no passado) → rejeitado
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE v_user UUID; v_plan UUID; v_expired_id UUID; v_result RECORD;
BEGIN
  SELECT test_user_id, trial_plan_id INTO v_user, v_plan FROM pg_temp._mv_trial_config;

  -- Encerra qualquer assignment ativo deste usuário antes de criar o expirado
  -- (evita overlap/ambiguidade de qual assignment é "o efetivo").
  UPDATE public.user_plan_assignments SET status = 'replaced', cancelled_at = now(), cancel_reason = 'mv item 9 setup'
  WHERE user_id = v_user AND status IN ('active', 'scheduled');

  INSERT INTO public.user_plan_assignments (user_id, plan_id, version_policy, origin, starts_at, ends_at, status, created_by, reason)
  VALUES (v_user, v_plan, 'follow_current_published', 'trial',
          now() - interval '10 days', now() - interval '3 days', -- já encerrado
          'expired', v_user, 'mv item 9 — trial expirado')
  RETURNING id INTO v_expired_id;
  UPDATE pg_temp._mv_trial_config SET expired_assignment_id = v_expired_id;

  SELECT * INTO v_result FROM public.authorize_trial_conversation_session_v1(
    v_user, 30, current_date, NULL, NULL, 'mv-item9-' || gen_random_uuid()::text
  );

  IF NOT v_result.blocked OR v_result.blocked_reason IS DISTINCT FROM 'no_active_trial' THEN
    RAISE EXCEPTION 'FAIL item 9: esperado blocked=true/reason=no_active_trial para trial expirado, obtido blocked=%, reason=%', v_result.blocked, v_result.blocked_reason;
  END IF;
  RAISE NOTICE 'PASS item 9: trial expirado rejeitado (no_active_trial)';
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- ITEM 10 — Cleanup de todos os dados descartáveis
-- ─────────────────────────────────────────────────────────────────────────────
-- Roda por último, depois de confirmar todos os PASS acima (incluindo o
-- item 6, que exigiu duas conexões manuais). Nunca apaga capability_definitions,
-- plan_versions, ou qualquer coisa criada pelo item 1 (a publicação em si é
-- o objetivo real da tarefa, não descartável) — só os dados sintéticos dos
-- itens 2-9.
DO $$
DECLARE v_user UUID; v_other UUID;
BEGIN
  SELECT test_user_id, other_user_id INTO v_user, v_other FROM pg_temp._mv_trial_config;

  DELETE FROM public.conversation_sessions WHERE user_id IN (v_user, v_other);
  DELETE FROM public.conversation_session_authorizations WHERE user_id IN (v_user, v_other);
  DELETE FROM public.user_plan_assignments WHERE user_id IN (v_user, v_other);

  RAISE NOTICE 'cleanup completo para test_user_id=% e other_user_id=%', v_user, v_other;
  RAISE NOTICE 'Os dois usuários em auth.users NÃO foram removidos por este script — delete-os manualmente (Supabase Studio → Authentication) se forem exclusivos desta validação.';
END $$;

DROP TABLE IF EXISTS pg_temp._mv_trial_config;

-- =============================================================================
-- SUMMARY — preencher depois de rodar contra lemon-homolog real:
--   Item 1 (publicação):            [ ] PASS  [ ] FAIL  —
--   Item 2 (setup usuário/assignment): [ ] PASS  [ ] FAIL  —
--   Item 3 (900 disponíveis):       [ ] PASS  [ ] FAIL  —
--   Item 4 (consumo parcial):       [ ] PASS  [ ] FAIL  —
--   Item 5 (saldo esgotado):        [ ] PASS  [ ] FAIL  —
--   Item 6 (concorrência real):     [ ] PASS  [ ] FAIL  — soma observada: ____
--   Item 7 (idempotência):          [ ] PASS  [ ] FAIL  —
--   Item 8 (outro usuário):         [ ] PASS  [ ] FAIL  —
--   Item 9 (trial expirado):        [ ] PASS  [ ] FAIL  —
--   Item 10 (cleanup):              [ ] PASS  [ ] FAIL  —
-- =============================================================================
