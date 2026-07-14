# Migrations — Lemon (english learning app)

## Regra fundamental

**Nunca executar `supabase db push` contra o banco de produção.**

Toda migration é aplicada **manualmente** no Supabase SQL Editor:
Dashboard → SQL Editor → Nova query → cole o arquivo → Execute.

---

## Estrutura de arquivos

```
supabase/
  schema.sql                    ← Schema canônico completo (estado final)
  MIGRATIONS.md                 ← Este arquivo
  verify_schema.sql             ← Script somente-leitura para verificação
  migrations/
    20260714120000_schema_integrity_baseline.sql   ← Primeira migration oficial
  migration_*.sql               ← Scripts históricos (NÃO reaplicar em produção)
```

---

## Criando um banco novo (do zero)

Execute **somente** `schema.sql`. Ele contém todas as tabelas, índices, políticas
RLS, triggers e funções no estado final esperado.

```
Dashboard → SQL Editor → Abrir schema.sql → Execute
```

Não execute os arquivos `migration_*.sql` em um banco criado pelo `schema.sql` —
eles representam o histórico de evolução incremental e causariam erros de
"policy already exists" ou "table already exists" sem o IF NOT EXISTS adequado.

---

## Banco existente em produção

Aplique **apenas** as migrations da pasta `supabase/migrations/` que ainda não
foram aplicadas, em ordem crescente pelo timestamp no nome do arquivo.

### Migrations já em produção (NÃO aplicar novamente)

Os arquivos `migration_*.sql` na raiz do diretório `supabase/` representam a
evolução histórica do banco. Assumimos que todos já foram aplicados ao banco de
produção. **Não reaplicar.**

| Arquivo | O que fez |
|---|---|
| `schema.sql` (original) | Criou `writing_entries` com RLS anon |
| `migration_generated_themes.sql` | Criou `generated_themes` |
| `migration_multiuser.sql` | Adicionou `user_id` às tabelas; criou `english_reviews`, `english_learning_memory`, `grammar_explanations` |
| `migration_add_ai_review.sql` | Adicionou `ai_review JSONB` em `writing_entries` |
| `migration_grammar_explanations.sql` | Recriou `grammar_explanations` (pode ter introduzido `anon_all`) |
| `migration_ai_conversation.sql` | Criou `ai_conversation_preferences` |
| `migration_history_persistence.sql` | Adicionou colunas de v2 em `english_reviews` |
| `migration_v2_ai_columns.sql` | Adicionou colunas de IA v2 em `writing_entries` |
| `migration_review_groups.sql` | Criou `review_groups`, `review_group_items` |
| `migration_review_attempts.sql` | Criou `review_attempts`, `review_attempt_items` |
| `migration_review_schedule.sql` | Criou `review_schedule_history`; primeira versão de `apply_review_schedule` |
| `migration_rls_authenticated.sql` | Adicionou `authenticated_all` (política incorreta — removida em 20260714120000) |
| `migration_pronunciation_assessment.sql` | Criou `pronunciation_assessments` |
| `migration_pronunciation_start.sql` | Criou `reserve_pronunciation_assessment` (2 params) e `compensate_pronunciation_assessment` |
| `migration_pronunciation_step5.sql` | Adicionou colunas de attempt; substituiu reserve por 3 params; criou complete/fail |
| `migration_pronunciation_unlimited_attempts.sql` | Versão final de reserve e fail (permite tentativas ilimitadas) |
| `migration_learning_settings.sql` | Criou `user_learning_settings`, `learning_day_overrides`; versão final de `apply_review_schedule` com weekdays |
| `migration_tutor_preferences.sql` | Expandiu `ai_conversation_preferences` com colunas de personalização |
| `migration_conversation_goal.sql` | Adicionou `daily_conversation_goal_minutes`; criou `conversation_sessions` |

### Migration a aplicar agora

```
supabase/migrations/20260714120000_schema_integrity_baseline.sql
```

**O que ela corrige:**
1. Remove `"authenticated_all"` de `writing_entries` (permitia qualquer usuário
   autenticado ler entradas de outros usuários — política incorreta).
2. Remove `"anon_all"` de `grammar_explanations` (pode ter sobrevivido por ordem
   de aplicação das migrations históricas).
3. Garante que `generated_themes` tenha políticas user-specific corretas,
   independentemente da ordem de aplicação anterior.
4. Adiciona `CHECK` constraints `NOT VALID` em `review_groups` e
   `pronunciation_assessments` (não bloqueiam dados existentes).
5. Adiciona índice `(user_id, session_date)` em `conversation_sessions`
   para acelerar `getDayTotalSeconds()`.
6. Recria `update_updated_at()` e `set_updated_at()` com `SET search_path = ''`
   (hardening contra search_path injection).

---

## Padrão para novas migrations

### Nome do arquivo

```
supabase/migrations/YYYYMMDDHHMMSS_descricao_curta.sql
```

Use UTC. Exemplo: `20260801090000_add_user_preferences_theme.sql`

### Estrutura obrigatória do arquivo

```sql
-- =============================================================================
-- MIGRATION: YYYYMMDDHHMMSS_nome
-- Projeto: Lemon
--
-- APLICAR UMA ÚNICA VEZ no Supabase SQL Editor.
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
- Toda alteração de schema deve ser refletida em `schema.sql` após a migration.

---

## Validação pós-migration

Execute `supabase/verify_schema.sql` após cada migration para confirmar:
- Que todas as tabelas esperadas existem.
- Que não há políticas `anon_all` em tabelas de usuário.
- Que os índices críticos existem.
- Que as constraints foram criadas.

O script é somente-leitura (apenas `SELECT` e `\d`) — sem efeitos colaterais.

---

## Validar constraints NOT VALID (opcional)

Após confirmar que os dados existentes são válidos (via `verify_schema.sql`),
execute separadamente para cada constraint:

```sql
-- Verifica dados existentes contra a constraint (pode demorar em tabelas grandes)
ALTER TABLE public.review_groups
  VALIDATE CONSTRAINT review_groups_level_non_negative;

ALTER TABLE public.pronunciation_assessments
  VALIDATE CONSTRAINT pa_pronunciation_score_range;
-- (repetir para pa_accuracy_score_range, pa_fluency_score_range,
--  pa_completeness_score_range, pa_prosody_score_range)
```
