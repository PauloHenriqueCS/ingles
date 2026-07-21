# Homologação real do hard control de sessões realtime

Procedimento manual exato para homologar, contra o Primary Database e a API real da
OpenAI, o mecanismo de hard control das três features realtime
(`conversation.create_session`, `conversation.webrtc_connect`,
`conversation.realtime_usage` — `REALTIME_SESSION_FEATURES` em
`api/_ai-gateway/enforce-readiness.ts`), que hoje compartilham o gate
`realtimeHardControlReady`.

**Arquitetura testada aqui (`hard_control_version = 'session_control_hangup_v1'`)**:
captura de `call_id` no início da sessão (`handleSessionActive`,
`api/conversation/[...slug].ts`) + encerramento real via
`POST https://api.openai.com/v1/realtime/calls/{call_id}/hangup`
(`hangupRealtimeCall`), disparado por `/api/conversation/session-control`
(`handleSessionControl`), polled pelo cliente a cada ~5s
(`src/hooks/useRealtimeSession.ts`). Nunca ativa `gateway_mode=enforce` em
nenhuma feature — este procedimento é só-leitura em relação a `ai_runtime_controls`.

**Pré-requisitos**: `OPENAI_API_KEY` real (funded) e `SUPABASE_SERVICE_ROLE_KEY` do
Primary Database disponíveis no processo local (nunca colados no chat/log), e o
app rodando de verdade (`npm run dev`) em um navegador real — a negociação
WebRTC/SDP com a Realtime API acontece inteiramente no browser
(`useRealtimeSession.ts`), então não há como simular isso via curl/SQL puro.
Uma conta de usuário descartável (marcada com um `session_date` sintético e
distante de qualquer tráfego real, ex. `2099-01-01`, mesmo padrão de
`ai-gateway-enforcement-concurrency.sql`) evita qualquer colisão com dados reais.

Custo real esperado: alguns segundos de uma sessão Realtime (modelo mini) por
cenário — minutos de áudio no total, não horas. Nunca rode isso contra uma
conta de produção real de um aluno.

---

## Antes de tudo — snapshot

```sql
-- 0a. Nenhuma sessão/autorização órfã pré-existente do usuário de teste.
SELECT id, status, started_at, provider_session_id
FROM public.ai_provider_sessions
WHERE user_id = '<UUID do usuário de teste>' AND feature_key = 'conversation.webrtc_connect';

SELECT id, status, session_date, authorized_at, authorized_max_seconds, duration_seconds
FROM public.conversation_session_authorizations
WHERE user_id = '<UUID do usuário de teste>';
-- EXPECTED: 0 linhas em ambas (conta descartável recém-criada) ou apenas
-- linhas já 'completed'/'ended' de execuções anteriores deste mesmo runbook.
```

---

## Cenário 1 — Reserva/autorização

1. No navegador, autenticado como o usuário de teste, inicie uma conversa
   (`POST /api/conversation/session`).
2. Confirme:
   ```sql
   SELECT status, started_at FROM public.ai_provider_sessions
   WHERE user_id = '<uuid>' AND feature_key = 'conversation.webrtc_connect'
   ORDER BY started_at DESC LIMIT 1;
   -- EXPECTED: status = 'pending' ou 'active' (reserva/observe registrada).

   SELECT status, authorized_max_seconds FROM public.conversation_session_authorizations
   WHERE user_id = '<uuid>' ORDER BY authorized_at DESC LIMIT 1;
   -- EXPECTED: status = 'authorized', authorized_max_seconds > 0.
   ```
3. Registre o `recordingAuthorizationId` retornado pelo endpoint — usado nos
   cenários seguintes para confirmar que cada teste fecha a SUA própria linha,
   nunca uma de outro cenário.

## Cenário 2 — Concorrência

Com a sessão do Cenário 1 ainda ativa, dispare **duas** chamadas concorrentes a
`/api/conversation/session-control` (duas abas, ou duas requisições disparadas
no mesmo instante via um pequeno script). Confirme:
```sql
SELECT status FROM public.ai_provider_sessions WHERE id = '<gatewaySessionId>';
-- EXPECTED: exatamente um estado final consistente (não corrompido, não
-- duplicado) — as duas chamadas concorrentes nunca produzem dois hangups
-- reais nem dois status finais divergentes.
```
Confirme nos logs/resposta HTTP que ambas as chamadas concorrentes retornaram
sem erro 5xx e sem exceção não tratada.

## Cenário 3 — Rejeição ao exceder limite

Force um limite pequeno e real para o usuário de teste (ex.: plano com
`monthlyTime` quase esgotado, ou aguarde o `authorized_max_seconds` do Cenário
1 ser pequeno o suficiente para expirar em segundos). Continue polling
`/session-control` até passar do `effectiveDeadlineMs`. Confirme:
```json
// resposta esperada de /session-control após o deadline:
{ "terminate": true, "reason": "max_duration_reached" }
```
E confirme no lado da OpenAI que a chamada real foi encerrada: uma nova
tentativa de `hangup` no mesmo `call_id` (ou qualquer ação subsequente nesse
`call_id`) retorna erro do lado da OpenAI (4xx — chamada já encerrada), nunca
sucesso.

## Cenário 4 — Encerramento normal

