# Etapa 11 — Implantação e homologação final do enforcement

Procedimento manual exato para aplicar `supabase/migrations/20260718000000_ai_gateway_enforcement.sql`,
a migration corretiva de segurança `supabase/migrations/20260718010000_ai_gateway_enforcement_security_fix.sql`
(Passo 6 — fecha um gap de privilégio descoberto no postcheck do Passo 5, obrigatória antes de
prosseguir), as duas migrations corretivas de ambiguidade de coluna — Passo 7
(`20260718020000_ai_gateway_enforcement_function_ambiguity_fix.sql`) e Passo 8
(`20260718030000_ai_gateway_enforcement_budget_conflict_ambiguity_fix.sql`), ambas obrigatórias antes
do Passo 9 — e homologar os 7 cenários de
`supabase/manual-validation/ai-gateway-enforcement-concurrency.sql`.

**Status:** homologado em 2026-07-18. Os 7 cenários foram executados de ponta a ponta contra o
Primary Database com as quatro migrations acima já aplicadas, com PASS em todos — ver o Passo 9 e a
seção SUMMARY no fim do arquivo de validação para as evidências numéricas completas.

**HEAD do repositório neste procedimento:** o commit que introduz esta atualização de documentação
(migration `20260718030000` e o script de validação manual estão byte a byte como estavam nesse
commit — rode `git log -1 --oneline -- supabase/manual-validation/ai-gateway-enforcement-concurrency.sql
supabase/migrations/20260718030000_ai_gateway_enforcement_budget_conflict_ambiguity_fix.sql` no seu
checkout para o hash exato; um valor fixado aqui ficaria desatualizado assim que qualquer um dos dois
arquivos mudasse de novo).

**Hash SHA-256 atual do script de validação manual** (recalcule antes do Passo 9 — se este arquivo
mudar um único byte, este número muda; o valor abaixo já é o real, pós-homologação, calculado com
`sha256sum supabase/manual-validation/ai-gateway-enforcement-concurrency.sql` — nunca reutilize o
valor antigo `4561ba5e9f85f6b3fa4fba3d623f6722f1619795bccb8bc51ddc7e750c72a4ff`, que era de uma versão
anterior do arquivo, antes do modelo de lock-hold determinístico de 25s e da reconciliação com os
resultados reais):
```
122d4aa5442c24a88b35fce74e8e654f5da36d337e358ea7422915b754580bec
```

Nenhum passo abaixo ativa `enforce` em nenhuma feature, altera `ai_runtime_controls` fora do que a
própria migration já faz (nada — ela só amplia CHECK constraints), ou registra
`concurrencyValidated=true` antes da execução real dos 7 cenários.

---

## PASSO 1 — Precheck somente leitura (rodar ANTES de tocar em qualquer coisa)

Confirma que todo objeto do qual a migration depende já existe, e que nenhum dos 8 objetos que ela
vai *criar* já existe (ou seja: a migration nunca foi aplicada antes). Cole isto no SQL Editor e
rode como uma única query — é 100% `SELECT`, não escreve nada.

```sql
-- ── Dependências que a migration PRESUME já existirem ──────────────────────
SELECT 'ai_features' AS dependency, EXISTS (
  SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='ai_features'
) AS exists
UNION ALL SELECT 'usage_reservations', EXISTS (
  SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='usage_reservations')
UNION ALL SELECT 'usage_reservation_items', EXISTS (
  SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='usage_reservation_items')
UNION ALL SELECT 'ai_runtime_controls', EXISTS (
  SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='ai_runtime_controls')
UNION ALL SELECT 'ai_gateway_configs', EXISTS (
  SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='ai_gateway_configs')
UNION ALL SELECT 'ai_control_switches', EXISTS (
  SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='ai_control_switches')
UNION ALL SELECT 'ai_pricing_versions', EXISTS (
  SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='ai_pricing_versions')
UNION ALL SELECT 'ai_pricing_rates', EXISTS (
  SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='ai_pricing_rates')
UNION ALL SELECT 'provider_pricing', EXISTS (
  SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='provider_pricing')
UNION ALL SELECT 'ai_usage_events', EXISTS (
  SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='ai_usage_events')
UNION ALL SELECT 'ai_usage_event_metrics', EXISTS (
  SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='ai_usage_event_metrics')
UNION ALL SELECT 'function update_updated_at()', EXISTS (
  SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at');
-- EXPECTED: todas as linhas com exists = true. Se qualquer uma vier false,
-- PARE — a migration vai falhar (ela referencia essas tabelas/função
-- diretamente) e a causa raiz é externa a esta migration.

-- ── Objetos que a migration VAI criar — devem estar todos ausentes hoje ────
SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN (
  'ai_gateway_decisions','ai_gateway_idempotency_locks','ai_gateway_quota_buckets',
  'ai_gateway_budget_buckets','ai_gateway_reservation_budget_links',
  'ai_gateway_circuit_breakers','api_rate_limits','ai_gateway_concurrency_validations'
);
-- EXPECTED: 0 linhas (nenhuma existe ainda) — EXCETO api_rate_limits, que
-- pode já existir (é uma redeclaração idempotente de uma migration anterior,
-- 20260714130000_api_rate_limits.sql — CREATE TABLE IF NOT EXISTS não falha
-- se já existir). Qualquer OUTRA linha aparecendo aqui significa que esta
-- migration (ou parte dela) já foi aplicada antes — pare e investigue, não
-- rode de novo sem entender por quê.

SELECT proname FROM pg_proc WHERE proname IN (
  'begin_gateway_idempotent_op_v1','complete_gateway_idempotent_op_v1','fail_gateway_idempotent_op_v1',
  'reserve_gateway_usage_v1','commit_gateway_reservation_v1','release_gateway_reservation_v1',
  'mark_gateway_reservation_reconciliation_required_v1','expire_stale_gateway_reservations_v1',
  '_gateway_touch_quota_bucket_v1','_gateway_touch_budget_bucket_v1',
  'get_gateway_breaker_state_v1','record_gateway_breaker_outcome_v1',
  'gateway_publish_runtime_controls_v1','gateway_publish_pricing_v1',
  '_gateway_publish_runtime_controls_trigger_v1','_gateway_publish_pricing_trigger_v1',
  'record_gateway_concurrency_validation_v1'
);
-- EXPECTED: 0 linhas — EXCETO check_and_increment_rate_limit (não incluída
-- acima de propósito), que é a mesma redeclaração idempotente idempotente do
-- api_rate_limits. Qualquer uma das 17 funções listadas aqui já existindo
-- significa aplicação prévia parcial — pare e investigue.
```

