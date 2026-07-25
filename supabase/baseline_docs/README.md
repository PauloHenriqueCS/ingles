# Baseline candidato — Lemon + ingles-dashboad (produção → homologação)

Gerado em 2026-07-25, 100% a partir de introspecção **read-only** de produção (`jiuurvheeuwmayrfnqgm`). **Nada nesta pasta foi aplicado** — nem em produção, nem em homologação (`ahszqexfzpbirdlkmdci`, que segue vazia). Isto é planejamento e preparação, aguardando autorização para os próximos passos.

## Arquivos nesta pasta

| Arquivo | Etapa | Conteúdo |
|---|---|---|
| `20260725120000_baseline_full_database.sql` | 2 | Schema completo de produção: extensions, enums, 107 tabelas, PK/UNIQUE/FK/CHECK (715 constraints), 205 índices, 1 view, 202 functions, coluna gerada, 58 triggers, RLS + 174 policies, 933 grants, bucket de Storage + suas 2 policies, cron documentado (não agendado) |
| `20260725120001_seed_reference_data.sql` | 3 | Seed idempotente (`ON CONFLICT`) de 10 tabelas de referência: RBAC do admin (roles/permissions/role_permissions), catálogo de capabilities, planos/versões/valores, catálogo de AI features, tabela de preços de provedores, definições de app_config |
| `inventory.md` | 1 | Inventário completo com contagens, ownership (Lemon/dashboard/ambos) e o que não deu para inventariar |
| `out_of_schema_config.md` | 4 | Tudo que o dump SQL não cobre (Auth, SMTP, redirects, secrets, cron, config de projeto) — o que é igual vs. específico do ambiente |
| `equality_validation.md` | 5 | Script de fingerprint (hash) para comparar produção × homologação depois de aplicar |
| `migration_history_plan.md` | 6 | Estado atual das 61 migrations de produção vs. as 0 de homologação, e exatamente quais comandos de `migration repair` seriam necessários — nada executado |

## Como este baseline foi construído

Toda linha de DDL veio de introspecção via `pg_catalog`/`information_schema` (`pg_get_constraintdef`, `pg_get_indexdef`, `pg_get_functiondef`, `pg_get_triggerdef`, `pg_get_viewdef`, `pg_policies`) — não é uma cópia manual, é o texto real de definição de cada objeto em produção, capturado por SELECT. Os únicos ajustes manuais foram de **ordenação** (FKs depois de todas as tabelas existirem; a única coluna gerada depois das funções, porque ela depende de uma função) — nunca de conteúdo.

## Dados estruturais incluídos vs. propositalmente fora do seed

**Incluído** (Etapa 3): planos, limites/capabilities, RBAC do admin, catálogo de features de IA, preços de provedores, definições de app_config — exatamente o pedido.

**Fora do seed, com motivo específico** (não foi escolha arbitrária):
- `auth.users`, sessões, textos/histórias/áudios gerados, avaliações, consumo, logs, dados pessoais — excluídos por instrução explícita.
- `app_config_versions`/`values`, `ai_pricing_versions`/`rates`, `ai_gateway_config_versions`/`configs`, `admin_security_configs`/`policy_versions` — **não** são dados pessoais nem operacionais, mas têm `created_by`/`published_by` `NOT NULL` referenciando `auth.users`. Não dá para semear via INSERT direto sem um usuário real existindo em homologação. Ver `out_of_schema_config.md` para o passo (bootstrap de um admin `owner`) que destrava isso via função administrativa, depois que o baseline for aplicado.

## Riscos e ambiguidades identificados

1. **3 dos 5 planos parecem artefatos de teste/dev** (`Teste`/22112, `Ilimitado`/24317180, `desligado`) — incluídos fielmente no seed (é o que existe em produção), mas vale decidir antes de aplicar se algum deve ser excluído manualmente do seed.
2. **Cron job roda a cada minuto** (`conversation-sweep-stale-sessions`) — documentado no baseline mas **não agendado automaticamente**, para não gerar execução contra dados ainda não validados em homolog. Decisão de ativar fica para depois de aplicar e validar.
3. **Ownership de tabelas compartilhadas é inferido**, não confirmado no código do dashboard (que não está neste repositório) — baixo risco, porque nenhum objeto foi excluído por causa disso de qualquer forma.
4. **Secrets do Vault** (`cron_secret`, `app_base_url`) precisam de **valores novos** em homologação — nunca os mesmos de produção; `app_base_url` em particular, se copiado errado, faria homolog apontar callbacks/webhooks para a URL de produção.
5. **Grants inconsistentes entre tabelas antigas e novas**: tabelas mais antigas (ex. `admin_audit_log`) têm grant total (`DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE`) para `anon`/`authenticated` diretamente — mitigado só por RLS, não pelo GRANT. Isso é o comportamento *real* de produção e foi reproduzido fielmente; não é um bug introduzido por este baseline, mas vale ciência de que RLS é a única barreira nessas tabelas mais antigas (migration `20260723000000_revoke_new_tables_default_grants_and_extend_privilege_audit` sugere que isso já foi endereçado para tabelas *novas*, não retroativamente).
6. **Extensions da homologação precisam bater com as 8 de produção** antes de aplicar o baseline (`uuid-ossp`, `pgcrypto`, `pg_stat_statements`, `pg_net`, `pg_cron`, `pg_graphql`, `supabase_vault` — `plpgsql` já vem por padrão). O baseline já inclui `CREATE EXTENSION IF NOT EXISTS` para todas.
7. **Migration history de produção tem nomes/timestamps não-lineares** (documentado em `migration_history_plan.md`) — confirma a premissa do usuário de que não dá para reconstruir do zero a partir dela.

## Próximos passos (todos aguardando autorização — nenhum foi feito)

1. Revisar os 6 documentos e o SQL candidato.
2. Decidir sobre os 3 planos de teste (manter ou remover do seed).
3. Autorizar mover o baseline para `supabase/migrations/` com timestamp real de corte, e rodar `migration repair` em produção (Etapa 6).
4. Aplicar baseline + seed em homologação.
5. Rodar o fingerprint de `equality_validation.md` nos dois projetos e comparar.
6. Bootstrapar 1 admin `owner` em homologação e usar as funções administrativas para publicar `app_config`/`ai_pricing`/`ai_gateway_config` com os mesmos valores de produção.
7. Decidir se/quando ativar o cron job em homologação.
