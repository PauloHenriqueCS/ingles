# Homologação real do hard control de sessões realtime

Procedimento manual exato para homologar, contra o Primary Database e a API real da
OpenAI, o mecanismo de hard control das três features realtime
(`conversation.create_session`, `conversation.webrtc_connect`,
`conversation.realtime_usage` — `REALTIME_SESSION_FEATURES` em
`api/_ai-gateway/enforce-readiness.ts`), que hoje compartilham o gate
`realtimeHardControlReady`.

**Arquitetura testada aqui (`hard_control_version = 'session_control_unified_interface_v1'`)**,
atualizada nesta entrega (fecha os gaps encontrados na auditoria de
2026-07-23 do mecanismo original `session_control_hangup_v1`, nunca
homologado — a tabela estava vazia):

- **Unified interface para captura de `call_id`** — o navegador não posta
  mais o SDP offer direto para `https://api.openai.com/v1/realtime/calls`;
  ele posta para `/api/conversation/webrtc-connect`
  (`handleWebrtcConnect`, `api/conversation/[...slug].ts`), que faz essa
  chamada ele mesmo, server-to-server, com o mesmo token efêmero de antes.
  Como quem chama a OpenAI agora é o backend, o header `Location` (que
  contém o `call_id`) é lido de forma confiável em toda chamada, sem
  depender de CORS nem do navegador — resolve o limite antigo, documentado
  no comentário original de `handleSessionControl`, de que "só o navegador
  via esse `call_id`".
- **Heartbeat/lease server-side** — `handleSessionActive` e cada poll de
  `handleSessionControl` (a cada ~5s) renovam `ai_provider_sessions.last_heartbeat_at`.
- **Varredura automática (`handleConversationSweep`,
  `api/internal/listening/[...slug].ts`, cron a cada minuto)** — fecha
  sessões `active` cujo heartbeat parou (aba fechada, crash, rede caiu) e
  autorizações (`conversation_session_authorizations`) abandonadas além do
  prazo, tentando o hangup real quando há `call_id` capturado. Nenhum
  caminho cooperativo (`session-end`/`session-failed`/`session-complete`/
  `session-control`) consegue alcançar esses casos sozinho, porque por
  definição não há mais cliente do lado de lá para acioná-los.
- **Persistência do resultado do hangup** — `ai_provider_sessions.hangup_status`/
  `hangup_at`/`hangup_http_status` (nunca mais descartado silenciosamente).

Encerramento real continua via
`POST https://api.openai.com/v1/realtime/calls/{call_id}/hangup`
(`hangupAndPersist`, `api/_realtime-hangup.ts`), agora chamado tanto por
`handleSessionControl` (caminho cooperativo) quanto por
`handleConversationSweep` (caminho de abandono). Nunca ativa
`gateway_mode=enforce` em nenhuma feature — este procedimento é só-leitura
em relação a `ai_runtime_controls`.

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

## Cenário 5 — Desconexão (mecanismo de varredura, não um caminho cooperativo)

Prova o `handleConversationSweep`, não `/session-control` — o ponto deste
cenário é que NENHUM cliente aciona nada depois da desconexão.

1. Inicie uma nova sessão curta (Cenário 1) e confirme que ela chegou a
   `active` de verdade (fale algo, confirme áudio saindo).
2. Force uma desconexão real e definitiva: feche a aba (não minimize, feche)
   ou desligue o Wi-Fi/dados do dispositivo. Nunca chame `/session-end`,
   `/session-failed` nem `/session-complete` manualmente — o objetivo é que
   literalmente nenhum código cliente rode depois disso.
3. Confirme que o heartbeat parou de fato:
   ```sql
   SELECT status, last_heartbeat_at, now() - last_heartbeat_at AS idle_for
   FROM public.ai_provider_sessions WHERE id = '<gatewaySessionId>';
   -- EXPECTED: status ainda 'active', idle_for crescendo a cada nova consulta.
   ```
4. Espere passar `REALTIME_HEARTBEAT_STALE_SECONDS` (60s —
   `api/_realtime-constants.ts`) mais uma folga para o próximo tick do cron
   (até 60s) — cerca de 2 minutos no total. Não chame nada manualmente; o
   cron `conversation-sweep-stale-sessions` (a cada minuto) deve fazer isso
   sozinho. Se quiser confirmar sem esperar o cron, dispare o endpoint
   diretamente (mesma autenticação que o cron usa):
   ```bash
   curl -X GET https://<seu-dominio>/api/internal/listening/conversation-sweep \
     -H "Authorization: Bearer $CRON_SECRET"
   ```
5. Confirme o resultado real:
   ```sql
   SELECT status, ended_at, duration_seconds, measurement_source,
          hangup_status, hangup_at, hangup_http_status
   FROM public.ai_provider_sessions WHERE id = '<gatewaySessionId>';
   -- EXPECTED: status='expired', ended_at preenchido, duration_seconds > 0,
   -- measurement_source='sweep_expired'. Se um call_id foi capturado (ver
   -- Cenário abaixo sobre webrtc-connect): hangup_status='ok' ou 'failed'
   -- (nunca 'not_attempted' quando havia call_id), hangup_at preenchido.
   ```