Se o precheck vier limpo (dependências todas `true`, objetos-alvo todos ausentes), siga para o Passo 2.

---

## PASSO 2 — Snapshot completo (rodar e SALVAR o resultado antes de aplicar)

Rode cada bloco abaixo e guarde a saída (copiar para um arquivo local, print da tela, o que for mais
prático) — é o "antes" contra o qual o Passo 5 vai comparar o "depois".

```sql
-- 2a. ai_runtime_controls — TODAS as linhas, ordenadas de forma estável
SELECT id, scope_type, scope_key, gateway_mode, runtime_status, updated_at
FROM public.ai_runtime_controls
ORDER BY scope_type, scope_key;

-- 2b. Distribuição de gateway_mode e runtime_status (para comparação rápida)
SELECT gateway_mode, runtime_status, COUNT(*) AS n
FROM public.ai_runtime_controls
GROUP BY gateway_mode, runtime_status
ORDER BY gateway_mode, runtime_status;

-- 2c. provider_pricing — TODAS as linhas ativas (histórico de preço)
SELECT id, provider, service, model, metric_key, currency, unit_size, price_per_unit,
       valid_from, valid_until, is_active, source_reference, updated_at
FROM public.provider_pricing
ORDER BY provider, model, metric_key, valid_from;

-- 2d. Contagem simples de provider_pricing para conferência rápida pós-migração
SELECT COUNT(*) AS total_rows, COUNT(*) FILTER (WHERE is_active) AS active_rows
FROM public.provider_pricing;

-- 2e. Nenhuma feature em enforce hoje (confirma o estado de partida)
SELECT scope_type, scope_key, gateway_mode FROM public.ai_runtime_controls WHERE gateway_mode = 'enforce';
-- EXPECTED hoje: 0 linhas.

-- 2f. Checksum agregado de ai_runtime_controls inteiro (comparação de uma
-- linha só no Passo 5, além da comparação linha-a-linha de 2a/2b)
SELECT md5(string_agg(id::text || ':' || gateway_mode || ':' || runtime_status, ',' ORDER BY id))
  AS ai_runtime_controls_checksum
FROM public.ai_runtime_controls;
```

Guarde especialmente o resultado de **2f** (um único hash) — é a forma mais rápida de confirmar
"nada mudou" no Passo 5 sem precisar comparar linha por linha manualmente.

---

## PASSO 3 — Por que a migration pode ser aplicada isoladamente

Confirmado por leitura completa do arquivo (1531 linhas):

- É **um único arquivo autocontido**, envolto em `BEGIN; ... COMMIT;` — tudo ou nada.
- Todo `CREATE TABLE`/`CREATE INDEX`/`CREATE FUNCTION` usa `IF NOT EXISTS` ou `CREATE OR REPLACE`;
  todo `DROP TRIGGER` usa `IF EXISTS` — reaplicar por engano não quebra nada, apenas não faz nada
  de novo (idempotente).
- Ela mesma captura um snapshot de `ai_runtime_controls` (`_migration_arc_before`, uma TEMP TABLE
  escopada à transação) e, no final, **antes do COMMIT**, roda um bloco `DO $$ ... $$` que
  `RAISE EXCEPTION` (desfazendo a transação inteira) se:
  - a contagem de linhas de `ai_runtime_controls` mudou;
  - qualquer `gateway_mode`/`runtime_status` de uma linha existente mudou;
  - o número de tabelas novas não for exatamente 8;
  - o número de funções novas/redeclaradas não for exatamente 18.
- Ou seja: **a migration já se auto-valida e se autorreverte em caso de violação** — não depende de
  nenhuma migration anterior específica ter rodado nesta sessão, só dos objetos listados no Passo 1.
