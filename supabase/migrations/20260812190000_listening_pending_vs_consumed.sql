-- =============================================================================
-- MIGRATION: 20260812190000_listening_pending_vs_consumed
-- Projeto: Orodim
--
-- Aplicada automaticamente por .github/workflows/deploy-production.yml
-- (supabase db push) após o merge na main, e por homologation.yml em develop.
-- Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO: separar HISTÓRIA PREPARADA (pending) de HISTÓRIA PRATICADA
-- (consumida) no fluxo de listening compartilhado. Hoje o contador de cota
-- conta TODA linha de user_listening_shared_progress (criada só por abrir/
-- preparar) → preparar = consumir, e sair/voltar troca de história. Regra final:
--   PREPARAR/ABRIR/GERAR/BUSCAR CACHE ≠ consumir; PRATICAR = consumir 1.
--
-- MODELO (reusa a coluna `completed`, que hoje NUNCA é escrita — todas as linhas
-- em prod são completed=false):
--   completed=false  → PENDENTE (preparada, não praticada).
--   completed=true   → PRATICADA/CONSUMIDA (o único estado que conta cota).
-- O contador (plan-entitlements-service) passa a contar só completed=true.
--
-- Esta migration:
--   1) denormaliza `activity_date` (dia SP da história) na linha de progresso,
--      para poder impor "uma pendente por usuário/dia" com índice único parcial
--      (a tabela não tinha coluna de dia local — o dia vinha só do JOIN à
--      shared story). NULLABLE de propósito: o `db push` roda ANTES do deploy do
--      código; NOT NULL quebraria o attachUserProgress antigo na janela entre os
--      dois. O código novo sempre preenche activity_date; linhas antigas são
--      backfilladas abaixo.
--   2) cria a RPC consume_listening_pending_story: transição atômica
--      pending → consumida, com re-checagem do limite do plano (passado como
--      parâmetro pelo handler — nenhum número comercial embutido em SQL) e
--      idempotência (praticar duas vezes consome uma só).
--
-- NÃO faz backfill de consumo: todas as linhas históricas continuam
-- completed=false (pendentes), então NINGUÉM é penalizado retroativamente por
-- ter apenas aberto histórias no passado.
--
-- Preserva o multi-slot recente, o advisory lock, o reuso cross-user, a
-- deduplicação (user, shared_story) e o timezone SP. Não altera a RPC
-- acquire_or_get_listening_shared_story (a recuperação de pendente é feita na
-- camada de serviço, antes da seleção). Preserva RLS/grants/SECURITY DEFINER.
-- =============================================================================

-- 1. Coluna de dia SP denormalizada (nullable — ver cabeçalho).
ALTER TABLE public.user_listening_shared_progress
  ADD COLUMN IF NOT EXISTS activity_date date;

-- 2. Backfill: dia da história associada (practice_date já é dia SP).
UPDATE public.user_listening_shared_progress p
   SET activity_date = s.practice_date
  FROM public.listening_shared_stories s
 WHERE s.id = p.shared_story_id
   AND p.activity_date IS NULL;

-- 3. "Uma história PENDENTE por usuário por dia". Só linhas completed=false
--    participam; as praticadas (completed=true) podem coexistir várias/dia.
--    Verificado antes desta migration: nenhum usuário tem >1 pendente/dia hoje,
--    então a criação do índice não colide. NULLs de activity_date (janela de
--    deploy) são distintos num índice único → não conflitam.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ulsp_one_pending_per_day
  ON public.user_listening_shared_progress (user_id, activity_date)
  WHERE completed = false;

-- Índice de apoio para o lookup de pendente por (user, dia).
CREATE INDEX IF NOT EXISTS idx_ulsp_user_activity_completed
  ON public.user_listening_shared_progress (user_id, activity_date, completed);

-- =============================================================================
-- consume_listening_pending_story — transição atômica pending → consumida.
-- Chamada pelo backend no PRIMEIRO evento inequívoco de prática ("Começar a
-- ouvir"). O limite efetivo vem do plano/capability, resolvido pelo entitlements
-- service e passado como parâmetro (nunca hardcoded em SQL). Idempotente e
-- concurrency-safe (SELECT ... FOR UPDATE na linha do usuário+história).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.consume_listening_pending_story(
  p_shared_story_id uuid,
  p_practice_date   date,
  p_effective_limit integer,
  p_unlimited       boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id   UUID;
  v_completed BOOLEAN;
  v_consumed  INTEGER;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  -- Trava a linha de progresso deste usuário para esta história. Serializa
  -- práticas concorrentes da MESMA história (só uma consome; as demais viram
  -- idempotentes).
  SELECT completed
  INTO   v_completed
  FROM   user_listening_shared_progress
  WHERE  user_id = v_user_id AND shared_story_id = p_shared_story_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- O usuário nunca preparou esta história (sem linha pendente). Nunca cria
    -- consumo do nada.
    RETURN jsonb_build_object('error', 'NOT_PREPARED');
  END IF;

  -- Consumidas hoje (SP): só completed=true contam.
  SELECT count(*) INTO v_consumed
  FROM   user_listening_shared_progress
  WHERE  user_id = v_user_id AND activity_date = p_practice_date AND completed = true;

  IF v_completed THEN
    -- Já praticada: idempotente (reabrir/retry não duplica).
    RETURN jsonb_build_object('action', 'already_consumed', 'consumed', v_consumed);
  END IF;

  -- Re-checagem atômica do limite no momento do consumo (não confia só na
  -- checagem feita ao preparar). Sob a trava de linha acima, duas práticas
  -- concorrentes não ultrapassam N.
  IF NOT COALESCE(p_unlimited, false) AND v_consumed >= COALESCE(p_effective_limit, 0) THEN
    RETURN jsonb_build_object('error', 'DAILY_LIMIT_REACHED', 'consumed', v_consumed);
  END IF;

  UPDATE user_listening_shared_progress
     SET completed    = true,
         completed_at = now(),
         updated_at   = now()
   WHERE user_id = v_user_id AND shared_story_id = p_shared_story_id AND completed = false;

  RETURN jsonb_build_object('action', 'consumed', 'consumed', v_consumed + 1);
END;
$$;

REVOKE ALL ON FUNCTION public.consume_listening_pending_story(uuid, date, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_listening_pending_story(uuid, date, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.consume_listening_pending_story(uuid, date, integer, boolean) TO service_role;

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
