# Histórico de migrations de produção — captura pós-repair

Repair executado em 2026-08-01 via SQL direto (equivalente transacional a `supabase migration repair`, já que o CLI local não aceitava `--project-ref` e a senha do Postgres de produção não estava disponível) contra `supabase_migrations.schema_migrations` do projeto `jiuurvheeuwmayrfnqgm`. Nenhuma credencial neste arquivo.

## O que foi executado

Uma única transação (`BEGIN` ... `COMMIT`), com lock exclusivo da tabela, validação de pré-condições e pós-condições dentro da mesma transação (qualquer falha aborta via `RAISE EXCEPTION`, o que impede o `COMMIT` de ter efeito):

1. Pré-condições verificadas dentro da transação: exatamente 58 linhas presentes; `20260725120000` e `20260725120001` ainda não existiam; as 58 versões da lista validada (carregada de `production_migration_history_pre_repair.md`) estavam todas presentes.
2. `INSERT` marcando como aplicadas, sem executar SQL algum (o schema já existe em produção):
   - `20260725120000` — `baseline_full_database`
   - `20260725120001` — `seed_reference_data`
3. `DELETE` das 58 versões antigas listadas em `production_migration_history_pre_repair.md`.
4. Pós-condições verificadas dentro da mesma transação, antes do `COMMIT`: exatamente 2 linhas restantes, e as únicas versões são `20260725120000` e `20260725120001`.

Nenhuma tabela fora de `supabase_migrations.schema_migrations` foi referenciada em qualquer statement desta transação.

## Estado resultante (confirmado após o COMMIT, em consulta independente)

| version | name |
|---|---|
| `20260725120000` | `baseline_full_database` |
| `20260725120001` | `seed_reference_data` |

Total: 2 registros.

## Confirmação de que nada de aplicação foi alterado

Reconferido logo após o repair, comparado com os valores documentados em `inventory.md`/`equality_validation.md` (capturados antes do repair):

| Métrica | Antes | Depois |
|---|---|---|
| Tabelas em `public` | 107 | 107 |
| Functions em `public` | 202 | 202 |
| Policies (`public`+`storage`) | 174 | 174 |
| Linhas em `ai_runtime_controls` | 28 | 28 |
| Linhas em `plans` | 6 | 6 |

Nenhuma divergência.
