-- =============================================================================
-- MIGRATION: 20260911170000_placement_sweep_abandon_expired
-- Projeto: Orodim
--
-- Aplicada automaticamente pelo pipeline de CI (supabase db push).
-- NÃO aplicar manualmente no SQL Editor.
--
-- OBJETIVO (item 4 — estado inconsistente do placement):
--   O gate do App (src/App.tsx) só bloqueia em placementStatus='not_started'.
--   Assim que startPlacement cria a linha 'in_progress', o usuário é liberado
--   para SEMPRE — o placement nunca precisa chegar a completed/skipped. A
--   finalização de uma tentativa expirada para 'abandoned' só acontece de forma
--   PREGUIÇOSA (api/_placement/placement-runtime.ts::markAbandoned), quando o
--   usuário faz uma nova requisição de placement DEPOIS do expires_at. Não há
--   varredura: uma tentativa 'in_progress' de quem nunca voltou fica pendurada
--   indefinidamente. Isso NÃO prende o usuário (o gate falha aberto), mas suja o
--   estado e as métricas.
--
--   IMPORTANTE: a expiração/bloqueio do TRIAL após 7 dias NÃO é tocada aqui —
--   isso é outro subsistema, já validado.
--
-- ESTA MIGRATION:
--   (a) cria placement_sweep_abandon_expired() — faz EXATAMENTE o que markAbandoned
--       já faz (in_progress + expires_at<=now → 'abandoned'), em lote; e
--   (b) executa uma varredura ÚNICA agora, no corpo da migration, para recuperar
--       com segurança as linhas já penduradas (recuperação de estado
--       inconsistente pedida no item 4).
--
-- NÃO auto-agenda o cron (mesma convenção deliberada de behavioral_push_sweep_cron
--   e operational_alerts): a ativação periódica é um passo manual único por
--   ambiente — ver comentário no fim.
--
-- NÃO destrutivo: só troca um status transitório ('in_progress' expirado) pelo
--   estado terminal que o próprio app aplicaria; não apaga nada, não mexe em
--   nível/currículo, não afeta tentativas 'completed'/'skipped'/'pending_evaluation'.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.placement_sweep_abandon_expired()
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.placement_attempts
     SET status = 'abandoned',
         updated_at = now()
   WHERE status = 'in_progress'
     AND expires_at <= now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.placement_sweep_abandon_expired() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.placement_sweep_abandon_expired() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.placement_sweep_abandon_expired() TO service_role;

-- ── Recuperação única, no deploy, do estado já inconsistente ─────────────────
-- (idempotente: nas próximas aplicações não haverá linhas expiradas para varrer)
SELECT public.placement_sweep_abandon_expired();

-- ── Ativação periódica (passo manual único por ambiente, no SQL Editor) ──────
-- Requer pg_cron habilitado. Roda de hora em hora; a função é barata e
-- idempotente (só toca linhas expiradas). Idempotente (unschedule antes):
--
--   DO $do$
--   BEGIN
--     PERFORM cron.unschedule('placement-sweep-abandon-expired')
--       WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'placement-sweep-abandon-expired');
--     PERFORM cron.schedule(
--       'placement-sweep-abandon-expired',
--       '7 * * * *',
--       $$SELECT public.placement_sweep_abandon_expired()$$
--     );
--   END;
--   $do$;
