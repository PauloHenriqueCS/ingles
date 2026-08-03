# Migrations — Lemon (english learning app)

## O corte de baseline (2026-07-25)

O histórico de migrations anterior a `20260725120000` não conseguia reconstruir o
banco do zero de forma confiável (timestamps de `name` e `version` divergentes,
migrations `fix_*` sem uma migration original correspondente, dependências
implícitas de ordem de aplicação). Um baseline completo foi gerado por
introspecção read-only direta de produção e testado exaustivamente em
homologação antes deste corte — ver `supabase/baseline_docs/` para o
inventário completo, o plano de corte e a prova de igualdade estrutural
usados nessa validação.

**A partir deste corte:**

- **`20260725120000_baseline_full_database.sql` é o novo baseline oficial.**
  Contém o schema inteiro (extensions, enums, 107 tabelas, constraints,
  índices, views, functions, triggers, RLS, policies, grants) capturado de
  produção.
- **`20260725120001_seed_reference_data.sql`** e
  **`20260725120002_seed_ai_runtime_controls.sql`** são os dois seeds
  estruturais que acompanham o baseline (dados de referência — planos,
  capabilities, RBAC de admin, catálogo de IA, preços de provedores,
  definições de app_config — e os controles de runtime do AI Gateway).
  Nenhum dado pessoal, operacional ou secret é copiado.
- **`20260725120002_seed_ai_runtime_controls.sql` existe apenas em
  `develop`/homologação — não faz parte do corte de produção.** É um ajuste
  específico de `lemon-homolog` (preenche `ai_runtime_controls`, que nasceu
  vazio nesse projeto) e nunca deve ser aplicado em produção, onde essa
  tabela já tem as 28 linhas reais desde o histórico antigo.
- **Um banco de homologação novo nasce de baseline + os dois seeds, nessa
  ordem. Um banco de produção novo nasce de baseline + `seed_reference_data`
  apenas** (sem `seed_ai_runtime_controls`). Nenhuma migration anterior a
  `20260725120000` deve ser aplicada a um banco novo.
- **Toda migration anterior ao corte foi preservada, sem alteração de SQL ou
  conteúdo, em `supabase/migrations_legacy/`** — histórico e auditoria, nunca
  para reaplicação:
  - `supabase/migrations_legacy/*.sql` — as migrations datadas que estavam em
    `supabase/migrations/`.
  - `supabase/migrations_legacy/loose_scripts/` — os scripts soltos
    `migration_*.sql` que existiam na raiz de `supabase/`.
  - `supabase/migrations_legacy/schema.sql` — o dump de schema legado,
    pré-baseline (não é mais o schema canônico; mantido só como referência
    histórica).
  - `supabase/migrations_legacy/__tests__/` — o teste estático que valida uma
    dessas migrations legadas, movido junto com o arquivo que ele referencia.

## Estrutura de arquivos

```
supabase/
  MIGRATIONS.md                 ← Este arquivo
  migrations/
    20260725120000_baseline_full_database.sql       ← baseline oficial
    20260725120001_seed_reference_data.sql          ← seed estrutural
    20260725120002_seed_ai_runtime_controls.sql     ← seed de runtime do AI Gateway (só develop/homolog)
    (futuras migrations, sempre com timestamp > 20260725120002)
  migrations_legacy/             ← histórico pré-corte, preservado, nunca reaplicar
  baseline_docs/                 ← inventário, plano de corte, prova de igualdade
```

## Regras fundamentais a partir de agora

1. **`develop` aplica migrations automaticamente em homologação**
   (`ahszqexfzpbirdlkmdci`), via o workflow
   `.github/workflows/homologation.yml` (`supabase db push` no job
   `apply-migrations`, gatilhado por push em `develop`).
2. **`main` aplica migrations automaticamente em produção**
   (`jiuurvheeuwmayrfnqgm`), via o workflow
   `.github/workflows/deploy-production.yml` (`supabase db push`), depois de
   um merge na branch `main` — nunca manualmente no SQL Editor e nunca antes
   dos testes/build/dry-run passarem.
