-- =============================================================================
-- MIGRATION: 20260724040000_conversation_session_authorizations_gateway_budget_reservation
-- Projeto: Lemon — AI Gateway budget-enforcement audit follow-up (Realtime)
--
-- Estritamente aditiva: duas colunas nullable em uma tabela já existente
-- (conversation_session_authorizations, criada por
-- 20260721010000_conversation_session_server_authoritative.sql). Nenhuma
-- policy, índice existente ou coluna existente é alterada.
--
-- Esta migration NÃO é aplicada remotamente por este processo — apenas
-- criada e validada localmente.
--
-- Motivo: conversation.realtime_usage é cobrado por token, mas o custo real
-- só é conhecido durante/depois da sessão (a chamada física acontece
-- inteiramente no browser — não pode ser envolvida por executeAiGatewayCall,
-- mesma limitação já documentada para conversation.webrtc_connect e
-- pronunciation.assess_text). Para nunca permitir que uma sessão comece
-- quando seu pior custo razoavelmente possível já ultrapassaria o saldo
-- restante, api/conversation/[...slug].ts cria uma reserva ATÔMICA real
-- (reserve_gateway_usage_v1, já corrigido por
-- 20260724030000_ai_gateway_conservative_budget_estimate_fix.sql) dimensionada
-- pelo teto técnico/comercial já calculado (authorizedMaxRecordingSeconds) ×
-- uma taxa conservadora documentada de tokens de áudio por segundo, ANTES de
-- emitir o token efêmero da OpenAI.
--
-- gateway_budget_reservation_id guarda o id dessa reserva.
-- gateway_session_id guarda o ai_provider_sessions.id (conversation.
-- webrtc_connect) da mesma sessão — necessário porque conversation.
-- realtime_usage grava seus eventos reais (ai_usage_events) usando esse id
-- como provider_session_record_id, não o id desta própria linha; sem essa
-- coluna, /session-complete (e o sweep de sessões abandonadas) não teria
-- como localizar os eventos reais da sessão para somar o custo real na hora
-- de reconciliar a reserva.
--
-- CORREÇÃO (2026-07-24, follow-up ao follow-up): a versão original desta
-- migration só liberava (release) a reserva no fim da sessão, nunca
-- convertendo em committed_cost_usd — o custo real ficava registrado apenas
-- em usage_daily, invisível para reserve_gateway_usage_v1 (que só lê
-- ai_gateway_budget_buckets). Isso permitia que, após uma sessão terminar,
-- o orçamento voltasse a parecer totalmente disponível mesmo com gasto real
-- já ocorrido. api/_ai-gateway/reservation-reconciliation.ts agora comita o
-- custo real (commit_gateway_reservation_v1) em vez de apenas liberar.
-- =============================================================================

ALTER TABLE public.conversation_session_authorizations
  ADD COLUMN IF NOT EXISTS gateway_budget_reservation_id UUID;

ALTER TABLE public.conversation_session_authorizations
  ADD COLUMN IF NOT EXISTS gateway_session_id UUID;

-- Sem FK para usage_reservations/ai_provider_sessions: a reserva pode já ter
-- sido finalizada (committed/released) por outro caminho (ex.: o sweep de
-- sessões abandonadas) antes desta linha ser encerrada —
-- commit_gateway_reservation_v1/release_gateway_reservation_v1 já são
-- idempotentes (WHERE status='pending'), então uma referência solta aqui
-- nunca é um erro, apenas um no-op na reconciliação.

COMMENT ON COLUMN public.conversation_session_authorizations.gateway_budget_reservation_id IS
  'usage_reservations.id for the upfront conversation.realtime_usage budget hold created at session start (see reserveRealtimeSessionBudget in api/_realtime-budget.ts). NULL when no budget was configured for that scope at session-start time (no reservation was needed). Reconciled (committed with the session real cost, or released if no usage occurred — see api/_ai-gateway/reservation-reconciliation.ts) by /session-complete or by the abandoned-session sweep.';

COMMENT ON COLUMN public.conversation_session_authorizations.gateway_session_id IS
  'ai_provider_sessions.id (conversation.webrtc_connect) for the same realtime session — the provider_session_record_id conversation.realtime_usage''s real ai_usage_events are keyed by. Used to look up the session''s real recorded cost when reconciling gateway_budget_reservation_id. NULL when the webrtc_connect bridge session was never authorized (fail-open — see maybeAuthorizeWebrtcSession).';
