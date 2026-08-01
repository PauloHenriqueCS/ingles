# Etapa 6 — Corte do histórico de migrations (proposta, nada executado)

## Estado atual lido (read-only) em cada projeto

### Produção (`jiuurvheeuwmayrfnqgm`) — `supabase_migrations.schema_migrations`: 61 registros

```
20260716003802  20260715200000_create_listening_jobs
20260716003824  20260715160000_create_listening_block_sessions
20260716003827  20260715210000_create_listening_assignments
20260716003841  20260715220000_create_listening_results
20260716003923  20260715240000_create_listening_cron_jobs
20260716162104  listening_story_completion
20260717022117  fix_listening_rls_and_conversation_date
20260718015737  fix_assignment_rpc_authorization
20260718022310  capability_schema_evolution
20260718022658  ai_gateway_observability_gateway_heartbeats
20260718022937  ai_gateway_control
20260718023232  ai_gateway_pricing
20260718023437  product_config_center
20260718035610  20260717900000_listening_content_operations
20260718040503  fix_users_and_config_versions_functions
20260718054736  plan_visibility_capability_entitlements_and_conversation_credits
20260718082115  listening_multi_story_per_day
20260718082130  publish_plan_version_requires_complete_capabilities
20260721152515  fix_gateway_ledger_schema_drift
20260721212734  20260721000000_ai_gateway_provider_pricing_tts_and_azure_speech
20260721212749  20260721010000_conversation_session_server_authoritative
20260721212814  20260722000000_realtime_hard_control_validation
20260721221259  fix_plan_assignment_and_capability_override_concurrency
20260721222505  fix_gateway_reprocessing_and_listening_schema_drift
20260721222615  fix_listening_subtitle_cues_status_column
20260721223210  add_listening_jobs_readonly_visibility
20260721224418  20260723000000_revoke_new_tables_default_grants_and_extend_privilege_audit
20260721224512  20260723010000_realtime_hard_control_evidence_schema
20260721224536  20260723020000_conversation_session_heartbeat_and_hangup_evidence
20260721224701  20260723030000_fix_conversation_sweep_cron_privileges
20260722001125  fix_assign_plan_advisory_lock_hex_cast
20260722161707  20260723040000_create_user_account_deactivations
20260722161710  20260722100000_create_listening_generation_jobs
20260722161723  20260722110000_disable_listening_inventory_preventive_generation
20260722161731  20260723040001_create_user_billing_blocks
20260722161756  20260723040002_create_user_communication_blocks
20260722163829  20260722120000_reconcile_listening_audio_publication_schema
20260722215121  20260724010000_create_pronunciation_training_sessions
20260722235429  pronunciation_training_unlimited_daily_reset
20260723011600  create_writing_review_reservations
20260723011802  create_writing_review_reservations_v2
20260723020910  create_writing_rewrite_attempts
20260723020919  protect_submitted_rewrite_immutability
20260723020932  create_writing_rewrite_evaluations
20260723020941  create_writing_rewrite_correction_outcomes
20260723020948  create_writing_rewrite_evidence_candidates
20260723020953  create_writing_rewrite_status_history
20260723022209  fix_overview_retries_operational_and_labels
20260723023339  enable_rls_listening_bookmark_word_timings
20260723211954  20260723050000_gateway_global_runtime_control_activation
20260723224403  kill_switch_runtime_controls_fix
20260724001111  20260724050000_create_listening_shared_stories
20260724001156  20260724050001_fix_listening_shared_stories_security_advisories
20260724002828  ai_gateway_conservative_budget_estimate_fix
20260724002841  conversation_session_authorizations_gateway_budget_reservation
20260724003124  gateway_publish_budget_policies_sync
20260724011228  20260724070000_fix_listening_shared_story_reacquire_and_grants
20260724105536  20260724090000_ai_gateway_provider_pricing_tts1_historical_backfill
```

Note-se que os `version` (primeira coluna) **não são iguais** aos timestamps embutidos no `name` — os `version` são o horário real de aplicação em produção (ex. `20260716003802`), enquanto o `name` às vezes carrega um timestamp de autoria diferente e mais antigo (ex. `20260715200000_...`) ou nenhum timestamp reconhecível (ex. `listening_story_completion`). Isso por si só já é sintoma de histórico não-linear/não confiável para reconstrução do zero — exatamente o problema que motivou este baseline.

### Homologação (`ahszqexfzpbirdlkmdci`) — `supabase_migrations.schema_migrations`: **0 registros**

Confirmado na etapa anterior desta mesma sessão: banco vazio (0 tabelas, 0 migrations) após o reset autorizado. Continua vazio agora (nenhuma escrita foi feita nesta tarefa).