- **Não use `supabase db push`**: o histórico remoto de migrations pode estar incompleto (migrations
  anteriores foram aplicadas manualmente), e `db push` tentaria reconciliar todo o histórico, não
  apenas este arquivo — risco de tentar reaplicar ou pular migrations de forma imprevisível. Aplique
  **somente o conteúdo deste arquivo**, colado diretamente no SQL Editor.

---

## PASSO 4 — Comando exato para aplicar

1. Abra o projeto no [Supabase Studio](https://supabase.com/dashboard) → **SQL Editor** → **New query**.
2. Abra `supabase/migrations/20260718000000_ai_gateway_enforcement.sql` no seu editor local.
3. Selecione **o arquivo inteiro** (Ctrl+A), copie, cole no SQL Editor — sem editar nada, sem
   remover o `BEGIN;`/`COMMIT;` do topo/fim.
4. Clique **Run**.
5. Resultado esperado: sucesso, com uma mensagem `NOTICE` no final:
   `VALIDATION PASSED: 8 new tables, 18 new/re-declared functions, zero changes to existing ai_runtime_controls rows, runtime_status and usage_reservations.status CHECK constraints widened additively`
6. Se em vez disso vier um `ERROR: VALIDATION FAILED: ...` (ou qualquer outro erro), a transação foi
   **revertida automaticamente** (nada foi persistido) — pare, copie a mensagem de erro exata e
   pare aqui. Não tente aplicar de novo sem entender a causa.

---

## PASSO 5 — Queries pós-migração (rodar imediatamente depois do sucesso do Passo 4)

```sql
-- 5a. As 8 tabelas novas existem
SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN (
  'ai_gateway_decisions','ai_gateway_idempotency_locks','ai_gateway_circuit_breakers','api_rate_limits',
  'ai_gateway_quota_buckets','ai_gateway_budget_buckets','ai_gateway_reservation_budget_links',
  'ai_gateway_concurrency_validations'
) ORDER BY table_name;
-- EXPECTED: exatamente 8 linhas.

-- 5b. As 18 funções existem
SELECT proname FROM pg_proc WHERE proname IN (
  'check_and_increment_rate_limit','begin_gateway_idempotent_op_v1','complete_gateway_idempotent_op_v1',
  'fail_gateway_idempotent_op_v1','reserve_gateway_usage_v1','commit_gateway_reservation_v1',
  'release_gateway_reservation_v1','mark_gateway_reservation_reconciliation_required_v1',
  'get_gateway_breaker_state_v1','record_gateway_breaker_outcome_v1','_gateway_touch_quota_bucket_v1',
  '_gateway_touch_budget_bucket_v1','gateway_publish_runtime_controls_v1','gateway_publish_pricing_v1',
  '_gateway_publish_runtime_controls_trigger_v1','_gateway_publish_pricing_trigger_v1',
  'expire_stale_gateway_reservations_v1','record_gateway_concurrency_validation_v1'
) ORDER BY proname;
-- EXPECTED: exatamente 18 linhas.

-- 5c. RLS habilitado + ZERO políticas nas 8 tabelas novas (service_role-only)
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled,
       COUNT(p.polname) AS policy_count
FROM pg_class c
LEFT JOIN pg_policy p ON p.polrelid = c.oid
WHERE c.relname IN (
  'ai_gateway_decisions','ai_gateway_idempotency_locks','ai_gateway_circuit_breakers','api_rate_limits',
  'ai_gateway_quota_buckets','ai_gateway_budget_buckets','ai_gateway_reservation_budget_links',
  'ai_gateway_concurrency_validations'
)
GROUP BY c.relname, c.relrowsecurity
ORDER BY c.relname;
-- EXPECTED: rls_enabled = true e policy_count = 0 em TODAS as 8 linhas.

-- 5d. As funções sensíveis estão REVOKEd de anon/authenticated (amostra —
-- reserve/commit/release + o registrador de concorrência, os mais críticos)
SELECT
  has_function_privilege('anon', 'public.reserve_gateway_usage_v1(text,uuid,uuid,text,text,text,jsonb,jsonb,numeric,integer)', 'EXECUTE') AS anon_can_reserve,
  has_function_privilege('authenticated', 'public.reserve_gateway_usage_v1(text,uuid,uuid,text,text,text,jsonb,jsonb,numeric,integer)', 'EXECUTE') AS authenticated_can_reserve,
  has_function_privilege('anon', 'public.record_gateway_concurrency_validation_v1(text,text,text,text,text,text)', 'EXECUTE') AS anon_can_record_validation,
  has_function_privilege('authenticated', 'public.record_gateway_concurrency_validation_v1(text,text,text,text,text,text)', 'EXECUTE') AS authenticated_can_record_validation;
-- EXPECTED: as 4 colunas = false.

-- 5e. Nenhum gateway_mode/runtime_status existente mudou — comparação pelo
-- checksum agregado do Passo 2f (cole o valor que você guardou):
SELECT md5(string_agg(id::text || ':' || gateway_mode || ':' || runtime_status, ',' ORDER BY id))
  AS ai_runtime_controls_checksum_now
FROM public.ai_runtime_controls;
-- EXPECTED: idêntico ao valor salvo no Passo 2f. Se diferente, PARE — algo
-- alterou ai_runtime_controls fora do que a migration deveria fazer.

-- 5f. Nenhum preço histórico foi sobrescrito — comparação de contagem com o
-- Passo 2d (a migration não insere nenhuma linha em provider_pricing por si
-- só — só a função gateway_publish_pricing_v1 faria isso, e ela só roda via
-- trigger em ai_pricing_versions, que esta migration não toca):
SELECT COUNT(*) AS total_rows, COUNT(*) FILTER (WHERE is_active) AS active_rows
FROM public.provider_pricing;
-- EXPECTED: idêntico ao Passo 2d.

-- 5g. Nenhuma feature ativada em enforce
SELECT scope_type, scope_key, gateway_mode FROM public.ai_runtime_controls WHERE gateway_mode = 'enforce';
-- EXPECTED: 0 linhas (igual ao Passo 2e).
```

Se **qualquer** um dos itens 5a–5g vier fora do esperado, pare e reporte antes de prosseguir para
o Passo 6.

**Nota (descoberta em produção após este runbook ter sido escrito):** o item 5d acima checa só uma
amostra de 2 das 18 funções. Uma auditoria completa (todas as 8 tabelas + todas as 18 funções, via
`information_schema.role_table_grants` e `has_function_privilege`) contra o projeto já aplicado
encontrou dois gaps reais que 5a–5g sozinhos não pegam:
- anon/authenticated retinham o GRANT de tabela padrão que o Supabase concede a todo projeto novo
  (DELETE/INSERT/REFERENCES/SELECT/TRIGGER/TRUNCATE/UPDATE) nas 8 tabelas — RLS+zero-policy (5c)
  já bloqueava acesso via PostgREST, mas o GRANT bruto continuava concedido por baixo.
- 2 das 18 funções — `_gateway_publish_pricing_trigger_v1` e
  `_gateway_publish_runtime_controls_trigger_v1` — nunca tiveram `REVOKE` explícito na migration
  original (só são chamadas via trigger, nunca via RPC pela aplicação, então o gap não tinha efeito
  prático, mas o Supabase security advisor sinaliza EXECUTE concedido a anon/authenticated nas
  duas, expostas em `/rest/v1/rpc/<nome>`).

Por isso o Passo 6 abaixo é obrigatório antes de seguir para a correção de ambiguidade (Passo 7) e os
cenários de concorrência (Passo 8).

---

## PASSO 6 — Migration corretiva de segurança (OBRIGATÓRIA antes do Passo 7)

Aplica `supabase/migrations/20260718010000_ai_gateway_enforcement_security_fix.sql` — fecha os dois
gaps descritos acima. É **exclusivamente aditiva**: só `REVOKE`/`GRANT` de privilégio nas 8 tabelas
e 18 funções já existentes, mais um utilitário novo e mínimo, `_gateway_audit_database_privileges_v1()`
(read-only, sem side effect, `REVOKE`d de anon/authenticated do mesmo jeito) que o preflight
(`scripts/ai-gateway-enforce-preflight.ts`) usa para reportar `unsafe_database_privileges` ao vivo.
Nenhuma tabela, função, policy, trigger ou linha de dado da migration original é criada, removida
ou alterada.

### Aplicar

1. Abra o projeto no [Supabase Studio](https://supabase.com/dashboard) → **SQL Editor** → **New query**.
2. Abra `supabase/migrations/20260718010000_ai_gateway_enforcement_security_fix.sql` no seu editor local.
3. Selecione **o arquivo inteiro** (Ctrl+A), copie, cole no SQL Editor — sem editar nada.
4. Clique **Run**.
5. Resultado esperado: sucesso, com uma mensagem `NOTICE` no final:
   `VALIDATION PASSED: anon/authenticated stripped of every privilege on the 8 Etapa 11 tables and
   of EXECUTE on all 18 Etapa 11 functions; service_role/postgres retain required access; RLS
   remains enabled with zero policies on all 8 tables; gateway_mode/runtime_status/provider_pricing
   unchanged`
6. Se em vez disso vier `ERROR: VALIDATION FAILED: ...`, a transação foi **revertida
   automaticamente** (nada foi persistido) — pare, copie a mensagem de erro exata e reporte antes de
   tentar de novo.

### Postcheck

```sql
SELECT * FROM public._gateway_audit_database_privileges_v1();
-- EXPECTED: unsafe_tables = '{}' e unsafe_functions = '{}' — os dois arrays vazios.

SELECT
  has_function_privilege('anon', 'public._gateway_publish_pricing_trigger_v1()', 'EXECUTE') AS anon_can_publish_pricing_trigger,
  has_function_privilege('authenticated', 'public._gateway_publish_pricing_trigger_v1()', 'EXECUTE') AS authenticated_can_publish_pricing_trigger,
  has_function_privilege('anon', 'public._gateway_publish_runtime_controls_trigger_v1()', 'EXECUTE') AS anon_can_publish_runtime_trigger,
  has_function_privilege('authenticated', 'public._gateway_publish_runtime_controls_trigger_v1()', 'EXECUTE') AS authenticated_can_publish_runtime_trigger;
-- EXPECTED: as 4 colunas = false (os dois gaps reais fechados).
```

Só prossiga para o Passo 7 depois que este postcheck vier limpo.

---

## PASSO 7 — Migration corretiva de ambiguidade de colunas (OBRIGATÓRIA antes do Passo 8)

Execução real dos 7 cenários contra o Primary Database em 2026-07-18 (rollback proposital, nenhum
dado persistido) encontrou:
- `1_rate_limit_atomic` PASS
- `6_breaker_probe_exclusivity` PASS
- `2_dedupe_atomic_and_reclaim` FAIL — `column reference "result_ref" is ambiguous`
- `3_reservation_idempotency` FAIL — `column reference "status" is ambiguous`
- `7_backfill_on_first_touch` FAIL — `column reference "status" is ambiguous`

Causa: `RETURNS TABLE(...)` injeta uma variável PL/pgSQL por coluna de saída; `begin_gateway_idempotent_op_v1`
(saída `result_ref`) e `reserve_gateway_usage_v1` (saída `status`, referenciada na PRIMEIRA instrução
que a função executa em toda chamada — por isso quebrou tanto o Cenário 3, que a chama duas vezes,
quanto o Cenário 7, que a chama uma vez só) referenciavam essas mesmas colunas sem qualificação em
algumas consultas embutidas. Auditoria linha a linha das 18 funções da Etapa 11 confirmou que só
estas duas são afetadas — as outras 16 (incluindo as duas por trás dos Cenários 1 e 6, que passaram)
só tocam a coluna colidente via `SELECT *`/`RETURNING *` ou `record.campo`, nunca de forma nua.

Aplica `supabase/migrations/20260718020000_ai_gateway_enforcement_function_ambiguity_fix.sql` —
substitui as DUAS funções afetadas via `CREATE OR REPLACE FUNCTION`, qualificando as colunas
ambíguas com alias de tabela (nunca `#variable_conflict`, que mascararia a causa em vez de eliminá-la).
Assinatura pública, tipo de retorno, comportamento, `SECURITY DEFINER`, `search_path` e ownership
preservados exatamente — nenhuma regra de quota, orçamento, dedupe, circuit breaker ou reserva muda.
Reafirma `REVOKE`/`GRANT` de privilégio nas duas funções. A própria migration roda um self-test
funcional (begin → in_progress → fail → reclaimed, e duas chamadas `reserve_gateway_usage_v1` com a
mesma `idempotency_key`) **antes do COMMIT** — se a ambiguidade não estiver realmente corrigida, a
migration inteira falha e reverte, nunca fica em estado parcial.

### Aplicar
1. SQL Editor → New query.
2. Cole `supabase/migrations/20260718020000_ai_gateway_enforcement_function_ambiguity_fix.sql` inteiro.
3. Run.
4. Esperado: `NOTICE: VALIDATION PASSED: begin_gateway_idempotent_op_v1 and reserve_gateway_usage_v1
   replaced with qualified column references; begin->in_progress->fail->reclaimed and reserve
   idempotent-retry self-tests both passed with zero ambiguity and zero residual rows; ...`
5. Se vier `ERROR: VALIDATION FAILED: ...`, a transação reverteu automaticamente (nada foi
   persistido) — pare, copie a mensagem de erro exata e reporte antes de tentar de novo.

Só prossiga para o Passo 8 depois deste sucesso — sem esta migration aplicada,
`begin_gateway_idempotent_op_v1` e `reserve_gateway_usage_v1` continuam lançando "column reference
... is ambiguous" para qualquer chamador, incluindo os Cenários 2, 3, 4, 5 e 7.

---

## PASSO 8 — Segunda migration corretiva de ambiguidade de coluna (OBRIGATÓRIA antes do Passo 9)

Com o Passo 7 aplicado, uma re-execução dos 7 cenários (ainda em 2026-07-18) avançou até o Cenário 5
— o único que passa `p_budget_scopes` não vazio para `reserve_gateway_usage_v1` — e encontrou um
segundo `ERROR: 42702: column reference "reservation_id" is ambiguous`, desta vez na cláusula
`ON CONFLICT (reservation_id, budget_bucket_id)` do `INSERT INTO ai_gateway_reservation_budget_links`
dentro de `reserve_gateway_usage_v1`. Mesma classe de causa do Passo 7 (`RETURNS TABLE(...)` injeta
uma variável PL/pgSQL por coluna de saída — aqui, a saída `reservation_id` da própria função colide
com a coluna de mesmo nome referenciada no `ON CONFLICT`), mas uma ocorrência distinta, só alcançável
pelo caminho de código do budget scope — por isso não foi pega pelo self-test do Passo 7, que não
exercita `p_budget_scopes` não vazio.

Aplica `supabase/migrations/20260718030000_ai_gateway_enforcement_budget_conflict_ambiguity_fix.sql`
— substitui `reserve_gateway_usage_v1` via `CREATE OR REPLACE FUNCTION`, trocando
`ON CONFLICT (reservation_id, budget_bucket_id)` por `ON CONFLICT ON CONSTRAINT
uq_agrbl_reservation_bucket` (o nome real da constraint UNIQUE por trás desse índice — nunca inventado,
nunca `#variable_conflict`, que mascararia a causa em vez de eliminá-la). Assinatura pública, tipo de
retorno, todas as regras de quota/orçamento/dedupe/circuit breaker/reserva, ordem de lock,
idempotência, `SECURITY DEFINER`, `search_path` e ownership preservados exatamente. Reafirma
`REVOKE`/`GRANT` de privilégio na função. Auditoria completa (execução real, não só leitura) das
outras 4 funções `RETURNS TABLE(...)` da Etapa 11 —
`_gateway_audit_database_privileges_v1`, `begin_gateway_idempotent_op_v1`, `get_gateway_breaker_state_v1`,
`record_gateway_breaker_outcome_v1` — confirmou que nenhuma compartilha essa ambiguidade. A própria
migration roda um self-test funcional **dentro de uma transação com `p_budget_scopes` não vazio**
(exatamente o caminho que antes falhava) antes do `COMMIT`, limpando os dados sintéticos do self-test
antes de confirmar — se a ambiguidade não estiver realmente corrigida, a migration inteira falha e
reverte, nunca fica em estado parcial.

### Aplicar
1. SQL Editor → New query.
2. Cole `supabase/migrations/20260718030000_ai_gateway_enforcement_budget_conflict_ambiguity_fix.sql`
   inteiro.
3. Run.
4. Esperado: uma mensagem `NOTICE` confirmando que o self-test com budget scope passou sem
   ambiguidade e sem linhas residuais, e que a auditoria das outras 4 funções `RETURNS TABLE(...)`
   não encontrou o mesmo padrão.
5. Se vier `ERROR: VALIDATION FAILED: ...`, a transação reverteu automaticamente (nada foi
   persistido) — pare, copie a mensagem de erro exata e reporte antes de tentar de novo.

Só prossiga para o Passo 9 depois deste sucesso — sem esta migration aplicada, qualquer chamada a
`reserve_gateway_usage_v1` com `p_budget_scopes` não vazio (Cenário 5, e qualquer uso real que
associe a reserva a um orçamento) continua lançando "column reference \"reservation_id\" is
ambiguous".

---

## PASSO 9 — Os 7 cenários de `ai-gateway-enforcement-concurrency.sql`

Execução no **Primary Database** (não há projeto de staging/scratch separado neste momento) — a
segurança vem do desenho do próprio script, não de isolar o projeto:
- Marcadores sintéticos exclusivos em todo identificador, período sempre no ano 2099 — nunca colide
  com tráfego real.
- Cenários 1, 2, 3, 6 e 7 rodam dentro de um único `DO` block, envolto por `BEGIN;`/`ROLLBACK;`
  explícitos no próprio arquivo — tudo que o `DO` escreve é desfeito no `ROLLBACK` final, sempre,
  PASS ou FAIL, sem depender de limpeza manual linha a linha. Sem tabela temporária: cada resultado é
  reportado via `RAISE NOTICE` (não-transacional — aparece mesmo com o `ROLLBACK` subsequente).
  `pg_advisory_xact_lock` impede duas execuções simultâneas. O usuário de teste é validado contra
  `auth.users` antes de qualquer escrita, com abort automático se não existir.
- Cenários 4 e 5 continuam exigindo duas conexões reais (a prova de concorrência depende de duas
  transações independentes correndo ao mesmo tempo — não cabe em um único `DO`), com limpeza
  explícita própria (não há `ROLLBACK` os cobrindo). Desde a homologação de 2026-07-18, os dois usam
  um protocolo determinístico: a Sessão A abre uma transação, adquire `SELECT ... FOR UPDATE` na
  mesma linha (bucket de quota no Cenário 4, bucket de orçamento no Cenário 5) que
  `reserve_gateway_usage_v1` vai travar internamente, e segura essa trava por 25 segundos reais
  (`SELECT pg_sleep(25)`) antes de chamar a função e dar `COMMIT` — isso garante que a Sessão B
  bloqueia de verdade, não depende mais de disparar as duas "na mesma respiração" e torcer para os
  timestamps se sobreporem.

**Antes de tudo:**
1. Crie um usuário descartável em Authentication → Add user, copie o UUID dele.
2. Abra `supabase/manual-validation/ai-gateway-enforcement-concurrency.sql` e substitua o UUID
   placeholder em DOIS lugares (busque `00000000-0000-0000-0000-000000000000` — cada ocorrência tem
   um comentário `← REPLACE` do lado): a linha `INSERT INTO _mv_config VALUES (...)` perto do topo
   (usada só pelos Cenários 4 e 5) e a linha `v_user_id UUID := ...` dentro do `DO $$` da seção dos
   Cenários 1/2/3/6/7 (independente de `_mv_config` — não dá para compartilhar uma tabela temporária
   entre as duas abas separadas que os Cenários 4/5 vão precisar, então essa seção nunca dependeu
   dela).
3. Não precisa editar mais nada além desses dois UUIDs.

### Cenários 1, 2, 3, 6, 7 — um único `DO` block, `BEGIN;`/`ROLLBACK;` explícitos

Copie os três comandos inteiros — `BEGIN;`, o `DO $$ ... $$;`, e `ROLLBACK;` — e rode-os juntos, de
uma vez só, na mesma execução. Rodar cada um separadamente só funciona se a mesma
aba/conexão continuar aberta entre eles; se o seu cliente abre uma conexão nova a cada clique em
"Run", o `BEGIN` não vale para os comandos seguintes e o `ROLLBACK` no fim reverte uma transação
diferente (inofensivo, mas os resultados dos `RAISE NOTICE` não terão o efeito de isolamento
pretendido). Depois de rodar, leia as mensagens `NOTICE` no painel de log/mensagens do SQL Editor
(não uma grade de resultado — de propósito, não sobra nenhuma tabela para consultar depois do
`ROLLBACK`) — uma linha `PASS` ou `FAIL` por cenário. Nenhuma linha fica persistida em nenhuma
tabela, PASS ou FAIL, sempre.

### Cenários 4 e 5 — OBRIGATÓRIO duas abas reais (execução sequencial NÃO conta)

Siga exatamente o protocolo determinístico "PROOF OF CONCURRENCY" já documentado no topo do arquivo
(SETUP item 4). Passo a passo prático:

1. Abra **duas abas separadas** do SQL Editor (não reutilize a mesma aba/conexão — isso serializa
   trivialmente e não prova nada).
2. Rode o setup do cenário (os `INSERT`s que populam o bucket — no cenário 5, também a reserva e o
   link pré-existentes que simulam os `$0.30` já reservados) em **qualquer uma** das duas abas, uma
   única vez.
3. Na **Aba A**, cole o bloco `SESSION A` inteiro do cenário — `BEGIN;`, o `SELECT ... FOR UPDATE`,
   o `SELECT pg_sleep(25)`, a chamada a `reserve_gateway_usage_v1`, e o `COMMIT;` — **não rode ainda**.
4. Na **Aba B**, cole o bloco `SESSION B` do mesmo cenário (uma única chamada a
   `reserve_gateway_usage_v1`) — **não rode ainda**.
5. Execute a Aba A.
6. A qualquer momento **enquanto a Aba A ainda está rodando** (os 25 segundos de `pg_sleep` dão uma
   margem folgada — não precisa mais ser instantâneo nem "na mesma respiração"), execute a Aba B.
7. Confirme o bloqueio real: o tempo que a Aba B reporta (`Query took Xms` no Supabase Studio) deve
   ficar próximo de quanto restava do `pg_sleep(25)` da Aba A quando você disparou B — nunca
   quase-instantâneo. Só um tempo de espera não-trivial confirma que a Aba B ficou genuinamente presa
   na trava de linha da Aba A.
8. Só depois de ambas retornarem, leia os dois resultados e confira contra o `EXPECTED` do arquivo.
9. Rode a query `SELECT reserved_quantity, committed_quantity FROM ai_gateway_quota_buckets ...`
   logo depois das duas SESSIONs (cenário 4) — ou `SELECT reserved_cost_usd FROM
   ai_gateway_budget_buckets ...` e a query de `link_count`/`link_reserved_total` (cenário 5) — para
   confirmar o estado final do bucket contra o `EXPECTED` no comentário logo acima de cada uma no
   arquivo.
10. Rode o `Cleanup` do cenário.

**Resultado esperado do cenário 4:** exatamente uma das duas chamadas retorna `status='pending'`; a
outra retorna `status='blocked', blocked_reason='QUOTA_EXCEEDED'`.
**Resultado esperado do cenário 5:** exatamente uma das duas chamadas retorna `status='pending'`; a
outra retorna `status='blocked', blocked_reason='BUDGET_EXCEEDED'`. O bucket não faz backfill
automático de `committed_cost_usd` (diferente do bucket de quota do Cenário 7) — os `$0.60` de
committed e os `$0.30` previamente reservados do setup são inteiramente sintéticos, preparados à mão.

Se qualquer cenário retornar `status='pending'` para **ambas** as chamadas, a claim de atomicidade
daquele cenário é **FALSA** — pare, não prossiga para o registro do Passo 10, e reporte o resultado
real (inclusive se for uma falha).

**Resultado real da homologação de 2026-07-18** (Primary Database, com as quatro migrations
aplicadas): todos os 7 cenários PASS. Cenário 4 — limite=600s, committed=300, previamente
reservado=250, duas tentativas concorrentes de 40s, exatamente uma pending e uma
`QUOTA_EXCEEDED`, reserved final=290, contender_count=1. Cenário 5 — limite=USD 1.00, committed
sintético=USD 0.60, previamente reservado=USD 0.30, duas tentativas concorrentes de USD 0.08,
exatamente uma pending e uma `BUDGET_EXCEEDED`, reserved final=USD 0.38, contender_count=1,
link_count=2, link_reserved_total=USD 0.38. Bloco A (Cenários 1/2/3/6/7) terminou com o `ROLLBACK`
intencional e esperado, sem persistir dados — ver a seção SUMMARY em
`ai-gateway-enforcement-concurrency.sql` para o texto completo.

---

## PASSO 10 — NÃO registrar `concurrencyValidated` até você mesmo confirmar

Eu não rodei (e não posso, à distância) o `INSERT`/`SELECT` de registro por você — a instrução do
arquivo é explícita: `record_gateway_concurrency_validation_v1` só deve ser chamada **depois** que
você observou pessoalmente os 7 resultados reais. Ela **não foi executada remotamente** como parte
desta atualização de documentação.

Com os 7 resultados reais já em mãos (passou ou falhou — registre a verdade, nunca omita uma falha):

1. Recalcule o hash do arquivo **no estado em que ele está no seu disco agora** (não confie no valor
   fixo no topo deste runbook — ele pode ter mudado se o arquivo foi editado depois):
   ```powershell
   Get-FileHash supabase\manual-validation\ai-gateway-enforcement-concurrency.sql -Algorithm SHA256
   ```
   ou rode `npx tsx scripts/ai-gateway-enforce-preflight.ts | grep "validation script hash"`.
   No momento desta homologação (2026-07-18), esse hash é
   `122d4aa5442c24a88b35fce74e8e654f5da36d337e358ea7422915b754580bec`.

2. No SQL Editor (mesma conexão service-role usada para aplicar a migration):
   ```sql
   SELECT public.record_gateway_concurrency_validation_v1(
     '20260718030000_ai_gateway_enforcement_budget_conflict_ambiguity_fix',
     'supabase/manual-validation/ai-gateway-enforcement-concurrency.sql',
     '<cole aqui o hash do Passo 10.1>',
     'passed',  -- ou 'failed' se qualquer cenário divergiu do EXPECTED
     '<seu nome/identificador técnico>',
     'Rodei os 7 cenários em 2026-07-18 contra o Primary Database. Cenários 1/2/3/6/7 via único DO+ROLLBACK (rollback intencional e esperado, Bloco A nunca persistiu dados). Cenários 4/5 confirmados com bloqueio real via lock-hold determinístico de 25s (Sessão A) — não uma sobreposição de timing por sorte.'
   );
   ```
   Essa função é `REVOKE`d de `anon`/`authenticated` — só é alcançável com acesso direto
   service-role ao banco, nunca por uma rota HTTP da aplicação.

3. Verifique com uma query de acompanhamento que existe exatamente um registro válido para essa
   versão/hash:
   ```sql
   SELECT migration_version, validation_script_sha256, status, executed_at, executed_by, notes
   FROM public.ai_gateway_concurrency_validations
   WHERE migration_version = '20260718030000_ai_gateway_enforcement_budget_conflict_ambiguity_fix'
     AND validation_script_sha256 = '122d4aa5442c24a88b35fce74e8e654f5da36d337e358ea7422915b754580bec'
     AND status = 'passed'
   ORDER BY executed_at DESC;
   -- EXPECTED: exatamente 1 linha.
   ```

4. Qualquer edição futura no arquivo `.sql` de validação (mesmo um byte) muda o hash e invalida essa
   aprovação automaticamente — o preflight volta a reportar `concurrencyValidated=false` sem
   nenhum passo manual de "invalidar".

---

## PASSO 11 — Depois da validação real: preflight e tabela das 25 features

Comando exato (requer `VITE_SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` no `.env`, ambiente
somente-leitura — o script nunca escreve):

```bash
npx tsx scripts/ai-gateway-enforce-preflight.ts
```

ou, para saída estruturada:

```bash
npx tsx scripts/ai-gateway-enforce-preflight.ts --json
```

Isso vai imprimir, por feature, os 9 campos de readiness (`codeReady`, `unitEnforcementCodeReady`,
`estimatorReady`, `pricingReady`, `costEnforcementCodeReady`, `infraDeployed`,
`concurrencyValidated`, `realtimeHardControlReady`, `enforceReadyUnit`/`enforceReadyCost`),
computados ao vivo — `infraDeployed` lido pelos probes de RPC reais (Passo 5b) **e** pelo probe de
privilégios (Passo 6, via `_gateway_audit_database_privileges_v1()`) — se esse probe encontrar
qualquer privilégio residual de anon/authenticated, `infraDeployed=false` para toda feature e o
blocker `unsafe_database_privileges` aparece separado de `infra_not_deployed` em `blockersUnit`/
`blockersCost`, para nunca esconder qual das duas causas é a real. `concurrencyValidated` lido da
tabela `ai_gateway_concurrency_validations` (Passo 10), comparado contra o `MIGRATION_VERSION` atual
(`20260718030000_ai_gateway_enforcement_budget_conflict_ambiguity_fix` — ver Passo 8).

Resultados ainda aceitáveis nesta fase (não são defeitos):
- Azure/TTS sem preço: `pricingReady=false` e `costEnforcementCodeReady` não bloqueado por isso —
  quotas por unidade (`enforceReadyUnit`) podem ficar prontas mesmo assim.
- `conversation.realtime_usage`: bloqueada para enforce enquanto `realtimeHardControlReady=false`
  (nunca testado contra produção OpenAI real nesta entrega).
- `writing.evaluate_rewrite`: bloqueada por fluxo inacessível (`dead_unreachable`).

Eu não tenho `SUPABASE_SERVICE_ROLE_KEY` neste ambiente de desenvolvimento — não consigo rodar este
comando nem produzir a tabela final de 25 linhas agora. Depois que você aplicar a migration original
(Passo 4), a correção de segurança (Passo 6), as duas correções de ambiguidade (Passos 7 e 8), rodar
os cenários (Passo 9) e registrar a validação (Passo 10), me envie a saída do comando acima (ou rode
você mesmo e leia diretamente) e eu reviso/explico o resultado.