6. Confirme que o hangup real foi de fato disparado contra a OpenAI (mesmo
   teste de "ação subsequente no call_id falha" do Cenário 3) — SE
   `hangup_status='ok'`. Se `hangup_status='failed'`, registre a mensagem
   real (o `hangup_http_status` já indica se foi um 4xx da OpenAI ou uma
   falha de rede/timeout — `hangup_http_status` nulo).

**Captura server-side do `call_id` (parte deste mesmo cenário, não
opcional):** confirme nos logs do backend (ou por uma query antes do sweep
no passo 3) que `provider_session_id` já estava preenchido em
`ai_provider_sessions` **antes** do sweep rodar — prova de que
`handleWebrtcConnect` capturou o `call_id` no momento da negociação SDP
(server-to-server), não dependendo do navegador ler o header `Location`.

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

Só depois de rodar os 8 cenários reais acima e confirmar cada `EXPECTED`.
Desde a auditoria de 2026-07-23, `record_realtime_hard_control_validation_v1`
**nunca mais aceita `status` como parâmetro** — ele é derivado
internamente dos 8 resultados individuais em `scenario_results` (impossível
gravar `passed` com um cenário faltando ou reprovado), e exige `git_sha` +
`environment` (evidência amarrada ao commit exato testado — nunca "antiga"
nem de "outro Git SHA").

1. Chaves exigidas em `scenario_results` (as 8, nem mais nem menos — mapeadas
   1:1 aos cenários acima):

   | Chave | Cenário |
   |---|---|
   | `reservation_authorization` | 1 |
   | `concurrency` | 2 |
   | `limit_rejection` | 3 |
   | `normal_termination` | 4 |
   | `disconnection` | 5 |
   | `timeout` | 6 |
   | `reservation_release` | 7 |
   | `orphan_cleanup` | 8 |

2. Calcule o hash deste arquivo no estado atual do seu disco:
   ```powershell
   Get-FileHash supabase\manual-validation\realtime-hard-control-validation.md -Algorithm SHA256
   ```
3. Pegue o commit exato que está rodando em produção agora (o mesmo código
   que você acabou de testar nos 8 cenários — nunca um commit local não
   deployado):
   ```powershell
   git rev-parse HEAD
   ```
4. No SQL Editor, com a mesma conexão service-role:
   ```sql
   SELECT public.record_realtime_hard_control_validation_v1(
     'session_control_unified_interface_v1',
     'supabase/manual-validation/realtime-hard-control-validation.md',
     '<hash do passo 2, lowercase hex>',
     '<git sha do passo 3, 40 chars lowercase hex>',
     'production',
     jsonb_build_object(
       'reservation_authorization', 'passed', -- ou 'failed' — registre a verdade, cenário a cenário
       'concurrency',               'passed',
       'limit_rejection',           'passed',
       'normal_termination',        'passed',
       'disconnection',             'passed',
       'timeout',                   'passed',
       'reservation_release',       'passed',
       'orphan_cleanup',            'passed'
     ),
     '<seu nome/identificador técnico>',
     'Rodei os 8 cenários reais contra <data> com conta de teste <id/marcador>. Detalhe por cenário: ...',
     jsonb_build_object(
       'disconnection', jsonb_build_object(
         'call_id_captured_before_sweep', true,
         'hangup_status', 'ok',
         'hangup_http_status', 200,
         'swept_after_seconds', 118
       )
       -- adicione outras chaves de evidência sanitizada por cenário conforme
       -- fizer sentido (nunca cole token/SDP/transcript — só timestamps,
       -- status, contagens, IDs técnicos)
     )
   );
   ```
   Se `status` derivado vier `'failed'` (qualquer cenário reprovado), a
   função ainda grava o registro — nunca omita uma falha real.
5. Confirme exatamente 1 registro `passed` para este exato commit:
   ```sql
   SELECT hard_control_version, status, git_sha, environment, executed_at, executed_by
   FROM public.realtime_hard_control_validations
   WHERE hard_control_version = 'session_control_unified_interface_v1'
     AND validation_script_sha256 = '<hash do passo 2>'
     AND git_sha = '<git sha do passo 3>'
     AND status = 'passed'
   ORDER BY executed_at DESC;
   ```
6. Qualquer edição futura neste arquivo (mesmo um byte) OU qualquer commit
   novo em `main` muda o hash/git_sha e invalida essa aprovação
   automaticamente — o preflight volta a reportar
   `realtimeHardControlReady=false` sem nenhum passo manual de "invalidar".

Nunca chame `record_realtime_hard_control_validation_v1` afirmando um
cenário como `'passed'` em `scenario_results` sem ter executado esse
cenário de verdade contra o Primary Database e a API real da OpenAI — a
função confia inteiramente no que você reporta; a honestidade dos 8 valores
é a única coisa que garante que `realtimeHardControlReady` signifique algo
real.