3. **Toda migration futura deve ter timestamp estritamente posterior a
   `20260725120002`.** `supabase/migrations/` deve conter, a qualquer
   momento, apenas os três arquivos do baseline/seeds e migrations com
   timestamp posterior a esse corte — nunca arquivos do histórico legado.
4. **Alterações manuais diretas nos bancos de homologação ou produção (SQL
   Editor, `psql` avulso, tool `apply_migration` do MCP para qualquer coisa
   que deva ficar rastreada) ficam proibidas depois deste corte.** Qualquer
   mudança de schema ou dado estrutural passa a ser, obrigatoriamente, uma
   nova migration versionada em `supabase/migrations/`, aplicada via
   `db push` pelo workflow correspondente. Isso é o que mantém
   `supabase migration list` e `db push` sincronizados entre ambientes.
5. **Nunca reaplicar** nada de `supabase/migrations_legacy/` — está ali só
   para consulta/auditoria histórica.

## Deploy de produção

A ordem da release é:

1. testes;
2. build;
3. dry-run das migrations;
4. aplicação das migrations;
5. confirmação do histórico;
6. build e deploy da Vercel;
7. smoke test.

Se uma migration falhar, o código não é publicado na Vercel.

## Padrão para novas migrations

### Nome do arquivo

```
supabase/migrations/YYYYMMDDHHMMSS_descricao_curta.sql
```

Use UTC, e sempre um timestamp posterior a `20260725120002`.

### Estrutura obrigatória do arquivo

```sql
-- =============================================================================
-- MIGRATION: YYYYMMDDHHMMSS_nome
-- Projeto: Lemon
--
-- Aplicada automaticamente por .github/workflows/deploy-production.yml
-- (supabase db push) após o merge na main. Não aplicar manualmente no SQL
-- Editor — isso desalinha o histórico de `supabase migration list`.
-- Esta migration NÃO modifica nem remove dados existentes.
-- =============================================================================

-- ... SQL aqui ...

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
```

### Regras

- Use `IF NOT EXISTS` para `CREATE TABLE`, `CREATE INDEX`, `CREATE UNIQUE INDEX`, `CREATE EXTENSION`.
- Use `DROP POLICY IF EXISTS` antes de `CREATE POLICY` quando a migration
  puder rodar mais de uma vez.
- Use `DO $$ BEGIN ... IF NOT EXISTS ... END; $$;` para adicionar constraints.
- Use `NOT VALID` ao adicionar `CHECK` constraints em tabelas com dados.
- Nunca `DROP TABLE`, `DROP COLUMN` ou `DELETE FROM` sem revisão explícita do
  impacto em produção.
- A migration deve ser idempotente sempre que possível (`ON CONFLICT`,
  `IF NOT EXISTS`).

## Validação pós-migration

Execute `supabase/verify_schema.sql` após cada migration para confirmar:
- Que todas as tabelas esperadas existem.
- Que não há políticas `anon_all` em tabelas de usuário.
- Que os índices críticos existem.
- Que as constraints foram criadas.

O script é somente-leitura (apenas `SELECT` e `\d`) — sem efeitos colaterais.

## Coordenação com `ingles-dashboad` (banco compartilhado)

`jiuurvheeuwmayrfnqgm` (produção) e `ahszqexfzpbirdlkmdci` (`lemon-homolog`)
são compartilhados por dois repositórios — `ingles` (este) e
`ingles-dashboad` — cada um com seu próprio diretório `supabase/migrations/`
local. Isso já causou uma colisão real (Etapa 2A, 2026-07-27): os dois
repositórios criaram, de forma independente, um arquivo com o **mesmo
prefixo de timestamp** (`20260727000000_...`), cada um com conteúdo
completamente diferente.