### Repositório local — `supabase/migrations/`

Ainda não lido linha a linha nesta etapa (fora do escopo de "planejamento" pedido — o objetivo aqui é o plano, não a auditoria arquivo-a-arquivo do diretório local). O ponto relevante é: **o usuário já afirmou** que "o histórico antigo de migrations não consegue reconstruir o banco do zero" — o que bate com o achado acima (nomes/timestamps inconsistentes, prefixos `fix_*` sem migration original correspondente no mesmo padrão de nome, etc.).

## Estado esperado pós-corte

1. Um novo arquivo de migration em `supabase/migrations/` (nome sugerido: `<timestamp>_baseline_full_database.sql`, mesmo conteúdo do baseline candidato desta pasta, só movido para lá **quando autorizado** — não fazer isso agora) se torna a **origem única** reproduzível.
2. As 61 migrations antigas listadas acima deixam de ser "replayable" — não são apagadas do repositório (histórico git preserva), mas páram de ser a fonte de verdade para reconstrução.
3. Produção: seu `supabase_migrations.schema_migrations` precisa **reconhecer** a nova migration de baseline como já aplicada, **sem rodar o DDL de novo** (produção já tem o schema — rodar o `CREATE TABLE`/`CREATE POLICY` etc. do baseline contra produção falharia ou duplicaria objetos). Isso é o papel do `supabase migration repair --status applied <version>`.
4. Homologação: aplica o baseline (+ seed) do zero como sua primeira e única migration real, e seu histórico passa a ter só essa entrada.
5. Daqui em diante, toda migration nova é escrita uma única vez e aplicada nos dois projetos na mesma ordem — `supabase migration list` e `supabase db push` ficam sincronizados porque ambos os históricos começam do mesmo ponto (o baseline) e recebem exatamente as mesmas migrations depois.

## Comandos que seriam necessários (não executados)

Assumindo que o baseline vire o arquivo `supabase/migrations/<TS>_baseline_full_database.sql` (passo futuro, não desta tarefa):

- **Em produção**: marcar essa migration como já aplicada, sem rodar seu conteúdo —
  `supabase migration repair --status applied <TS> --project-ref jiuurvheeuwmayrfnqgm`
  Isso insere uma linha em `supabase_migrations.schema_migrations` com `version=<TS>` sem executar o SQL (produção já tem esses objetos).

- **Opcional, se decidido "esquecer" as 61 migrations antigas do histórico remoto de produção** (não obrigatório — elas podem conviver com a nova linha de baseline sem conflito, já que `supabase migration repair` só adiciona/marca registros, não remove):
  `supabase migration repair --status reverted <version>` para cada uma das 61 versões antigas, **uma a uma**, se o objetivo for zerar o histórico visível e deixar só o baseline. Isso é uma escolha de limpeza, não uma necessidade técnica — CLI moderno do Supabase não exige histórico "limpo" para funcionar, só que os `version` batam entre o que está no banco e o que está no diretório local.

- **Em homologação**: como já está vazia, basta `supabase db push --project-ref ahszqexfzpbirdlkmdci` (ou `supabase migration up`) para aplicar o baseline como migration única — isso **executa** o DDL de verdade (correto, já que homolog não tem os objetos ainda). Nenhum `migration repair` é necessário aqui, porque não há histórico para reconciliar.

- **Seed**: aplicado separadamente (`supabase db seed` ou execução manual do `20260725120001_seed_reference_data.sql`), não via `migration repair`.

## Exatamente quais registros seriam marcados como quê

| Ação | Onde | Quais versões | Efeito |
|---|---|---|---|
| `applied` (sem rodar SQL) | Produção | A nova versão do baseline (ainda não criada) | Produção passa a reconhecer o baseline como "já aplicado", sem duplicar objetos |
| `reverted` (opcional) | Produção | As 61 versões acima, uma a uma, **se** o usuário quiser um histórico remoto limpo | Zera o histórico visível em `supabase migration list` para produção, deixando só o baseline daqui pra frente |
| Nenhuma ação de repair | Homologação | N/A | Homolog aplica o baseline como migration real (`db push`), não precisa de reconciliação porque não tem histórico prévio |

## Restrição respeitada

Nenhum destes comandos foi executado nesta tarefa. Este documento é só o plano — a criação do arquivo de migration de baseline em `supabase/migrations/`, a execução de `migration repair` e a aplicação em homologação exigem autorização explícita e separada, e continuam fora do escopo do que foi pedido ("planejamento e preparação").
