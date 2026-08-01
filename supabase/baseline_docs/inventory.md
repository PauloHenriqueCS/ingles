# Etapa 1 — Inventário completo de produção (jiuurvheeuwmayrfnqgm)

Levantado 100% via SELECT read-only contra produção (nenhuma escrita). Homologação (`ahszqexfzpbirdlkmdci`) não foi consultada nesta etapa — seu estado (0 tabelas, 0 migrations) já era conhecido de um passo anterior desta mesma sessão.

## Contagens por categoria

| Categoria | Contagem |
|---|---|
| Schemas não-sistema | 12 (`auth, cron, extensions, graphql, graphql_public, net, pgbouncer, public, realtime, storage, supabase_migrations, vault`) — **nenhum schema de aplicação além de `public`** |
| Extensions instaladas | 8 (`uuid-ossp, pgcrypto, pg_stat_statements, pg_net, pg_cron, pg_graphql, supabase_vault, plpgsql`) |
| Tabelas (schema `public`) | 107 |
| Enums | 13 |
| Tipos compostos | 0 |
| Sequences standalone | 0 (todas as PKs usam `gen_random_uuid()`, nenhum `serial`/`identity` clássico) |
| Colunas geradas (`GENERATED ALWAYS AS ... STORED`) | 1 (`listening_episodes.level_group`) |
| Primary keys | 107 |
| Unique constraints | 56 |
| Foreign keys | 195 |
| Check constraints | 357 |
| Índices extras (fora de PK/UNIQUE) | 205 |
| Views | 1 (`listening_questions_public`) |
| Materialized views | 0 |
| Functions/procedures | 202 (162 `SECURITY DEFINER`, 40 sem `SECURITY DEFINER` — majoritariamente triggers/helpers de guarda de imutabilidade) |
| Triggers | 58 (`information_schema.triggers` mostra 78 porque conta cada evento combinado — INSERT/UPDATE/DELETE — como linha separada) |
| RLS habilitado | 107/107 tabelas (100%) |
| Policies | 172 em `public` + 2 em `storage.objects` = 174 |
| Grants (tabelas + funções, para `anon/authenticated/service_role/postgres`) | 933 (400 de tabelas, 533 de funções) |
| Cron jobs (`pg_cron`) | 1 (`conversation-sweep-stale-sessions`, `* * * * *`) |
| Secrets no Vault | 2 (`cron_secret`, `app_base_url` — metadados apenas, valores nunca lidos) |
| Storage buckets | 1 (`listening-audio`, privado, 100MB, mp3) |
| Edge Functions | 0 |
| Migrations aplicadas (`supabase_migrations.schema_migrations`) | 61 |

## Schemas próprios

Só `public` contém objetos de aplicação. Os outros 11 schemas são 100% padrão de fábrica do Supabase/extensões (`auth`, `storage`, `realtime`, `graphql`/`graphql_public`, `vault`, `pgbouncer`, `supabase_migrations`, `extensions`) ou criados por extensão habilitada (`cron` por `pg_cron`, `net` por `pg_net`).

## Customizações em `auth`/`storage`

- **`auth`**: **nenhuma customização** encontrada — 0 triggers, 0 funções, 0 colunas extras além do padrão Supabase. Nenhum `handle_new_user` ou equivalente.
- **`storage`**: tabelas são as padrão da versão atual da extensão Storage (`buckets`, `buckets_analytics`, `buckets_vectors`, `migrations`, `objects`, `s3_multipart_uploads`, `s3_multipart_uploads_parts`, `vector_indexes`) — `buckets_analytics`/`buckets_vectors`/`vector_indexes` não são customização do Lemon, são recursos nativos da extensão. A customização real é: **1 bucket** (`listening-audio`) e **2 policies próprias** em `storage.objects` (`deny_authed_listening_audio`, `service_role_all_listening_audio`), ambas cobertas no baseline (seção 14).

## `app_config_*` (Central de Configuração)

4 tabelas: `app_config_definitions` (12 linhas, catálogo — seedado), `app_config_versions`, `app_config_values`, `app_config_acknowledgements` (estas 3 vazias/quase vazias em produção hoje — 1/12/102 linhas respectivamente — mas dependem de `created_by NOT NULL`, então não seedadas; ver `out_of_schema_config.md`). Corresponde ao desenho descrito em `src/server/product-config/service.ts`, `src/hooks/usePublicConfig.ts` e à migration local `supabase/migrations/20260725000000_bootstrap_product_config_consumer_subset.sql` deste repositório — confirmado como o mesmo sistema, não uma coincidência de nomes.

## Objetos administrativos do ingles-dashboad