**Achado ao investigar (leitura de `supabase_migrations.schema_migrations`
via MCP, `list_migrations`)**: a migration do `ingles-dashboad` está
registrada no remoto sob a versão `20260727223126` — **diferente** do
prefixo do nome do arquivo local (`20260727000000`). Isso confirma que ela
não foi aplicada via `supabase db push` a partir do arquivo local commitado
(que teria registrado a versão exatamente como `20260727000000`) — foi
aplicada por outro caminho (o mais provável: a tool MCP `apply_migration`,
que gera sua própria versão no momento da chamada, ou uma reconciliação
manual via `supabase migration repair`). O mesmo padrão já era conhecido
antes desta etapa — ver `supabase/baseline_docs/migration_history_plan.md`,
que documenta `version` (horário real de aplicação) divergindo de `name`
(timestamp de autoria) no histórico de produção.

**Recomendação concreta para evitar reaplicação/drift futuros:**

1. **Nunca aplicar uma migration que deveria ficar rastreada em
   `supabase/migrations/` usando a tool `apply_migration` do MCP do
   Supabase, ou SQL manual (SQL Editor, `psql` avulso).** Esses caminhos geram uma
   versão própria no `schema_migrations`, que nunca bate com o timestamp do
   arquivo local — é exatamente essa divergência que torna
   `supabase migration list`/`db push` não confiáveis para detectar "já
   aplicada". Reserve `apply_migration` (MCP) só para exploração/scratch que
   nunca vira arquivo commitado.
2. **Antes de todo `db push` (manual ou via workflow de CI, `apply-migrations`
   ou `deploy-production.yml`), rode `supabase migration list --project-ref
   <ref>`** (ou a mesma consulta via MCP `list_migrations`) e confira que
   todo arquivo local novo tem uma versão que ainda NÃO aparece no remoto, E
   que nenhum arquivo novo colide, por prefixo, com nada listado — nem deste
   repositório, nem (verificando manualmente o diretório vizinho) do
   `ingles-dashboad`.
3. **Toda migration nova neste repositório usa um timestamp estritamente
   posterior à MAIOR versão conhecida em `schema_migrations`** (não apenas
   à maior versão entre os arquivos locais) — a Etapa 2A passou a numerar a
   partir de `20260727223126` por esse motivo exato.
4. Isso não corrige a divergência já existente da migration do
   `ingles-dashboad` (fora de escopo alterar o histórico remoto ou o outro
   repositório) — só evita que o problema se repita daqui para frente.
5. **Quando `supabase migration list`/`db push --dry-run` (local ou no
   workflow de CI) mostrar uma versão remota pertencente ao
   `ingles-dashboad` sem arquivo local correspondente** (bloqueando
   qualquer push seguinte, mesmo de migrations legítimas deste
   repositório — caso real: `20260803000000 plans_store_ids`, 2026-08-03),
   este repositório recebe um **arquivo marcador** em
   `supabase/migrations/` com o mesmo timestamp e nome, contendo **apenas
   comentários** (nenhum DDL/DML/GRANT/REVOKE/chamada de função) — nunca
   uma cópia do SQL real, que continua propriedade exclusiva do
   `ingles-dashboad`. O marcador só alinha o histórico local ao remoto para
   o CLI parar de bloquear; migrations próprias deste repositório continuam
   contendo o SQL real normalmente. Nunca usar `apply_migration` (MCP) nem
   `supabase migration repair`/edição direta de
   `supabase_migrations.schema_migrations` para isso — essas rotas geram ou
   alteram histórico fora do fluxo versionado por arquivo, exatamente o que
   este documento já pede para evitar.

## Onde encontrar mais contexto

- `supabase/baseline_docs/inventory.md` — inventário completo do que existe
  em produção (extensions, schemas, tabelas, functions, policies, grants,
  cron, Storage, ownership Lemon/ingles-dashboad).
- `supabase/baseline_docs/out_of_schema_config.md` — o que não é reproduzido
  pelo dump SQL (Auth, SMTP, redirects, secrets, Storage, Edge Functions) e o
  que fazer a respeito em cada ambiente.
- `supabase/baseline_docs/equality_validation.md` — script de fingerprint
  para comparar estrutura entre produção e homologação.
- `supabase/baseline_docs/migration_history_plan.md` — o plano original de
  corte, incluindo o estado do histórico de produção antes desta mudança.
