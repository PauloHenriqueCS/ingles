-- =============================================================================
-- MIGRATION: 20260818130000_listening_assignment_idempotent_completion
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml.
-- Não aplicar manualmente no SQL Editor.
--
-- BUG: ao concluir um Listening, o app mostrava "Atividade concluída!" e logo
-- abaixo "Não foi possível registrar no calendário. Tentar novamente".
--
-- CAUSA RAIZ: o registro do calendário é a linha em user_listening_assignments
-- (episode_id IS NULL, status='completed') — é a VERDADE CANÔNICA que o
-- calendário lê (src/lib/activeDates.ts). O handler POST /api/listening/story/
-- complete gravava essa linha com um SELECT-depois-INSERT NÃO idempotente:
--   • o índice único (user_id, activity_date, episode_id) trata NULL como
--     DISTINTO, então episode_id IS NULL NUNCA conflita → retries/concorrência
--     podiam criar DUAS linhas de calendário para o mesmo dia; e um segundo
--     registro por reentrada não era barrado.
--   • Além disso a reconciliação curricular (lenta) rodava sempre antes de
--     responder, aumentando a latência e a chance de o cliente PERDER a resposta
--     — nesse caso o backend gravava o calendário (200) mas o cliente exibia o
--     falso "não foi possível registrar".
--
-- CORREÇÃO (substrato de idempotência):
--   1. Índice único PARCIAL (user_id, activity_date) WHERE episode_id IS NULL:
--      garante NO MÁXIMO um registro de calendário de história compartilhada por
--      usuário/dia.
--   2. RPC atômica complete_listening_shared_assignment: faz o upsert idempotente
--      (INSERT ... ON CONFLICT ... DO UPDATE) e informa se JÁ estava concluído,
--      para o handler pular a reconciliação curricular em retries (resposta rápida
--      e retry seguro). Segue o padrão de idempotência já usado no projeto
--      (create_pronunciation_training_text / consume_listening_pending_story).
--
-- Idempotente: dedup defensivo antes do índice; IF NOT EXISTS; CREATE OR REPLACE.
-- =============================================================================

-- 1) Dedup defensivo: mantém a MELHOR linha por (user, dia) para episode_id NULL
--    (concluída > mais recente), removendo apenas DUPLICATAS do mesmo dia (nunca
--    remove um dia de calendário — só colapsa duplicatas do mesmo dia). Hoje não
--    há duplicatas; isto apenas garante que o índice único possa ser criado mesmo
--    que uma corrida crie uma duplicata antes desta migration rodar.
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY user_id, activity_date
    ORDER BY (status = 'completed') DESC, completed_at DESC NULLS LAST, created_at DESC
  ) AS rn
  FROM public.user_listening_assignments
  WHERE episode_id IS NULL
)
DELETE FROM public.user_listening_assignments a
USING ranked r
WHERE a.id = r.id AND r.rn > 1;

-- 2) Índice único parcial — um registro de calendário de história por usuário/dia.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ula_user_date_shared
  ON public.user_listening_assignments (user_id, activity_date)
  WHERE episode_id IS NULL;

-- 3) RPC atômica idempotente para registrar a conclusão no calendário.
CREATE OR REPLACE FUNCTION public.complete_listening_shared_assignment(
  p_user_id uuid,
  p_activity_date date
)
RETURNS TABLE(already_completed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_was_completed boolean;
BEGIN
  -- Estado ANTES (para o chamador decidir pular a reconciliação curricular num
  -- retry). Com o índice parcial existe no máximo uma linha aqui.
  SELECT (status = 'completed') INTO v_was_completed
  FROM public.user_listening_assignments
  WHERE user_id = p_user_id AND activity_date = p_activity_date AND episode_id IS NULL;

  -- Upsert atômico: uma corrida/retry NUNCA cria duas linhas nem duplica o
  -- calendário. Preserva o completed_at original quando já existia.
  INSERT INTO public.user_listening_assignments
    (user_id, episode_id, activity_date, status, assigned_at, completed_at, created_at, updated_at)
  VALUES
    (p_user_id, NULL, p_activity_date, 'completed', now(), now(), now(), now())
  ON CONFLICT (user_id, activity_date) WHERE episode_id IS NULL
  DO UPDATE SET
    status = 'completed',
    completed_at = COALESCE(public.user_listening_assignments.completed_at, now()),
    updated_at = now();

  RETURN QUERY SELECT COALESCE(v_was_completed, false);
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_listening_shared_assignment(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_listening_shared_assignment(uuid, date) TO service_role;