Inicie uma nova sessão curta (Cenário 1), converse por poucos segundos, e
encerre normalmente pelo app (botão de encerrar chamada → `/session-end` e/ou
`/session-complete`). Confirme:
```sql
SELECT status FROM public.ai_provider_sessions WHERE id = '<novo gatewaySessionId>';
-- EXPECTED: 'completed' (ou equivalente de encerramento cooperativo).

SELECT status, duration_seconds FROM public.conversation_session_authorizations
WHERE id = '<novo recordingAuthorizationId>';
-- EXPECTED: status='completed', duration_seconds > 0 e coerente com a duração
-- real observada (nunca um valor relatado pelo cliente — computado server-side
-- a partir de authorized_at, ver api/conversation/[...slug].ts's handleSessionComplete).
```

## Cenário 5 — Desconexão

Inicie uma nova sessão curta (Cenário 1). Force uma desconexão anormal (feche
a aba/perca a rede) SEM clicar em encerrar — nunca chamando `/session-end` nem
`/session-complete`. Depois de passado o `authorized_max_seconds`, dispare uma
última chamada a `/session-control` (simulando, por exemplo, uma nova aba
consultando o mesmo `gatewaySessionId`, ou aguardando o próprio poll que já
estava em voo). Confirme:
```sql
SELECT status FROM public.ai_provider_sessions WHERE id = '<gatewaySessionId>';
-- EXPECTED: eventualmente 'completed'/'expired' — nunca 'active' para sempre.
```
Confirme que o hangup real foi de fato disparado contra a OpenAI (mesmo teste
de "ação subsequente no call_id falha" do Cenário 3).

## Cenário 6 — Timeout

Idêntico ao Cenário 3/5 do ponto de vista do servidor (o deadline é
server-side, baseado em `started_at + REALTIME_MAX_SESSION_SECONDS`, nunca em
sinal do cliente) — a diferença aqui é confirmar explicitamente o caminho de
**duração técnica máxima** (não limite comercial): use uma conta com
`monthlyTime`/`maxRecordingSeconds` ilimitados, deixe a sessão correr até
`REALTIME_MAX_SESSION_SECONDS`, e confirme `reason = 'max_duration_reached'`
mesmo sem nenhum limite comercial envolvido.

## Cenário 7 — Liberação de reservas

Após CADA cenário acima, confirme que nenhuma reserva/estado fica preso:
```sql
SELECT id, status FROM public.ai_provider_sessions
WHERE user_id = '<uuid>' AND status NOT IN ('completed', 'expired', 'failed');
-- EXPECTED: 0 linhas — toda sessão do usuário de teste terminou em um
-- estado terminal ao final de cada cenário, nunca 'pending'/'active' solta.
```

## Cenário 8 — Ausência de sessões ou custos órfãos (limpeza final)

```sql
-- Nenhuma linha 'authorized' (não fechada) do usuário de teste sobra.
SELECT COUNT(*) FROM public.conversation_session_authorizations
WHERE user_id = '<uuid>' AND status = 'authorized';
-- EXPECTED: 0.

-- Nenhuma linha 'pending'/'active' em ai_provider_sessions sobra.
SELECT COUNT(*) FROM public.ai_provider_sessions
WHERE user_id = '<uuid>' AND status NOT IN ('completed', 'expired', 'failed');
-- EXPECTED: 0.
```
Se qualquer uma dessas contagens vier diferente de 0, **não registre a
validação como passed** — investigue e feche a sessão órfã manualmente antes
de prosseguir (ex. via um encerramento cooperativo real, nunca um `UPDATE`
direto que mascare o bug).

Ao final, delete/desative a conta de teste descartável (ou deixe-a marcada
como sintética/teste) para que ela nunca conte em nenhuma métrica de produto.

---

## Registro da validação

Só depois de rodar os 8 cenários reais acima e confirmar cada `EXPECTED`:

1. Calcule o hash deste arquivo no estado atual do seu disco:
   ```powershell
   Get-FileHash supabase\manual-validation\realtime-hard-control-validation.md -Algorithm SHA256
   ```
2. No SQL Editor, com a mesma conexão service-role:
   ```sql
   SELECT public.record_realtime_hard_control_validation_v1(
     'session_control_hangup_v1',
     'supabase/manual-validation/realtime-hard-control-validation.md',
     '<hash do passo 1>',
     'passed', -- ou 'failed' se qualquer cenário divergiu do EXPECTED — registre a verdade
     '<seu nome/identificador técnico>',
     'Rodei os 8 cenários reais contra <data> com conta de teste <id/marcador>. Resultado por cenário: ...'
   );
   ```
3. Confirme exatamente 1 registro:
   ```sql
   SELECT hard_control_version, status, executed_at, executed_by
   FROM public.realtime_hard_control_validations
   WHERE hard_control_version = 'session_control_hangup_v1'
     AND validation_script_sha256 = '<hash do passo 1>'
     AND status = 'passed'
   ORDER BY executed_at DESC;
   ```
4. Qualquer edição futura neste arquivo (mesmo um byte) muda o hash e invalida
   essa aprovação automaticamente — o preflight volta a reportar
   `realtimeHardControlReady=false` sem nenhum passo manual de "invalidar".

Nunca chame `record_realtime_hard_control_validation_v1` com `status='passed'`
sem ter executado os 8 cenários de verdade contra o Primary Database e a API
real da OpenAI.
