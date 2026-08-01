# Histórico de migrations de produção — captura pré-repair

Capturado em 2026-08-01T15:28:11.389Z via consulta read-only direta em `supabase_migrations.schema_migrations` (projeto `jiuurvheeuwmayrfnqgm`), cross-checada campo a campo com a tool `list_migrations`. Nenhuma credencial neste arquivo — apenas `version`/`name`, que não são secrets.

Validado programaticamente antes do repair:

- contagem exata: 58
- toda versão casa com `^[0-9]{14}$`
- nenhuma versão duplicada
- ordem ascendente por `version`
- consulta SQL direta e `list_migrations` retornaram exatamente a mesma lista, na mesma ordem

## Consulta usada (read-only)

```sql
SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version;
```

## Lista completa (version | name)

| version | name |
|---|---|
| `20260716003802` | `20260715200000_create_listening_jobs` |
| `20260716003824` | `20260715160000_create_listening_block_sessions` |
| `20260716003827` | `20260715210000_create_listening_assignments` |
| `20260716003841` | `20260715220000_create_listening_results` |
| `20260716003923` | `20260715240000_create_listening_cron_jobs` |
| `20260716162104` | `listening_story_completion` |
| `20260717022117` | `fix_listening_rls_and_conversation_date` |
| `20260718015737` | `fix_assignment_rpc_authorization` |
| `20260718022310` | `capability_schema_evolution` |
| `20260718022658` | `ai_gateway_observability_gateway_heartbeats` |
| `20260718022937` | `ai_gateway_control` |
| `20260718023232` | `ai_gateway_pricing` |
| `20260718023437` | `product_config_center` |
| `20260718035610` | `20260717900000_listening_content_operations` |
| `20260718040503` | `fix_users_and_config_versions_functions` |
| `20260718054736` | `plan_visibility_capability_entitlements_and_conversation_credits` |
| `20260718082115` | `listening_multi_story_per_day` |
| `20260718082130` | `publish_plan_version_requires_complete_capabilities` |
| `20260721152515` | `fix_gateway_ledger_schema_drift` |
| `20260721212734` | `20260721000000_ai_gateway_provider_pricing_tts_and_azure_speech` |
| `20260721212749` | `20260721010000_conversation_session_server_authoritative` |
| `20260721212814` | `20260722000000_realtime_hard_control_validation` |
| `20260721221259` | `fix_plan_assignment_and_capability_override_concurrency` |
| `20260721222505` | `fix_gateway_reprocessing_and_listening_schema_drift` |
| `20260721222615` | `fix_listening_subtitle_cues_status_column` |
| `20260721223210` | `add_listening_jobs_readonly_visibility` |
| `20260721224418` | `20260723000000_revoke_new_tables_default_grants_and_extend_privilege_audit` |
| `20260721224512` | `20260723010000_realtime_hard_control_evidence_schema` |
| `20260721224536` | `20260723020000_conversation_session_heartbeat_and_hangup_evidence` |
| `20260721224701` | `20260723030000_fix_conversation_sweep_cron_privileges` |
| `20260722001125` | `fix_assign_plan_advisory_lock_hex_cast` |
| `20260722161707` | `20260723040000_create_user_account_deactivations` |
| `20260722161710` | `20260722100000_create_listening_generation_jobs` |
| `20260722161723` | `20260722110000_disable_listening_inventory_preventive_generation` |
| `20260722161731` | `20260723040001_create_user_billing_blocks` |
| `20260722161756` | `20260723040002_create_user_communication_blocks` |
| `20260722163829` | `20260722120000_reconcile_listening_audio_publication_schema` |
| `20260722215121` | `20260724010000_create_pronunciation_training_sessions` |
| `20260722235429` | `pronunciation_training_unlimited_daily_reset` |
| `20260723011600` | `create_writing_review_reservations` |
| `20260723011802` | `create_writing_review_reservations_v2` |
| `20260723020910` | `create_writing_rewrite_attempts` |
| `20260723020919` | `protect_submitted_rewrite_immutability` |
| `20260723020932` | `create_writing_rewrite_evaluations` |
| `20260723020941` | `create_writing_rewrite_correction_outcomes` |
| `20260723020948` | `create_writing_rewrite_evidence_candidates` |
| `20260723020953` | `create_writing_rewrite_status_history` |
| `20260723022209` | `fix_overview_retries_operational_and_labels` |
| `20260723023339` | `enable_rls_listening_bookmark_word_timings` |
| `20260723211954` | `20260723050000_gateway_global_runtime_control_activation` |
| `20260723224403` | `kill_switch_runtime_controls_fix` |
| `20260724001111` | `20260724050000_create_listening_shared_stories` |
| `20260724001156` | `20260724050001_fix_listening_shared_stories_security_advisories` |
| `20260724002828` | `ai_gateway_conservative_budget_estimate_fix` |
| `20260724002841` | `conversation_session_authorizations_gateway_budget_reservation` |
| `20260724003124` | `gateway_publish_budget_policies_sync` |
| `20260724011228` | `20260724070000_fix_listening_shared_story_reacquire_and_grants` |
| `20260724105536` | `20260724090000_ai_gateway_provider_pricing_tts1_historical_backfill` |

## Apenas as versões (uma por linha, para uso em `supabase migration repair --status reverted`)

```
20260716003802
20260716003824
20260716003827
20260716003841
20260716003923
20260716162104
20260717022117
20260718015737
20260718022310
20260718022658
20260718022937
20260718023232
20260718023437
20260718035610
20260718040503
20260718054736
20260718082115
20260718082130
20260721152515
20260721212734
20260721212749
20260721212814
20260721221259
20260721222505
20260721222615
20260721223210
20260721224418
20260721224512
20260721224536
20260721224701
20260722001125
20260722161707
20260722161710
20260722161723
20260722161731
20260722161756
20260722163829
20260722215121
20260722235429
20260723011600
20260723011802
20260723020910
20260723020919
20260723020932
20260723020941
20260723020948
20260723020953
20260723022209
20260723023339
20260723211954
20260723224403
20260724001111
20260724001156
20260724002828
20260724002841
20260724003124
20260724011228
20260724105536
```

## Destino após o repair

Todas as 58 versões acima serão marcadas `reverted` em produção — não removidas, não reaplicadas, apenas retiradas da linhagem ativa, já que nenhum arquivo local em `supabase/migrations/` corresponde a elas (preservadas, inalteradas, em `supabase/migrations_legacy/`). `20260725120000` e `20260725120001` serão marcadas `applied` sem execução de SQL, pois o schema já existe em produção.
