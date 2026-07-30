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
  capabilities, RBAC de admin, catálogo de IA — e os controles de runtime do
  AI Gateway). Nenhum dado pessoal, operacional ou secret é copiado.
- **Um banco novo nasce exclusivamente de baseline + os dois seeds**, nessa
  ordem. Nenhuma migration anterior a `20260725120000` deve ser aplicada a um
  banco novo.
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
    20260725120002_seed_ai_runtime_controls.sql     ← seed de runtime do AI Gateway
    (futuras migrations, sempre com timestamp > 20260725120002)
  migrations_legacy/             ← histórico pré-corte, preservado, nunca reaplicar
  baseline_docs/                 ← inventário, plano de corte, prova de igualdade
```

## Regras fundamentais a partir de agora

1. **`develop` aplica migrations automaticamente, somente em homologação**
   (`ahszqexfzpbirdlkmdci`), via o workflow
   `.github/workflows/homologation.yml` (`supabase db push` no job
   `apply-migrations`, gatilhado por push em `develop`).
2. **Produção (`jiuurvheeuwmayrfnqgm`) continua sem `db push` automático.** O
   alinhamento do histórico de migrations de produção com este novo baseline
   é uma tarefa separada, deliberadamente **não realizada agora** — produção
   segue no seu próprio histórico até que essa tarefa seja executada
   explicitamente.
3. **Toda migration futura deve ter timestamp estritamente posterior a
   `20260725120002`.** `supabase/migrations/` deve conter, a qualquer
   momento, apenas os três arquivos do baseline/seeds e migrations com
   timestamp posterior a esse corte — nunca arquivos do histórico legado.
4. **Alterações manuais diretas no banco de homologação (SQL Editor, `psql`
   avulso, etc.) ficam proibidas depois deste corte.** Qualquer mudança de
   schema ou dado estrutural passa a ser, obrigatoriamente, uma nova migration
   versionada em `supabase/migrations/`, aplicada via `db push` pelo
   workflow. Isso é o que mantém `supabase migration list` e `db push`
   sincronizados entre ambientes.
5. **Nunca reaplicar** nada de `supabase/migrations_legacy/` — está ali só
   para consulta/auditoria histórica.

## Padrão para novas migrations

### Nome do arquivo

```
supabase/migrations/YYYYMMDDHHMMSS_descricao_curta.sql
```

Use UTC, e sempre um timestamp posterior a `20260725120002`.

### Regras

- Use `IF NOT EXISTS` para `CREATE TABLE`/`CREATE INDEX`/`CREATE EXTENSION`.
- Use `DROP POLICY IF EXISTS` antes de `CREATE POLICY` quando a migration
  puder rodar mais de uma vez.
- Use `NOT VALID` ao adicionar `CHECK` constraints em tabelas com dados.
- Nunca `DROP TABLE`, `DROP COLUMN` ou `DELETE FROM` sem revisão explícita do
  impacto em produção.
- A migration deve ser idempotente sempre que possível (`ON CONFLICT`,
  `IF NOT EXISTS`).

## Coordenação com `ingles-dashboad` (banco compartilhado)

`lemon-homolog` (`ahszqexfzpbirdlkmdci`) é compartilhado por dois
repositórios — `ingles` (este) e `ingles-dashboad` — cada um com seu próprio
diretório `supabase/migrations/` local. Isso já causou uma colisão real
(Etapa 2A, 2026-07-27): os dois repositórios criaram, de forma
independente, um arquivo com o **mesmo prefixo de timestamp**
(`20260727000000_...`), cada um com conteúdo completamente diferente.

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
2. **Antes de todo `db push` (manual ou via o workflow de CI
   `apply-migrations`), rode `supabase migration list --project-ref
   ahszqexfzpbirdlkmdci`** (ou a mesma consulta via MCP `list_migrations`) e
   confira que todo arquivo local novo tem uma versão que ainda NÃO aparece
   no remoto, E que nenhum arquivo novo colide, por prefixo, com nada
   listado — nem deste repositório, nem (verificando manualmente o
   diretório vizinho) do `ingles-dashboad`.
3. **Toda migration nova neste repositório usa um timestamp estritamente
   posterior à MAIOR versão conhecida em `schema_migrations`** (não apenas
   à maior versão entre os arquivos locais) — a Etapa 2A passou a numerar a
   partir de `20260727223126` por esse motivo exato.
4. Isso não corrige a divergência já existente da migration do
   `ingles-dashboad` (fora de escopo alterar o histórico remoto ou o outro
   repositório) — só evita que o problema se repita daqui para frente.

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
