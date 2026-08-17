-- =============================================================================
-- MIGRATION: 20260817160000_conversation_authorization_heartbeat
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml.
-- Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO (hotfix de consumo): uma Conversa com IA abandonada (usuário sai da
-- tela / app em background / crash / rede cai) NÃO pode continuar consumindo
-- minutos indefinidamente.
--
-- Causa raiz: plan-entitlements-service soma conversation_session_authorizations
-- e, para uma linha ainda 'authorized', conta min(now - authorized_at,
-- authorized_max_seconds) AO VIVO. Sem um sinal de "cliente ainda presente", uma
-- sessão abandonada continua contando até o teto (~30 min).
--
-- Correção: a própria linha de autorização passa a ter um heartbeat leve
-- (last_seen_at), renovado pelo cliente enquanto a conversa está realmente
-- aberta. Quando o heartbeat some, o consumo é fixado no último heartbeat e a
-- linha é encerrada (reconcile-on-start / sweep). Linhas antigas ficam com
-- last_seen_at = NULL e mantêm o comportamento anterior — heartbeat é EVIDÊNCIA
-- para fixar o consumo; sem ele nunca reembolsamos.
--
-- Idempotente.
-- =============================================================================

-- 1) Coluna de heartbeat da linha de autorização (quota), distinta do heartbeat
--    de telemetria em ai_provider_sessions.last_heartbeat_at.
ALTER TABLE public.conversation_session_authorizations
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

COMMENT ON COLUMN public.conversation_session_authorizations.last_seen_at IS
  'Heartbeat leve renovado pelo cliente (~a cada 20s) enquanto a conversa está aberta. NULL em linhas anteriores ao recurso. Quando fica obsoleto, o consumo é fixado neste instante e a sessão é encerrada como abandonada (sem crédito curricular).';

-- Índice para o reconcile/sweep localizarem rapidamente linhas abertas obsoletas.
CREATE INDEX IF NOT EXISTS idx_csa_open_last_seen
  ON public.conversation_session_authorizations (last_seen_at)
  WHERE status = 'authorized';

-- 2) Limpeza única e SEGURA de sessões já presas: encerra APENAS linhas
--    inequivocamente abandonadas — abertas há mais tempo que o teto técnico
--    (REALTIME_MAX_SESSION_SECONDS = 1800s) + folga (AUTHORIZATION_SWEEP_GRACE
--    = 120s) = 1920s. Nenhuma sessão realmente ativa fica aberta tanto tempo.
--    A duração gravada = min(tempo decorrido, teto autorizado) = o mesmo valor
--    que já estava sendo contado ao vivo (não é reembolso, não é cobrança nova):
--    apenas FIXA o consumo e fecha o status, impedindo crescimento até o teto.
--    Linhas mais novas/ativas NÃO são tocadas aqui — o heartbeat + reconcile
--    server-side cuidam delas em produção.
UPDATE public.conversation_session_authorizations
SET status = 'completed',
    completed_at = now(),
    duration_seconds = LEAST(
      authorized_max_seconds,
      GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - authorized_at)))::int)
    )
WHERE status = 'authorized'
  AND authorized_at < now() - interval '1920 seconds';
