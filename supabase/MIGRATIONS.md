# Migrations — Lemon (english learning app)

## O corte de baseline (2026-07-25)

O histórico de migrations anterior a `20260725120000` não conseguia reconstruir o
banco do zero de forma confiável (timestamps de `name` e `version` divergentes,
migrations `fix_*` sem uma migration original correspondente, dependências
implícitas de ordem de aplicação). Um baseline completo foi gerado por
introspecção read-only direta de produção — ver `supabase/baseline_docs/` para
o inventário completo, o plano de corte e a prova de igualdade estrutural
usados nessa validação.

**A partir deste corte:**

- **`20260725120000_baseline_full_database.sql` é o novo baseline oficial.**
  Contém o schema inteiro (extensions, enums, 107 tabelas, constraints,
  índices, views, functions, triggers, RLS, policies, grants) capturado de
  produção.
- **`20260725120001_seed_reference_data.sql`** é o seed estrutural idempotente
  que acompanha o baseline (dados de referência — planos, capabilities, RBAC
  de admin, catálogo de IA, preços de provedores, definições de
  app_config). Nenhum dado pessoal, operacional ou secret é copiado.
- **Um banco novo nasce exclusivamente de baseline + seed**, nessa ordem.
  Nenhuma migration anterior a `20260725120000` deve ser aplicada a um banco
  novo.
- **Toda migration anterior ao corte foi preservada, sem alteração de SQL ou
  conteúdo, em `supabase/migrations_legacy/`** — histórico e auditoria, nunca
  para reaplicação (arquivos datados, `loose_scripts/` com os antigos
  `migration_*.sql` da raiz, `schema.sql` legado e `__tests__/`).
- **`20260725120002_seed_ai_runtime_controls.sql` existe apenas em
  `develop`/homologação — não faz parte deste corte de produção.** É um
  ajuste específico de `lemon-homolog` (preenche `ai_runtime_controls`, que
  nasceu vazio nesse projeto) e nunca deve ser aplicado em produção, onde
  essa tabela já tem as 28 linhas reais desde o histórico antigo.

## Estrutura de arquivos

```
supabase/
  MIGRATIONS.md                 ← Este arquivo
  migrations/
    20260725120000_baseline_full_database.sql       ← baseline oficial
    20260725120001_seed_reference_data.sql          ← seed estrutural
    (futuras migrations, sempre com timestamp > 20260725120001)
  migrations_legacy/             ← histórico pré-corte, preservado, nunca reaplicar
  baseline_docs/                 ← inventário, plano de corte, prova de igualdade
```

## Regras fundamentais a partir de agora

1. **Migrations versionadas em `supabase/migrations/` são aplicadas
   automaticamente contra produção** pelo workflow
   `.github/workflows/deploy-production.yml` (`supabase db push`), depois de
   um merge na branch `main` — nunca manualmente no SQL Editor e nunca antes
   dos testes/build/dry-run passarem.
2. **Toda migration futura deve ter timestamp estritamente posterior a
   `20260725120001`.** `supabase/migrations/` deve conter, a qualquer
   momento, apenas o baseline/seed oficiais e migrations com timestamp
   posterior a esse corte — nunca arquivos do histórico legado.
3. **Alterações manuais diretas no banco de produção (SQL Editor, `psql`
   avulso, tool `apply_migration` do MCP para qualquer coisa que deva ficar
   rastreada) ficam proibidas.** Qualquer mudança de schema ou dado
   estrutural é, obrigatoriamente, uma nova migration versionada em
   `supabase/migrations/`, aplicada via `db push` pelo workflow. Isso é o
   que mantém `supabase migration list` e `db push` sincronizados.
4. **Nunca reaplicar** nada de `supabase/migrations_legacy/` — está ali só
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

## Coordenação com `ingles-dashboad` (banco compartilhado)

`jiuurvheeuwmayrfnqgm` (produção) e `ahszqexfzpbirdlkmdci` (`lemon-homolog`)
são compartilhados por dois repositórios — `ingles` (este) e
`ingles-dashboad` — cada um com seu próprio diretório `supabase/migrations/`
local. Isso já causou uma colisão real em homologação (2026-07-27): os dois
repositórios criaram, de forma independente, um arquivo com o **mesmo
prefixo de timestamp**, cada um com conteúdo completamente diferente.

**Para evitar reaplicação/drift:**

1. **Nunca aplicar uma migration que deveria ficar rastreada em
   `supabase/migrations/` usando a tool `apply_migration` do MCP do
   Supabase, ou SQL manual.** Esses caminhos geram sua própria versão em
   `schema_migrations`, que nunca bate com o timestamp do arquivo local.
2. **Antes de todo `db push` (manual ou via CI), rode `supabase migration
   list --project-ref <ref>`** (ou a mesma consulta via MCP
   `list_migrations`) e confira que todo arquivo local novo tem uma versão
   que ainda NÃO aparece no remoto, e que nenhum arquivo novo colide, por
   prefixo, com nada listado — nem deste repositório, nem do
   `ingles-dashboad`.
3. **Toda migration nova usa um timestamp estritamente posterior à MAIOR
   versão conhecida em `schema_migrations`** (não apenas à maior versão
   entre os arquivos locais).

## Padrão para novas migrations

### Nome do arquivo

```
supabase/migrations/YYYYMMDDHHMMSS_descricao_curta.sql
```

Use UTC, e sempre um timestamp posterior a `20260725120001`. Exemplo:
`20260801090000_add_user_preferences_theme.sql`.

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

- Use `IF NOT EXISTS` para `CREATE TABLE`, `CREATE INDEX`, `CREATE UNIQUE INDEX`.
- Use `DROP POLICY IF EXISTS` antes de `CREATE POLICY`.
- Use `DO $$ BEGIN ... IF NOT EXISTS ... END; $$;` para adicionar constraints.
- Use `NOT VALID` ao adicionar `CHECK` constraints em tabelas com dados.
- Nunca `DROP TABLE`, `DROP COLUMN` ou `DELETE FROM` em migrations de produção.
- A migration deve ser idempotente sempre que possível (`ON CONFLICT`,
  `IF NOT EXISTS`).

## Validação pós-migration

Execute `supabase/verify_schema.sql` após cada migration para confirmar:
- Que todas as tabelas esperadas existem.
- Que não há políticas `anon_all` em tabelas de usuário.
- Que os índices críticos existem.
- Que as constraints foram criadas.

O script é somente-leitura (apenas `SELECT` e `\d`) — sem efeitos colaterais.

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