Identificados por padrão de nome (`admin_*`) e por não aparecerem referenciados em `src/`/`api/` deste repositório (grep dedicado, ver seção Ownership): `admin_users`, `admin_roles`, `admin_permissions`, `admin_role_permissions`, `admin_invitations`, `admin_audit_log`, `admin_security_configs`, `admin_security_policy_versions`, `admin_security_events`, `admin_rate_limit_buckets` — 10 tabelas, todas com RLS + policies `is_active_admin()`/`get_admin_role() = 'owner'`, nenhuma excluída do baseline.

## Ownership (Lemon / ingles-dashboad / ambos)

Atribuição por grep neste repositório (`src/`, `api/`) cruzado com padrão de nome — marcado como **inferido** onde o código do dashboard não está disponível para confirmar diretamente.

| Ownership | Tabelas (amostra representativa, não exaustiva — ver baseline SQL para a lista completa de 107) |
|---|---|
| **Lemon** (referenciado direto em `src/`/`api/` deste repo) | `writing_entries`, `english_reviews`, `english_learning_memory`, `generated_themes`, `grammar_explanations`, `review_groups`/`review_group_items`/`review_attempts`/`review_attempt_items`/`review_schedule_history`, `learner_skill_profiles`, `learning_day_overrides`, `pronunciation_assessments`, `pronunciation_training_sessions`, `ai_conversation_preferences`, `conversation_sessions`, `conversation_session_authorizations`, `api_rate_limits`, `user_conversation_credits`, `user_account_deactivations`, `user_billing_blocks`, `user_communication_blocks`, `realtime_hard_control_validations`, `engine_activation_log`, `listening_episodes`/`listening_blocks`/`listening_sentences`/`listening_questions`/`listening_subtitle_cues`/`listening_*_timings`/`listening_audio_assets`/`listening_shared_stories`/`listening_jobs`/`listening_generation_requests`, `user_listening_*` (todas), `writing_rewrite_*` (todas), `writing_review_reservations` |
| **ingles-dashboad** (inferido — só `admin_*`, sem referência em código Lemon) | `admin_users`, `admin_roles`, `admin_permissions`, `admin_role_permissions`, `admin_invitations`, `admin_audit_log`, `admin_security_configs`, `admin_security_policy_versions`, `admin_security_events`, `admin_rate_limit_buckets` |
| **Ambos (confirmado — Lemon lê/grava via `api/_ai-gateway/*`, `api/_entitlements/*`, `api/_account/audit.ts`; dashboard escreve via funções `admin_*_v1`)** | `plans`, `plan_versions`, `plan_capability_values`, `plan_trial_policies`, `capability_definitions`, `user_plan_assignments`, `user_capability_overrides`, `user_access_controls`, todas as `ai_gateway_*`, `ai_pricing_*`, `ai_features`, `ai_budget_policies`, `ai_control_switches`, `ai_alert_rules`, `ai_alerts`, `ai_cost_valuations`, `ai_runtime_controls`, `ai_usage_events`, `ai_usage_event_metrics`, `ai_provider_sessions`, `provider_pricing`, `usage_daily`, `usage_daily_metrics`, `usage_reservations`, `usage_reservation_items`, `gateway_heartbeats`, `app_config_*` (todas as 4), `listening_operational_alerts`, `listening_audio_flags`, `listening_episode_distribution`, `listening_episode_publications`, `listening_generation_jobs` |

**Nenhum objeto foi excluído do baseline por pertencer ao dashboard** — todas as 107 tabelas, 202 funções, 58 triggers e 174 policies estão no arquivo SQL candidato, independente de ownership.

## Dependências diretas e transitivas

- Toda FK aponta só para `auth.users` (extern) ou para outra tabela de `public` (interna) — nenhuma dependência cross-schema além de `auth`.
- A única dependência de ordenação não-trivial no baseline é a coluna gerada `listening_episodes.level_group`, que depende da função `listening_level_group_for_cefr` — resolvida no baseline criando a coluna **depois** da seção de functions (seção 10, pós-seção 9).
- `capability_definitions.dependency_key` é uma FK auto-referenciada, mas **nenhuma linha em produção tem esse campo preenchido** — sem risco de ordenação circular no seed.

## O que não foi possível inventariar

- Configurações de projeto fora do banco (Auth providers, SMTP, redirect URLs, tamanho de compute, PITR) — exigem Management API/Dashboard, não SQL. Documentado como lacuna em `out_of_schema_config.md`.
- Conteúdo real dos 2 secrets do Vault (por design — nunca descriptografados nesta tarefa).
- Código-fonte do `ingles-dashboad` (não está neste repositório) — ownership de tabelas `admin_*`/compartilhadas é inferido por padrão de nome e grep no repo Lemon, não confirmado lendo o dashboard diretamente.
