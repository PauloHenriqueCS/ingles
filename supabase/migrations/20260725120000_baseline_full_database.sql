-- =====================================================================
-- BASELINE CANDIDATO - schema completo de producao (jiuurvheeuwmayrfnqgm)
-- Gerado em 2026-07-25 via introspeccao read-only (pg_catalog/information_schema).
-- NAO APLICADO. Ver README.md nesta pasta antes de qualquer execucao.
-- Ordem: extensions -> schemas -> enums -> tabelas (colunas) -> PK/UNIQUE ->
--        indexes -> views -> functions -> colunas geradas (pos-functions) ->
--        triggers -> RLS enable -> policies -> FK -> grants -> storage/cron/vault refs.
-- FKs sao aplicadas DEPOIS de todas as tabelas existirem (evita ordenacao topologica manual).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. EXTENSIONS (apenas as habilitadas em producao; pg_net e pg_cron
--    ficam nos schemas dedicados 'net' e 'cron' criados pelas proprias extensions)
-- ---------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "pg_net";
CREATE EXTENSION IF NOT EXISTS "pg_cron";
-- pg_graphql: revalidado em 2026-08-01 contra producao (SELECT extname FROM
-- pg_extension) - NAO esta instalada em producao hoje, apesar dos schemas
-- graphql/graphql_public existirem (bootstrap padrao do Supabase,
-- independente da extension). Omitido de propósito para bater exatamente
-- com o estado real de producao; reinstalar aqui criaria uma tabela/schema
-- extra que produção não tem, quebrando o fingerprint de equality_validation.md.
CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA vault;

-- ---------------------------------------------------------------------
-- 2. ENUMS (schema public)
-- ---------------------------------------------------------------------
CREATE TYPE public.learning_skill AS ENUM ('writing', 'pronunciation', 'conversation', 'listening');
CREATE TYPE public.listening_block_session_status AS ENUM ('active', 'awaiting_answer', 'replay_required', 'completed', 'abandoned', 'expired');
CREATE TYPE public.listening_block_status AS ENUM ('draft', 'content_ready', 'audio_processing', 'ready', 'failed');
CREATE TYPE public.listening_episode_status AS ENUM ('draft', 'content_ready', 'audio_processing', 'ready', 'publishing', 'published', 'failed', 'archived');
CREATE TYPE public.listening_subtitle_language AS ENUM ('en', 'pt-BR');
CREATE TYPE public.listening_subtitle_mode AS ENUM ('none', 'en', 'pt-BR');
CREATE TYPE public.rewrite_correction_outcome_status AS ENUM ('corrected', 'partially_corrected', 'unchanged', 'valid_alternative', 'worsened', 'not_applicable');
CREATE TYPE public.rewrite_evaluation_status AS ENUM ('pending', 'completed', 'failed');
CREATE TYPE public.rewrite_independence_assessment AS ENUM ('independent', 'likely_independent', 'uncertain', 'likely_copied', 'copied');
CREATE TYPE public.rewrite_status AS ENUM ('draft', 'submitted', 'evaluation_pending', 'evaluated', 'evaluation_failed', 'superseded', 'cancelled');
CREATE TYPE public.skill_assessment_status AS ENUM ('unknown', 'provisional', 'calibrating', 'confirmed', 'stale');
CREATE TYPE public.skill_level_source AS ENUM ('diagnostic', 'ongoing_calibration', 'checkpoint', 'manual_admin', 'legacy_migration', 'system_default');
CREATE TYPE public.user_listening_progress_status AS ENUM ('not_started', 'block_1_active', 'block_1_completed', 'block_2_active', 'completed');

-- ---------------------------------------------------------------------
-- 3. TABLES (colunas apenas; PK/UNIQUE/CHECK/FK/indexes nas secoes seguintes)
--    NOTA: public.listening_episodes.level_group e coluna GERADA
--    (GENERATED ALWAYS AS (listening_level_group_for_cefr(cefr_level)) STORED);
--    ela e adicionada via ALTER TABLE na secao 8, depois que a funcao existir.
-- ---------------------------------------------------------------------
CREATE TABLE public.admin_audit_log (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  actor_user_id uuid,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  before_state jsonb,
  after_state jsonb,
  reason text,
  request_id text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  actor_role text,
  permission_key text,
  environment text,
  correlation_id uuid,
  idempotency_key text,
  admin_session_id uuid,
  result text,
  error_code text
);
CREATE TABLE public.admin_invitations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  email_normalized text NOT NULL,
  role text NOT NULL,
  permissions_snapshot jsonb NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  invitation_token_hash text NOT NULL,
  created_by uuid NOT NULL,
  reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  accepted_at timestamp with time zone,
  accepted_user_id uuid,
  revoked_at timestamp with time zone,
  revoked_by uuid,
  revoke_reason text,
  resend_count integer DEFAULT 0 NOT NULL,
  last_sent_at timestamp with time zone,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.admin_permissions (
  key text NOT NULL,
  category text NOT NULL,
  label text NOT NULL,
  description text,
  requires_aal2 boolean DEFAULT false NOT NULL,
  requires_recent_auth boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.admin_rate_limit_buckets (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  actor_id uuid NOT NULL,
  action_key text NOT NULL,
  window_start timestamp with time zone NOT NULL,
  attempt_count integer DEFAULT 1 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.admin_role_permissions (
  role text NOT NULL,
  permission_key text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.admin_roles (
  role text NOT NULL,
  label text NOT NULL,
  description text,
  is_protected boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.admin_security_configs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  environment text NOT NULL,
  current_version_id uuid,
  mfa_required boolean DEFAULT false NOT NULL,
  recent_auth_window_seconds integer DEFAULT 900 NOT NULL,
  max_admin_session_hours integer DEFAULT 12 NOT NULL,
  max_idle_minutes integer,
  invitation_expiry_hours integer DEFAULT 72 NOT NULL,
  rate_limit_max_attempts integer DEFAULT 10 NOT NULL,
  rate_limit_window_seconds integer DEFAULT 300 NOT NULL,
  lockout_duration_seconds integer DEFAULT 900 NOT NULL,
  min_reason_length integer DEFAULT 10 NOT NULL,
  revision integer DEFAULT 0 NOT NULL,
  config_hash text,
  updated_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.admin_security_events (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  environment text DEFAULT 'production'::text NOT NULL,
  event_type text NOT NULL,
  severity text DEFAULT 'info'::text NOT NULL,
  actor_user_id uuid,
  target_user_id uuid,
  detail jsonb,
  correlation_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.admin_security_policy_versions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  environment text NOT NULL,
  version_number integer NOT NULL,
  snapshot jsonb NOT NULL,
  config_hash text NOT NULL,
  state text DEFAULT 'published'::text NOT NULL,
  change_type text NOT NULL,
  reason text NOT NULL,
  published_by uuid NOT NULL,
  published_at timestamp with time zone DEFAULT now() NOT NULL,
  previous_version_id uuid
);
CREATE TABLE public.admin_users (
  user_id uuid NOT NULL,
  role text NOT NULL,
  status text DEFAULT 'active'::text NOT NULL,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  revision integer DEFAULT 1 NOT NULL,
  last_admin_access_at timestamp with time zone,
  status_changed_at timestamp with time zone,
  status_changed_by uuid,
  status_change_reason text,
  invitation_id uuid
);
CREATE TABLE public.ai_alert_rules (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  environment text NOT NULL,
  alert_type text NOT NULL,
  scope text,
  window_seconds integer DEFAULT 3600 NOT NULL,
  threshold_value numeric(20,8),
  min_event_count integer DEFAULT 1 NOT NULL,
  severity text DEFAULT 'warning'::text NOT NULL,
  active boolean DEFAULT true NOT NULL,
  cooldown_seconds integer DEFAULT 3600 NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.ai_alerts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  environment text NOT NULL,
  rule_id uuid,
  alert_type text NOT NULL,
  scope text,
  severity text NOT NULL,
  status text DEFAULT 'open'::text NOT NULL,
  title text NOT NULL,
  detail jsonb,
  dedup_key text NOT NULL,
  acknowledged_by uuid,
  acknowledged_at timestamp with time zone,
  acknowledge_reason text,
  resolved_by uuid,
  resolved_at timestamp with time zone,
  resolve_reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.ai_budget_policies (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  environment text NOT NULL,
  name text NOT NULL,
  scope text NOT NULL,
  scope_value text,
  metric text NOT NULL,
  currency text,
  limit_value numeric(20,8) NOT NULL,
  period text NOT NULL,
  timezone text DEFAULT 'America/Sao_Paulo'::text NOT NULL,
  alert_thresholds integer[] DEFAULT '{50,75,90,100}'::integer[] NOT NULL,
  action text DEFAULT 'alert_only'::text NOT NULL,
  starts_at timestamp with time zone DEFAULT now() NOT NULL,
  ends_at timestamp with time zone,
  active boolean DEFAULT true NOT NULL,
  priority integer DEFAULT 100 NOT NULL,
  reason text NOT NULL,
  created_by uuid NOT NULL,
  updated_by uuid,
  revision integer DEFAULT 1 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.ai_control_switches (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  environment text NOT NULL,
  scope text NOT NULL,
  provider text,
  model text,
  feature_key text,
  enabled boolean DEFAULT false NOT NULL,
  starts_at timestamp with time zone DEFAULT now() NOT NULL,
  ends_at timestamp with time zone,
  reason text NOT NULL,
  created_by uuid NOT NULL,
  revoked_at timestamp with time zone,
  revoked_by uuid,
  revoke_reason text,
  revision integer DEFAULT 1 NOT NULL,
  config_version integer,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.ai_conversation_preferences (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  teacher_name text DEFAULT 'Alex'::text NOT NULL,
  personality text DEFAULT 'friendly'::text NOT NULL,
  correction_style text DEFAULT 'gentle'::text NOT NULL,
  voice text DEFAULT 'coral'::text NOT NULL,
  focus_areas text[] DEFAULT '{}'::text[] NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  accent text DEFAULT 'american'::text NOT NULL,
  speech_pace text DEFAULT 'slow'::text NOT NULL,
  personality_preset text DEFAULT 'patient'::text NOT NULL,
  formality text DEFAULT 'medium'::text NOT NULL,
  humor_level text DEFAULT 'low'::text NOT NULL,
  roast_intensity text DEFAULT 'off'::text NOT NULL,
  profanity_enabled boolean DEFAULT false NOT NULL,
  topic_initiative text DEFAULT 'medium'::text NOT NULL,
  correction_timing text DEFAULT 'after_each'::text NOT NULL,
  correction_scope text DEFAULT 'important_only'::text NOT NULL,
  correction_language text DEFAULT 'portuguese'::text NOT NULL,
  correction_detail text DEFAULT 'brief'::text NOT NULL,
  daily_conversation_goal_minutes integer DEFAULT 15 NOT NULL
);
CREATE TABLE public.ai_cost_valuations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  event_id uuid NOT NULL,
  pricing_version_id uuid,
  status text NOT NULL,
  currency text,
  cost_input numeric(24,12),
  cost_output numeric(24,12),
  cost_cache numeric(24,12),
  cost_audio numeric(24,12),
  cost_tts numeric(24,12),
  cost_fixed numeric(24,12),
  cost_other numeric(24,12),
  cost_total numeric(24,12),
  components jsonb NOT NULL,
  engine_version text NOT NULL,
  input_hash text NOT NULL,
  origin text DEFAULT 'recalculated'::text NOT NULL,
  original_cost_total numeric(18,8),
  original_currency text,
  original_cost_status text,
  divergence_status text,
  divergence_abs numeric(24,12),
  divergence_pct numeric(12,4),
  superseded_valuation_id uuid,
  reason text,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.ai_features (
  feature_key text NOT NULL,
  display_name text NOT NULL,
  category text NOT NULL,
  provider text,
  execution_location text NOT NULL,
  is_billable boolean NOT NULL,
  primary_billing_metric text,
  measurement_strategy text NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.ai_gateway_budget_buckets (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  scope_type text NOT NULL,
  scope_key text NOT NULL,
  period_type text NOT NULL,
  period_start timestamp with time zone NOT NULL,
  period_end timestamp with time zone NOT NULL,
  committed_cost_usd numeric DEFAULT 0 NOT NULL,
  reserved_cost_usd numeric DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.ai_gateway_circuit_breakers (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  provider text NOT NULL,
  model text,
  feature_key text NOT NULL,
  state text DEFAULT 'closed'::text NOT NULL,
  consecutive_failures integer DEFAULT 0 NOT NULL,
  window_started_at timestamp with time zone DEFAULT now() NOT NULL,
  window_failure_count integer DEFAULT 0 NOT NULL,
  window_sample_count integer DEFAULT 0 NOT NULL,
  opened_at timestamp with time zone,
  half_open_at timestamp with time zone,
  half_open_probes_used integer DEFAULT 0 NOT NULL,
  min_samples integer,
  failure_rate_threshold numeric,
  consecutive_failure_threshold integer,
  cooldown_seconds integer,
  half_open_probe_count integer,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.ai_gateway_concurrency_validations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  migration_version text NOT NULL,
  validation_script_path text NOT NULL,
  validation_script_sha256 text NOT NULL,
  status text NOT NULL,
  executed_at timestamp with time zone NOT NULL,
  executed_by text NOT NULL,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.ai_gateway_config_acknowledgements (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  environment text NOT NULL,
  instance_id text NOT NULL,
  version_received integer NOT NULL,
  hash_received text NOT NULL,
  version_applied integer,
  hash_applied text,
  gateway_version text,
  result text NOT NULL,
  error_sanitized text,
  acked_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.ai_gateway_config_versions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  environment text NOT NULL,
  version_number integer NOT NULL,
  snapshot jsonb NOT NULL,
  config_hash text NOT NULL,
  state text DEFAULT 'published'::text NOT NULL,
  change_type text DEFAULT 'update'::text NOT NULL,
  is_emergency boolean DEFAULT false NOT NULL,
  reason text NOT NULL,
  published_by uuid NOT NULL,
  published_at timestamp with time zone DEFAULT now() NOT NULL,
  expires_at timestamp with time zone,
  previous_version_id uuid
);
CREATE TABLE public.ai_gateway_configs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  environment text NOT NULL,
  current_version_id uuid,
  gateway_mode text DEFAULT 'legacy'::text NOT NULL,
  ai_enabled boolean DEFAULT true NOT NULL,
  emergency_stop boolean DEFAULT false NOT NULL,
  emergency_stop_at timestamp with time zone,
  emergency_stop_by uuid,
  emergency_stop_reason text,
  failure_strategy text DEFAULT 'use_last_known'::text NOT NULL,
  cache_ttl_seconds integer DEFAULT 30 NOT NULL,
  max_stale_seconds integer DEFAULT 300 NOT NULL,
  revision integer DEFAULT 0 NOT NULL,
  config_hash text,
  updated_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.ai_gateway_decisions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  outcome text NOT NULL,
  reason_code text NOT NULL,
  feature_key text NOT NULL,
  provider text,
  user_id uuid,
  actor_type text NOT NULL,
  gateway_mode text NOT NULL,
  policy_revision text,
  correlation_id uuid,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.ai_gateway_idempotency_locks (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  status text DEFAULT 'in_progress'::text NOT NULL,
  result_ref text,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.ai_gateway_quota_buckets (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  subject_type text NOT NULL,
  subject_id uuid,
  feature_key text NOT NULL,
  metric_key text NOT NULL,
  period_type text NOT NULL,
  period_start timestamp with time zone NOT NULL,
  period_end timestamp with time zone NOT NULL,
  committed_quantity numeric DEFAULT 0 NOT NULL,
  reserved_quantity numeric DEFAULT 0 NOT NULL,
  backfilled boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.ai_gateway_reservation_budget_links (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  reservation_id uuid NOT NULL,
  budget_bucket_id uuid NOT NULL,
  reserved_cost_usd numeric NOT NULL
);
CREATE TABLE public.ai_pricing_acknowledgements (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  environment text NOT NULL,
  instance_id text NOT NULL,
  version_received integer NOT NULL,
  hash_received text NOT NULL,
  version_applied integer,
  hash_applied text,
  gateway_version text,
  result text NOT NULL,
  error_sanitized text,
  acked_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.ai_pricing_rates (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  version_id uuid NOT NULL,
  provider text NOT NULL,
  model text,
  operation text,
  metric_key text NOT NULL,
  feature_key text,
  region text,
  unit_type text NOT NULL,
  unit_size numeric(20,6) NOT NULL,
  unit_price numeric(24,12) NOT NULL,
  currency text NOT NULL,
  priority integer DEFAULT 100 NOT NULL,
  source text NOT NULL,
  source_url text,
  verified_at timestamp with time zone,
  verified_by uuid,
  notes text,
  created_by uuid NOT NULL,
  revision integer DEFAULT 1 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.ai_pricing_versions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  environment text NOT NULL,
  version_number integer NOT NULL,
  name text NOT NULL,
  description text,
  state text DEFAULT 'draft'::text NOT NULL,
  currencies text[] DEFAULT '{}'::text[] NOT NULL,
  effective_from timestamp with time zone,
  effective_to timestamp with time zone,
  config_hash text,
  previous_version_id uuid,
  created_by uuid NOT NULL,
  published_by uuid,
  discarded_by uuid,
  reason text,
  is_retroactive boolean DEFAULT false NOT NULL,
  retroactive_justification text,
  origin_note text,
  snapshot jsonb,
  revision integer DEFAULT 1 NOT NULL,
  create_idempotency_key text,
  publish_idempotency_key text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  published_at timestamp with time zone,
  discarded_at timestamp with time zone
);
CREATE TABLE public.ai_provider_sessions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid,
  initiated_by_user_id uuid,
  feature_key text NOT NULL,
  provider text NOT NULL,
  internal_session_type text,
  internal_session_id text,
  provider_session_id text,
  authorization_fingerprint text,
  authorization_expires_at timestamp with time zone,
  status text DEFAULT 'authorized'::text NOT NULL,
  measurement_source text,
  started_at timestamp with time zone,
  ended_at timestamp with time zone,
  duration_seconds numeric,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  last_heartbeat_at timestamp with time zone,
  hangup_status text DEFAULT 'not_attempted'::text NOT NULL,
  hangup_at timestamp with time zone,
  hangup_http_status integer
);
CREATE TABLE public.ai_runtime_controls (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  scope_type text NOT NULL,
  scope_key text NOT NULL,
  provider text,
  feature_key text,
  user_id uuid,
  runtime_status text DEFAULT 'enabled'::text NOT NULL,
  gateway_mode text DEFAULT 'legacy'::text NOT NULL,
  daily_budget_usd numeric,
  monthly_budget_usd numeric,
  max_concurrent_requests integer,
  rate_limit_requests integer,
  rate_limit_window_seconds integer,
  reason text,
  updated_by uuid,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.ai_usage_event_metrics (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  usage_event_id uuid NOT NULL,
  metric_key text NOT NULL,
  unit_type text NOT NULL,
  quantity numeric NOT NULL,
  billable_quantity numeric,
  is_billable boolean NOT NULL,
  is_final boolean DEFAULT true NOT NULL,
  measurement_source text NOT NULL,
  pricing_id uuid,
  calculated_cost_usd numeric,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.ai_usage_events (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  request_id uuid DEFAULT gen_random_uuid() NOT NULL,
  correlation_id uuid,
  parent_event_id uuid,
  provider_session_record_id uuid,
  idempotency_key text,
  user_id uuid,
  initiated_by_user_id uuid,
  actor_type text DEFAULT 'user'::text NOT NULL,
  feature_key text NOT NULL,
  provider text NOT NULL,
  service text,
  model text,
  provider_request_id text,
  execution_location text NOT NULL,
  status text NOT NULL,
  attempt_number integer DEFAULT 1 NOT NULL,
  call_sequence integer DEFAULT 1 NOT NULL,
  operation_part text,
  is_billable boolean NOT NULL,
  cost_status text DEFAULT 'pending'::text NOT NULL,
  estimated_cost_usd numeric,
  calculated_cost_usd numeric,
  reconciled_cost_usd numeric,
  cache_hit boolean DEFAULT false NOT NULL,
  latency_ms integer,
  http_status integer,
  error_code text,
  error_category text,
  sanitized_error_message text,
  block_reason text,
  resource_type text,
  resource_id text,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  started_at timestamp with time zone DEFAULT now() NOT NULL,
  completed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.api_rate_limits (
  user_id uuid NOT NULL,
  route_key text NOT NULL,
  window_start timestamp with time zone DEFAULT now() NOT NULL,
  request_count integer DEFAULT 1 NOT NULL
);
CREATE TABLE public.app_config_acknowledgements (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  environment text NOT NULL,
  application text NOT NULL,
  instance_id text NOT NULL,
  version_received integer NOT NULL,
  hash_received text NOT NULL,
  version_applied integer,
  hash_applied text,
  app_version text,
  result text NOT NULL,
  error_sanitized text,
  acked_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.app_config_definitions (
  key text NOT NULL,
  label text NOT NULL,
  category text NOT NULL,
  description text NOT NULL,
  value_type text NOT NULL,
  value_schema jsonb NOT NULL,
  default_value jsonb NOT NULL,
  scope text DEFAULT 'global'::text NOT NULL,
  applicable_environments text[] DEFAULT ARRAY['development'::text, 'staging'::text, 'production'::text] NOT NULL,
  exposure text NOT NULL,
  risk_level text DEFAULT 'low'::text NOT NULL,
  consumer_component text NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.app_config_values (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  version_id uuid NOT NULL,
  definition_key text NOT NULL,
  value jsonb NOT NULL,
  updated_by uuid NOT NULL,
  revision integer DEFAULT 1 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.app_config_versions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  environment text NOT NULL,
  version_number integer NOT NULL,
  state text DEFAULT 'draft'::text NOT NULL,
  config_hash text,
  previous_version_id uuid,
  snapshot jsonb,
  reason text,
  is_high_risk boolean DEFAULT false NOT NULL,
  high_risk_confirmation text,
  created_by uuid NOT NULL,
  published_by uuid,
  discarded_by uuid,
  revision integer DEFAULT 1 NOT NULL,
  create_idempotency_key text,
  publish_idempotency_key text,
  effective_from timestamp with time zone,
  effective_to timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  published_at timestamp with time zone,
  discarded_at timestamp with time zone
);
CREATE TABLE public.capability_definitions (
  key text NOT NULL,
  category text NOT NULL,
  group_key text NOT NULL,
  label text NOT NULL,
  description text,
  value_type text NOT NULL,
  unit text,
  default_period text,
  default_value jsonb,
  constraints jsonb,
  display_order integer DEFAULT 0 NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  help_text text,
  allowed_periods jsonb DEFAULT '["none", "request", "day", "week", "month", "lifetime"]'::jsonb,
  dependency_key text,
  is_plan_configurable boolean DEFAULT true NOT NULL,
  source_reference text
);
CREATE TABLE public.conversation_session_authorizations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  session_date date NOT NULL,
  authorized_at timestamp with time zone DEFAULT now() NOT NULL,
  authorized_max_seconds integer NOT NULL,
  status text DEFAULT 'authorized'::text NOT NULL,
  completed_at timestamp with time zone,
  duration_seconds integer,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  gateway_budget_reservation_id uuid,
  gateway_session_id uuid
);
CREATE TABLE public.conversation_sessions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  session_date date NOT NULL,
  duration_sec integer NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.engine_activation_log (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid,
  executed_by text NOT NULL,
  operation text NOT NULL,
  engine_version text NOT NULL,
  idempotency_key text NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  result_json jsonb,
  error_message text,
  duration_ms integer,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  completed_at timestamp with time zone
);
CREATE TABLE public.english_learning_memory (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid,
  current_level text DEFAULT 'A1'::text NOT NULL,
  average_score integer DEFAULT 0 NOT NULL,
  weakest_skill text,
  strongest_skill text,
  recurring_mistakes jsonb DEFAULT '[]'::jsonb NOT NULL,
  grammar_focus jsonb DEFAULT '[]'::jsonb NOT NULL,
  vocabulary_learned jsonb DEFAULT '[]'::jsonb NOT NULL,
  vocabulary_to_review jsonb DEFAULT '[]'::jsonb NOT NULL,
  recommended_next_focus text,
  recommended_next_theme text,
  teacher_summary text,
  total_reviews integer DEFAULT 0 NOT NULL,
  practiced_days integer DEFAULT 0 NOT NULL,
  current_streak integer DEFAULT 0 NOT NULL,
  last_review_at timestamp with time zone,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.english_reviews (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid,
  original_text text NOT NULL,
  corrected_text text,
  score integer DEFAULT 0 NOT NULL,
  level text DEFAULT 'A1'::text NOT NULL,
  grammar integer DEFAULT 0 NOT NULL,
  vocabulary integer DEFAULT 0 NOT NULL,
  naturalness integer DEFAULT 0 NOT NULL,
  fluency integer DEFAULT 0 NOT NULL,
  summary text,
  main_mistakes jsonb DEFAULT '[]'::jsonb NOT NULL,
  new_vocabulary jsonb DEFAULT '[]'::jsonb NOT NULL,
  objective_feedback text,
  next_practice text,
  category text,
  difficulty text,
  objective text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  entry_date date,
  mission_snapshot jsonb,
  version_2_text text,
  version_2_comparison jsonb,
  version_2_improvement_score integer
);
CREATE TABLE public.gateway_heartbeats (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  environment text DEFAULT 'production'::text NOT NULL,
  instance_id text,
  gateway_version text,
  deploy_version text,
  gateway_mode text DEFAULT 'legacy'::text NOT NULL,
  region text,
  status_summary jsonb,
  last_event_at timestamp with time zone,
  received_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.generated_themes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid,
  title text NOT NULL,
  description text,
  grammar_focus text[],
  activity_type text,
  context text,
  semantic_summary text,
  difficulty text,
  vocabulary text[],
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  status text DEFAULT 'generated'::text NOT NULL
);
CREATE TABLE public.grammar_explanations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  content jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.learner_skill_profiles (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  skill learning_skill NOT NULL,
  cefr_level text,
  assessment_status skill_assessment_status DEFAULT 'unknown'::skill_assessment_status NOT NULL,
  source skill_level_source DEFAULT 'system_default'::skill_level_source NOT NULL,
  confidence numeric(4,3) DEFAULT 0 NOT NULL,
  evidence_count integer DEFAULT 0 NOT NULL,
  catalog_version integer DEFAULT 1 NOT NULL,
  assessed_at timestamp with time zone,
  calibrated_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.learning_day_overrides (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  entry_date date NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.listening_audio_assets (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  episode_id uuid NOT NULL,
  block_id uuid NOT NULL,
  block_order smallint NOT NULL,
  audio_path text,
  published_path text,
  audio_format text NOT NULL,
  content_type text NOT NULL,
  file_size_bytes bigint,
  duration_ms integer,
  voice_name text NOT NULL,
  locale text NOT NULL,
  ssml_hash text NOT NULL,
  audio_hash text,
  word_timing_status text,
  duration_status text,
  synthesis_config_version text NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  raw_synthesis_events_json jsonb,
  error_code text,
  error_message text,
  timing_hash text,
  timing_manifest_json jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.listening_audio_flags (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  block_id uuid NOT NULL,
  flagged_for_review boolean DEFAULT false NOT NULL,
  flagged_reason text,
  flagged_by uuid,
  flagged_at timestamp with time zone,
  quarantined_at timestamp with time zone,
  quarantined_by uuid,
  quarantine_reason text,
  restored_at timestamp with time zone,
  restored_by uuid,
  restore_reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.listening_blocks (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  episode_id uuid NOT NULL,
  block_order integer NOT NULL,
  text_en text NOT NULL,
  translation_pt text,
  ssml text,
  audio_path text,
  duration_ms integer,
  status listening_block_status DEFAULT 'draft'::listening_block_status NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  ssml_status text,
  ssml_version integer,
  ssml_generator_version text,
  ssml_generated_at timestamp with time zone,
  ssml_content_hash text,
  audio_status text,
  audio_asset_id uuid,
  timing_status text,
  timing_generated_at timestamp with time zone,
  timing_version integer DEFAULT 0 NOT NULL,
  timing_config_version text
);
CREATE TABLE public.listening_bookmark_timings (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  audio_asset_id uuid NOT NULL,
  bookmark_name text NOT NULL,
  event_order integer NOT NULL,
  offset_ms integer NOT NULL,
  raw_offset_ticks bigint NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.listening_episode_distribution (
  episode_id uuid NOT NULL,
  state text DEFAULT 'draft'::text NOT NULL,
  available_from timestamp with time zone,
  available_to timestamp with time zone,
  eligible_levels text[] DEFAULT '{}'::text[] NOT NULL,
  priority integer DEFAULT 100 NOT NULL,
  content_hash text,
  content_version_at_publish integer,
  revision integer DEFAULT 1 NOT NULL,
  updated_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.listening_episode_publications (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  episode_id uuid NOT NULL,
  action text NOT NULL,
  previous_state text,
  new_state text NOT NULL,
  available_from timestamp with time zone,
  available_to timestamp with time zone,
  eligible_levels text[] DEFAULT '{}'::text[] NOT NULL,
  priority integer,
  content_hash text,
  content_version_at_publish integer,
  reason text NOT NULL,
  actor_id uuid NOT NULL,
  idempotency_key text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.listening_episodes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  title text NOT NULL,
  synopsis text,
  cefr_level text NOT NULL,
  status listening_episode_status DEFAULT 'draft'::listening_episode_status NOT NULL,
  content_version integer DEFAULT 1 NOT NULL,
  estimated_duration_seconds integer,
  actual_duration_seconds integer,
  voice_name text,
  published_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  generation_key text,
  theme text,
  synopsis_pt text,
  questions_status text,
  questions_generated_at timestamp with time zone,
  ssml_status text,
  ssml_generated_at timestamp with time zone,
  ssml_generator_version text,
  locale text,
  audio_status text,
  subtitles_status text,
  subtitles_generated_at timestamp with time zone,
  subtitle_prompt_version text,
  subtitle_validator_prompt_version text,
  timing_status text,
  timing_generated_at timestamp with time zone,
  timing_version integer DEFAULT 0 NOT NULL,
  timing_config_version text,
  publication_version integer DEFAULT 0 NOT NULL,
  published_by uuid,
  publication_source text,
  access_tier text DEFAULT 'free'::text NOT NULL
);
CREATE TABLE public.listening_generation_jobs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  level_group text NOT NULL,
  target_level text NOT NULL,
  idempotency_key text NOT NULL,
  status text DEFAULT 'created'::text NOT NULL,
  current_step text,
  progress_percent integer DEFAULT 0 NOT NULL,
  episode_id uuid,
  attempts integer DEFAULT 0 NOT NULL,
  max_attempts integer DEFAULT 3 NOT NULL,
  error_code text,
  error_message text,
  retryable boolean DEFAULT false NOT NULL,
  locked_by text,
  locked_at timestamp with time zone,
  lock_expires_at timestamp with time zone,
  started_at timestamp with time zone DEFAULT now() NOT NULL,
  completed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.listening_generation_requests (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  job_type text NOT NULL,
  episode_id uuid,
  block_id uuid,
  cefr_level text NOT NULL,
  topic text,
  priority integer DEFAULT 100 NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  attempts integer DEFAULT 0 NOT NULL,
  max_attempts integer DEFAULT 3 NOT NULL,
  scheduled_for timestamp with time zone,
  started_at timestamp with time zone,
  finished_at timestamp with time zone,
  worker_id text,
  correlation_id uuid DEFAULT gen_random_uuid() NOT NULL,
  idempotency_key text,
  gateway_request_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  error_sanitized text,
  requested_by uuid NOT NULL,
  reason text,
  cancelled_at timestamp with time zone,
  cancelled_by uuid,
  cancel_reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.listening_jobs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  job_type text NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  priority integer DEFAULT 10 NOT NULL,
  episode_id uuid,
  block_id uuid,
  cefr_level text,
  payload jsonb DEFAULT '{}'::jsonb NOT NULL,
  result jsonb,
  idempotency_key text NOT NULL,
  attempts integer DEFAULT 0 NOT NULL,
  max_attempts integer DEFAULT 3 NOT NULL,
  locked_by text,
  locked_at timestamp with time zone,
  lock_expires_at timestamp with time zone,
  next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
  started_at timestamp with time zone,
  finished_at timestamp with time zone,
  error_code text,
  error_message text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.listening_operational_alerts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  alert_type text NOT NULL,
  severity text DEFAULT 'warning'::text NOT NULL,
  episode_id uuid,
  job_id uuid,
  message text NOT NULL,
  details jsonb,
  status text DEFAULT 'open'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  resolved_at timestamp with time zone
);
CREATE TABLE public.listening_publication_log (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  episode_id uuid NOT NULL,
  event text NOT NULL,
  publication_version integer,
  published_by uuid,
  publication_source text,
  details jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.listening_questions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  episode_id uuid NOT NULL,
  block_id uuid NOT NULL,
  question_order integer NOT NULL,
  prompt text NOT NULL,
  options_json jsonb NOT NULL,
  correct_option integer NOT NULL,
  explanation_pt text NOT NULL,
  max_attempts integer DEFAULT 3 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  validation_status text DEFAULT 'pending'::text NOT NULL,
  question_type text,
  difficulty text,
  evidence_sentence_keys jsonb,
  validation_notes jsonb,
  generator_prompt_version text,
  validator_prompt_version text
);
CREATE TABLE public.listening_sentence_timings (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  audio_asset_id uuid NOT NULL,
  block_id uuid NOT NULL,
  sentence_key text NOT NULL,
  sentence_order integer NOT NULL,
  start_ms integer NOT NULL,
  spoken_end_ms integer NOT NULL,
  interval_end_ms integer NOT NULL,
  timing_confidence numeric(4,3) DEFAULT 1.0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.listening_sentences (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  block_id uuid NOT NULL,
  sentence_key text NOT NULL,
  sentence_order integer NOT NULL,
  paragraph_order integer NOT NULL,
  speaker text,
  text_en text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.listening_shared_stories (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  level_group text NOT NULL,
  target_level text NOT NULL,
  practice_date date NOT NULL,
  status text DEFAULT 'generating'::text NOT NULL,
  content jsonb,
  part1_audio_path text,
  part2_audio_path text,
  audio_mime_type text,
  error_message text,
  lock_expires_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.listening_subtitle_cues (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  block_id uuid NOT NULL,
  language listening_subtitle_language NOT NULL,
  cue_order integer NOT NULL,
  start_ms integer,
  end_ms integer,
  text text NOT NULL,
  sentence_key text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  status text DEFAULT 'timing_pending'::text,
  cue_key text,
  source_sentence_keys jsonb,
  content_version integer DEFAULT 1,
  updated_at timestamp with time zone DEFAULT now(),
  timing_source text,
  timing_confidence numeric(4,3),
  audio_asset_id uuid,
  ssml_hash text,
  audio_hash text,
  timed_at timestamp with time zone
);
CREATE TABLE public.listening_word_timings (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  audio_asset_id uuid NOT NULL,
  word_order integer NOT NULL,
  text text NOT NULL,
  start_ms integer NOT NULL,
  duration_ms integer,
  end_ms integer,
  text_offset integer,
  word_length integer,
  boundary_type text,
  raw_offset_ticks bigint,
  raw_duration_ticks bigint,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.plan_capability_values (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  plan_version_id uuid NOT NULL,
  capability_key text NOT NULL,
  value jsonb NOT NULL,
  period text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid
);
CREATE TABLE public.plan_trial_policies (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  plan_id uuid NOT NULL,
  trial_enabled boolean DEFAULT false NOT NULL,
  duration_days integer DEFAULT 7 NOT NULL,
  max_grants_per_user integer DEFAULT 1 NOT NULL,
  allow_owner_exception boolean DEFAULT true NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.plan_versions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  plan_id uuid NOT NULL,
  version_number integer NOT NULL,
  status text DEFAULT 'draft'::text NOT NULL,
  effective_from timestamp with time zone,
  effective_to timestamp with time zone,
  created_by uuid,
  published_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  published_at timestamp with time zone,
  based_on_version_id uuid,
  change_summary text,
  publication_notes text,
  config_hash text,
  revision integer DEFAULT 1 NOT NULL,
  discarded_at timestamp with time zone,
  discarded_by uuid,
  discard_reason text,
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE public.plans (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  code text NOT NULL,
  description text,
  status text DEFAULT 'draft'::text NOT NULL,
  is_default boolean DEFAULT false NOT NULL,
  monthly_price_cents integer DEFAULT 0 NOT NULL,
  currency text DEFAULT 'BRL'::text NOT NULL,
  trial_days integer DEFAULT 0 NOT NULL,
  display_order integer DEFAULT 0 NOT NULL,
  internal_notes text,
  created_by uuid,
  updated_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  is_visible_to_users boolean DEFAULT true NOT NULL
);
CREATE TABLE public.pronunciation_assessments (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  text_version_id uuid NOT NULL,
  status text DEFAULT 'processing'::text NOT NULL,
  reference_text text NOT NULL,
  language_code text DEFAULT 'en-US'::text NOT NULL,
  azure_region text NOT NULL,
  pronunciation_score numeric(5,2),
  accuracy_score numeric(5,2),
  fluency_score numeric(5,2),
  completeness_score numeric(5,2),
  prosody_score numeric(5,2),
  recognized_text text,
  words_json jsonb,
  raw_result_json jsonb,
  audio_path text,
  audio_duration_seconds numeric(8,3),
  error_code text,
  error_message text,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  active_attempt_id uuid,
  attempt_started_at timestamp with time zone
);
CREATE TABLE public.pronunciation_training_sessions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  practice_date date NOT NULL,
  level text NOT NULL,
  generated_text text NOT NULL,
  status text DEFAULT 'text_generated'::text NOT NULL,
  language_code text DEFAULT 'en-US'::text NOT NULL,
  azure_region text,
  pronunciation_score numeric,
  accuracy_score numeric,
  fluency_score numeric,
  completeness_score numeric,
  prosody_score numeric,
  recognized_text text,
  words_json jsonb,
  raw_result_json jsonb,
  audio_duration_seconds numeric,
  error_code text,
  error_message text,
  active_attempt_id uuid,
  attempt_started_at timestamp with time zone,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.provider_pricing (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  provider text NOT NULL,
  service text NOT NULL,
  model text,
  region text,
  metric_key text NOT NULL,
  currency text DEFAULT 'USD'::text NOT NULL,
  unit_size numeric NOT NULL,
  price_per_unit numeric NOT NULL,
  valid_from timestamp with time zone NOT NULL,
  valid_until timestamp with time zone,
  is_active boolean DEFAULT true NOT NULL,
  source_reference text,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.realtime_hard_control_validations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  hard_control_version text NOT NULL,
  validation_script_path text NOT NULL,
  validation_script_sha256 text NOT NULL,
  status text NOT NULL,
  executed_at timestamp with time zone NOT NULL,
  executed_by text NOT NULL,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  git_sha text NOT NULL,
  environment text NOT NULL,
  scenario_results jsonb NOT NULL,
  evidence jsonb DEFAULT '{}'::jsonb NOT NULL
);
CREATE TABLE public.review_attempt_items (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  review_attempt_id uuid NOT NULL,
  review_group_item_id uuid,
  required_word text NOT NULL,
  status text NOT NULL,
  used_excerpt text,
  explanation text NOT NULL,
  suggested_correction text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.review_attempts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  review_group_id uuid NOT NULL,
  source_entry_date date,
  submitted_text text,
  overall_result text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.review_group_items (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  review_group_id uuid NOT NULL,
  original_value text NOT NULL,
  corrected_value text NOT NULL,
  explanation text,
  original_sentence text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.review_groups (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  source_review_id uuid NOT NULL,
  source_entry_date date,
  original_theme text,
  status text DEFAULT 'scheduled'::text NOT NULL,
  review_level integer DEFAULT 0 NOT NULL,
  next_review_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.review_schedule_history (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  review_group_id uuid NOT NULL,
  review_attempt_id uuid NOT NULL,
  previous_level integer NOT NULL,
  new_level integer NOT NULL,
  overall_result text NOT NULL,
  previous_status text NOT NULL,
  new_status text NOT NULL,
  previous_next_review_at timestamp with time zone,
  new_next_review_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.usage_daily (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  usage_date date NOT NULL,
  user_id uuid,
  actor_type text NOT NULL,
  feature_key text NOT NULL,
  provider text NOT NULL,
  model text,
  total_requests bigint DEFAULT 0 NOT NULL,
  successful_requests bigint DEFAULT 0 NOT NULL,
  failed_requests bigint DEFAULT 0 NOT NULL,
  blocked_requests bigint DEFAULT 0 NOT NULL,
  cache_hits bigint DEFAULT 0 NOT NULL,
  unpriced_events bigint DEFAULT 0 NOT NULL,
  estimated_cost_usd numeric DEFAULT 0 NOT NULL,
  calculated_cost_usd numeric DEFAULT 0 NOT NULL,
  reconciled_cost_usd numeric DEFAULT 0 NOT NULL,
  last_event_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  distinct_logical_requests bigint DEFAULT 0 NOT NULL,
  total_latency_ms bigint,
  last_rebuilt_at timestamp with time zone
);
CREATE TABLE public.usage_daily_metrics (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  usage_daily_id uuid NOT NULL,
  metric_key text NOT NULL,
  unit_type text NOT NULL,
  total_quantity numeric DEFAULT 0 NOT NULL,
  billable_quantity numeric DEFAULT 0 NOT NULL,
  calculated_cost_usd numeric DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.usage_reservation_items (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  reservation_id uuid NOT NULL,
  quota_key text NOT NULL,
  unit_type text NOT NULL,
  reserved_quantity numeric NOT NULL,
  consumed_quantity numeric DEFAULT 0 NOT NULL,
  released_quantity numeric DEFAULT 0 NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  quota_bucket_id uuid,
  overage boolean DEFAULT false NOT NULL
);
CREATE TABLE public.usage_reservations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  request_id uuid NOT NULL,
  correlation_id uuid,
  provider_session_record_id uuid,
  idempotency_key text,
  user_id uuid,
  initiated_by_user_id uuid,
  feature_key text NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  estimated_cost_usd numeric,
  actual_cost_usd numeric,
  usage_event_id uuid,
  expires_at timestamp with time zone NOT NULL,
  finalized_at timestamp with time zone,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.user_access_controls (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  is_suspended boolean DEFAULT false NOT NULL,
  suspended_at timestamp with time zone,
  suspended_until timestamp with time zone,
  suspension_reason text,
  suspended_by uuid,
  restored_at timestamp with time zone,
  restored_by uuid,
  restore_reason text,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.user_account_deactivations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  status text DEFAULT 'deactivated'::text NOT NULL,
  reason text DEFAULT 'user_requested_account_deletion'::text NOT NULL,
  requested_at timestamp with time zone DEFAULT now() NOT NULL,
  deactivated_at timestamp with time zone DEFAULT now() NOT NULL,
  reactivated_at timestamp with time zone,
  reactivated_by uuid,
  reactivation_reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.user_billing_blocks (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  reason text NOT NULL,
  source text NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  blocked_at timestamp with time zone DEFAULT now() NOT NULL,
  external_customer_id text,
  external_subscription_id text,
  provider text,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  lifted_at timestamp with time zone,
  lifted_by uuid,
  lift_reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.user_capability_overrides (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  capability_key text NOT NULL,
  operation text NOT NULL,
  value jsonb,
  period text,
  unit text,
  starts_at timestamp with time zone DEFAULT now() NOT NULL,
  ends_at timestamp with time zone,
  status text DEFAULT 'active'::text NOT NULL,
  reason text NOT NULL,
  created_by uuid NOT NULL,
  revoked_at timestamp with time zone,
  revoked_by uuid,
  revoke_reason text,
  idempotency_key text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.user_communication_blocks (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid,
  channel text NOT NULL,
  scope text DEFAULT 'all'::text NOT NULL,
  reason text NOT NULL,
  source text NOT NULL,
  destination_hash text,
  is_active boolean DEFAULT true NOT NULL,
  blocked_at timestamp with time zone DEFAULT now() NOT NULL,
  expires_at timestamp with time zone,
  lifted_at timestamp with time zone,
  lifted_by uuid,
  lift_reason text,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.user_conversation_credits (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  total_seconds integer NOT NULL,
  remaining_seconds integer NOT NULL,
  source text NOT NULL,
  external_reference text,
  expires_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.user_learning_settings (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  active_weekdays jsonb DEFAULT '[1, 2, 3, 4, 5]'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  audio_preferences jsonb
);
CREATE TABLE public.user_listening_assignments (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  episode_id uuid,
  activity_date date NOT NULL,
  status text DEFAULT 'assigned'::text NOT NULL,
  assigned_at timestamp with time zone DEFAULT now() NOT NULL,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.user_listening_attempts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  episode_id uuid NOT NULL,
  block_id uuid NOT NULL,
  question_id uuid NOT NULL,
  attempt_cycle integer DEFAULT 1 NOT NULL,
  attempt_number integer NOT NULL,
  selected_option integer NOT NULL,
  is_correct boolean,
  subtitle_mode listening_subtitle_mode NOT NULL,
  playback_rate numeric(4,2) DEFAULT 1.0 NOT NULL,
  answered_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  submission_id uuid
);
CREATE TABLE public.user_listening_block_sessions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  episode_id uuid NOT NULL,
  block_id uuid NOT NULL,
  question_id uuid NOT NULL,
  attempt_cycle integer DEFAULT 1 NOT NULL,
  current_attempt integer DEFAULT 1 NOT NULL,
  status listening_block_session_status DEFAULT 'active'::listening_block_session_status NOT NULL,
  started_at timestamp with time zone DEFAULT now() NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  completed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.user_listening_generation_sessions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  user_level text,
  local_date date NOT NULL,
  idempotency_key text NOT NULL,
  status text DEFAULT 'created'::text NOT NULL,
  current_step text,
  progress_percent integer DEFAULT 0 NOT NULL,
  episode_id uuid,
  error_code text,
  error_message text,
  retryable boolean DEFAULT false NOT NULL,
  locked_at timestamp with time zone,
  lock_expires_at timestamp with time zone,
  started_at timestamp with time zone DEFAULT now() NOT NULL,
  completed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.user_listening_progress (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  episode_id uuid NOT NULL,
  status user_listening_progress_status DEFAULT 'not_started'::user_listening_progress_status NOT NULL,
  current_block integer DEFAULT 1 NOT NULL,
  block_1_completed_at timestamp with time zone,
  block_1_correct_attempt integer,
  block_2_completed_at timestamp with time zone,
  block_2_correct_attempt integer,
  completed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.user_listening_results (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  episode_id uuid NOT NULL,
  performance_score numeric(5,2) NOT NULL,
  q1_attempt_cycle integer NOT NULL,
  q2_attempt_cycle integer NOT NULL,
  q1_weight numeric(4,3) NOT NULL,
  q2_weight numeric(4,3) NOT NULL,
  calculation_version text DEFAULT 'listening-performance-v1'::text NOT NULL,
  level_evidence_submitted boolean DEFAULT false NOT NULL,
  calculated_at timestamp with time zone DEFAULT now() NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.user_listening_shared_progress (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  shared_story_id uuid NOT NULL,
  answers jsonb DEFAULT '{}'::jsonb NOT NULL,
  current_part integer DEFAULT 1 NOT NULL,
  completed boolean DEFAULT false NOT NULL,
  completed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.user_plan_assignments (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  version_policy text DEFAULT 'follow_current_published'::text NOT NULL,
  pinned_version_id uuid,
  snapshot_version_id uuid,
  origin text NOT NULL,
  starts_at timestamp with time zone DEFAULT now() NOT NULL,
  ends_at timestamp with time zone,
  status text DEFAULT 'active'::text NOT NULL,
  created_by uuid NOT NULL,
  reason text NOT NULL,
  cancelled_at timestamp with time zone,
  cancelled_by uuid,
  cancel_reason text,
  revision integer DEFAULT 1 NOT NULL,
  idempotency_key text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.writing_entries (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  entry_date date NOT NULL,
  month integer NOT NULL,
  year integer NOT NULL,
  theme text DEFAULT ''::text NOT NULL,
  grammar_goal text,
  main_tense text,
  title text,
  original_text text,
  corrected_text text,
  notes text,
  main_errors text,
  difficulty text,
  status text DEFAULT 'nao-iniciado'::text NOT NULL,
  word_count integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  ai_score integer,
  cefr_level text,
  grammar_score integer,
  vocabulary_score integer,
  naturalness_score integer,
  fluency_score integer,
  ai_summary text,
  grammar_feedback jsonb,
  ai_main_errors jsonb,
  new_vocabulary jsonb,
  natural_expressions jsonb,
  grammar_goal_achieved boolean,
  rewrite_challenge text,
  reviewed_at timestamp with time zone,
  user_id uuid
);
CREATE TABLE public.writing_review_reservations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  status text DEFAULT 'reserved'::text NOT NULL,
  review_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.writing_rewrite_attempts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  mission_id uuid,
  review_id uuid NOT NULL,
  rewrite_sequence integer DEFAULT 1 NOT NULL,
  status rewrite_status DEFAULT 'draft'::rewrite_status NOT NULL,
  author_type text DEFAULT 'learner'::text NOT NULL,
  submission_type text DEFAULT 'rewrite_v2'::text NOT NULL,
  rewrite_text text,
  original_text_snapshot text NOT NULL,
  corrected_text_hash text NOT NULL,
  review_version integer DEFAULT 1 NOT NULL,
  support_usage_snapshot jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  submitted_at timestamp with time zone
);
CREATE TABLE public.writing_rewrite_correction_outcomes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  rewrite_evaluation_id uuid NOT NULL,
  correction_id text NOT NULL,
  status rewrite_correction_outcome_status NOT NULL,
  original_excerpt text DEFAULT ''::text NOT NULL,
  expected_correction text DEFAULT ''::text NOT NULL,
  rewrite_excerpt text,
  explanation_pt_br text DEFAULT ''::text NOT NULL,
  confidence numeric(4,3) DEFAULT 0.5 NOT NULL,
  should_affect_score boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.writing_rewrite_evaluations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  mission_id uuid,
  original_submission_id uuid NOT NULL,
  rewrite_submission_id uuid NOT NULL,
  review_id uuid NOT NULL,
  evaluation_version integer DEFAULT 1 NOT NULL,
  status rewrite_evaluation_status DEFAULT 'pending'::rewrite_evaluation_status NOT NULL,
  correction_resolution_score integer NOT NULL,
  new_error_avoidance_score integer NOT NULL,
  meaning_preservation_score integer NOT NULL,
  clarity_improvement_score integer NOT NULL,
  cohesion_improvement_score integer NOT NULL,
  independence_score integer NOT NULL,
  overall_improvement_score integer NOT NULL,
  independence_assessment rewrite_independence_assessment DEFAULT 'uncertain'::rewrite_independence_assessment NOT NULL,
  summary_pt_br text,
  new_issues_json jsonb DEFAULT '[]'::jsonb NOT NULL,
  scoring_version text DEFAULT 'v1'::text NOT NULL,
  schema_version text DEFAULT 'v1'::text NOT NULL,
  prompt_version text,
  model_provider text,
  model_name text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  completed_at timestamp with time zone
);
CREATE TABLE public.writing_rewrite_evidence_candidates (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  rewrite_submission_id uuid NOT NULL,
  review_id uuid NOT NULL,
  correction_id text,
  grammar_topic_id uuid,
  evidence_type text NOT NULL,
  independence_assessment rewrite_independence_assessment DEFAULT 'uncertain'::rewrite_independence_assessment NOT NULL,
  confidence numeric(4,3) DEFAULT 0.5 NOT NULL,
  should_affect_mastery boolean DEFAULT false NOT NULL,
  context_key text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.writing_rewrite_status_history (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  rewrite_submission_id uuid NOT NULL,
  evaluation_id uuid,
  previous_status rewrite_status,
  new_status rewrite_status NOT NULL,
  reason_code text,
  source text DEFAULT 'user_action'::text NOT NULL,
  request_id text,
  metadata_json jsonb,
  changed_at timestamp with time zone DEFAULT now() NOT NULL
);

-- ---------------------------------------------------------------------
-- 4. PRIMARY KEY / UNIQUE CONSTRAINTS (107 PK + 56 UNIQUE)
-- ---------------------------------------------------------------------
ALTER TABLE ONLY public.admin_audit_log ADD CONSTRAINT admin_audit_log_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.admin_invitations ADD CONSTRAINT admin_invitations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.admin_invitations ADD CONSTRAINT admin_invitations_invitation_token_hash_key UNIQUE (invitation_token_hash);
ALTER TABLE ONLY public.admin_permissions ADD CONSTRAINT admin_permissions_pkey PRIMARY KEY (key);
ALTER TABLE ONLY public.admin_rate_limit_buckets ADD CONSTRAINT admin_rate_limit_buckets_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.admin_rate_limit_buckets ADD CONSTRAINT admin_rate_limit_buckets_actor_id_action_key_window_start_key UNIQUE (actor_id, action_key, window_start);
ALTER TABLE ONLY public.admin_role_permissions ADD CONSTRAINT admin_role_permissions_pkey PRIMARY KEY (role, permission_key);
ALTER TABLE ONLY public.admin_roles ADD CONSTRAINT admin_roles_pkey PRIMARY KEY (role);
ALTER TABLE ONLY public.admin_security_configs ADD CONSTRAINT admin_security_configs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.admin_security_configs ADD CONSTRAINT admin_security_configs_environment_key UNIQUE (environment);
ALTER TABLE ONLY public.admin_security_events ADD CONSTRAINT admin_security_events_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.admin_security_policy_versions ADD CONSTRAINT admin_security_policy_versions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.admin_security_policy_versions ADD CONSTRAINT admin_security_policy_versions_environment_version_number_key UNIQUE (environment, version_number);
ALTER TABLE ONLY public.admin_users ADD CONSTRAINT admin_users_pkey PRIMARY KEY (user_id);
ALTER TABLE ONLY public.ai_alert_rules ADD CONSTRAINT ai_alert_rules_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ai_alerts ADD CONSTRAINT ai_alerts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ai_budget_policies ADD CONSTRAINT ai_budget_policies_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ai_control_switches ADD CONSTRAINT ai_control_switches_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ai_conversation_preferences ADD CONSTRAINT ai_conversation_preferences_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ai_conversation_preferences ADD CONSTRAINT uq_ai_prefs_per_user UNIQUE (user_id);
ALTER TABLE ONLY public.ai_cost_valuations ADD CONSTRAINT ai_cost_valuations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ai_cost_valuations ADD CONSTRAINT ai_cost_valuations_event_id_pricing_version_id_input_hash_key UNIQUE (event_id, pricing_version_id, input_hash);
ALTER TABLE ONLY public.ai_features ADD CONSTRAINT ai_features_pkey PRIMARY KEY (feature_key);
ALTER TABLE ONLY public.ai_gateway_budget_buckets ADD CONSTRAINT ai_gateway_budget_buckets_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ai_gateway_circuit_breakers ADD CONSTRAINT ai_gateway_circuit_breakers_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ai_gateway_concurrency_validations ADD CONSTRAINT ai_gateway_concurrency_validations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ai_gateway_config_acknowledgements ADD CONSTRAINT ai_gateway_config_acknowledgements_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ai_gateway_config_versions ADD CONSTRAINT ai_gateway_config_versions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ai_gateway_config_versions ADD CONSTRAINT ai_gateway_config_versions_environment_version_number_key UNIQUE (environment, version_number);
ALTER TABLE ONLY public.ai_gateway_configs ADD CONSTRAINT ai_gateway_configs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ai_gateway_configs ADD CONSTRAINT ai_gateway_configs_environment_key UNIQUE (environment);
ALTER TABLE ONLY public.ai_gateway_decisions ADD CONSTRAINT ai_gateway_decisions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ai_gateway_idempotency_locks ADD CONSTRAINT ai_gateway_idempotency_locks_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ai_gateway_idempotency_locks ADD CONSTRAINT uq_agil_scope_key UNIQUE (scope, idempotency_key);
ALTER TABLE ONLY public.ai_gateway_quota_buckets ADD CONSTRAINT ai_gateway_quota_buckets_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ai_gateway_reservation_budget_links ADD CONSTRAINT ai_gateway_reservation_budget_links_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ai_gateway_reservation_budget_links ADD CONSTRAINT uq_agrbl_reservation_bucket UNIQUE (reservation_id, budget_bucket_id);
ALTER TABLE ONLY public.ai_pricing_acknowledgements ADD CONSTRAINT ai_pricing_acknowledgements_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ai_pricing_rates ADD CONSTRAINT ai_pricing_rates_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ai_pricing_versions ADD CONSTRAINT ai_pricing_versions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ai_pricing_versions ADD CONSTRAINT ai_pricing_versions_environment_version_number_key UNIQUE (environment, version_number);
ALTER TABLE ONLY public.ai_provider_sessions ADD CONSTRAINT ai_provider_sessions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ai_runtime_controls ADD CONSTRAINT ai_runtime_controls_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ai_runtime_controls ADD CONSTRAINT uq_arc_scope UNIQUE (scope_type, scope_key);
ALTER TABLE ONLY public.ai_usage_event_metrics ADD CONSTRAINT ai_usage_event_metrics_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ai_usage_events ADD CONSTRAINT ai_usage_events_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ai_usage_events ADD CONSTRAINT ai_usage_events_request_id_key UNIQUE (request_id);
ALTER TABLE ONLY public.api_rate_limits ADD CONSTRAINT api_rate_limits_pkey PRIMARY KEY (user_id, route_key);
ALTER TABLE ONLY public.app_config_acknowledgements ADD CONSTRAINT app_config_acknowledgements_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.app_config_definitions ADD CONSTRAINT app_config_definitions_pkey PRIMARY KEY (key);
ALTER TABLE ONLY public.app_config_values ADD CONSTRAINT app_config_values_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.app_config_values ADD CONSTRAINT app_config_values_version_id_definition_key_key UNIQUE (version_id, definition_key);
ALTER TABLE ONLY public.app_config_versions ADD CONSTRAINT app_config_versions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.app_config_versions ADD CONSTRAINT app_config_versions_environment_version_number_key UNIQUE (environment, version_number);
ALTER TABLE ONLY public.capability_definitions ADD CONSTRAINT capability_definitions_pkey PRIMARY KEY (key);
ALTER TABLE ONLY public.conversation_session_authorizations ADD CONSTRAINT conversation_session_authorizations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.conversation_sessions ADD CONSTRAINT conversation_sessions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.engine_activation_log ADD CONSTRAINT engine_activation_log_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.engine_activation_log ADD CONSTRAINT engine_activation_log_idempotency_key_key UNIQUE (idempotency_key);
ALTER TABLE ONLY public.english_learning_memory ADD CONSTRAINT english_learning_memory_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.english_reviews ADD CONSTRAINT english_reviews_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.gateway_heartbeats ADD CONSTRAINT gateway_heartbeats_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.generated_themes ADD CONSTRAINT generated_themes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.grammar_explanations ADD CONSTRAINT grammar_explanations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.learner_skill_profiles ADD CONSTRAINT learner_skill_profiles_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.learner_skill_profiles ADD CONSTRAINT uq_learner_skill_profiles_user_skill UNIQUE (user_id, skill);
ALTER TABLE ONLY public.learning_day_overrides ADD CONSTRAINT learning_day_overrides_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.learning_day_overrides ADD CONSTRAINT learning_day_overrides_user_id_entry_date_key UNIQUE (user_id, entry_date);
ALTER TABLE ONLY public.listening_audio_assets ADD CONSTRAINT listening_audio_assets_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.listening_audio_assets ADD CONSTRAINT listening_audio_assets_block_id_ssml_hash_synthesis_config__key UNIQUE (block_id, ssml_hash, synthesis_config_version);
ALTER TABLE ONLY public.listening_audio_flags ADD CONSTRAINT listening_audio_flags_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.listening_audio_flags ADD CONSTRAINT listening_audio_flags_block_id_key UNIQUE (block_id);
ALTER TABLE ONLY public.listening_blocks ADD CONSTRAINT listening_blocks_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.listening_blocks ADD CONSTRAINT listening_blocks_episode_id_block_order_key UNIQUE (episode_id, block_order);
ALTER TABLE ONLY public.listening_bookmark_timings ADD CONSTRAINT listening_bookmark_timings_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.listening_bookmark_timings ADD CONSTRAINT listening_bookmark_timings_audio_asset_id_bookmark_name_key UNIQUE (audio_asset_id, bookmark_name);
ALTER TABLE ONLY public.listening_episode_distribution ADD CONSTRAINT listening_episode_distribution_pkey PRIMARY KEY (episode_id);
ALTER TABLE ONLY public.listening_episode_publications ADD CONSTRAINT listening_episode_publications_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.listening_episodes ADD CONSTRAINT listening_episodes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.listening_episodes ADD CONSTRAINT listening_episodes_generation_key_key UNIQUE (generation_key);
ALTER TABLE ONLY public.listening_generation_jobs ADD CONSTRAINT listening_generation_jobs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.listening_generation_requests ADD CONSTRAINT listening_generation_requests_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.listening_jobs ADD CONSTRAINT listening_jobs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.listening_operational_alerts ADD CONSTRAINT listening_operational_alerts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.listening_publication_log ADD CONSTRAINT listening_publication_log_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.listening_questions ADD CONSTRAINT listening_questions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.listening_questions ADD CONSTRAINT listening_questions_block_id_key UNIQUE (block_id);
ALTER TABLE ONLY public.listening_questions ADD CONSTRAINT listening_questions_episode_id_question_order_key UNIQUE (episode_id, question_order);
ALTER TABLE ONLY public.listening_sentence_timings ADD CONSTRAINT listening_sentence_timings_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.listening_sentence_timings ADD CONSTRAINT listening_sentence_timings_audio_asset_id_sentence_key_key UNIQUE (audio_asset_id, sentence_key);
ALTER TABLE ONLY public.listening_sentences ADD CONSTRAINT listening_sentences_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.listening_sentences ADD CONSTRAINT listening_sentences_block_id_sentence_key_key UNIQUE (block_id, sentence_key);
ALTER TABLE ONLY public.listening_sentences ADD CONSTRAINT listening_sentences_block_id_sentence_order_key UNIQUE (block_id, sentence_order);
ALTER TABLE ONLY public.listening_shared_stories ADD CONSTRAINT listening_shared_stories_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.listening_shared_stories ADD CONSTRAINT uq_lss_group_date UNIQUE (level_group, practice_date);
ALTER TABLE ONLY public.listening_subtitle_cues ADD CONSTRAINT listening_subtitle_cues_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.listening_subtitle_cues ADD CONSTRAINT listening_subtitle_cues_block_id_language_cue_order_key UNIQUE (block_id, language, cue_order);
ALTER TABLE ONLY public.listening_subtitle_cues ADD CONSTRAINT uq_lsc_block_lang_cue_key UNIQUE (block_id, language, cue_key);
ALTER TABLE ONLY public.listening_word_timings ADD CONSTRAINT listening_word_timings_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.listening_word_timings ADD CONSTRAINT listening_word_timings_audio_asset_id_word_order_key UNIQUE (audio_asset_id, word_order);
ALTER TABLE ONLY public.plan_capability_values ADD CONSTRAINT plan_capability_values_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.plan_capability_values ADD CONSTRAINT plan_capability_values_plan_version_id_capability_key_key UNIQUE (plan_version_id, capability_key);
ALTER TABLE ONLY public.plan_trial_policies ADD CONSTRAINT plan_trial_policies_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.plan_trial_policies ADD CONSTRAINT plan_trial_policies_plan_id_key UNIQUE (plan_id);
ALTER TABLE ONLY public.plan_versions ADD CONSTRAINT plan_versions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.plan_versions ADD CONSTRAINT plan_versions_plan_id_version_number_key UNIQUE (plan_id, version_number);
ALTER TABLE ONLY public.plans ADD CONSTRAINT plans_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.plans ADD CONSTRAINT plans_code_key UNIQUE (code);
ALTER TABLE ONLY public.pronunciation_assessments ADD CONSTRAINT pronunciation_assessments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.pronunciation_assessments ADD CONSTRAINT uq_pronunciation_per_text_version UNIQUE (user_id, text_version_id);
ALTER TABLE ONLY public.pronunciation_training_sessions ADD CONSTRAINT pronunciation_training_sessions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.pronunciation_training_sessions ADD CONSTRAINT uq_pts_user_date UNIQUE (user_id, practice_date);
ALTER TABLE ONLY public.provider_pricing ADD CONSTRAINT provider_pricing_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.realtime_hard_control_validations ADD CONSTRAINT realtime_hard_control_validations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.review_attempt_items ADD CONSTRAINT review_attempt_items_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.review_attempts ADD CONSTRAINT review_attempts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.review_group_items ADD CONSTRAINT review_group_items_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.review_groups ADD CONSTRAINT review_groups_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.review_groups ADD CONSTRAINT review_groups_user_review_unique UNIQUE (user_id, source_review_id);
ALTER TABLE ONLY public.review_schedule_history ADD CONSTRAINT review_schedule_history_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.review_schedule_history ADD CONSTRAINT review_schedule_history_review_attempt_id_key UNIQUE (review_attempt_id);
ALTER TABLE ONLY public.usage_daily ADD CONSTRAINT usage_daily_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.usage_daily_metrics ADD CONSTRAINT usage_daily_metrics_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.usage_daily_metrics ADD CONSTRAINT uq_udm_daily_metric UNIQUE (usage_daily_id, metric_key, unit_type);
ALTER TABLE ONLY public.usage_reservation_items ADD CONSTRAINT usage_reservation_items_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.usage_reservation_items ADD CONSTRAINT uq_uri_reservation_quota UNIQUE (reservation_id, quota_key, unit_type);
ALTER TABLE ONLY public.usage_reservations ADD CONSTRAINT usage_reservations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.user_access_controls ADD CONSTRAINT user_access_controls_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.user_access_controls ADD CONSTRAINT user_access_controls_user_id_key UNIQUE (user_id);
ALTER TABLE ONLY public.user_account_deactivations ADD CONSTRAINT user_account_deactivations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.user_billing_blocks ADD CONSTRAINT user_billing_blocks_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.user_capability_overrides ADD CONSTRAINT user_capability_overrides_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.user_capability_overrides ADD CONSTRAINT user_capability_overrides_idempotency_key_key UNIQUE (idempotency_key);
ALTER TABLE ONLY public.user_communication_blocks ADD CONSTRAINT user_communication_blocks_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.user_conversation_credits ADD CONSTRAINT user_conversation_credits_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.user_learning_settings ADD CONSTRAINT user_learning_settings_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.user_learning_settings ADD CONSTRAINT user_learning_settings_user_id_key UNIQUE (user_id);
ALTER TABLE ONLY public.user_listening_assignments ADD CONSTRAINT user_listening_assignments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.user_listening_assignments ADD CONSTRAINT user_listening_assignments_user_date_episode_key UNIQUE (user_id, activity_date, episode_id);
ALTER TABLE ONLY public.user_listening_attempts ADD CONSTRAINT user_listening_attempts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.user_listening_attempts ADD CONSTRAINT user_listening_attempts_user_id_question_id_attempt_cycle_a_key UNIQUE (user_id, question_id, attempt_cycle, attempt_number);
ALTER TABLE ONLY public.user_listening_block_sessions ADD CONSTRAINT user_listening_block_sessions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.user_listening_generation_sessions ADD CONSTRAINT user_listening_generation_sessions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.user_listening_generation_sessions ADD CONSTRAINT user_listening_generation_sessions_idempotency_key_key UNIQUE (idempotency_key);
ALTER TABLE ONLY public.user_listening_progress ADD CONSTRAINT user_listening_progress_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.user_listening_progress ADD CONSTRAINT user_listening_progress_user_id_episode_id_key UNIQUE (user_id, episode_id);
ALTER TABLE ONLY public.user_listening_results ADD CONSTRAINT user_listening_results_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.user_listening_results ADD CONSTRAINT user_listening_results_user_id_assignment_id_key UNIQUE (user_id, assignment_id);
ALTER TABLE ONLY public.user_listening_shared_progress ADD CONSTRAINT user_listening_shared_progress_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.user_listening_shared_progress ADD CONSTRAINT uq_ulsp_user_story UNIQUE (user_id, shared_story_id);
ALTER TABLE ONLY public.user_plan_assignments ADD CONSTRAINT user_plan_assignments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.user_plan_assignments ADD CONSTRAINT user_plan_assignments_idempotency_key_key UNIQUE (idempotency_key);
ALTER TABLE ONLY public.writing_entries ADD CONSTRAINT writing_entries_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.writing_review_reservations ADD CONSTRAINT writing_review_reservations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.writing_review_reservations ADD CONSTRAINT uq_wrr_user_attempt UNIQUE (user_id, attempt_id);
ALTER TABLE ONLY public.writing_rewrite_attempts ADD CONSTRAINT writing_rewrite_attempts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.writing_rewrite_attempts ADD CONSTRAINT writing_rewrite_attempts_review_id_user_id_rewrite_sequence_key UNIQUE (review_id, user_id, rewrite_sequence);
ALTER TABLE ONLY public.writing_rewrite_correction_outcomes ADD CONSTRAINT writing_rewrite_correction_outcomes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.writing_rewrite_evaluations ADD CONSTRAINT writing_rewrite_evaluations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.writing_rewrite_evaluations ADD CONSTRAINT writing_rewrite_evaluations_rewrite_submission_id_evaluatio_key UNIQUE (rewrite_submission_id, evaluation_version);
ALTER TABLE ONLY public.writing_rewrite_evidence_candidates ADD CONSTRAINT writing_rewrite_evidence_candidates_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.writing_rewrite_evidence_candidates ADD CONSTRAINT writing_rewrite_evidence_cand_review_id_correction_id_evide_key UNIQUE (review_id, correction_id, evidence_type, rewrite_submission_id);
ALTER TABLE ONLY public.writing_rewrite_status_history ADD CONSTRAINT writing_rewrite_status_history_pkey PRIMARY KEY (id);

-- ---------------------------------------------------------------------
-- 5. FOREIGN KEYS (195) -- aplicadas apos todas as tabelas existirem
-- ---------------------------------------------------------------------
ALTER TABLE ONLY public.admin_audit_log ADD CONSTRAINT admin_audit_log_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES auth.users(id);
ALTER TABLE ONLY public.admin_invitations ADD CONSTRAINT admin_invitations_accepted_user_id_fkey FOREIGN KEY (accepted_user_id) REFERENCES auth.users(id);
ALTER TABLE ONLY public.admin_invitations ADD CONSTRAINT admin_invitations_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.admin_invitations ADD CONSTRAINT admin_invitations_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.admin_invitations ADD CONSTRAINT admin_invitations_role_fkey FOREIGN KEY (role) REFERENCES admin_roles(role);
ALTER TABLE ONLY public.admin_role_permissions ADD CONSTRAINT admin_role_permissions_permission_key_fkey FOREIGN KEY (permission_key) REFERENCES admin_permissions(key);
ALTER TABLE ONLY public.admin_role_permissions ADD CONSTRAINT admin_role_permissions_role_fkey FOREIGN KEY (role) REFERENCES admin_roles(role);
ALTER TABLE ONLY public.admin_security_configs ADD CONSTRAINT admin_security_configs_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.admin_security_configs ADD CONSTRAINT fk_admin_security_configs_current_version FOREIGN KEY (current_version_id) REFERENCES admin_security_policy_versions(id);
ALTER TABLE ONLY public.admin_security_events ADD CONSTRAINT admin_security_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES auth.users(id);
ALTER TABLE ONLY public.admin_security_events ADD CONSTRAINT admin_security_events_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES auth.users(id);
ALTER TABLE ONLY public.admin_security_policy_versions ADD CONSTRAINT admin_security_policy_versions_previous_version_id_fkey FOREIGN KEY (previous_version_id) REFERENCES admin_security_policy_versions(id);
ALTER TABLE ONLY public.admin_security_policy_versions ADD CONSTRAINT admin_security_policy_versions_published_by_fkey FOREIGN KEY (published_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.admin_users ADD CONSTRAINT admin_users_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.admin_users ADD CONSTRAINT admin_users_status_changed_by_fkey FOREIGN KEY (status_changed_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.admin_users ADD CONSTRAINT admin_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.admin_users ADD CONSTRAINT fk_admin_users_invitation FOREIGN KEY (invitation_id) REFERENCES admin_invitations(id);
ALTER TABLE ONLY public.ai_alert_rules ADD CONSTRAINT ai_alert_rules_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.ai_alerts ADD CONSTRAINT ai_alerts_acknowledged_by_fkey FOREIGN KEY (acknowledged_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.ai_alerts ADD CONSTRAINT ai_alerts_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.ai_alerts ADD CONSTRAINT ai_alerts_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES ai_alert_rules(id);
ALTER TABLE ONLY public.ai_budget_policies ADD CONSTRAINT ai_budget_policies_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.ai_budget_policies ADD CONSTRAINT ai_budget_policies_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.ai_control_switches ADD CONSTRAINT ai_control_switches_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.ai_control_switches ADD CONSTRAINT ai_control_switches_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.ai_conversation_preferences ADD CONSTRAINT ai_conversation_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.ai_cost_valuations ADD CONSTRAINT ai_cost_valuations_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.ai_cost_valuations ADD CONSTRAINT ai_cost_valuations_event_id_fkey FOREIGN KEY (event_id) REFERENCES ai_usage_events(id);
ALTER TABLE ONLY public.ai_cost_valuations ADD CONSTRAINT ai_cost_valuations_pricing_version_id_fkey FOREIGN KEY (pricing_version_id) REFERENCES ai_pricing_versions(id);
ALTER TABLE ONLY public.ai_cost_valuations ADD CONSTRAINT ai_cost_valuations_superseded_valuation_id_fkey FOREIGN KEY (superseded_valuation_id) REFERENCES ai_cost_valuations(id);
ALTER TABLE ONLY public.ai_gateway_circuit_breakers ADD CONSTRAINT ai_gateway_circuit_breakers_feature_key_fkey FOREIGN KEY (feature_key) REFERENCES ai_features(feature_key);
ALTER TABLE ONLY public.ai_gateway_config_versions ADD CONSTRAINT ai_gateway_config_versions_previous_version_id_fkey FOREIGN KEY (previous_version_id) REFERENCES ai_gateway_config_versions(id);
ALTER TABLE ONLY public.ai_gateway_config_versions ADD CONSTRAINT ai_gateway_config_versions_published_by_fkey FOREIGN KEY (published_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.ai_gateway_configs ADD CONSTRAINT ai_gateway_configs_emergency_stop_by_fkey FOREIGN KEY (emergency_stop_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.ai_gateway_configs ADD CONSTRAINT ai_gateway_configs_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.ai_gateway_configs ADD CONSTRAINT fk_current_version FOREIGN KEY (current_version_id) REFERENCES ai_gateway_config_versions(id);
ALTER TABLE ONLY public.ai_gateway_decisions ADD CONSTRAINT ai_gateway_decisions_feature_key_fkey FOREIGN KEY (feature_key) REFERENCES ai_features(feature_key);
ALTER TABLE ONLY public.ai_gateway_decisions ADD CONSTRAINT ai_gateway_decisions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.ai_gateway_quota_buckets ADD CONSTRAINT ai_gateway_quota_buckets_feature_key_fkey FOREIGN KEY (feature_key) REFERENCES ai_features(feature_key);
ALTER TABLE ONLY public.ai_gateway_quota_buckets ADD CONSTRAINT ai_gateway_quota_buckets_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.ai_gateway_reservation_budget_links ADD CONSTRAINT ai_gateway_reservation_budget_links_budget_bucket_id_fkey FOREIGN KEY (budget_bucket_id) REFERENCES ai_gateway_budget_buckets(id);
ALTER TABLE ONLY public.ai_gateway_reservation_budget_links ADD CONSTRAINT ai_gateway_reservation_budget_links_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES usage_reservations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.ai_pricing_rates ADD CONSTRAINT ai_pricing_rates_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.ai_pricing_rates ADD CONSTRAINT ai_pricing_rates_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.ai_pricing_rates ADD CONSTRAINT ai_pricing_rates_version_id_fkey FOREIGN KEY (version_id) REFERENCES ai_pricing_versions(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.ai_pricing_versions ADD CONSTRAINT ai_pricing_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.ai_pricing_versions ADD CONSTRAINT ai_pricing_versions_discarded_by_fkey FOREIGN KEY (discarded_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.ai_pricing_versions ADD CONSTRAINT ai_pricing_versions_previous_version_id_fkey FOREIGN KEY (previous_version_id) REFERENCES ai_pricing_versions(id);
ALTER TABLE ONLY public.ai_pricing_versions ADD CONSTRAINT ai_pricing_versions_published_by_fkey FOREIGN KEY (published_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.ai_provider_sessions ADD CONSTRAINT ai_provider_sessions_feature_key_fkey FOREIGN KEY (feature_key) REFERENCES ai_features(feature_key);
ALTER TABLE ONLY public.ai_provider_sessions ADD CONSTRAINT ai_provider_sessions_initiated_by_user_id_fkey FOREIGN KEY (initiated_by_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.ai_provider_sessions ADD CONSTRAINT ai_provider_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.ai_runtime_controls ADD CONSTRAINT ai_runtime_controls_feature_key_fkey FOREIGN KEY (feature_key) REFERENCES ai_features(feature_key) ON DELETE SET NULL;
ALTER TABLE ONLY public.ai_runtime_controls ADD CONSTRAINT ai_runtime_controls_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.ai_runtime_controls ADD CONSTRAINT ai_runtime_controls_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.ai_usage_event_metrics ADD CONSTRAINT ai_usage_event_metrics_pricing_id_fkey FOREIGN KEY (pricing_id) REFERENCES provider_pricing(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.ai_usage_event_metrics ADD CONSTRAINT ai_usage_event_metrics_usage_event_id_fkey FOREIGN KEY (usage_event_id) REFERENCES ai_usage_events(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.ai_usage_events ADD CONSTRAINT ai_usage_events_feature_key_fkey FOREIGN KEY (feature_key) REFERENCES ai_features(feature_key);
ALTER TABLE ONLY public.ai_usage_events ADD CONSTRAINT ai_usage_events_initiated_by_user_id_fkey FOREIGN KEY (initiated_by_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.ai_usage_events ADD CONSTRAINT ai_usage_events_parent_event_id_fkey FOREIGN KEY (parent_event_id) REFERENCES ai_usage_events(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.ai_usage_events ADD CONSTRAINT ai_usage_events_provider_session_record_id_fkey FOREIGN KEY (provider_session_record_id) REFERENCES ai_provider_sessions(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.ai_usage_events ADD CONSTRAINT ai_usage_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.app_config_definitions ADD CONSTRAINT app_config_definitions_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.app_config_values ADD CONSTRAINT app_config_values_definition_key_fkey FOREIGN KEY (definition_key) REFERENCES app_config_definitions(key);
ALTER TABLE ONLY public.app_config_values ADD CONSTRAINT app_config_values_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.app_config_values ADD CONSTRAINT app_config_values_version_id_fkey FOREIGN KEY (version_id) REFERENCES app_config_versions(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.app_config_versions ADD CONSTRAINT app_config_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.app_config_versions ADD CONSTRAINT app_config_versions_discarded_by_fkey FOREIGN KEY (discarded_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.app_config_versions ADD CONSTRAINT app_config_versions_previous_version_id_fkey FOREIGN KEY (previous_version_id) REFERENCES app_config_versions(id);
ALTER TABLE ONLY public.app_config_versions ADD CONSTRAINT app_config_versions_published_by_fkey FOREIGN KEY (published_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.capability_definitions ADD CONSTRAINT capability_definitions_dependency_key_fkey FOREIGN KEY (dependency_key) REFERENCES capability_definitions(key);
ALTER TABLE ONLY public.conversation_session_authorizations ADD CONSTRAINT conversation_session_authorizations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.conversation_sessions ADD CONSTRAINT conversation_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.engine_activation_log ADD CONSTRAINT engine_activation_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.generated_themes ADD CONSTRAINT generated_themes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
ALTER TABLE ONLY public.learner_skill_profiles ADD CONSTRAINT learner_skill_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.learning_day_overrides ADD CONSTRAINT learning_day_overrides_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.listening_audio_assets ADD CONSTRAINT listening_audio_assets_block_id_fkey FOREIGN KEY (block_id) REFERENCES listening_blocks(id);
ALTER TABLE ONLY public.listening_audio_assets ADD CONSTRAINT listening_audio_assets_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES listening_episodes(id);
ALTER TABLE ONLY public.listening_audio_flags ADD CONSTRAINT listening_audio_flags_flagged_by_fkey FOREIGN KEY (flagged_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.listening_audio_flags ADD CONSTRAINT listening_audio_flags_quarantined_by_fkey FOREIGN KEY (quarantined_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.listening_audio_flags ADD CONSTRAINT listening_audio_flags_restored_by_fkey FOREIGN KEY (restored_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.listening_blocks ADD CONSTRAINT listening_blocks_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES listening_episodes(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.listening_bookmark_timings ADD CONSTRAINT listening_bookmark_timings_audio_asset_id_fkey FOREIGN KEY (audio_asset_id) REFERENCES listening_audio_assets(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.listening_episode_distribution ADD CONSTRAINT listening_episode_distribution_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.listening_episode_publications ADD CONSTRAINT listening_episode_publications_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth.users(id);
ALTER TABLE ONLY public.listening_episodes ADD CONSTRAINT listening_episodes_published_by_fkey FOREIGN KEY (published_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.listening_generation_jobs ADD CONSTRAINT listening_generation_jobs_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES listening_episodes(id);
ALTER TABLE ONLY public.listening_generation_requests ADD CONSTRAINT listening_generation_requests_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.listening_generation_requests ADD CONSTRAINT listening_generation_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.listening_jobs ADD CONSTRAINT listening_jobs_block_id_fkey FOREIGN KEY (block_id) REFERENCES listening_blocks(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.listening_jobs ADD CONSTRAINT listening_jobs_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES listening_episodes(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.listening_operational_alerts ADD CONSTRAINT listening_operational_alerts_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES listening_episodes(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.listening_operational_alerts ADD CONSTRAINT listening_operational_alerts_job_id_fkey FOREIGN KEY (job_id) REFERENCES listening_jobs(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.listening_publication_log ADD CONSTRAINT listening_publication_log_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES listening_episodes(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.listening_publication_log ADD CONSTRAINT listening_publication_log_published_by_fkey FOREIGN KEY (published_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.listening_questions ADD CONSTRAINT listening_questions_block_id_fkey FOREIGN KEY (block_id) REFERENCES listening_blocks(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.listening_questions ADD CONSTRAINT listening_questions_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES listening_episodes(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.listening_sentence_timings ADD CONSTRAINT listening_sentence_timings_audio_asset_id_fkey FOREIGN KEY (audio_asset_id) REFERENCES listening_audio_assets(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.listening_sentence_timings ADD CONSTRAINT listening_sentence_timings_block_id_fkey FOREIGN KEY (block_id) REFERENCES listening_blocks(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.listening_sentences ADD CONSTRAINT listening_sentences_block_id_fkey FOREIGN KEY (block_id) REFERENCES listening_blocks(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.listening_subtitle_cues ADD CONSTRAINT listening_subtitle_cues_audio_asset_id_fkey FOREIGN KEY (audio_asset_id) REFERENCES listening_audio_assets(id);
ALTER TABLE ONLY public.listening_subtitle_cues ADD CONSTRAINT listening_subtitle_cues_block_id_fkey FOREIGN KEY (block_id) REFERENCES listening_blocks(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.listening_word_timings ADD CONSTRAINT listening_word_timings_audio_asset_id_fkey FOREIGN KEY (audio_asset_id) REFERENCES listening_audio_assets(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.plan_capability_values ADD CONSTRAINT plan_capability_values_capability_key_fkey FOREIGN KEY (capability_key) REFERENCES capability_definitions(key);
ALTER TABLE ONLY public.plan_capability_values ADD CONSTRAINT plan_capability_values_plan_version_id_fkey FOREIGN KEY (plan_version_id) REFERENCES plan_versions(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.plan_capability_values ADD CONSTRAINT plan_capability_values_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.plan_trial_policies ADD CONSTRAINT plan_trial_policies_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES plans(id);
ALTER TABLE ONLY public.plan_trial_policies ADD CONSTRAINT plan_trial_policies_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.plan_versions ADD CONSTRAINT plan_versions_based_on_version_id_fkey FOREIGN KEY (based_on_version_id) REFERENCES plan_versions(id);
ALTER TABLE ONLY public.plan_versions ADD CONSTRAINT plan_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.plan_versions ADD CONSTRAINT plan_versions_discarded_by_fkey FOREIGN KEY (discarded_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.plan_versions ADD CONSTRAINT plan_versions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.plan_versions ADD CONSTRAINT plan_versions_published_by_fkey FOREIGN KEY (published_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.plans ADD CONSTRAINT plans_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.plans ADD CONSTRAINT plans_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.pronunciation_assessments ADD CONSTRAINT pronunciation_assessments_text_version_id_fkey FOREIGN KEY (text_version_id) REFERENCES english_reviews(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.pronunciation_assessments ADD CONSTRAINT pronunciation_assessments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.pronunciation_training_sessions ADD CONSTRAINT pronunciation_training_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
ALTER TABLE ONLY public.review_attempt_items ADD CONSTRAINT review_attempt_items_review_attempt_id_fkey FOREIGN KEY (review_attempt_id) REFERENCES review_attempts(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.review_attempt_items ADD CONSTRAINT review_attempt_items_review_group_item_id_fkey FOREIGN KEY (review_group_item_id) REFERENCES review_group_items(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.review_attempts ADD CONSTRAINT review_attempts_review_group_id_fkey FOREIGN KEY (review_group_id) REFERENCES review_groups(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.review_attempts ADD CONSTRAINT review_attempts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.review_group_items ADD CONSTRAINT review_group_items_review_group_id_fkey FOREIGN KEY (review_group_id) REFERENCES review_groups(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.review_groups ADD CONSTRAINT review_groups_source_review_id_fkey FOREIGN KEY (source_review_id) REFERENCES english_reviews(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.review_groups ADD CONSTRAINT review_groups_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.review_schedule_history ADD CONSTRAINT review_schedule_history_review_attempt_id_fkey FOREIGN KEY (review_attempt_id) REFERENCES review_attempts(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.review_schedule_history ADD CONSTRAINT review_schedule_history_review_group_id_fkey FOREIGN KEY (review_group_id) REFERENCES review_groups(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.review_schedule_history ADD CONSTRAINT review_schedule_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.usage_daily ADD CONSTRAINT usage_daily_feature_key_fkey FOREIGN KEY (feature_key) REFERENCES ai_features(feature_key);
ALTER TABLE ONLY public.usage_daily ADD CONSTRAINT usage_daily_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.usage_daily_metrics ADD CONSTRAINT usage_daily_metrics_usage_daily_id_fkey FOREIGN KEY (usage_daily_id) REFERENCES usage_daily(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.usage_reservation_items ADD CONSTRAINT usage_reservation_items_quota_bucket_id_fkey FOREIGN KEY (quota_bucket_id) REFERENCES ai_gateway_quota_buckets(id);
ALTER TABLE ONLY public.usage_reservation_items ADD CONSTRAINT usage_reservation_items_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES usage_reservations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.usage_reservations ADD CONSTRAINT usage_reservations_feature_key_fkey FOREIGN KEY (feature_key) REFERENCES ai_features(feature_key);
ALTER TABLE ONLY public.usage_reservations ADD CONSTRAINT usage_reservations_initiated_by_user_id_fkey FOREIGN KEY (initiated_by_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.usage_reservations ADD CONSTRAINT usage_reservations_provider_session_record_id_fkey FOREIGN KEY (provider_session_record_id) REFERENCES ai_provider_sessions(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.usage_reservations ADD CONSTRAINT usage_reservations_usage_event_id_fkey FOREIGN KEY (usage_event_id) REFERENCES ai_usage_events(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.usage_reservations ADD CONSTRAINT usage_reservations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.user_access_controls ADD CONSTRAINT user_access_controls_restored_by_fkey FOREIGN KEY (restored_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.user_access_controls ADD CONSTRAINT user_access_controls_suspended_by_fkey FOREIGN KEY (suspended_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.user_access_controls ADD CONSTRAINT user_access_controls_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
ALTER TABLE ONLY public.user_account_deactivations ADD CONSTRAINT user_account_deactivations_reactivated_by_fkey FOREIGN KEY (reactivated_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.user_account_deactivations ADD CONSTRAINT user_account_deactivations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
ALTER TABLE ONLY public.user_billing_blocks ADD CONSTRAINT user_billing_blocks_lifted_by_fkey FOREIGN KEY (lifted_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.user_billing_blocks ADD CONSTRAINT user_billing_blocks_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
ALTER TABLE ONLY public.user_capability_overrides ADD CONSTRAINT user_capability_overrides_capability_key_fkey FOREIGN KEY (capability_key) REFERENCES capability_definitions(key);
ALTER TABLE ONLY public.user_capability_overrides ADD CONSTRAINT user_capability_overrides_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.user_capability_overrides ADD CONSTRAINT user_capability_overrides_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.user_capability_overrides ADD CONSTRAINT user_capability_overrides_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
ALTER TABLE ONLY public.user_communication_blocks ADD CONSTRAINT user_communication_blocks_lifted_by_fkey FOREIGN KEY (lifted_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.user_communication_blocks ADD CONSTRAINT user_communication_blocks_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.user_conversation_credits ADD CONSTRAINT user_conversation_credits_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.user_conversation_credits ADD CONSTRAINT user_conversation_credits_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
ALTER TABLE ONLY public.user_learning_settings ADD CONSTRAINT user_learning_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.user_listening_assignments ADD CONSTRAINT user_listening_assignments_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES listening_episodes(id);
ALTER TABLE ONLY public.user_listening_assignments ADD CONSTRAINT user_listening_assignments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.user_listening_attempts ADD CONSTRAINT user_listening_attempts_block_id_fkey FOREIGN KEY (block_id) REFERENCES listening_blocks(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.user_listening_attempts ADD CONSTRAINT user_listening_attempts_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES listening_episodes(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.user_listening_attempts ADD CONSTRAINT user_listening_attempts_question_id_fkey FOREIGN KEY (question_id) REFERENCES listening_questions(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.user_listening_attempts ADD CONSTRAINT user_listening_attempts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.user_listening_block_sessions ADD CONSTRAINT user_listening_block_sessions_block_id_fkey FOREIGN KEY (block_id) REFERENCES listening_blocks(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.user_listening_block_sessions ADD CONSTRAINT user_listening_block_sessions_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES listening_episodes(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.user_listening_block_sessions ADD CONSTRAINT user_listening_block_sessions_question_id_fkey FOREIGN KEY (question_id) REFERENCES listening_questions(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.user_listening_block_sessions ADD CONSTRAINT user_listening_block_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.user_listening_generation_sessions ADD CONSTRAINT user_listening_generation_sessions_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES listening_episodes(id);
ALTER TABLE ONLY public.user_listening_generation_sessions ADD CONSTRAINT user_listening_generation_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.user_listening_progress ADD CONSTRAINT user_listening_progress_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES listening_episodes(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.user_listening_progress ADD CONSTRAINT user_listening_progress_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.user_listening_results ADD CONSTRAINT user_listening_results_assignment_id_fkey FOREIGN KEY (assignment_id) REFERENCES user_listening_assignments(id);
ALTER TABLE ONLY public.user_listening_results ADD CONSTRAINT user_listening_results_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES listening_episodes(id);
ALTER TABLE ONLY public.user_listening_results ADD CONSTRAINT user_listening_results_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.user_listening_shared_progress ADD CONSTRAINT user_listening_shared_progress_shared_story_id_fkey FOREIGN KEY (shared_story_id) REFERENCES listening_shared_stories(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.user_listening_shared_progress ADD CONSTRAINT user_listening_shared_progress_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.user_plan_assignments ADD CONSTRAINT user_plan_assignments_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.user_plan_assignments ADD CONSTRAINT user_plan_assignments_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.user_plan_assignments ADD CONSTRAINT user_plan_assignments_pinned_version_id_fkey FOREIGN KEY (pinned_version_id) REFERENCES plan_versions(id);
ALTER TABLE ONLY public.user_plan_assignments ADD CONSTRAINT user_plan_assignments_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES plans(id);
ALTER TABLE ONLY public.user_plan_assignments ADD CONSTRAINT user_plan_assignments_snapshot_version_id_fkey FOREIGN KEY (snapshot_version_id) REFERENCES plan_versions(id);
ALTER TABLE ONLY public.user_plan_assignments ADD CONSTRAINT user_plan_assignments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
ALTER TABLE ONLY public.writing_entries ADD CONSTRAINT writing_entries_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.writing_review_reservations ADD CONSTRAINT writing_review_reservations_review_id_fkey FOREIGN KEY (review_id) REFERENCES english_reviews(id);
ALTER TABLE ONLY public.writing_review_reservations ADD CONSTRAINT writing_review_reservations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
ALTER TABLE ONLY public.writing_rewrite_attempts ADD CONSTRAINT writing_rewrite_attempts_review_id_fkey FOREIGN KEY (review_id) REFERENCES english_reviews(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.writing_rewrite_attempts ADD CONSTRAINT writing_rewrite_attempts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.writing_rewrite_correction_outcomes ADD CONSTRAINT writing_rewrite_correction_outcomes_rewrite_evaluation_id_fkey FOREIGN KEY (rewrite_evaluation_id) REFERENCES writing_rewrite_evaluations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.writing_rewrite_evaluations ADD CONSTRAINT writing_rewrite_evaluations_original_submission_id_fkey FOREIGN KEY (original_submission_id) REFERENCES english_reviews(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.writing_rewrite_evaluations ADD CONSTRAINT writing_rewrite_evaluations_review_id_fkey FOREIGN KEY (review_id) REFERENCES english_reviews(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.writing_rewrite_evaluations ADD CONSTRAINT writing_rewrite_evaluations_rewrite_submission_id_fkey FOREIGN KEY (rewrite_submission_id) REFERENCES writing_rewrite_attempts(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.writing_rewrite_evaluations ADD CONSTRAINT writing_rewrite_evaluations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.writing_rewrite_evidence_candidates ADD CONSTRAINT writing_rewrite_evidence_candidates_review_id_fkey FOREIGN KEY (review_id) REFERENCES english_reviews(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.writing_rewrite_evidence_candidates ADD CONSTRAINT writing_rewrite_evidence_candidates_rewrite_submission_id_fkey FOREIGN KEY (rewrite_submission_id) REFERENCES writing_rewrite_attempts(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.writing_rewrite_evidence_candidates ADD CONSTRAINT writing_rewrite_evidence_candidates_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.writing_rewrite_status_history ADD CONSTRAINT writing_rewrite_status_history_evaluation_id_fkey FOREIGN KEY (evaluation_id) REFERENCES writing_rewrite_evaluations(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.writing_rewrite_status_history ADD CONSTRAINT writing_rewrite_status_history_rewrite_submission_id_fkey FOREIGN KEY (rewrite_submission_id) REFERENCES writing_rewrite_attempts(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------
-- 6. CHECK CONSTRAINTS (357)
-- ---------------------------------------------------------------------
ALTER TABLE ONLY public.admin_audit_log ADD CONSTRAINT admin_audit_log_result_check CHECK (((result IS NULL) OR (result = ANY (ARRAY['success'::text, 'failure'::text]))));
ALTER TABLE ONLY public.admin_invitations ADD CONSTRAINT admin_invitations_invitation_token_hash_check CHECK ((invitation_token_hash ~ '^[a-f0-9]{64}$'::text));
ALTER TABLE ONLY public.admin_invitations ADD CONSTRAINT admin_invitations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'expired'::text, 'revoked'::text])));
ALTER TABLE ONLY public.admin_invitations ADD CONSTRAINT chk_admin_invitations_expiry CHECK ((expires_at > created_at));
ALTER TABLE ONLY public.admin_roles ADD CONSTRAINT admin_roles_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'analyst'::text, 'support'::text])));
ALTER TABLE ONLY public.admin_security_configs ADD CONSTRAINT admin_security_configs_environment_check CHECK ((environment = ANY (ARRAY['development'::text, 'staging'::text, 'production'::text])));
ALTER TABLE ONLY public.admin_security_configs ADD CONSTRAINT admin_security_configs_invitation_expiry_hours_check CHECK (((invitation_expiry_hours >= 1) AND (invitation_expiry_hours <= 720)));
ALTER TABLE ONLY public.admin_security_configs ADD CONSTRAINT admin_security_configs_lockout_duration_seconds_check CHECK (((lockout_duration_seconds >= 60) AND (lockout_duration_seconds <= 86400)));
ALTER TABLE ONLY public.admin_security_configs ADD CONSTRAINT admin_security_configs_max_admin_session_hours_check CHECK (((max_admin_session_hours >= 1) AND (max_admin_session_hours <= 168)));
ALTER TABLE ONLY public.admin_security_configs ADD CONSTRAINT admin_security_configs_max_idle_minutes_check CHECK (((max_idle_minutes IS NULL) OR ((max_idle_minutes >= 5) AND (max_idle_minutes <= 1440))));
ALTER TABLE ONLY public.admin_security_configs ADD CONSTRAINT admin_security_configs_min_reason_length_check CHECK (((min_reason_length >= 1) AND (min_reason_length <= 500)));
ALTER TABLE ONLY public.admin_security_configs ADD CONSTRAINT admin_security_configs_rate_limit_max_attempts_check CHECK (((rate_limit_max_attempts >= 1) AND (rate_limit_max_attempts <= 1000)));
ALTER TABLE ONLY public.admin_security_configs ADD CONSTRAINT admin_security_configs_rate_limit_window_seconds_check CHECK (((rate_limit_window_seconds >= 10) AND (rate_limit_window_seconds <= 86400)));
ALTER TABLE ONLY public.admin_security_configs ADD CONSTRAINT admin_security_configs_recent_auth_window_seconds_check CHECK (((recent_auth_window_seconds >= 60) AND (recent_auth_window_seconds <= 86400)));
ALTER TABLE ONLY public.admin_security_events ADD CONSTRAINT admin_security_events_environment_check CHECK ((environment = ANY (ARRAY['development'::text, 'staging'::text, 'production'::text])));
ALTER TABLE ONLY public.admin_security_events ADD CONSTRAINT admin_security_events_event_type_check CHECK ((event_type = ANY (ARRAY['admin_login'::text, 'access_denied'::text, 'mfa_enrolled'::text, 'mfa_removed'::text, 'mfa_invalid'::text, 'reauth_required'::text, 'rate_limited'::text, 'invitation_created'::text, 'invitation_revoked'::text, 'invitation_expired'::text, 'role_changed'::text, 'admin_activated'::text, 'admin_deactivated'::text, 'sessions_revoked'::text, 'self_elevation_attempt'::text, 'last_owner_protection_triggered'::text, 'invalid_origin'::text, 'csrf_violation'::text, 'policy_error'::text])));
ALTER TABLE ONLY public.admin_security_events ADD CONSTRAINT admin_security_events_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text])));
ALTER TABLE ONLY public.admin_security_policy_versions ADD CONSTRAINT admin_security_policy_versions_change_type_check CHECK ((change_type = ANY (ARRAY['initial'::text, 'mfa_required_change'::text, 'recent_auth_change'::text, 'session_change'::text, 'invitation_expiry_change'::text, 'rate_limit_change'::text, 'rollback'::text, 'update'::text])));
ALTER TABLE ONLY public.admin_security_policy_versions ADD CONSTRAINT admin_security_policy_versions_environment_check CHECK ((environment = ANY (ARRAY['development'::text, 'staging'::text, 'production'::text])));
ALTER TABLE ONLY public.admin_security_policy_versions ADD CONSTRAINT admin_security_policy_versions_reason_check CHECK ((length(reason) > 0));
ALTER TABLE ONLY public.admin_security_policy_versions ADD CONSTRAINT admin_security_policy_versions_state_check CHECK ((state = ANY (ARRAY['published'::text, 'superseded'::text, 'revoked'::text])));
ALTER TABLE ONLY public.admin_users ADD CONSTRAINT admin_users_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'analyst'::text, 'support'::text])));
ALTER TABLE ONLY public.admin_users ADD CONSTRAINT admin_users_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text])));
ALTER TABLE ONLY public.ai_alert_rules ADD CONSTRAINT ai_alert_rules_alert_type_check CHECK ((alert_type = ANY (ARRAY['budget_threshold'::text, 'cost_anomaly'::text, 'call_spike'::text, 'error_rate'::text, 'latency_p95'::text, 'block_rate'::text, 'retry_rate'::text, 'unpriced_events'::text, 'unknown_feature'::text, 'gateway_offline'::text, 'config_unacknowledged'::text, 'version_drift'::text])));
ALTER TABLE ONLY public.ai_alert_rules ADD CONSTRAINT ai_alert_rules_cooldown_seconds_check CHECK ((cooldown_seconds >= 0));
ALTER TABLE ONLY public.ai_alert_rules ADD CONSTRAINT ai_alert_rules_environment_check CHECK ((environment = ANY (ARRAY['development'::text, 'staging'::text, 'production'::text])));
ALTER TABLE ONLY public.ai_alert_rules ADD CONSTRAINT ai_alert_rules_min_event_count_check CHECK ((min_event_count >= 1));
ALTER TABLE ONLY public.ai_alert_rules ADD CONSTRAINT ai_alert_rules_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text])));
ALTER TABLE ONLY public.ai_alert_rules ADD CONSTRAINT ai_alert_rules_window_seconds_check CHECK ((window_seconds > 0));
ALTER TABLE ONLY public.ai_alerts ADD CONSTRAINT ai_alerts_environment_check CHECK ((environment = ANY (ARRAY['development'::text, 'staging'::text, 'production'::text])));
ALTER TABLE ONLY public.ai_alerts ADD CONSTRAINT ai_alerts_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text])));
ALTER TABLE ONLY public.ai_alerts ADD CONSTRAINT ai_alerts_status_check CHECK ((status = ANY (ARRAY['open'::text, 'acknowledged'::text, 'resolved'::text])));
ALTER TABLE ONLY public.ai_alerts ADD CONSTRAINT ai_alerts_title_check CHECK (((length(title) >= 1) AND (length(title) <= 500)));
ALTER TABLE ONLY public.ai_budget_policies ADD CONSTRAINT ai_budget_policies_action_check CHECK ((action = ANY (ARRAY['alert_only'::text, 'would_block'::text, 'block'::text])));
ALTER TABLE ONLY public.ai_budget_policies ADD CONSTRAINT ai_budget_policies_environment_check CHECK ((environment = ANY (ARRAY['development'::text, 'staging'::text, 'production'::text])));
ALTER TABLE ONLY public.ai_budget_policies ADD CONSTRAINT ai_budget_policies_limit_value_check CHECK ((limit_value > (0)::numeric));
ALTER TABLE ONLY public.ai_budget_policies ADD CONSTRAINT ai_budget_policies_metric_check CHECK ((metric = ANY (ARRAY['cost'::text, 'calls'::text, 'input_tokens'::text, 'output_tokens'::text, 'tts_chars'::text, 'audio_seconds'::text, 'realtime_seconds'::text])));
ALTER TABLE ONLY public.ai_budget_policies ADD CONSTRAINT ai_budget_policies_name_check CHECK (((length(name) >= 1) AND (length(name) <= 200)));
ALTER TABLE ONLY public.ai_budget_policies ADD CONSTRAINT ai_budget_policies_period_check CHECK ((period = ANY (ARRAY['daily'::text, 'monthly'::text])));
ALTER TABLE ONLY public.ai_budget_policies ADD CONSTRAINT ai_budget_policies_priority_check CHECK (((priority >= 1) AND (priority <= 1000)));
ALTER TABLE ONLY public.ai_budget_policies ADD CONSTRAINT ai_budget_policies_scope_check CHECK ((scope = ANY (ARRAY['global'::text, 'provider'::text, 'model'::text, 'feature'::text, 'plan'::text, 'user'::text])));
ALTER TABLE ONLY public.ai_budget_policies ADD CONSTRAINT chk_budget_ends_after_starts CHECK (((ends_at IS NULL) OR (ends_at > starts_at)));
ALTER TABLE ONLY public.ai_budget_policies ADD CONSTRAINT chk_cost_requires_currency CHECK (((metric <> 'cost'::text) OR ((currency IS NOT NULL) AND (length(currency) = 3))));
ALTER TABLE ONLY public.ai_control_switches ADD CONSTRAINT ai_control_switches_environment_check CHECK ((environment = ANY (ARRAY['development'::text, 'staging'::text, 'production'::text])));
ALTER TABLE ONLY public.ai_control_switches ADD CONSTRAINT ai_control_switches_provider_check CHECK ((provider = ANY (ARRAY['openai'::text, 'azure'::text])));
ALTER TABLE ONLY public.ai_control_switches ADD CONSTRAINT ai_control_switches_scope_check CHECK ((scope = ANY (ARRAY['provider'::text, 'model'::text, 'feature'::text, 'route'::text])));
ALTER TABLE ONLY public.ai_control_switches ADD CONSTRAINT chk_feature_scope CHECK (((scope <> 'feature'::text) OR ((provider IS NULL) AND (model IS NULL) AND (feature_key IS NOT NULL))));
ALTER TABLE ONLY public.ai_control_switches ADD CONSTRAINT chk_model_scope CHECK (((scope <> 'model'::text) OR ((provider IS NOT NULL) AND (model IS NOT NULL) AND (feature_key IS NULL))));
ALTER TABLE ONLY public.ai_control_switches ADD CONSTRAINT chk_provider_scope CHECK (((scope <> 'provider'::text) OR ((provider IS NOT NULL) AND (model IS NULL) AND (feature_key IS NULL))));
ALTER TABLE ONLY public.ai_control_switches ADD CONSTRAINT chk_route_scope CHECK (((scope <> 'route'::text) OR ((feature_key IS NOT NULL) AND (provider IS NOT NULL))));
ALTER TABLE ONLY public.ai_control_switches ADD CONSTRAINT chk_switch_ends_after_starts CHECK (((ends_at IS NULL) OR (ends_at > starts_at)));
ALTER TABLE ONLY public.ai_conversation_preferences ADD CONSTRAINT ai_conversation_preferences_accent_check CHECK ((accent = ANY (ARRAY['american'::text, 'british'::text, 'neutral'::text])));
ALTER TABLE ONLY public.ai_conversation_preferences ADD CONSTRAINT ai_conversation_preferences_correction_detail_check CHECK ((correction_detail = ANY (ARRAY['brief'::text, 'detailed'::text])));
ALTER TABLE ONLY public.ai_conversation_preferences ADD CONSTRAINT ai_conversation_preferences_correction_language_check CHECK ((correction_language = ANY (ARRAY['portuguese'::text, 'english'::text])));
ALTER TABLE ONLY public.ai_conversation_preferences ADD CONSTRAINT ai_conversation_preferences_correction_scope_check CHECK ((correction_scope = ANY (ARRAY['important_only'::text, 'all_relevant'::text, 'communication_impact'::text])));
ALTER TABLE ONLY public.ai_conversation_preferences ADD CONSTRAINT ai_conversation_preferences_correction_style_check CHECK ((correction_style = ANY (ARRAY['gentle'::text, 'direct'::text])));
ALTER TABLE ONLY public.ai_conversation_preferences ADD CONSTRAINT ai_conversation_preferences_correction_timing_check CHECK ((correction_timing = ANY (ARRAY['after_each'::text, 'end_of_block'::text, 'session_summary'::text])));
ALTER TABLE ONLY public.ai_conversation_preferences ADD CONSTRAINT ai_conversation_preferences_daily_conversation_goal_minut_check CHECK ((daily_conversation_goal_minutes = ANY (ARRAY[5, 10, 15, 20, 30])));
ALTER TABLE ONLY public.ai_conversation_preferences ADD CONSTRAINT ai_conversation_preferences_formality_check CHECK ((formality = ANY (ARRAY['very_low'::text, 'low'::text, 'medium'::text, 'high'::text])));
ALTER TABLE ONLY public.ai_conversation_preferences ADD CONSTRAINT ai_conversation_preferences_humor_level_check CHECK ((humor_level = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text])));
ALTER TABLE ONLY public.ai_conversation_preferences ADD CONSTRAINT ai_conversation_preferences_personality_check CHECK ((personality = ANY (ARRAY['friendly'::text, 'professional'::text, 'strict'::text])));
ALTER TABLE ONLY public.ai_conversation_preferences ADD CONSTRAINT ai_conversation_preferences_personality_preset_check CHECK ((personality_preset = ANY (ARRAY['patient'::text, 'friend'::text, 'teacher'::text, 'unfiltered_friend'::text, 'custom'::text])));
ALTER TABLE ONLY public.ai_conversation_preferences ADD CONSTRAINT ai_conversation_preferences_roast_intensity_check CHECK ((roast_intensity = ANY (ARRAY['off'::text, 'light'::text, 'high'::text])));
ALTER TABLE ONLY public.ai_conversation_preferences ADD CONSTRAINT ai_conversation_preferences_speech_pace_check CHECK ((speech_pace = ANY (ARRAY['slow'::text, 'normal'::text, 'natural'::text])));
ALTER TABLE ONLY public.ai_conversation_preferences ADD CONSTRAINT ai_conversation_preferences_topic_initiative_check CHECK ((topic_initiative = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text])));
ALTER TABLE ONLY public.ai_cost_valuations ADD CONSTRAINT ai_cost_valuations_divergence_status_check CHECK ((divergence_status = ANY (ARRAY['compatible'::text, 'within_tolerance'::text, 'divergent'::text, 'not_comparable'::text, 'no_price'::text])));
ALTER TABLE ONLY public.ai_cost_valuations ADD CONSTRAINT ai_cost_valuations_origin_check CHECK ((origin = 'recalculated'::text));
ALTER TABLE ONLY public.ai_cost_valuations ADD CONSTRAINT ai_cost_valuations_status_check CHECK ((status = ANY (ARRAY['calculated'::text, 'partial'::text, 'no_rate'::text, 'ambiguous_rate'::text, 'invalid_metric'::text, 'incompatible_currency'::text])));
ALTER TABLE ONLY public.ai_features ADD CONSTRAINT chk_af_execution_location CHECK ((execution_location = ANY (ARRAY['backend'::text, 'frontend'::text, 'mixed'::text, 'system'::text])));
ALTER TABLE ONLY public.ai_features ADD CONSTRAINT chk_af_measurement_strategy CHECK ((measurement_strategy = ANY (ARRAY['provider_usage'::text, 'input_derived'::text, 'duration_derived'::text, 'session_derived'::text, 'non_billable'::text, 'unavailable'::text, 'mixed'::text])));
ALTER TABLE ONLY public.ai_features ADD CONSTRAINT chk_af_metadata_object CHECK ((jsonb_typeof(metadata) = 'object'::text));
ALTER TABLE ONLY public.ai_gateway_budget_buckets ADD CONSTRAINT chk_agbb_committed_non_negative CHECK ((committed_cost_usd >= (0)::numeric));
ALTER TABLE ONLY public.ai_gateway_budget_buckets ADD CONSTRAINT chk_agbb_period_valid CHECK ((period_end > period_start));
ALTER TABLE ONLY public.ai_gateway_budget_buckets ADD CONSTRAINT chk_agbb_reserved_non_negative CHECK ((reserved_cost_usd >= (0)::numeric));
ALTER TABLE ONLY public.ai_gateway_budget_buckets ADD CONSTRAINT chk_agbb_scope_type CHECK ((scope_type = ANY (ARRAY['user'::text, 'plan'::text, 'feature'::text, 'provider'::text, 'global'::text])));
ALTER TABLE ONLY public.ai_gateway_circuit_breakers ADD CONSTRAINT chk_agcb_consecutive_non_negative CHECK ((consecutive_failures >= 0));
ALTER TABLE ONLY public.ai_gateway_circuit_breakers ADD CONSTRAINT chk_agcb_half_open_probes_non_negative CHECK ((half_open_probes_used >= 0));
ALTER TABLE ONLY public.ai_gateway_circuit_breakers ADD CONSTRAINT chk_agcb_state CHECK ((state = ANY (ARRAY['closed'::text, 'open'::text, 'half_open'::text])));
ALTER TABLE ONLY public.ai_gateway_circuit_breakers ADD CONSTRAINT chk_agcb_window_counts_non_negative CHECK (((window_failure_count >= 0) AND (window_sample_count >= 0)));
ALTER TABLE ONLY public.ai_gateway_concurrency_validations ADD CONSTRAINT ai_gateway_concurrency_validatio_validation_script_sha256_check CHECK ((validation_script_sha256 ~ '^[0-9a-f]{64}$'::text));
ALTER TABLE ONLY public.ai_gateway_concurrency_validations ADD CONSTRAINT ai_gateway_concurrency_validations_executed_by_check CHECK (((char_length(executed_by) >= 1) AND (char_length(executed_by) <= 200)));
ALTER TABLE ONLY public.ai_gateway_concurrency_validations ADD CONSTRAINT chk_agcv_status CHECK ((status = ANY (ARRAY['passed'::text, 'failed'::text])));
ALTER TABLE ONLY public.ai_gateway_config_acknowledgements ADD CONSTRAINT ai_gateway_config_acknowledgements_environment_check CHECK ((environment = ANY (ARRAY['development'::text, 'staging'::text, 'production'::text])));
ALTER TABLE ONLY public.ai_gateway_config_acknowledgements ADD CONSTRAINT ai_gateway_config_acknowledgements_error_sanitized_check CHECK ((length(error_sanitized) <= 1000));
ALTER TABLE ONLY public.ai_gateway_config_acknowledgements ADD CONSTRAINT ai_gateway_config_acknowledgements_result_check CHECK ((result = ANY (ARRAY['applied'::text, 'failed'::text, 'skipped'::text])));
ALTER TABLE ONLY public.ai_gateway_config_versions ADD CONSTRAINT ai_gateway_config_versions_change_type_check CHECK ((change_type = ANY (ARRAY['initial'::text, 'mode_change'::text, 'emergency_stop'::text, 'emergency_restore'::text, 'switch_update'::text, 'budget_update'::text, 'alert_update'::text, 'rollback'::text, 'update'::text])));
ALTER TABLE ONLY public.ai_gateway_config_versions ADD CONSTRAINT ai_gateway_config_versions_environment_check CHECK ((environment = ANY (ARRAY['development'::text, 'staging'::text, 'production'::text])));
ALTER TABLE ONLY public.ai_gateway_config_versions ADD CONSTRAINT ai_gateway_config_versions_state_check CHECK ((state = ANY (ARRAY['published'::text, 'superseded'::text, 'revoked'::text])));
ALTER TABLE ONLY public.ai_gateway_configs ADD CONSTRAINT ai_gateway_configs_cache_ttl_seconds_check CHECK (((cache_ttl_seconds >= 5) AND (cache_ttl_seconds <= 3600)));
ALTER TABLE ONLY public.ai_gateway_configs ADD CONSTRAINT ai_gateway_configs_environment_check CHECK ((environment = ANY (ARRAY['development'::text, 'staging'::text, 'production'::text])));
ALTER TABLE ONLY public.ai_gateway_configs ADD CONSTRAINT ai_gateway_configs_failure_strategy_check CHECK ((failure_strategy = ANY (ARRAY['use_last_known'::text, 'fail_open'::text, 'fail_closed'::text])));
ALTER TABLE ONLY public.ai_gateway_configs ADD CONSTRAINT ai_gateway_configs_gateway_mode_check CHECK ((gateway_mode = ANY (ARRAY['legacy'::text, 'observe'::text, 'enforce'::text])));
ALTER TABLE ONLY public.ai_gateway_configs ADD CONSTRAINT ai_gateway_configs_max_stale_seconds_check CHECK (((max_stale_seconds >= 30) AND (max_stale_seconds <= 86400)));
ALTER TABLE ONLY public.ai_gateway_decisions ADD CONSTRAINT chk_agd_actor_type CHECK ((actor_type = ANY (ARRAY['user'::text, 'system'::text, 'cron'::text, 'admin'::text])));
ALTER TABLE ONLY public.ai_gateway_decisions ADD CONSTRAINT chk_agd_gateway_mode CHECK ((gateway_mode = ANY (ARRAY['legacy'::text, 'observe'::text, 'enforce'::text])));
ALTER TABLE ONLY public.ai_gateway_decisions ADD CONSTRAINT chk_agd_metadata_object CHECK ((jsonb_typeof(metadata) = 'object'::text));
ALTER TABLE ONLY public.ai_gateway_decisions ADD CONSTRAINT chk_agd_outcome CHECK ((outcome = ANY (ARRAY['allowed'::text, 'blocked'::text, 'would_block'::text])));
ALTER TABLE ONLY public.ai_gateway_idempotency_locks ADD CONSTRAINT ai_gateway_idempotency_locks_idempotency_key_check CHECK (((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 256)));
ALTER TABLE ONLY public.ai_gateway_idempotency_locks ADD CONSTRAINT ai_gateway_idempotency_locks_scope_check CHECK (((char_length(scope) >= 1) AND (char_length(scope) <= 128)));
ALTER TABLE ONLY public.ai_gateway_idempotency_locks ADD CONSTRAINT chk_agil_status CHECK ((status = ANY (ARRAY['in_progress'::text, 'completed'::text, 'failed'::text])));
ALTER TABLE ONLY public.ai_gateway_quota_buckets ADD CONSTRAINT chk_agqb_committed_non_negative CHECK ((committed_quantity >= (0)::numeric));
ALTER TABLE ONLY public.ai_gateway_quota_buckets ADD CONSTRAINT chk_agqb_period_valid CHECK ((period_end > period_start));
ALTER TABLE ONLY public.ai_gateway_quota_buckets ADD CONSTRAINT chk_agqb_reserved_non_negative CHECK ((reserved_quantity >= (0)::numeric));
ALTER TABLE ONLY public.ai_gateway_quota_buckets ADD CONSTRAINT chk_agqb_subject_type CHECK ((subject_type = ANY (ARRAY['user'::text, 'system'::text])));
ALTER TABLE ONLY public.ai_gateway_quota_buckets ADD CONSTRAINT chk_agqb_subject_user CHECK (((subject_type <> 'user'::text) OR (subject_id IS NOT NULL)));
ALTER TABLE ONLY public.ai_gateway_reservation_budget_links ADD CONSTRAINT ai_gateway_reservation_budget_links_reserved_cost_usd_check CHECK ((reserved_cost_usd >= (0)::numeric));
ALTER TABLE ONLY public.ai_pricing_acknowledgements ADD CONSTRAINT ai_pricing_acknowledgements_environment_check CHECK ((environment = ANY (ARRAY['development'::text, 'staging'::text, 'production'::text])));
ALTER TABLE ONLY public.ai_pricing_acknowledgements ADD CONSTRAINT ai_pricing_acknowledgements_error_sanitized_check CHECK ((length(error_sanitized) <= 1000));
ALTER TABLE ONLY public.ai_pricing_acknowledgements ADD CONSTRAINT ai_pricing_acknowledgements_result_check CHECK ((result = ANY (ARRAY['applied'::text, 'failed'::text, 'skipped'::text])));
ALTER TABLE ONLY public.ai_pricing_rates ADD CONSTRAINT ai_pricing_rates_currency_check CHECK ((length(currency) = 3));
ALTER TABLE ONLY public.ai_pricing_rates ADD CONSTRAINT ai_pricing_rates_metric_key_check CHECK ((metric_key = ANY (ARRAY['tokens_input'::text, 'tokens_output'::text, 'tokens_cached'::text, 'tokens_cached_output'::text, 'audio_input_seconds'::text, 'audio_output_seconds'::text, 'realtime_seconds'::text, 'chars_tts_billed'::text, 'transcription_seconds'::text, 'pronunciation_assessment_count'::text, 'images_count'::text, 'fixed_per_call'::text])));
ALTER TABLE ONLY public.ai_pricing_rates ADD CONSTRAINT ai_pricing_rates_priority_check CHECK (((priority >= 1) AND (priority <= 1000)));
ALTER TABLE ONLY public.ai_pricing_rates ADD CONSTRAINT ai_pricing_rates_provider_check CHECK ((provider = ANY (ARRAY['openai'::text, 'azure'::text])));
ALTER TABLE ONLY public.ai_pricing_rates ADD CONSTRAINT ai_pricing_rates_source_check CHECK (((length(source) >= 1) AND (length(source) <= 500)));
ALTER TABLE ONLY public.ai_pricing_rates ADD CONSTRAINT ai_pricing_rates_unit_price_check CHECK ((unit_price >= (0)::numeric));
ALTER TABLE ONLY public.ai_pricing_rates ADD CONSTRAINT ai_pricing_rates_unit_size_check CHECK ((unit_size > (0)::numeric));
ALTER TABLE ONLY public.ai_pricing_rates ADD CONSTRAINT ai_pricing_rates_unit_type_check CHECK ((unit_type = ANY (ARRAY['per_token'::text, 'per_1k_tokens'::text, 'per_1m_tokens'::text, 'per_1k_chars'::text, 'per_second'::text, 'per_minute'::text, 'per_call'::text, 'per_image'::text])));
ALTER TABLE ONLY public.ai_pricing_versions ADD CONSTRAINT ai_pricing_versions_environment_check CHECK ((environment = ANY (ARRAY['development'::text, 'staging'::text, 'production'::text])));
ALTER TABLE ONLY public.ai_pricing_versions ADD CONSTRAINT ai_pricing_versions_name_check CHECK (((length(name) >= 1) AND (length(name) <= 200)));
ALTER TABLE ONLY public.ai_pricing_versions ADD CONSTRAINT ai_pricing_versions_state_check CHECK ((state = ANY (ARRAY['draft'::text, 'scheduled'::text, 'published'::text, 'superseded'::text, 'discarded'::text])));
ALTER TABLE ONLY public.ai_pricing_versions ADD CONSTRAINT chk_pricing_version_ends_after_starts CHECK (((effective_to IS NULL) OR (effective_from IS NULL) OR (effective_to > effective_from)));
ALTER TABLE ONLY public.ai_provider_sessions ADD CONSTRAINT chk_aps_duration_non_negative CHECK (((duration_seconds IS NULL) OR (duration_seconds >= (0)::numeric)));
ALTER TABLE ONLY public.ai_provider_sessions ADD CONSTRAINT chk_aps_ended_after_started CHECK (((ended_at IS NULL) OR (started_at IS NULL) OR (ended_at >= started_at)));
ALTER TABLE ONLY public.ai_provider_sessions ADD CONSTRAINT chk_aps_hangup_status CHECK ((hangup_status = ANY (ARRAY['not_attempted'::text, 'ok'::text, 'failed'::text])));
ALTER TABLE ONLY public.ai_provider_sessions ADD CONSTRAINT chk_aps_metadata_object CHECK ((jsonb_typeof(metadata) = 'object'::text));
ALTER TABLE ONLY public.ai_provider_sessions ADD CONSTRAINT chk_aps_status CHECK ((status = ANY (ARRAY['authorized'::text, 'connecting'::text, 'active'::text, 'completed'::text, 'failed'::text, 'expired'::text, 'cancelled'::text])));
ALTER TABLE ONLY public.ai_runtime_controls ADD CONSTRAINT chk_arc_daily_budget_non_negative CHECK (((daily_budget_usd IS NULL) OR (daily_budget_usd >= (0)::numeric)));
ALTER TABLE ONLY public.ai_runtime_controls ADD CONSTRAINT chk_arc_feature_scope CHECK (((scope_type <> 'feature'::text) OR (feature_key IS NOT NULL)));
ALTER TABLE ONLY public.ai_runtime_controls ADD CONSTRAINT chk_arc_gateway_mode CHECK ((gateway_mode = ANY (ARRAY['legacy'::text, 'observe'::text, 'enforce'::text])));
ALTER TABLE ONLY public.ai_runtime_controls ADD CONSTRAINT chk_arc_max_concurrent_positive CHECK (((max_concurrent_requests IS NULL) OR (max_concurrent_requests > 0)));
ALTER TABLE ONLY public.ai_runtime_controls ADD CONSTRAINT chk_arc_metadata_object CHECK ((jsonb_typeof(metadata) = 'object'::text));
ALTER TABLE ONLY public.ai_runtime_controls ADD CONSTRAINT chk_arc_monthly_budget_non_negative CHECK (((monthly_budget_usd IS NULL) OR (monthly_budget_usd >= (0)::numeric)));
ALTER TABLE ONLY public.ai_runtime_controls ADD CONSTRAINT chk_arc_provider_scope CHECK (((scope_type <> 'provider'::text) OR (provider IS NOT NULL)));
ALTER TABLE ONLY public.ai_runtime_controls ADD CONSTRAINT chk_arc_rate_limit_positive CHECK (((rate_limit_requests IS NULL) OR (rate_limit_requests > 0)));
ALTER TABLE ONLY public.ai_runtime_controls ADD CONSTRAINT chk_arc_rate_window_positive CHECK (((rate_limit_window_seconds IS NULL) OR (rate_limit_window_seconds > 0)));
ALTER TABLE ONLY public.ai_runtime_controls ADD CONSTRAINT chk_arc_runtime_status CHECK ((runtime_status = ANY (ARRAY['enabled'::text, 'cache_only'::text, 'disabled'::text, 'paused_automatically'::text, 'circuit_open'::text, 'maintenance'::text])));
ALTER TABLE ONLY public.ai_runtime_controls ADD CONSTRAINT chk_arc_scope_type CHECK ((scope_type = ANY (ARRAY['global'::text, 'provider'::text, 'feature'::text, 'user'::text])));
ALTER TABLE ONLY public.ai_runtime_controls ADD CONSTRAINT chk_arc_user_scope CHECK (((scope_type <> 'user'::text) OR (user_id IS NOT NULL)));
ALTER TABLE ONLY public.ai_usage_event_metrics ADD CONSTRAINT chk_auem_billable_qty_non_negative CHECK (((billable_quantity IS NULL) OR (billable_quantity >= (0)::numeric)));
ALTER TABLE ONLY public.ai_usage_event_metrics ADD CONSTRAINT chk_auem_cost_non_negative CHECK (((calculated_cost_usd IS NULL) OR (calculated_cost_usd >= (0)::numeric)));
ALTER TABLE ONLY public.ai_usage_event_metrics ADD CONSTRAINT chk_auem_metadata_object CHECK ((jsonb_typeof(metadata) = 'object'::text));
ALTER TABLE ONLY public.ai_usage_event_metrics ADD CONSTRAINT chk_auem_quantity_non_negative CHECK ((quantity >= (0)::numeric));
ALTER TABLE ONLY public.ai_usage_events ADD CONSTRAINT chk_aue_actor_type CHECK ((actor_type = ANY (ARRAY['user'::text, 'system'::text, 'cron'::text, 'admin'::text])));
ALTER TABLE ONLY public.ai_usage_events ADD CONSTRAINT chk_aue_attempt_number CHECK ((attempt_number >= 1));
ALTER TABLE ONLY public.ai_usage_events ADD CONSTRAINT chk_aue_call_sequence CHECK ((call_sequence >= 1));
ALTER TABLE ONLY public.ai_usage_events ADD CONSTRAINT chk_aue_cost_status CHECK ((cost_status = ANY (ARRAY['pending'::text, 'not_applicable'::text, 'estimated'::text, 'calculated'::text, 'reconciled'::text, 'unavailable'::text])));
ALTER TABLE ONLY public.ai_usage_events ADD CONSTRAINT chk_aue_execution_location CHECK ((execution_location = ANY (ARRAY['backend'::text, 'frontend'::text, 'mixed'::text, 'system'::text])));
ALTER TABLE ONLY public.ai_usage_events ADD CONSTRAINT chk_aue_metadata_object CHECK ((jsonb_typeof(metadata) = 'object'::text));
ALTER TABLE ONLY public.ai_usage_events ADD CONSTRAINT chk_aue_status CHECK ((status = ANY (ARRAY['started'::text, 'succeeded'::text, 'failed'::text, 'blocked'::text, 'cancelled'::text, 'expired'::text])));
ALTER TABLE ONLY public.api_rate_limits ADD CONSTRAINT api_rate_limits_request_count_check CHECK ((request_count >= 0));
ALTER TABLE ONLY public.api_rate_limits ADD CONSTRAINT api_rate_limits_route_key_check CHECK ((char_length(route_key) <= 64));
ALTER TABLE ONLY public.app_config_acknowledgements ADD CONSTRAINT app_config_acknowledgements_application_check CHECK ((application = ANY (ARRAY['web'::text, 'backend'::text, 'mobile_ios'::text, 'mobile_android'::text])));
ALTER TABLE ONLY public.app_config_acknowledgements ADD CONSTRAINT app_config_acknowledgements_environment_check CHECK ((environment = ANY (ARRAY['development'::text, 'staging'::text, 'production'::text])));
ALTER TABLE ONLY public.app_config_acknowledgements ADD CONSTRAINT app_config_acknowledgements_error_sanitized_check CHECK ((length(error_sanitized) <= 1000));
ALTER TABLE ONLY public.app_config_acknowledgements ADD CONSTRAINT app_config_acknowledgements_result_check CHECK ((result = ANY (ARRAY['applied'::text, 'failed'::text, 'skipped'::text, 'partial'::text])));
ALTER TABLE ONLY public.app_config_definitions ADD CONSTRAINT app_config_definitions_category_check CHECK ((category = ANY (ARRAY['signup'::text, 'maintenance'::text, 'audio_azure'::text, 'audio_openai'::text, 'features'::text, 'product'::text])));
ALTER TABLE ONLY public.app_config_definitions ADD CONSTRAINT app_config_definitions_exposure_check CHECK ((exposure = ANY (ARRAY['public'::text, 'server_only'::text])));
ALTER TABLE ONLY public.app_config_definitions ADD CONSTRAINT app_config_definitions_key_check CHECK ((key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'::text));
ALTER TABLE ONLY public.app_config_definitions ADD CONSTRAINT app_config_definitions_key_check1 CHECK ((key !~* '(secret|token|password|api[_-]?key|private[_-]?key|service[_-]?role)'::text));
ALTER TABLE ONLY public.app_config_definitions ADD CONSTRAINT app_config_definitions_label_check CHECK (((length(label) >= 1) AND (length(label) <= 200)));
ALTER TABLE ONLY public.app_config_definitions ADD CONSTRAINT app_config_definitions_risk_level_check CHECK ((risk_level = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text])));
ALTER TABLE ONLY public.app_config_definitions ADD CONSTRAINT app_config_definitions_scope_check CHECK ((scope = 'global'::text));
ALTER TABLE ONLY public.app_config_definitions ADD CONSTRAINT app_config_definitions_value_type_check CHECK ((value_type = ANY (ARRAY['boolean'::text, 'integer'::text, 'decimal'::text, 'string'::text, 'enum'::text, 'url'::text, 'object'::text, 'list'::text])));
ALTER TABLE ONLY public.app_config_versions ADD CONSTRAINT app_config_versions_environment_check CHECK ((environment = ANY (ARRAY['development'::text, 'staging'::text, 'production'::text])));
ALTER TABLE ONLY public.app_config_versions ADD CONSTRAINT app_config_versions_state_check CHECK ((state = ANY (ARRAY['draft'::text, 'scheduled'::text, 'published'::text, 'superseded'::text, 'discarded'::text])));
ALTER TABLE ONLY public.app_config_versions ADD CONSTRAINT chk_config_version_ends_after_starts CHECK (((effective_to IS NULL) OR (effective_from IS NULL) OR (effective_to > effective_from)));
ALTER TABLE ONLY public.capability_definitions ADD CONSTRAINT capability_definitions_category_check CHECK ((category = ANY (ARRAY['feature'::text, 'quota'::text, 'field_limit'::text, 'configuration'::text])));
ALTER TABLE ONLY public.capability_definitions ADD CONSTRAINT chk_capability_definitions_default_value_non_negative CHECK (((default_value IS NULL) OR (jsonb_typeof(default_value) <> 'number'::text) OR (((default_value)::text)::numeric >= (0)::numeric)));
ALTER TABLE ONLY public.conversation_session_authorizations ADD CONSTRAINT chk_csa_duration_non_negative CHECK (((duration_seconds IS NULL) OR (duration_seconds >= 0)));
ALTER TABLE ONLY public.conversation_session_authorizations ADD CONSTRAINT chk_csa_status CHECK ((status = ANY (ARRAY['authorized'::text, 'completed'::text])));
ALTER TABLE ONLY public.conversation_session_authorizations ADD CONSTRAINT conversation_session_authorization_authorized_max_seconds_check CHECK ((authorized_max_seconds > 0));
ALTER TABLE ONLY public.conversation_sessions ADD CONSTRAINT conversation_sessions_duration_sec_check CHECK ((duration_sec > 0));
ALTER TABLE ONLY public.gateway_heartbeats ADD CONSTRAINT gateway_heartbeats_gateway_mode_check CHECK ((gateway_mode = ANY (ARRAY['legacy'::text, 'observe'::text, 'enforce'::text])));
ALTER TABLE ONLY public.generated_themes ADD CONSTRAINT generated_themes_difficulty_check CHECK ((difficulty = ANY (ARRAY['easy'::text, 'medium'::text, 'hard'::text])));
ALTER TABLE ONLY public.generated_themes ADD CONSTRAINT generated_themes_status_check CHECK ((status = ANY (ARRAY['generated'::text, 'completed'::text, 'skipped'::text, 'regenerated'::text])));
ALTER TABLE ONLY public.learner_skill_profiles ADD CONSTRAINT learner_skill_profiles_catalog_version_check CHECK ((catalog_version > 0));
ALTER TABLE ONLY public.learner_skill_profiles ADD CONSTRAINT learner_skill_profiles_cefr_level_check CHECK ((cefr_level = ANY (ARRAY['A1'::text, 'A2'::text, 'B1'::text, 'B2'::text, 'C1'::text, 'C2'::text])));
ALTER TABLE ONLY public.learner_skill_profiles ADD CONSTRAINT learner_skill_profiles_confidence_check CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)));
ALTER TABLE ONLY public.learner_skill_profiles ADD CONSTRAINT learner_skill_profiles_evidence_count_check CHECK ((evidence_count >= 0));
ALTER TABLE ONLY public.listening_audio_assets ADD CONSTRAINT chk_laa_validated CHECK (((status <> ALL (ARRAY['validated'::text, 'published'::text])) OR ((audio_path IS NOT NULL) AND (file_size_bytes IS NOT NULL) AND (duration_ms IS NOT NULL) AND (audio_hash IS NOT NULL))));
ALTER TABLE ONLY public.listening_audio_assets ADD CONSTRAINT listening_audio_assets_block_order_check CHECK ((block_order = ANY (ARRAY[1, 2])));
ALTER TABLE ONLY public.listening_audio_assets ADD CONSTRAINT listening_audio_assets_duration_status_check CHECK ((duration_status = ANY (ARRAY['valid'::text, 'needs_review'::text, 'invalid'::text])));
ALTER TABLE ONLY public.listening_audio_assets ADD CONSTRAINT listening_audio_assets_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'uploaded'::text, 'validated'::text, 'published'::text, 'failed'::text])));
ALTER TABLE ONLY public.listening_audio_assets ADD CONSTRAINT listening_audio_assets_word_timing_status_check CHECK ((word_timing_status = ANY (ARRAY['complete'::text, 'partial'::text, 'missing'::text, 'invalid'::text])));
ALTER TABLE ONLY public.listening_blocks ADD CONSTRAINT chk_lb_ssml_ready CHECK (((ssml_status IS DISTINCT FROM 'ready'::text) OR ((ssml IS NOT NULL) AND (ssml_content_hash IS NOT NULL) AND (ssml_generated_at IS NOT NULL) AND (ssml_version IS NOT NULL))));
ALTER TABLE ONLY public.listening_blocks ADD CONSTRAINT listening_blocks_audio_status_check CHECK ((audio_status = ANY (ARRAY['pending'::text, 'processing'::text, 'uploaded'::text, 'validated'::text, 'failed'::text])));
ALTER TABLE ONLY public.listening_blocks ADD CONSTRAINT listening_blocks_block_order_check CHECK ((block_order = ANY (ARRAY[1, 2])));
ALTER TABLE ONLY public.listening_blocks ADD CONSTRAINT listening_blocks_duration_ms_check CHECK (((duration_ms IS NULL) OR (duration_ms > 0)));
ALTER TABLE ONLY public.listening_blocks ADD CONSTRAINT listening_blocks_ssml_status_check CHECK ((ssml_status = ANY (ARRAY['pending'::text, 'processing'::text, 'ready'::text, 'failed'::text])));
ALTER TABLE ONLY public.listening_blocks ADD CONSTRAINT listening_blocks_timing_status_check CHECK ((timing_status = ANY (ARRAY['pending'::text, 'processing'::text, 'ready'::text, 'needs_review'::text, 'failed'::text])));
ALTER TABLE ONLY public.listening_bookmark_timings ADD CONSTRAINT listening_bookmark_timings_offset_ms_check CHECK ((offset_ms >= 0));
ALTER TABLE ONLY public.listening_episode_distribution ADD CONSTRAINT chk_led_availability CHECK (((available_to IS NULL) OR (available_from IS NULL) OR (available_to > available_from)));
ALTER TABLE ONLY public.listening_episode_distribution ADD CONSTRAINT listening_episode_distribution_priority_check CHECK (((priority >= 1) AND (priority <= 1000)));
ALTER TABLE ONLY public.listening_episode_distribution ADD CONSTRAINT listening_episode_distribution_state_check CHECK ((state = ANY (ARRAY['draft'::text, 'scheduled'::text, 'published'::text, 'paused'::text, 'withdrawn'::text])));
ALTER TABLE ONLY public.listening_episode_publications ADD CONSTRAINT listening_episode_publications_action_check CHECK ((action = ANY (ARRAY['publish'::text, 'schedule'::text, 'pause'::text, 'resume'::text, 'withdraw'::text])));
ALTER TABLE ONLY public.listening_episode_publications ADD CONSTRAINT listening_episode_publications_reason_check CHECK ((length(reason) > 0));
ALTER TABLE ONLY public.listening_episodes ADD CONSTRAINT chk_le_published_requires_date CHECK (((status <> 'published'::listening_episode_status) OR (published_at IS NOT NULL)));
ALTER TABLE ONLY public.listening_episodes ADD CONSTRAINT listening_episodes_access_tier_check CHECK ((access_tier = ANY (ARRAY['free'::text, 'premium'::text, 'all'::text])));
ALTER TABLE ONLY public.listening_episodes ADD CONSTRAINT listening_episodes_actual_duration_seconds_check CHECK (((actual_duration_seconds IS NULL) OR (actual_duration_seconds > 0)));
ALTER TABLE ONLY public.listening_episodes ADD CONSTRAINT listening_episodes_audio_status_check CHECK ((audio_status = ANY (ARRAY['pending'::text, 'processing'::text, 'ready'::text, 'failed'::text])));
ALTER TABLE ONLY public.listening_episodes ADD CONSTRAINT listening_episodes_cefr_level_check CHECK ((cefr_level = ANY (ARRAY['A1'::text, 'A2'::text, 'B1'::text, 'B2'::text, 'C1'::text, 'C2'::text])));
ALTER TABLE ONLY public.listening_episodes ADD CONSTRAINT listening_episodes_content_version_check CHECK ((content_version >= 1));
ALTER TABLE ONLY public.listening_episodes ADD CONSTRAINT listening_episodes_estimated_duration_seconds_check CHECK (((estimated_duration_seconds IS NULL) OR (estimated_duration_seconds > 0)));
ALTER TABLE ONLY public.listening_episodes ADD CONSTRAINT listening_episodes_publication_source_check CHECK ((publication_source = ANY (ARRAY['admin'::text, 'system'::text, 'script'::text])));
ALTER TABLE ONLY public.listening_episodes ADD CONSTRAINT listening_episodes_publication_version_check CHECK ((publication_version >= 0));
ALTER TABLE ONLY public.listening_episodes ADD CONSTRAINT listening_episodes_questions_status_check CHECK (((questions_status IS NULL) OR (questions_status = ANY (ARRAY['pending'::text, 'processing'::text, 'ready'::text, 'failed'::text]))));
ALTER TABLE ONLY public.listening_episodes ADD CONSTRAINT listening_episodes_ssml_status_check CHECK ((ssml_status = ANY (ARRAY['pending'::text, 'processing'::text, 'ready'::text, 'failed'::text])));
ALTER TABLE ONLY public.listening_episodes ADD CONSTRAINT listening_episodes_subtitles_status_check CHECK ((subtitles_status = ANY (ARRAY['pending'::text, 'processing'::text, 'ready'::text, 'failed'::text])));
ALTER TABLE ONLY public.listening_episodes ADD CONSTRAINT listening_episodes_timing_status_check CHECK ((timing_status = ANY (ARRAY['pending'::text, 'processing'::text, 'ready'::text, 'needs_review'::text, 'failed'::text])));
ALTER TABLE ONLY public.listening_generation_jobs ADD CONSTRAINT chk_lgj_target_level_in_group CHECK ((((level_group = 'A1_A2'::text) AND (target_level = ANY (ARRAY['A1'::text, 'A2'::text]))) OR ((level_group = 'B1_B2'::text) AND (target_level = ANY (ARRAY['B1'::text, 'B2'::text]))) OR ((level_group = 'C1_C2'::text) AND (target_level = ANY (ARRAY['C1'::text, 'C2'::text])))));
ALTER TABLE ONLY public.listening_generation_jobs ADD CONSTRAINT listening_generation_jobs_attempts_check CHECK ((attempts >= 0));
ALTER TABLE ONLY public.listening_generation_jobs ADD CONSTRAINT listening_generation_jobs_level_group_check CHECK ((level_group = ANY (ARRAY['A1_A2'::text, 'B1_B2'::text, 'C1_C2'::text])));
ALTER TABLE ONLY public.listening_generation_jobs ADD CONSTRAINT listening_generation_jobs_max_attempts_check CHECK ((max_attempts >= 1));
ALTER TABLE ONLY public.listening_generation_jobs ADD CONSTRAINT listening_generation_jobs_progress_percent_check CHECK (((progress_percent >= 0) AND (progress_percent <= 100)));
ALTER TABLE ONLY public.listening_generation_jobs ADD CONSTRAINT listening_generation_jobs_status_check CHECK ((status = ANY (ARRAY['created'::text, 'generating_block_1'::text, 'validating_block_1'::text, 'generating_block_2'::text, 'validating_block_2'::text, 'generating_questions'::text, 'preparing_description'::text, 'preparing_subtitles'::text, 'generating_audio_block_1'::text, 'generating_audio_block_2'::text, 'validating_duration'::text, 'finalizing'::text, 'ready'::text, 'failed'::text, 'cancelled'::text])));
ALTER TABLE ONLY public.listening_generation_jobs ADD CONSTRAINT listening_generation_jobs_target_level_check CHECK ((target_level = ANY (ARRAY['A1'::text, 'A2'::text, 'B1'::text, 'B2'::text, 'C1'::text, 'C2'::text])));
ALTER TABLE ONLY public.listening_generation_requests ADD CONSTRAINT chk_lgr_finished_after_started CHECK (((finished_at IS NULL) OR (started_at IS NULL) OR (finished_at >= started_at)));
ALTER TABLE ONLY public.listening_generation_requests ADD CONSTRAINT listening_generation_requests_attempts_check CHECK ((attempts >= 0));
ALTER TABLE ONLY public.listening_generation_requests ADD CONSTRAINT listening_generation_requests_cefr_level_check CHECK ((cefr_level = ANY (ARRAY['A1'::text, 'A2'::text, 'B1'::text, 'B2'::text, 'C1'::text, 'C2'::text])));
ALTER TABLE ONLY public.listening_generation_requests ADD CONSTRAINT listening_generation_requests_error_sanitized_check CHECK ((length(error_sanitized) <= 1000));
ALTER TABLE ONLY public.listening_generation_requests ADD CONSTRAINT listening_generation_requests_job_type_check CHECK ((job_type = ANY (ARRAY['full_story'::text, 'text'::text, 'translation'::text, 'questions'::text, 'audio'::text, 'regeneration'::text])));
ALTER TABLE ONLY public.listening_generation_requests ADD CONSTRAINT listening_generation_requests_max_attempts_check CHECK ((max_attempts >= 1));
ALTER TABLE ONLY public.listening_generation_requests ADD CONSTRAINT listening_generation_requests_priority_check CHECK (((priority >= 1) AND (priority <= 1000)));
ALTER TABLE ONLY public.listening_generation_requests ADD CONSTRAINT listening_generation_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'scheduled'::text, 'processing'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])));
ALTER TABLE ONLY public.listening_jobs ADD CONSTRAINT chk_listening_job_priority CHECK ((priority >= 0));
ALTER TABLE ONLY public.listening_jobs ADD CONSTRAINT chk_listening_job_status CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'retry'::text, 'completed'::text, 'failed'::text, 'cancelled'::text, 'dead_letter'::text])));
ALTER TABLE ONLY public.listening_jobs ADD CONSTRAINT chk_listening_job_type CHECK ((job_type = ANY (ARRAY['ENSURE_LISTENING_INVENTORY'::text, 'GENERATE_LISTENING_STORY'::text, 'GENERATE_LISTENING_QUESTIONS'::text, 'PREPARE_LISTENING_SUBTITLES'::text, 'GENERATE_LISTENING_SSML'::text, 'SYNTHESIZE_LISTENING_BLOCK_AUDIO'::text, 'SYNCHRONIZE_LISTENING_BLOCK'::text, 'VALIDATE_LISTENING_EPISODE'::text, 'PUBLISH_LISTENING_EPISODE'::text, 'REPAIR_LISTENING_EPISODE'::text, 'AUDIT_LISTENING_INVENTORY'::text, 'AUDIT_LISTENING_STORAGE'::text, 'CLEANUP_LISTENING_STAGING'::text, 'CALCULATE_LISTENING_PERFORMANCE'::text])));
ALTER TABLE ONLY public.listening_operational_alerts ADD CONSTRAINT chk_alert_severity CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'error'::text, 'critical'::text])));
ALTER TABLE ONLY public.listening_operational_alerts ADD CONSTRAINT chk_alert_status CHECK ((status = ANY (ARRAY['open'::text, 'acknowledged'::text, 'resolved'::text])));
ALTER TABLE ONLY public.listening_questions ADD CONSTRAINT chk_lq_correct_in_range CHECK ((correct_option < jsonb_array_length(options_json)));
ALTER TABLE ONLY public.listening_questions ADD CONSTRAINT chk_lq_options_min_2 CHECK (((jsonb_typeof(options_json) = 'array'::text) AND (jsonb_array_length(options_json) >= 2)));
ALTER TABLE ONLY public.listening_questions ADD CONSTRAINT listening_questions_correct_option_check CHECK ((correct_option >= 0));
ALTER TABLE ONLY public.listening_questions ADD CONSTRAINT listening_questions_difficulty_check CHECK (((difficulty IS NULL) OR (difficulty = ANY (ARRAY['easy'::text, 'appropriate'::text, 'hard'::text]))));
ALTER TABLE ONLY public.listening_questions ADD CONSTRAINT listening_questions_evidence_sentence_keys_check CHECK (((evidence_sentence_keys IS NULL) OR ((jsonb_typeof(evidence_sentence_keys) = 'array'::text) AND (jsonb_array_length(evidence_sentence_keys) >= 1))));
ALTER TABLE ONLY public.listening_questions ADD CONSTRAINT listening_questions_max_attempts_check CHECK ((max_attempts = 3));
ALTER TABLE ONLY public.listening_questions ADD CONSTRAINT listening_questions_question_order_check CHECK ((question_order = ANY (ARRAY[1, 2])));
ALTER TABLE ONLY public.listening_questions ADD CONSTRAINT listening_questions_question_type_check CHECK (((question_type IS NULL) OR (question_type = ANY (ARRAY['main_idea'::text, 'detail'::text, 'cause'::text, 'sequence'::text, 'intention'::text, 'simple_inference'::text]))));
ALTER TABLE ONLY public.listening_questions ADD CONSTRAINT listening_questions_validation_status_check CHECK ((validation_status = ANY (ARRAY['pending'::text, 'valid'::text, 'invalid'::text, 'needs_review'::text])));
ALTER TABLE ONLY public.listening_sentence_timings ADD CONSTRAINT chk_lst_end_order CHECK (((spoken_end_ms >= start_ms) AND (interval_end_ms >= spoken_end_ms)));
ALTER TABLE ONLY public.listening_sentence_timings ADD CONSTRAINT listening_sentence_timings_sentence_order_check CHECK ((sentence_order >= 1));
ALTER TABLE ONLY public.listening_sentence_timings ADD CONSTRAINT listening_sentence_timings_start_ms_check CHECK ((start_ms >= 0));
ALTER TABLE ONLY public.listening_sentence_timings ADD CONSTRAINT listening_sentence_timings_timing_confidence_check CHECK (((timing_confidence >= (0)::numeric) AND (timing_confidence <= (1)::numeric)));
ALTER TABLE ONLY public.listening_sentences ADD CONSTRAINT listening_sentences_paragraph_order_check CHECK ((paragraph_order >= 1));
ALTER TABLE ONLY public.listening_sentences ADD CONSTRAINT listening_sentences_sentence_order_check CHECK ((sentence_order >= 1));
ALTER TABLE ONLY public.listening_shared_stories ADD CONSTRAINT chk_lss_target_level_in_group CHECK ((((level_group = 'A1_A2'::text) AND (target_level = ANY (ARRAY['A1'::text, 'A2'::text]))) OR ((level_group = 'B1_B2'::text) AND (target_level = ANY (ARRAY['B1'::text, 'B2'::text]))) OR ((level_group = 'C1_C2'::text) AND (target_level = ANY (ARRAY['C1'::text, 'C2'::text])))));
ALTER TABLE ONLY public.listening_shared_stories ADD CONSTRAINT listening_shared_stories_level_group_check CHECK ((level_group = ANY (ARRAY['A1_A2'::text, 'B1_B2'::text, 'C1_C2'::text])));
ALTER TABLE ONLY public.listening_shared_stories ADD CONSTRAINT listening_shared_stories_status_check CHECK ((status = ANY (ARRAY['generating'::text, 'ready'::text, 'failed'::text])));
ALTER TABLE ONLY public.listening_shared_stories ADD CONSTRAINT listening_shared_stories_target_level_check CHECK ((target_level = ANY (ARRAY['A1'::text, 'A2'::text, 'B1'::text, 'B2'::text, 'C1'::text, 'C2'::text])));
ALTER TABLE ONLY public.listening_subtitle_cues ADD CONSTRAINT chk_lsc_source_keys_array CHECK (((source_sentence_keys IS NULL) OR ((jsonb_typeof(source_sentence_keys) = 'array'::text) AND (jsonb_array_length(source_sentence_keys) >= 1))));
ALTER TABLE ONLY public.listening_subtitle_cues ADD CONSTRAINT chk_lsc_timed_fields CHECK (((status <> 'timed'::text) OR ((start_ms IS NOT NULL) AND (end_ms IS NOT NULL) AND (audio_asset_id IS NOT NULL) AND (timing_source IS NOT NULL))));
ALTER TABLE ONLY public.listening_subtitle_cues ADD CONSTRAINT chk_lsc_timing CHECK ((((start_ms IS NULL) AND (end_ms IS NULL)) OR ((start_ms IS NOT NULL) AND (end_ms IS NOT NULL) AND (start_ms >= 0) AND (end_ms > start_ms))));
ALTER TABLE ONLY public.listening_subtitle_cues ADD CONSTRAINT listening_subtitle_cues_content_version_check CHECK (((content_version IS NULL) OR (content_version >= 1)));
ALTER TABLE ONLY public.listening_subtitle_cues ADD CONSTRAINT listening_subtitle_cues_cue_order_check CHECK ((cue_order >= 1));
ALTER TABLE ONLY public.listening_subtitle_cues ADD CONSTRAINT listening_subtitle_cues_start_ms_check CHECK ((start_ms >= 0));
ALTER TABLE ONLY public.listening_subtitle_cues ADD CONSTRAINT listening_subtitle_cues_timing_confidence_check CHECK (((timing_confidence >= (0)::numeric) AND (timing_confidence <= (1)::numeric)));
ALTER TABLE ONLY public.listening_subtitle_cues ADD CONSTRAINT listening_subtitle_cues_timing_source_check CHECK ((timing_source = ANY (ARRAY['word_boundaries'::text, 'sentence_bookmarks'::text, 'hybrid'::text, 'fallback'::text])));
ALTER TABLE ONLY public.listening_subtitle_cues ADD CONSTRAINT lsc_status_check CHECK ((status = ANY (ARRAY['text_ready'::text, 'timing_pending'::text, 'timing_processing'::text, 'timed'::text, 'needs_review'::text, 'failed'::text])));
ALTER TABLE ONLY public.listening_word_timings ADD CONSTRAINT listening_word_timings_duration_ms_check CHECK ((duration_ms >= 0));
ALTER TABLE ONLY public.listening_word_timings ADD CONSTRAINT listening_word_timings_end_ms_check CHECK ((end_ms >= 0));
ALTER TABLE ONLY public.listening_word_timings ADD CONSTRAINT listening_word_timings_start_ms_check CHECK ((start_ms >= 0));
ALTER TABLE ONLY public.listening_word_timings ADD CONSTRAINT listening_word_timings_word_order_check CHECK ((word_order > 0));
ALTER TABLE ONLY public.plan_capability_values ADD CONSTRAINT chk_plan_capability_values_value_non_negative CHECK (((jsonb_typeof(value) <> 'number'::text) OR (((value)::text)::numeric >= (0)::numeric)));
ALTER TABLE ONLY public.plan_trial_policies ADD CONSTRAINT plan_trial_policies_duration_days_check CHECK (((duration_days > 0) AND (duration_days <= 365)));
ALTER TABLE ONLY public.plan_trial_policies ADD CONSTRAINT plan_trial_policies_max_grants_per_user_check CHECK ((max_grants_per_user > 0));
ALTER TABLE ONLY public.plan_versions ADD CONSTRAINT plan_versions_effective_dates_check CHECK (((effective_to IS NULL) OR (effective_from IS NULL) OR (effective_to > effective_from)));
ALTER TABLE ONLY public.plan_versions ADD CONSTRAINT plan_versions_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'retired'::text, 'discarded'::text])));
ALTER TABLE ONLY public.plans ADD CONSTRAINT chk_plans_default_must_be_visible CHECK ((NOT (is_default AND (NOT is_visible_to_users))));
ALTER TABLE ONLY public.plans ADD CONSTRAINT plans_monthly_price_cents_check CHECK ((monthly_price_cents >= 0));
ALTER TABLE ONLY public.plans ADD CONSTRAINT plans_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'inactive'::text, 'archived'::text])));
ALTER TABLE ONLY public.plans ADD CONSTRAINT plans_trial_days_check CHECK (((trial_days >= 0) AND (trial_days <= 365)));
ALTER TABLE ONLY public.pronunciation_assessments ADD CONSTRAINT pa_accuracy_score_range CHECK (((accuracy_score IS NULL) OR ((accuracy_score >= (0)::numeric) AND (accuracy_score <= (100)::numeric)))) NOT VALID;
ALTER TABLE ONLY public.pronunciation_assessments ADD CONSTRAINT pa_completeness_score_range CHECK (((completeness_score IS NULL) OR ((completeness_score >= (0)::numeric) AND (completeness_score <= (100)::numeric)))) NOT VALID;
ALTER TABLE ONLY public.pronunciation_assessments ADD CONSTRAINT pa_fluency_score_range CHECK (((fluency_score IS NULL) OR ((fluency_score >= (0)::numeric) AND (fluency_score <= (100)::numeric)))) NOT VALID;
ALTER TABLE ONLY public.pronunciation_assessments ADD CONSTRAINT pa_pronunciation_score_range CHECK (((pronunciation_score IS NULL) OR ((pronunciation_score >= (0)::numeric) AND (pronunciation_score <= (100)::numeric)))) NOT VALID;
ALTER TABLE ONLY public.pronunciation_assessments ADD CONSTRAINT pa_prosody_score_range CHECK (((prosody_score IS NULL) OR ((prosody_score >= (0)::numeric) AND (prosody_score <= (100)::numeric)))) NOT VALID;
ALTER TABLE ONLY public.pronunciation_assessments ADD CONSTRAINT pronunciation_assessments_status_check CHECK ((status = ANY (ARRAY['processing'::text, 'completed'::text, 'failed_retryable'::text, 'failed_final'::text])));
ALTER TABLE ONLY public.pronunciation_training_sessions ADD CONSTRAINT chk_pts_status CHECK ((status = ANY (ARRAY['text_generated'::text, 'processing'::text, 'completed'::text, 'failed_retryable'::text, 'failed_final'::text])));
ALTER TABLE ONLY public.provider_pricing ADD CONSTRAINT chk_pp_currency_length CHECK ((char_length(currency) = 3));
ALTER TABLE ONLY public.provider_pricing ADD CONSTRAINT chk_pp_metadata_object CHECK ((jsonb_typeof(metadata) = 'object'::text));
ALTER TABLE ONLY public.provider_pricing ADD CONSTRAINT chk_pp_price_non_negative CHECK ((price_per_unit >= (0)::numeric));
ALTER TABLE ONLY public.provider_pricing ADD CONSTRAINT chk_pp_unit_size_positive CHECK ((unit_size > (0)::numeric));
ALTER TABLE ONLY public.provider_pricing ADD CONSTRAINT chk_pp_valid_until_after_from CHECK (((valid_until IS NULL) OR (valid_until > valid_from)));
ALTER TABLE ONLY public.realtime_hard_control_validations ADD CONSTRAINT chk_rhcv_environment CHECK ((environment = ANY (ARRAY['production'::text, 'preview'::text, 'development'::text])));
ALTER TABLE ONLY public.realtime_hard_control_validations ADD CONSTRAINT chk_rhcv_evidence_object CHECK ((jsonb_typeof(evidence) = 'object'::text));
ALTER TABLE ONLY public.realtime_hard_control_validations ADD CONSTRAINT chk_rhcv_git_sha CHECK ((git_sha ~ '^[0-9a-f]{40}$'::text));
ALTER TABLE ONLY public.realtime_hard_control_validations ADD CONSTRAINT chk_rhcv_scenario_results_object CHECK ((jsonb_typeof(scenario_results) = 'object'::text));
ALTER TABLE ONLY public.realtime_hard_control_validations ADD CONSTRAINT chk_rhcv_status CHECK ((status = ANY (ARRAY['passed'::text, 'failed'::text])));
ALTER TABLE ONLY public.realtime_hard_control_validations ADD CONSTRAINT realtime_hard_control_validation_validation_script_sha256_check CHECK ((validation_script_sha256 ~ '^[0-9a-f]{64}$'::text));
ALTER TABLE ONLY public.realtime_hard_control_validations ADD CONSTRAINT realtime_hard_control_validations_executed_by_check CHECK (((char_length(executed_by) >= 1) AND (char_length(executed_by) <= 200)));
ALTER TABLE ONLY public.review_attempt_items ADD CONSTRAINT review_attempt_items_status_check CHECK ((status = ANY (ARRAY['correct'::text, 'incorrect_spelling'::text, 'incorrect_usage'::text, 'missing'::text, 'forced_usage'::text])));
ALTER TABLE ONLY public.review_attempts ADD CONSTRAINT review_attempts_overall_result_check CHECK ((overall_result = ANY (ARRAY['passed'::text, 'failed'::text])));
ALTER TABLE ONLY public.review_groups ADD CONSTRAINT review_groups_level_non_negative CHECK ((review_level >= 0)) NOT VALID;
ALTER TABLE ONLY public.review_groups ADD CONSTRAINT review_groups_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'active'::text, 'mastered'::text])));
ALTER TABLE ONLY public.usage_daily ADD CONSTRAINT chk_ud_actor_type CHECK ((actor_type = ANY (ARRAY['user'::text, 'system'::text, 'cron'::text, 'admin'::text])));
ALTER TABLE ONLY public.usage_daily ADD CONSTRAINT chk_ud_distinct_logical_requests_non_negative CHECK ((distinct_logical_requests >= 0));
ALTER TABLE ONLY public.usage_daily ADD CONSTRAINT chk_ud_total_latency_ms_non_negative CHECK (((total_latency_ms IS NULL) OR (total_latency_ms >= 0)));
ALTER TABLE ONLY public.usage_reservation_items ADD CONSTRAINT chk_uri_consumed_non_negative CHECK ((consumed_quantity >= (0)::numeric));
ALTER TABLE ONLY public.usage_reservation_items ADD CONSTRAINT chk_uri_metadata_object CHECK ((jsonb_typeof(metadata) = 'object'::text));
ALTER TABLE ONLY public.usage_reservation_items ADD CONSTRAINT chk_uri_released_non_negative CHECK ((released_quantity >= (0)::numeric));
ALTER TABLE ONLY public.usage_reservation_items ADD CONSTRAINT chk_uri_reserved_non_negative CHECK ((reserved_quantity >= (0)::numeric));
ALTER TABLE ONLY public.usage_reservations ADD CONSTRAINT chk_ur_metadata_object CHECK ((jsonb_typeof(metadata) = 'object'::text));
ALTER TABLE ONLY public.usage_reservations ADD CONSTRAINT chk_ur_status CHECK ((status = ANY (ARRAY['pending'::text, 'committed'::text, 'released'::text, 'expired'::text, 'cancelled'::text, 'reconciliation_required'::text])));
ALTER TABLE ONLY public.user_account_deactivations ADD CONSTRAINT chk_uad_reactivation_fields CHECK ((((status = 'deactivated'::text) AND (reactivated_at IS NULL) AND (reactivated_by IS NULL)) OR ((status = 'reactivated'::text) AND (reactivated_at IS NOT NULL))));
ALTER TABLE ONLY public.user_account_deactivations ADD CONSTRAINT chk_uad_status CHECK ((status = ANY (ARRAY['deactivated'::text, 'reactivated'::text])));
ALTER TABLE ONLY public.user_billing_blocks ADD CONSTRAINT chk_ubb_lift_fields CHECK ((((is_active = true) AND (lifted_at IS NULL)) OR (is_active = false)));
ALTER TABLE ONLY public.user_capability_overrides ADD CONSTRAINT chk_override_ends_after_starts CHECK (((ends_at IS NULL) OR (ends_at > starts_at)));
ALTER TABLE ONLY public.user_capability_overrides ADD CONSTRAINT chk_override_value CHECK ((((operation = ANY (ARRAY['disable'::text, 'unlimited'::text])) AND (value IS NULL)) OR ((operation = ANY (ARRAY['add'::text, 'replace'::text])) AND (value IS NOT NULL))));
ALTER TABLE ONLY public.user_capability_overrides ADD CONSTRAINT user_capability_overrides_operation_check CHECK ((operation = ANY (ARRAY['add'::text, 'replace'::text, 'unlimited'::text, 'disable'::text])));
ALTER TABLE ONLY public.user_capability_overrides ADD CONSTRAINT user_capability_overrides_status_check CHECK ((status = ANY (ARRAY['active'::text, 'expired'::text, 'revoked'::text])));
ALTER TABLE ONLY public.user_communication_blocks ADD CONSTRAINT chk_ucb_channel CHECK ((channel = ANY (ARRAY['email'::text, 'sms'::text, 'push'::text, 'whatsapp'::text, 'in_app'::text])));
ALTER TABLE ONLY public.user_communication_blocks ADD CONSTRAINT chk_ucb_has_identifier CHECK (((user_id IS NOT NULL) OR (destination_hash IS NOT NULL)));
ALTER TABLE ONLY public.user_communication_blocks ADD CONSTRAINT chk_ucb_lift_fields CHECK ((((is_active = true) AND (lifted_at IS NULL)) OR (is_active = false)));
ALTER TABLE ONLY public.user_communication_blocks ADD CONSTRAINT chk_ucb_scope CHECK ((scope = ANY (ARRAY['marketing'::text, 'transactional'::text, 'all'::text])));
ALTER TABLE ONLY public.user_conversation_credits ADD CONSTRAINT chk_ucc_remaining_le_total CHECK ((remaining_seconds <= total_seconds));
ALTER TABLE ONLY public.user_conversation_credits ADD CONSTRAINT chk_ucc_remaining_seconds_non_negative CHECK ((remaining_seconds >= 0));
ALTER TABLE ONLY public.user_conversation_credits ADD CONSTRAINT chk_ucc_source CHECK ((source = ANY (ARRAY['purchase'::text, 'admin_grant'::text, 'promotion'::text, 'refund'::text])));
ALTER TABLE ONLY public.user_conversation_credits ADD CONSTRAINT chk_ucc_total_seconds_positive CHECK ((total_seconds > 0));
ALTER TABLE ONLY public.user_listening_assignments ADD CONSTRAINT user_listening_assignments_status_check CHECK ((status = ANY (ARRAY['assigned'::text, 'in_progress'::text, 'completed'::text])));
ALTER TABLE ONLY public.user_listening_attempts ADD CONSTRAINT chk_ula_subtitle_matches_attempt CHECK ((((attempt_number = 1) AND (subtitle_mode = 'none'::listening_subtitle_mode)) OR ((attempt_number = 2) AND (subtitle_mode = 'en'::listening_subtitle_mode)) OR ((attempt_number = 3) AND (subtitle_mode = 'pt-BR'::listening_subtitle_mode))));
ALTER TABLE ONLY public.user_listening_attempts ADD CONSTRAINT user_listening_attempts_attempt_cycle_check CHECK ((attempt_cycle >= 1));
ALTER TABLE ONLY public.user_listening_attempts ADD CONSTRAINT user_listening_attempts_attempt_number_check CHECK ((attempt_number = ANY (ARRAY[1, 2, 3])));
ALTER TABLE ONLY public.user_listening_attempts ADD CONSTRAINT user_listening_attempts_playback_rate_check CHECK ((playback_rate > (0)::numeric));
ALTER TABLE ONLY public.user_listening_attempts ADD CONSTRAINT user_listening_attempts_selected_option_check CHECK ((selected_option >= 0));
ALTER TABLE ONLY public.user_listening_block_sessions ADD CONSTRAINT chk_ulbs_completed_requires_ts CHECK (((status <> 'completed'::listening_block_session_status) OR (completed_at IS NOT NULL)));
ALTER TABLE ONLY public.user_listening_block_sessions ADD CONSTRAINT chk_ulbs_expires_after_started CHECK ((expires_at > started_at));
ALTER TABLE ONLY public.user_listening_block_sessions ADD CONSTRAINT user_listening_block_sessions_attempt_cycle_check CHECK ((attempt_cycle >= 1));
ALTER TABLE ONLY public.user_listening_block_sessions ADD CONSTRAINT user_listening_block_sessions_current_attempt_check CHECK ((current_attempt = ANY (ARRAY[1, 2, 3])));
ALTER TABLE ONLY public.user_listening_generation_sessions ADD CONSTRAINT user_listening_generation_sessions_progress_percent_check CHECK (((progress_percent >= 0) AND (progress_percent <= 100)));
ALTER TABLE ONLY public.user_listening_generation_sessions ADD CONSTRAINT user_listening_generation_sessions_status_check CHECK ((status = ANY (ARRAY['created'::text, 'identifying_level'::text, 'generating_block_1'::text, 'validating_block_1'::text, 'generating_block_2'::text, 'validating_block_2'::text, 'generating_questions'::text, 'preparing_description'::text, 'preparing_subtitles'::text, 'generating_audio_block_1'::text, 'generating_audio_block_2'::text, 'validating_duration'::text, 'finalizing'::text, 'ready'::text, 'failed'::text, 'cancelled'::text])));
ALTER TABLE ONLY public.user_listening_generation_sessions ADD CONSTRAINT user_listening_generation_sessions_user_level_check CHECK ((user_level = ANY (ARRAY['A1'::text, 'A2'::text, 'B1'::text, 'B2'::text, 'C1'::text, 'C2'::text])));
ALTER TABLE ONLY public.user_listening_progress ADD CONSTRAINT chk_ulp_block2_requires_block1 CHECK (((block_2_completed_at IS NULL) OR (block_1_completed_at IS NOT NULL)));
ALTER TABLE ONLY public.user_listening_progress ADD CONSTRAINT chk_ulp_completed_at_requires_completed_status CHECK (((completed_at IS NULL) OR (status = 'completed'::user_listening_progress_status)));
ALTER TABLE ONLY public.user_listening_progress ADD CONSTRAINT chk_ulp_completed_requires_all_fields CHECK (((status <> 'completed'::user_listening_progress_status) OR ((block_1_completed_at IS NOT NULL) AND (block_2_completed_at IS NOT NULL) AND (block_1_correct_attempt IS NOT NULL) AND (block_2_correct_attempt IS NOT NULL) AND (completed_at IS NOT NULL))));
ALTER TABLE ONLY public.user_listening_progress ADD CONSTRAINT user_listening_progress_block_1_correct_attempt_check CHECK ((block_1_correct_attempt = ANY (ARRAY[1, 2, 3])));
ALTER TABLE ONLY public.user_listening_progress ADD CONSTRAINT user_listening_progress_block_2_correct_attempt_check CHECK ((block_2_correct_attempt = ANY (ARRAY[1, 2, 3])));
ALTER TABLE ONLY public.user_listening_progress ADD CONSTRAINT user_listening_progress_current_block_check CHECK ((current_block = ANY (ARRAY[1, 2])));
ALTER TABLE ONLY public.user_listening_shared_progress ADD CONSTRAINT user_listening_shared_progress_current_part_check CHECK ((current_part = ANY (ARRAY[1, 2])));
ALTER TABLE ONLY public.user_plan_assignments ADD CONSTRAINT chk_ends_after_starts CHECK (((ends_at IS NULL) OR (ends_at > starts_at)));
ALTER TABLE ONLY public.user_plan_assignments ADD CONSTRAINT chk_pinned_version_req CHECK (((version_policy <> 'pinned_version'::text) OR (pinned_version_id IS NOT NULL)));
ALTER TABLE ONLY public.user_plan_assignments ADD CONSTRAINT user_plan_assignments_origin_check CHECK ((origin = ANY (ARRAY['manual'::text, 'trial'::text, 'promotional'::text, 'subscription'::text])));
ALTER TABLE ONLY public.user_plan_assignments ADD CONSTRAINT user_plan_assignments_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'active'::text, 'expired'::text, 'cancelled'::text, 'replaced'::text])));
ALTER TABLE ONLY public.user_plan_assignments ADD CONSTRAINT user_plan_assignments_version_policy_check CHECK ((version_policy = ANY (ARRAY['follow_current_published'::text, 'pinned_version'::text])));
ALTER TABLE ONLY public.writing_entries ADD CONSTRAINT writing_entries_difficulty_check CHECK (((difficulty = ANY (ARRAY['facil'::text, 'medio'::text, 'dificil'::text])) OR (difficulty IS NULL)));
ALTER TABLE ONLY public.writing_entries ADD CONSTRAINT writing_entries_status_check CHECK ((status = ANY (ARRAY['nao-iniciado'::text, 'escrito'::text, 'corrigido'::text, 'revisado'::text])));
ALTER TABLE ONLY public.writing_review_reservations ADD CONSTRAINT chk_wrr_status CHECK ((status = ANY (ARRAY['reserved'::text, 'completed'::text, 'failed'::text])));
ALTER TABLE ONLY public.writing_rewrite_attempts ADD CONSTRAINT writing_rewrite_attempts_author_type_check CHECK ((author_type = 'learner'::text));
ALTER TABLE ONLY public.writing_rewrite_attempts ADD CONSTRAINT writing_rewrite_attempts_submission_type_check CHECK ((submission_type = 'rewrite_v2'::text));
ALTER TABLE ONLY public.writing_rewrite_correction_outcomes ADD CONSTRAINT writing_rewrite_correction_outcomes_confidence_check CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)));
ALTER TABLE ONLY public.writing_rewrite_evaluations ADD CONSTRAINT writing_rewrite_evaluations_clarity_improvement_score_check CHECK (((clarity_improvement_score >= 0) AND (clarity_improvement_score <= 100)));
ALTER TABLE ONLY public.writing_rewrite_evaluations ADD CONSTRAINT writing_rewrite_evaluations_cohesion_improvement_score_check CHECK (((cohesion_improvement_score >= 0) AND (cohesion_improvement_score <= 100)));
ALTER TABLE ONLY public.writing_rewrite_evaluations ADD CONSTRAINT writing_rewrite_evaluations_correction_resolution_score_check CHECK (((correction_resolution_score >= 0) AND (correction_resolution_score <= 100)));
ALTER TABLE ONLY public.writing_rewrite_evaluations ADD CONSTRAINT writing_rewrite_evaluations_independence_score_check CHECK (((independence_score >= 0) AND (independence_score <= 100)));
ALTER TABLE ONLY public.writing_rewrite_evaluations ADD CONSTRAINT writing_rewrite_evaluations_meaning_preservation_score_check CHECK (((meaning_preservation_score >= 0) AND (meaning_preservation_score <= 100)));
ALTER TABLE ONLY public.writing_rewrite_evaluations ADD CONSTRAINT writing_rewrite_evaluations_new_error_avoidance_score_check CHECK (((new_error_avoidance_score >= 0) AND (new_error_avoidance_score <= 100)));
ALTER TABLE ONLY public.writing_rewrite_evaluations ADD CONSTRAINT writing_rewrite_evaluations_overall_improvement_score_check CHECK (((overall_improvement_score >= 0) AND (overall_improvement_score <= 100)));
ALTER TABLE ONLY public.writing_rewrite_evidence_candidates ADD CONSTRAINT writing_rewrite_evidence_candidates_confidence_check CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)));

-- ---------------------------------------------------------------------
-- 7. INDEXES (nao cobertos por PK/UNIQUE) -- 205 indices
-- ---------------------------------------------------------------------
CREATE INDEX idx_admin_audit_log_actor ON public.admin_audit_log USING btree (actor_user_id, created_at DESC);
CREATE INDEX idx_admin_audit_log_correlation ON public.admin_audit_log USING btree (correlation_id);
CREATE INDEX idx_admin_audit_log_target ON public.admin_audit_log USING btree (target_type, target_id);
CREATE INDEX idx_admin_invitations_email ON public.admin_invitations USING btree (email_normalized);
CREATE UNIQUE INDEX idx_admin_invitations_pending_email ON public.admin_invitations USING btree (email_normalized) WHERE (status = 'pending'::text);
CREATE INDEX idx_admin_invitations_status ON public.admin_invitations USING btree (status);
CREATE INDEX idx_admin_rate_limit_window ON public.admin_rate_limit_buckets USING btree (window_start);
CREATE INDEX idx_admin_role_permissions_key ON public.admin_role_permissions USING btree (permission_key);
CREATE INDEX idx_admin_security_events_actor ON public.admin_security_events USING btree (actor_user_id, created_at DESC);
CREATE INDEX idx_admin_security_events_severity ON public.admin_security_events USING btree (severity, created_at DESC);
CREATE INDEX idx_admin_security_events_type ON public.admin_security_events USING btree (event_type, created_at DESC);
CREATE INDEX idx_admin_users_role_status ON public.admin_users USING btree (role, status);
CREATE UNIQUE INDEX idx_alerts_dedup_active ON public.ai_alerts USING btree (dedup_key, environment) WHERE (status <> 'resolved'::text);
CREATE INDEX idx_alerts_env_status ON public.ai_alerts USING btree (environment, status, severity, created_at DESC);
CREATE INDEX idx_budgets_env_active ON public.ai_budget_policies USING btree (environment, active, starts_at);
CREATE INDEX idx_switches_env_active ON public.ai_control_switches USING btree (environment, scope, revoked_at) WHERE (revoked_at IS NULL);
CREATE INDEX idx_cost_valuations_divergence ON public.ai_cost_valuations USING btree (divergence_status) WHERE (divergence_status IS NOT NULL);
CREATE INDEX idx_cost_valuations_event ON public.ai_cost_valuations USING btree (event_id, created_at DESC);
CREATE INDEX idx_cost_valuations_status ON public.ai_cost_valuations USING btree (status);
CREATE INDEX idx_cost_valuations_version ON public.ai_cost_valuations USING btree (pricing_version_id);
CREATE UNIQUE INDEX uq_agbb_key ON public.ai_gateway_budget_buckets USING btree (scope_type, scope_key, period_type, period_start);
CREATE UNIQUE INDEX uq_agcb_scope ON public.ai_gateway_circuit_breakers USING btree (provider, COALESCE(model, ''::text), feature_key);
CREATE INDEX idx_agcv_lookup ON public.ai_gateway_concurrency_validations USING btree (migration_version, validation_script_sha256, status, executed_at DESC);
CREATE INDEX idx_gateway_acks_env ON public.ai_gateway_config_acknowledgements USING btree (environment, version_received, acked_at DESC);
CREATE INDEX idx_agd_feature_date ON public.ai_gateway_decisions USING btree (feature_key, created_at);
CREATE INDEX idx_agd_outcome_date ON public.ai_gateway_decisions USING btree (outcome, created_at);
CREATE INDEX idx_agd_user_date ON public.ai_gateway_decisions USING btree (user_id, created_at) WHERE (user_id IS NOT NULL);
CREATE INDEX idx_agil_expiry ON public.ai_gateway_idempotency_locks USING btree (expires_at) WHERE (status = 'in_progress'::text);
CREATE INDEX idx_agqb_period_end ON public.ai_gateway_quota_buckets USING btree (period_end);
CREATE UNIQUE INDEX uq_agqb_key ON public.ai_gateway_quota_buckets USING btree (subject_type, COALESCE((subject_id)::text, 'system'::text), feature_key, metric_key, period_type, period_start);
CREATE INDEX idx_agrbl_reservation ON public.ai_gateway_reservation_budget_links USING btree (reservation_id);
CREATE INDEX idx_pricing_acks_env ON public.ai_pricing_acknowledgements USING btree (environment, version_received, acked_at DESC);
CREATE UNIQUE INDEX idx_pricing_rates_dims_unique ON public.ai_pricing_rates USING btree (version_id, provider, COALESCE(model, ''::text), COALESCE(operation, ''::text), metric_key, COALESCE(feature_key, ''::text), COALESCE(region, ''::text), priority);
CREATE INDEX idx_pricing_rates_lookup ON public.ai_pricing_rates USING btree (provider, metric_key);
CREATE INDEX idx_pricing_rates_version ON public.ai_pricing_rates USING btree (version_id);
CREATE UNIQUE INDEX idx_pricing_versions_create_idem ON public.ai_pricing_versions USING btree (environment, create_idempotency_key) WHERE (create_idempotency_key IS NOT NULL);
CREATE INDEX idx_pricing_versions_effective ON public.ai_pricing_versions USING btree (environment, effective_from, effective_to);
CREATE INDEX idx_pricing_versions_env_state ON public.ai_pricing_versions USING btree (environment, state);
CREATE UNIQUE INDEX idx_pricing_versions_one_published ON public.ai_pricing_versions USING btree (environment) WHERE (state = 'published'::text);
CREATE UNIQUE INDEX idx_pricing_versions_one_scheduled ON public.ai_pricing_versions USING btree (environment) WHERE (state = 'scheduled'::text);
CREATE UNIQUE INDEX idx_pricing_versions_publish_idem ON public.ai_pricing_versions USING btree (environment, publish_idempotency_key) WHERE (publish_idempotency_key IS NOT NULL);
CREATE INDEX idx_aps_auth_expiry ON public.ai_provider_sessions USING btree (authorization_expires_at) WHERE ((status = ANY (ARRAY['authorized'::text, 'connecting'::text])) AND (authorization_expires_at IS NOT NULL));
CREATE INDEX idx_aps_internal_session ON public.ai_provider_sessions USING btree (internal_session_type, internal_session_id) WHERE ((internal_session_type IS NOT NULL) AND (internal_session_id IS NOT NULL));
CREATE INDEX idx_aps_provider_session_id ON public.ai_provider_sessions USING btree (provider_session_id) WHERE (provider_session_id IS NOT NULL);
CREATE INDEX idx_aps_sweep_candidates ON public.ai_provider_sessions USING btree (feature_key, status, last_heartbeat_at, authorization_expires_at) WHERE (status = ANY (ARRAY['active'::text, 'authorized'::text, 'connecting'::text]));
CREATE INDEX idx_aps_user_status ON public.ai_provider_sessions USING btree (user_id, status) WHERE (user_id IS NOT NULL);
CREATE INDEX idx_arc_feature_key ON public.ai_runtime_controls USING btree (feature_key) WHERE (feature_key IS NOT NULL);
CREATE INDEX idx_arc_user_id ON public.ai_runtime_controls USING btree (user_id) WHERE (user_id IS NOT NULL);
CREATE INDEX idx_auem_event ON public.ai_usage_event_metrics USING btree (usage_event_id);
CREATE UNIQUE INDEX uq_auem_final_metric ON public.ai_usage_event_metrics USING btree (usage_event_id, metric_key, unit_type) WHERE (is_final = true);
CREATE INDEX idx_aue_correlation ON public.ai_usage_events USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);
CREATE INDEX idx_aue_cost_status ON public.ai_usage_events USING btree (cost_status) WHERE (cost_status <> ALL (ARRAY['reconciled'::text, 'not_applicable'::text]));
CREATE INDEX idx_aue_feature_date ON public.ai_usage_events USING btree (feature_key, started_at);
CREATE INDEX idx_aue_idempotency ON public.ai_usage_events USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);
CREATE INDEX idx_aue_initiator_date ON public.ai_usage_events USING btree (initiated_by_user_id, started_at) WHERE (initiated_by_user_id IS NOT NULL);
CREATE INDEX idx_aue_parent ON public.ai_usage_events USING btree (parent_event_id) WHERE (parent_event_id IS NOT NULL);
CREATE INDEX idx_aue_provider_date ON public.ai_usage_events USING btree (provider, started_at);
CREATE INDEX idx_aue_provider_request ON public.ai_usage_events USING btree (provider_request_id) WHERE (provider_request_id IS NOT NULL);
CREATE INDEX idx_aue_provider_session ON public.ai_usage_events USING btree (provider_session_record_id) WHERE (provider_session_record_id IS NOT NULL);
CREATE INDEX idx_aue_resource ON public.ai_usage_events USING btree (resource_type, resource_id) WHERE (resource_type IS NOT NULL);
CREATE INDEX idx_aue_status_date ON public.ai_usage_events USING btree (status, started_at);
CREATE INDEX idx_aue_user_date ON public.ai_usage_events USING btree (user_id, started_at) WHERE (user_id IS NOT NULL);
CREATE UNIQUE INDEX uq_aue_session_provider_request ON public.ai_usage_events USING btree (provider_session_record_id, provider_request_id) WHERE ((provider_session_record_id IS NOT NULL) AND (provider_request_id IS NOT NULL));
CREATE INDEX idx_api_rate_limits_window_start ON public.api_rate_limits USING btree (window_start);
CREATE INDEX idx_config_acks_env_app ON public.app_config_acknowledgements USING btree (environment, application, version_received, acked_at DESC);
CREATE INDEX idx_config_definitions_category ON public.app_config_definitions USING btree (category, active);
CREATE INDEX idx_config_values_version ON public.app_config_values USING btree (version_id);
CREATE UNIQUE INDEX idx_config_versions_create_idem ON public.app_config_versions USING btree (environment, create_idempotency_key) WHERE (create_idempotency_key IS NOT NULL);
CREATE INDEX idx_config_versions_env_state ON public.app_config_versions USING btree (environment, state);
CREATE UNIQUE INDEX idx_config_versions_one_published ON public.app_config_versions USING btree (environment) WHERE (state = 'published'::text);
CREATE UNIQUE INDEX idx_config_versions_one_scheduled ON public.app_config_versions USING btree (environment) WHERE (state = 'scheduled'::text);
CREATE UNIQUE INDEX idx_config_versions_publish_idem ON public.app_config_versions USING btree (environment, publish_idempotency_key) WHERE (publish_idempotency_key IS NOT NULL);
CREATE INDEX idx_csa_stale_authorized ON public.conversation_session_authorizations USING btree (authorized_at) WHERE (status = 'authorized'::text);
CREATE INDEX idx_csa_user_month ON public.conversation_session_authorizations USING btree (user_id, session_date);
CREATE INDEX idx_conversation_sessions_user_date ON public.conversation_sessions USING btree (user_id, session_date);
CREATE INDEX engine_activation_log_idempotency ON public.engine_activation_log USING btree (idempotency_key);
CREATE INDEX engine_activation_log_status ON public.engine_activation_log USING btree (status, created_at DESC);
CREATE INDEX engine_activation_log_user_op ON public.engine_activation_log USING btree (user_id, operation);
CREATE INDEX english_learning_memory_user_id_idx ON public.english_learning_memory USING btree (user_id);
CREATE INDEX english_learning_memory_user_idx ON public.english_learning_memory USING btree (user_id);
CREATE INDEX english_reviews_created_at_idx ON public.english_reviews USING btree (created_at DESC);
CREATE INDEX english_reviews_user_created_idx ON public.english_reviews USING btree (user_id, created_at DESC);
CREATE INDEX english_reviews_user_id_idx ON public.english_reviews USING btree (user_id);
CREATE INDEX idx_english_reviews_user_entry_date ON public.english_reviews USING btree (user_id, entry_date);
CREATE INDEX idx_ghb_environment ON public.gateway_heartbeats USING btree (environment);
CREATE INDEX idx_ghb_received_at ON public.gateway_heartbeats USING btree (received_at DESC);
CREATE INDEX generated_themes_user_created_idx ON public.generated_themes USING btree (user_id, created_at DESC);
CREATE UNIQUE INDEX grammar_explanations_name_lower_idx ON public.grammar_explanations USING btree (lower(name));
CREATE INDEX idx_lsp_user_id ON public.learner_skill_profiles USING btree (user_id);
CREATE INDEX idx_lsp_user_skill ON public.learner_skill_profiles USING btree (user_id, skill);
CREATE INDEX idx_laa_block ON public.listening_audio_assets USING btree (block_id, status);
CREATE INDEX idx_laa_episode ON public.listening_audio_assets USING btree (episode_id, status);
CREATE INDEX idx_laa_ssml_hash ON public.listening_audio_assets USING btree (ssml_hash);
CREATE INDEX idx_laf_quarantined ON public.listening_audio_flags USING btree (quarantined_at) WHERE ((quarantined_at IS NOT NULL) AND (restored_at IS NULL));
CREATE INDEX idx_lb_episode_order ON public.listening_blocks USING btree (episode_id, block_order);
CREATE INDEX idx_lb_ssml_status ON public.listening_blocks USING btree (episode_id, ssml_status);
CREATE INDEX idx_lbt_asset_order ON public.listening_bookmark_timings USING btree (audio_asset_id, event_order);
CREATE INDEX idx_led_state ON public.listening_episode_distribution USING btree (state);
CREATE INDEX idx_lep_episode ON public.listening_episode_publications USING btree (episode_id, created_at DESC);
CREATE UNIQUE INDEX idx_lep_idempotency ON public.listening_episode_publications USING btree (episode_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);
CREATE INDEX idx_le_cefr_theme ON public.listening_episodes USING btree (cefr_level, theme) WHERE (theme IS NOT NULL);
CREATE INDEX idx_le_questions_status ON public.listening_episodes USING btree (questions_status) WHERE (questions_status IS NOT NULL);
CREATE INDEX idx_le_status_level_published ON public.listening_episodes USING btree (status, cefr_level, published_at);
CREATE INDEX idx_le_subtitles_status ON public.listening_episodes USING btree (subtitles_status);
CREATE INDEX idx_listening_generation_jobs_group_created ON public.listening_generation_jobs USING btree (level_group, created_at DESC);
CREATE INDEX idx_listening_generation_jobs_lock_expiry ON public.listening_generation_jobs USING btree (lock_expires_at) WHERE (status <> ALL (ARRAY['ready'::text, 'failed'::text, 'cancelled'::text]));
CREATE UNIQUE INDEX uq_listening_generation_jobs_active_group ON public.listening_generation_jobs USING btree (level_group) WHERE (status <> ALL (ARRAY['ready'::text, 'failed'::text, 'cancelled'::text]));
CREATE INDEX idx_lgr_correlation ON public.listening_generation_requests USING btree (correlation_id);
CREATE INDEX idx_lgr_episode ON public.listening_generation_requests USING btree (episode_id);
CREATE INDEX idx_lgr_gateway_request_ids ON public.listening_generation_requests USING gin (gateway_request_ids);
CREATE UNIQUE INDEX idx_lgr_idempotency_active ON public.listening_generation_requests USING btree (idempotency_key) WHERE ((idempotency_key IS NOT NULL) AND (status = ANY (ARRAY['pending'::text, 'scheduled'::text, 'processing'::text])));
CREATE UNIQUE INDEX idx_lgr_no_duplicate_active ON public.listening_generation_requests USING btree (job_type, COALESCE(episode_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(block_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE (status = ANY (ARRAY['pending'::text, 'scheduled'::text, 'processing'::text]));
CREATE INDEX idx_lgr_status ON public.listening_generation_requests USING btree (status);
CREATE INDEX idx_listening_jobs_block ON public.listening_jobs USING btree (block_id, status);
CREATE INDEX idx_listening_jobs_dispatch ON public.listening_jobs USING btree (status, next_attempt_at, priority DESC, created_at) WHERE (status = ANY (ARRAY['pending'::text, 'retry'::text]));
CREATE INDEX idx_listening_jobs_episode ON public.listening_jobs USING btree (episode_id, status);
CREATE INDEX idx_listening_jobs_lock_expiry ON public.listening_jobs USING btree (lock_expires_at) WHERE (status = 'processing'::text);
CREATE INDEX idx_listening_jobs_type_status ON public.listening_jobs USING btree (job_type, status);
CREATE INDEX idx_listening_jobs_updated ON public.listening_jobs USING btree (updated_at);
CREATE UNIQUE INDEX uq_listening_jobs_idempotency ON public.listening_jobs USING btree (idempotency_key) WHERE (status <> ALL (ARRAY['cancelled'::text, 'dead_letter'::text]));
CREATE INDEX idx_listening_alerts_episode ON public.listening_operational_alerts USING btree (episode_id);
CREATE INDEX idx_listening_alerts_job ON public.listening_operational_alerts USING btree (job_id);
CREATE INDEX idx_listening_alerts_status ON public.listening_operational_alerts USING btree (status, created_at);
CREATE INDEX idx_lpl_episode ON public.listening_publication_log USING btree (episode_id, created_at);
CREATE INDEX idx_lq_episode_order ON public.listening_questions USING btree (episode_id, question_order);
CREATE INDEX idx_lq_episode_validation ON public.listening_questions USING btree (episode_id, validation_status, generator_prompt_version) WHERE (validation_status IS NOT NULL);
CREATE INDEX idx_lst_asset ON public.listening_sentence_timings USING btree (audio_asset_id);
CREATE INDEX idx_lst_block ON public.listening_sentence_timings USING btree (block_id, sentence_order);
CREATE INDEX idx_ls_block_order ON public.listening_sentences USING btree (block_id, sentence_order);
CREATE INDEX idx_lsc_audio_asset ON public.listening_subtitle_cues USING btree (audio_asset_id);
CREATE INDEX idx_lsc_block_lang_status ON public.listening_subtitle_cues USING btree (block_id, language, status);
CREATE INDEX idx_lsc_block_language_order ON public.listening_subtitle_cues USING btree (block_id, language, cue_order);
CREATE INDEX idx_lwt_asset_order ON public.listening_word_timings USING btree (audio_asset_id, word_order);
CREATE INDEX plan_versions_config_hash_idx ON public.plan_versions USING btree (plan_id, config_hash);
CREATE INDEX plan_versions_plan_status_idx ON public.plan_versions USING btree (plan_id, status);
CREATE UNIQUE INDEX plan_versions_single_current_published ON public.plan_versions USING btree (plan_id) WHERE ((status = 'published'::text) AND (effective_to IS NULL));
CREATE UNIQUE INDEX plan_versions_single_draft_per_plan ON public.plan_versions USING btree (plan_id) WHERE (status = 'draft'::text);
CREATE UNIQUE INDEX plans_single_active_default ON public.plans USING btree (is_default) WHERE ((is_default = true) AND (status = 'active'::text));
CREATE INDEX idx_pronunciation_assessments_text_version ON public.pronunciation_assessments USING btree (text_version_id);
CREATE INDEX idx_pronunciation_assessments_user ON public.pronunciation_assessments USING btree (user_id);
CREATE INDEX idx_pts_user_date ON public.pronunciation_training_sessions USING btree (user_id, practice_date);
CREATE INDEX idx_pp_active ON public.provider_pricing USING btree (provider, service, metric_key) WHERE (is_active = true);
CREATE INDEX idx_rhcv_lookup ON public.realtime_hard_control_validations USING btree (hard_control_version, validation_script_sha256, git_sha, status, executed_at DESC);
CREATE INDEX review_attempt_items_attempt_idx ON public.review_attempt_items USING btree (review_attempt_id);
CREATE INDEX review_attempts_group_id_idx ON public.review_attempts USING btree (review_group_id);
CREATE INDEX review_attempts_user_id_idx ON public.review_attempts USING btree (user_id);
CREATE INDEX review_group_items_group_idx ON public.review_group_items USING btree (review_group_id);
CREATE INDEX review_groups_user_id_idx ON public.review_groups USING btree (user_id);
CREATE INDEX review_groups_user_next_review_idx ON public.review_groups USING btree (user_id, next_review_at);
CREATE INDEX review_schedule_history_group_id_idx ON public.review_schedule_history USING btree (review_group_id);
CREATE INDEX review_schedule_history_user_id_idx ON public.review_schedule_history USING btree (user_id);
CREATE INDEX idx_ud_date_user ON public.usage_daily USING btree (usage_date, user_id);
CREATE INDEX idx_ud_feature_date ON public.usage_daily USING btree (feature_key, usage_date);
CREATE UNIQUE INDEX uq_usage_daily_composite ON public.usage_daily USING btree (usage_date, COALESCE((user_id)::text, '00000000-0000-0000-0000-000000000000'::text), actor_type, feature_key, provider, COALESCE(model, ''::text));
CREATE INDEX idx_udm_daily ON public.usage_daily_metrics USING btree (usage_daily_id);
CREATE INDEX idx_ur_expiry ON public.usage_reservations USING btree (expires_at) WHERE (status = 'pending'::text);
CREATE INDEX idx_ur_pending ON public.usage_reservations USING btree (user_id, feature_key) WHERE (status = 'pending'::text);
CREATE UNIQUE INDEX uq_ur_idempotency_key ON public.usage_reservations USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);
CREATE INDEX idx_uac_suspended ON public.user_access_controls USING btree (is_suspended, user_id);
CREATE INDEX idx_user_account_deactivations_user_id ON public.user_account_deactivations USING btree (user_id);
CREATE UNIQUE INDEX uq_user_account_deactivations_active ON public.user_account_deactivations USING btree (user_id) WHERE (status = 'deactivated'::text);
CREATE INDEX idx_user_billing_blocks_active ON public.user_billing_blocks USING btree (user_id) WHERE (is_active = true);
CREATE INDEX idx_user_billing_blocks_user_id ON public.user_billing_blocks USING btree (user_id);
CREATE UNIQUE INDEX uq_user_billing_blocks_active_reason ON public.user_billing_blocks USING btree (user_id, reason) WHERE (is_active = true);
CREATE INDEX idx_uco_user ON public.user_capability_overrides USING btree (user_id, capability_key, status);
CREATE UNIQUE INDEX uq_uco_user_capability_active ON public.user_capability_overrides USING btree (user_id, capability_key) WHERE (status = 'active'::text);
CREATE INDEX idx_user_communication_blocks_channel_active ON public.user_communication_blocks USING btree (channel, is_active);
CREATE INDEX idx_user_communication_blocks_destination_hash ON public.user_communication_blocks USING btree (destination_hash) WHERE (destination_hash IS NOT NULL);
CREATE INDEX idx_user_communication_blocks_user_id ON public.user_communication_blocks USING btree (user_id) WHERE (user_id IS NOT NULL);
CREATE UNIQUE INDEX uq_user_communication_blocks_active_hash ON public.user_communication_blocks USING btree (destination_hash, channel, scope, reason) WHERE ((is_active = true) AND (destination_hash IS NOT NULL));
CREATE UNIQUE INDEX uq_user_communication_blocks_active_user ON public.user_communication_blocks USING btree (user_id, channel, scope, reason) WHERE ((is_active = true) AND (user_id IS NOT NULL));
CREATE INDEX idx_user_conversation_credits_expires_at ON public.user_conversation_credits USING btree (expires_at) WHERE (expires_at IS NOT NULL);
CREATE INDEX idx_user_conversation_credits_external_reference ON public.user_conversation_credits USING btree (external_reference) WHERE (external_reference IS NOT NULL);
CREATE INDEX idx_user_conversation_credits_remaining_positive ON public.user_conversation_credits USING btree (remaining_seconds) WHERE (remaining_seconds > 0);
CREATE INDEX idx_user_conversation_credits_user_id ON public.user_conversation_credits USING btree (user_id);
CREATE INDEX idx_ula_episode_id ON public.user_listening_assignments USING btree (episode_id);
CREATE INDEX idx_ula_user_date ON public.user_listening_assignments USING btree (user_id, activity_date DESC);
CREATE INDEX idx_ula_user_status ON public.user_listening_assignments USING btree (user_id, status);
CREATE INDEX idx_ula_question_cycle_attempt ON public.user_listening_attempts USING btree (question_id, attempt_cycle, attempt_number);
CREATE INDEX idx_ula_user_episode ON public.user_listening_attempts USING btree (user_id, episode_id);
CREATE UNIQUE INDEX idx_ula_user_submission_id ON public.user_listening_attempts USING btree (user_id, submission_id) WHERE (submission_id IS NOT NULL);
CREATE INDEX idx_ulbs_expires_active ON public.user_listening_block_sessions USING btree (expires_at) WHERE (status = ANY (ARRAY['active'::listening_block_session_status, 'awaiting_answer'::listening_block_session_status, 'replay_required'::listening_block_session_status]));
CREATE UNIQUE INDEX idx_ulbs_user_block_active ON public.user_listening_block_sessions USING btree (user_id, block_id) WHERE (status = ANY (ARRAY['active'::listening_block_session_status, 'awaiting_answer'::listening_block_session_status, 'replay_required'::listening_block_session_status]));
CREATE INDEX idx_ulbs_user_episode ON public.user_listening_block_sessions USING btree (user_id, episode_id);
CREATE INDEX idx_ulgs_user_date ON public.user_listening_generation_sessions USING btree (user_id, local_date DESC);
CREATE UNIQUE INDEX idx_ulgs_user_date_active ON public.user_listening_generation_sessions USING btree (user_id, local_date) WHERE (status <> ALL (ARRAY['cancelled'::text, 'failed'::text]));
CREATE INDEX idx_ulp_user_status ON public.user_listening_progress USING btree (user_id, status);
CREATE INDEX idx_ulr_assignment ON public.user_listening_results USING btree (assignment_id);
CREATE INDEX idx_ulr_user_id ON public.user_listening_results USING btree (user_id);
CREATE INDEX idx_upa_plan ON public.user_plan_assignments USING btree (plan_id);
CREATE INDEX idx_upa_user_status ON public.user_plan_assignments USING btree (user_id, status, starts_at, ends_at);
CREATE INDEX writing_entries_user_date_idx ON public.writing_entries USING btree (user_id, entry_date DESC);
CREATE UNIQUE INDEX writing_entries_user_entry_date_unique ON public.writing_entries USING btree (user_id, entry_date);
CREATE INDEX writing_entries_user_id_idx ON public.writing_entries USING btree (user_id);
CREATE INDEX writing_entries_year_month_idx ON public.writing_entries USING btree (year, month);
CREATE INDEX idx_wrr_user_created_status ON public.writing_review_reservations USING btree (user_id, created_at, status);
CREATE INDEX idx_rewrite_attempts_review_user ON public.writing_rewrite_attempts USING btree (review_id, user_id, rewrite_sequence);
CREATE INDEX idx_rewrite_attempts_user_status ON public.writing_rewrite_attempts USING btree (user_id, status);
CREATE INDEX idx_correction_outcomes_eval ON public.writing_rewrite_correction_outcomes USING btree (rewrite_evaluation_id);
CREATE INDEX idx_rewrite_evaluations_submission ON public.writing_rewrite_evaluations USING btree (rewrite_submission_id);
CREATE INDEX idx_rewrite_evaluations_user ON public.writing_rewrite_evaluations USING btree (user_id, created_at DESC);
CREATE INDEX idx_rewrite_evidence_submission ON public.writing_rewrite_evidence_candidates USING btree (rewrite_submission_id);
CREATE INDEX idx_rewrite_evidence_user ON public.writing_rewrite_evidence_candidates USING btree (user_id, created_at DESC);
CREATE INDEX idx_rewrite_status_history_submission ON public.writing_rewrite_status_history USING btree (rewrite_submission_id, changed_at DESC);

-- ---------------------------------------------------------------------
-- 8. VIEWS (1)
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.listening_questions_public AS
 SELECT q.id,
    q.episode_id,
    q.block_id,
    q.question_order,
    q.prompt,
    q.options_json,
    q.explanation_pt,
    q.max_attempts
   FROM listening_questions q
     JOIN listening_episodes e ON e.id = q.episode_id
  WHERE e.status = 'published'::listening_episode_status;

-- ---------------------------------------------------------------------
-- 9. FUNCTIONS / PROCEDURES (202) -- SECURITY DEFINER/INVOKER preservado no proprio DDL de cada funcao
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._build_config_snapshot(p_version_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ver app_config_versions%ROWTYPE;
  v_values jsonb;
BEGIN
  SELECT * INTO v_ver FROM app_config_versions WHERE id = p_version_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Config version not found: %', p_version_id; END IF;

  SELECT COALESCE(jsonb_object_agg(d.key, jsonb_build_object(
    'value', v.value, 'exposure', d.exposure, 'valueType', d.value_type, 'category', d.category
  )), '{}'::jsonb)
  INTO v_values
  FROM app_config_values v
  JOIN app_config_definitions d ON d.key = v.definition_key
  WHERE v.version_id = p_version_id;

  RETURN jsonb_build_object(
    'environment', v_ver.environment,
    'version_id', v_ver.id,
    'version_number', v_ver.version_number,
    'effective_from', v_ver.effective_from,
    'effective_to', v_ver.effective_to,
    'values', v_values
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public._build_control_snapshot(p_environment text, p_version_number integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cfg  ai_gateway_configs%ROWTYPE;
BEGIN
  SELECT * INTO v_cfg FROM ai_gateway_configs WHERE environment = p_environment;

  RETURN jsonb_build_object(
    'environment',       p_environment,
    'version_number',    p_version_number,
    'gateway_mode',      v_cfg.gateway_mode,
    'ai_enabled',        v_cfg.ai_enabled,
    'emergency_stop',    v_cfg.emergency_stop,
    'failure_strategy',  v_cfg.failure_strategy,
    'cache_ttl_seconds', v_cfg.cache_ttl_seconds,
    'max_stale_seconds', v_cfg.max_stale_seconds,
    'published_at',      now(),
    'switches', jsonb_build_object(
      'providers', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', id, 'provider', provider, 'enabled', enabled,
          'reason', reason, 'starts_at', starts_at, 'ends_at', ends_at
        ) ORDER BY created_at)
        FROM ai_control_switches
        WHERE environment = p_environment AND scope = 'provider' AND revoked_at IS NULL
          AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())
      ), '[]'::jsonb),
      'models', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', id, 'provider', provider, 'model', model, 'enabled', enabled,
          'reason', reason, 'starts_at', starts_at, 'ends_at', ends_at
        ) ORDER BY created_at)
        FROM ai_control_switches
        WHERE environment = p_environment AND scope = 'model' AND revoked_at IS NULL
          AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())
      ), '[]'::jsonb),
      'features', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', id, 'feature_key', feature_key, 'enabled', enabled,
          'reason', reason, 'starts_at', starts_at, 'ends_at', ends_at
        ) ORDER BY created_at)
        FROM ai_control_switches
        WHERE environment = p_environment AND scope = 'feature' AND revoked_at IS NULL
          AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())
      ), '[]'::jsonb),
      'routes', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', id, 'feature_key', feature_key, 'provider', provider, 'model', model,
          'enabled', enabled, 'reason', reason, 'starts_at', starts_at, 'ends_at', ends_at
        ) ORDER BY created_at)
        FROM ai_control_switches
        WHERE environment = p_environment AND scope = 'route' AND revoked_at IS NULL
          AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())
      ), '[]'::jsonb)
    ),
    'budgets', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', id, 'name', name, 'scope', scope, 'scope_value', scope_value,
        'metric', metric, 'currency', currency, 'limit_value', limit_value,
        'period', period, 'timezone', timezone, 'action', action,
        'alert_thresholds', alert_thresholds, 'priority', priority,
        'starts_at', starts_at, 'ends_at', ends_at
      ) ORDER BY priority, created_at)
      FROM ai_budget_policies
      WHERE environment = p_environment AND active = true
        AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())
    ), '[]'::jsonb)
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public._build_pricing_snapshot(p_version_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ver ai_pricing_versions%ROWTYPE;
  v_rates jsonb;
BEGIN
  SELECT * INTO v_ver FROM ai_pricing_versions WHERE id = p_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pricing version not found: %', p_version_id;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id, 'provider', r.provider, 'model', r.model, 'operation', r.operation,
    'metric_key', r.metric_key, 'feature_key', r.feature_key, 'region', r.region,
    'unit_type', r.unit_type, 'unit_size', r.unit_size, 'unit_price', r.unit_price,
    'currency', r.currency, 'priority', r.priority, 'source', r.source
  ) ORDER BY r.provider, r.metric_key, r.priority), '[]'::jsonb)
  INTO v_rates
  FROM ai_pricing_rates r
  WHERE r.version_id = p_version_id;

  RETURN jsonb_build_object(
    'environment', v_ver.environment,
    'version_id', v_ver.id,
    'version_number', v_ver.version_number,
    'name', v_ver.name,
    'currencies', v_ver.currencies,
    'effective_from', v_ver.effective_from,
    'effective_to', v_ver.effective_to,
    'rates', v_rates
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public._build_security_policy_snapshot_v1(p_environment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_cfg admin_security_configs%ROWTYPE;
BEGIN
  SELECT * INTO v_cfg FROM admin_security_configs WHERE environment = p_environment;
  RETURN jsonb_build_object(
    'environment', p_environment,
    'mfa_required', v_cfg.mfa_required,
    'recent_auth_window_seconds', v_cfg.recent_auth_window_seconds,
    'max_admin_session_hours', v_cfg.max_admin_session_hours,
    'max_idle_minutes', v_cfg.max_idle_minutes,
    'invitation_expiry_hours', v_cfg.invitation_expiry_hours,
    'rate_limit_max_attempts', v_cfg.rate_limit_max_attempts,
    'rate_limit_window_seconds', v_cfg.rate_limit_window_seconds,
    'lockout_duration_seconds', v_cfg.lockout_duration_seconds,
    'min_reason_length', v_cfg.min_reason_length
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public._gateway_audit_database_privileges_v1()
 RETURNS TABLE(unsafe_tables text[], unsafe_functions text[])
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_table          TEXT;
  v_func_sig       TEXT;
  v_unsafe_tables  TEXT[] := '{}';
  v_unsafe_funcs   TEXT[] := '{}';
BEGIN
  FOR v_table IN
    SELECT unnest(ARRAY[
      'ai_gateway_decisions', 'ai_gateway_idempotency_locks', 'ai_gateway_quota_buckets',
      'ai_gateway_budget_buckets', 'ai_gateway_reservation_budget_links', 'ai_gateway_circuit_breakers',
      'api_rate_limits', 'ai_gateway_concurrency_validations',
      'conversation_session_authorizations', 'realtime_hard_control_validations'
    ])
  LOOP
    IF has_table_privilege('anon', 'public.' || v_table, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR has_table_privilege('authenticated', 'public.' || v_table, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    THEN
      v_unsafe_tables := array_append(v_unsafe_tables, v_table);
    END IF;
  END LOOP;

  FOR v_func_sig IN
    SELECT * FROM unnest(ARRAY[
      'begin_gateway_idempotent_op_v1(text, text, integer)',
      'complete_gateway_idempotent_op_v1(uuid, text)',
      'fail_gateway_idempotent_op_v1(uuid)',
      '_gateway_touch_quota_bucket_v1(text, uuid, text, text, text, timestamp with time zone, timestamp with time zone)',
      '_gateway_touch_budget_bucket_v1(text, text, text, timestamp with time zone, timestamp with time zone)',
      'reserve_gateway_usage_v1(text, uuid, uuid, text, text, text, jsonb, jsonb, numeric, integer)',
      'commit_gateway_reservation_v1(uuid, uuid, numeric, jsonb)',
      'release_gateway_reservation_v1(uuid, text)',
      'mark_gateway_reservation_reconciliation_required_v1(uuid, text)',
      'expire_stale_gateway_reservations_v1(integer)',
      'get_gateway_breaker_state_v1(text, text, text)',
      'record_gateway_breaker_outcome_v1(text, text, text, boolean)',
      'check_and_increment_rate_limit(uuid, text, integer, integer)',
      'gateway_publish_runtime_controls_v1()',
      'gateway_publish_pricing_v1()',
      '_gateway_publish_runtime_controls_trigger_v1()',
      '_gateway_publish_pricing_trigger_v1()',
      'record_gateway_concurrency_validation_v1(text, text, text, text, text, text)',
      'record_realtime_hard_control_validation_v1(text, text, text, text, text, jsonb, text, text, jsonb)'
    ])
  LOOP
    IF has_function_privilege('anon', ('public.' || v_func_sig)::regprocedure, 'EXECUTE')
       OR has_function_privilege('authenticated', ('public.' || v_func_sig)::regprocedure, 'EXECUTE')
    THEN
      v_unsafe_funcs := array_append(v_unsafe_funcs, v_func_sig);
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_unsafe_tables, v_unsafe_funcs;
END;
$function$;


CREATE OR REPLACE FUNCTION public._gateway_publish_pricing_trigger_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.gateway_publish_pricing_v1();
  RETURN NULL;
END;
$function$;


CREATE OR REPLACE FUNCTION public._gateway_publish_runtime_controls_trigger_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.gateway_publish_runtime_controls_v1();
  PERFORM public.gateway_publish_budget_policies_v1();
  RETURN NULL;
END;
$function$;


CREATE OR REPLACE FUNCTION public._gateway_touch_budget_bucket_v1(p_scope_type text, p_scope_key text, p_period_type text, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS ai_gateway_budget_buckets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.ai_gateway_budget_buckets;
BEGIN
  SELECT * INTO v_row FROM public.ai_gateway_budget_buckets
    WHERE scope_type = p_scope_type AND scope_key = p_scope_key
      AND period_type = p_period_type AND period_start = p_period_start
    FOR UPDATE;

  IF FOUND THEN RETURN v_row; END IF;

  INSERT INTO public.ai_gateway_budget_buckets (scope_type, scope_key, period_type, period_start, period_end)
  VALUES (p_scope_type, p_scope_key, p_period_type, p_period_start, p_period_end)
  ON CONFLICT (scope_type, scope_key, period_type, period_start) DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN RETURN v_row; END IF;

  SELECT * INTO v_row FROM public.ai_gateway_budget_buckets
    WHERE scope_type = p_scope_type AND scope_key = p_scope_key
      AND period_type = p_period_type AND period_start = p_period_start
    FOR UPDATE;

  RETURN v_row;
END;
$function$;


CREATE OR REPLACE FUNCTION public._gateway_touch_quota_bucket_v1(p_subject_type text, p_subject_id uuid, p_feature_key text, p_metric_key text, p_period_type text, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS ai_gateway_quota_buckets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row      public.ai_gateway_quota_buckets;
  v_backfill NUMERIC;
BEGIN
  SELECT * INTO v_row FROM public.ai_gateway_quota_buckets
    WHERE subject_type = p_subject_type
      AND COALESCE(subject_id::TEXT, 'system') = COALESCE(p_subject_id::TEXT, 'system')
      AND feature_key = p_feature_key AND metric_key = p_metric_key
      AND period_type = p_period_type AND period_start = p_period_start
    FOR UPDATE;

  IF FOUND THEN RETURN v_row; END IF;

  SELECT COALESCE(SUM(m.quantity), 0) INTO v_backfill
    FROM public.ai_usage_event_metrics m
    JOIN public.ai_usage_events e ON e.id = m.usage_event_id
    WHERE e.feature_key = p_feature_key AND m.metric_key = p_metric_key
      AND e.status = 'succeeded'
      AND e.started_at >= p_period_start AND e.started_at < p_period_end
      AND (
        (p_subject_type = 'user' AND e.user_id = p_subject_id)
        OR (p_subject_type = 'system' AND e.user_id IS NULL)
      );

  INSERT INTO public.ai_gateway_quota_buckets (
    subject_type, subject_id, feature_key, metric_key, period_type, period_start, period_end,
    committed_quantity, reserved_quantity, backfilled
  ) VALUES (
    p_subject_type, p_subject_id, p_feature_key, p_metric_key, p_period_type, p_period_start, p_period_end,
    v_backfill, 0, TRUE
  )
  ON CONFLICT (subject_type, (COALESCE(subject_id::TEXT, 'system')), feature_key, metric_key, period_type, period_start)
  DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN RETURN v_row; END IF;

  SELECT * INTO v_row FROM public.ai_gateway_quota_buckets
    WHERE subject_type = p_subject_type
      AND COALESCE(subject_id::TEXT, 'system') = COALESCE(p_subject_id::TEXT, 'system')
      AND feature_key = p_feature_key AND metric_key = p_metric_key
      AND period_type = p_period_type AND period_start = p_period_start
    FOR UPDATE;

  RETURN v_row;
END;
$function$;


CREATE OR REPLACE FUNCTION public._hash_listening_episode_content_v1(p_episode_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_payload jsonb;
BEGIN
  SELECT jsonb_build_object(
    'episode', (SELECT jsonb_build_object('title', e.title, 'synopsis', e.synopsis, 'synopsis_pt', e.synopsis_pt, 'cefr_level', e.cefr_level)
                FROM listening_episodes e WHERE e.id = p_episode_id),
    'blocks', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('block_order', b.block_order, 'text_en', b.text_en, 'translation_pt', b.translation_pt) ORDER BY b.block_order)
      FROM listening_blocks b WHERE b.episode_id = p_episode_id
    ), '[]'::jsonb),
    'questions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('question_order', q.question_order, 'prompt', q.prompt, 'options_json', q.options_json, 'correct_option', q.correct_option, 'explanation_pt', q.explanation_pt) ORDER BY q.question_order)
      FROM listening_questions q WHERE q.episode_id = p_episode_id
    ), '[]'::jsonb)
  ) INTO v_payload;

  RETURN md5(v_payload::text);
END;
$function$;


CREATE OR REPLACE FUNCTION public._promote_due_config_versions(p_environment text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_due app_config_versions%ROWTYPE;
  v_current app_config_versions%ROWTYPE;
BEGIN
  SELECT * INTO v_due FROM app_config_versions
  WHERE environment = p_environment AND state = 'scheduled' AND effective_from <= now()
  ORDER BY effective_from ASC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT * INTO v_current FROM app_config_versions
  WHERE environment = p_environment AND state = 'published' FOR UPDATE;
  IF FOUND THEN
    UPDATE app_config_versions SET state = 'superseded', effective_to = v_due.effective_from WHERE id = v_current.id;
  END IF;

  UPDATE app_config_versions SET state = 'published' WHERE id = v_due.id;
END;
$function$;


CREATE OR REPLACE FUNCTION public._promote_due_pricing_versions(p_environment text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_due ai_pricing_versions%ROWTYPE;
  v_current ai_pricing_versions%ROWTYPE;
BEGIN
  SELECT * INTO v_due FROM ai_pricing_versions
  WHERE environment = p_environment AND state = 'scheduled' AND effective_from <= now()
  ORDER BY effective_from ASC LIMIT 1 FOR UPDATE;

  IF NOT FOUND THEN RETURN; END IF;

  SELECT * INTO v_current FROM ai_pricing_versions
  WHERE environment = p_environment AND state = 'published' FOR UPDATE;
  IF FOUND THEN
    UPDATE ai_pricing_versions SET state = 'superseded', effective_to = v_due.effective_from
    WHERE id = v_current.id;
  END IF;

  UPDATE ai_pricing_versions SET state = 'published' WHERE id = v_due.id;
END;
$function$;


CREATE OR REPLACE FUNCTION public.acquire_or_get_listening_shared_story(p_level_group text, p_target_level text, p_practice_date date, p_lock_duration_seconds integer)
 RETURNS TABLE(id uuid, status text, won boolean, content jsonb, part1_audio_path text, part2_audio_path text, audio_mime_type text, error_message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO listening_shared_stories (level_group, target_level, practice_date, status, lock_expires_at)
  VALUES (p_level_group, p_target_level, p_practice_date, 'generating', now() + make_interval(secs => p_lock_duration_seconds))
  ON CONFLICT (level_group, practice_date) DO UPDATE
    SET status = 'generating',
        target_level = EXCLUDED.target_level,
        lock_expires_at = now() + make_interval(secs => p_lock_duration_seconds),
        error_message = NULL
    WHERE listening_shared_stories.status = 'failed'
       OR (listening_shared_stories.status = 'generating' AND listening_shared_stories.lock_expires_at < now())
  RETURNING listening_shared_stories.id INTO v_id;

  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, 'generating'::TEXT, true, NULL::JSONB, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  RETURN QUERY
    SELECT s.id, s.status, false, s.content, s.part1_audio_path, s.part2_audio_path, s.audio_mime_type, s.error_message
    FROM listening_shared_stories s
    WHERE s.level_group = p_level_group AND s.practice_date = p_practice_date;
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_accept_invitation_v1(p_invitation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'auth', 'public'
AS $function$
DECLARE
  v_invite admin_invitations%ROWTYPE;
  v_caller_id UUID := auth.uid();
  v_real_email TEXT;
BEGIN
  IF v_caller_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'UNAUTHENTICATED');
  END IF;

  SELECT * INTO v_invite FROM admin_invitations WHERE id = p_invitation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'NOT_FOUND'); END IF;

  IF v_invite.status <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'NOT_PENDING', 'status', v_invite.status);
  END IF;
  IF v_invite.expires_at <= now() THEN
    UPDATE admin_invitations SET status = 'expired' WHERE id = p_invitation_id;
    RETURN jsonb_build_object('success', false, 'error', 'EXPIRED');
  END IF;

  SELECT lower(email) INTO v_real_email FROM auth.users WHERE id = v_caller_id;
  IF v_real_email IS NULL OR v_real_email <> v_invite.email_normalized THEN
    RETURN jsonb_build_object('success', false, 'error', 'EMAIL_MISMATCH');
  END IF;

  INSERT INTO public.admin_users (user_id, role, status, created_by, invitation_id)
  VALUES (v_caller_id, v_invite.role, 'active', v_invite.created_by, v_invite.id)
  ON CONFLICT (user_id) DO UPDATE SET
    role = v_invite.role, status = 'active', invitation_id = v_invite.id,
    status_changed_at = now(), status_change_reason = 'Convite aceito', revision = admin_users.revision + 1;

  UPDATE admin_invitations SET status = 'accepted', accepted_at = now(), accepted_user_id = v_caller_id
  WHERE id = p_invitation_id;

  RETURN jsonb_build_object('success', true, 'role', v_invite.role);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_acknowledge_alert_v1(p_alert_id uuid, p_reason text, p_actor_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active') THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  UPDATE ai_alerts SET
    status             = 'acknowledged',
    acknowledged_by    = p_actor_id,
    acknowledged_at    = now(),
    acknowledge_reason = p_reason,
    updated_at         = now()
  WHERE id = p_alert_id AND status = 'open';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Alert not found or not open: %', p_alert_id;
  END IF;
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_activate_global_runtime_enforcement_v1(p_control_id uuid, p_expected_mode text, p_reason text, p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_admin admin_users%ROWTYPE;
  v_row   ai_runtime_controls%ROWTYPE;
BEGIN
  SELECT * INTO v_admin FROM admin_users WHERE user_id = p_actor_id;
  IF NOT FOUND OR v_admin.status <> 'active' THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  -- Defense in depth: the TS layer already gates this behind
  -- requireAdminPermission('gateway.manage_runtime_controls'), but this
  -- function additionally checks role itself rather than trusting active
  -- status alone, given how consequential flipping the Gateway's global
  -- control is.
  IF v_admin.role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;

  SELECT * INTO v_row FROM ai_runtime_controls
  WHERE id = p_control_id AND scope_type = 'global'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTROL_NOT_FOUND';
  END IF;

  IF v_row.gateway_mode != p_expected_mode THEN
    RAISE EXCEPTION 'MODE_CONFLICT' USING ERRCODE = 'P0002';
  END IF;

  UPDATE ai_runtime_controls SET
    gateway_mode = 'enforce',
    reason       = p_reason,
    updated_by   = p_actor_id,
    updated_at   = now()
  WHERE id = p_control_id;

  RETURN jsonb_build_object(
    'id', p_control_id,
    'previous_mode', v_row.gateway_mode,
    'new_mode', 'enforce'
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_assign_plan_v1(p_user_id uuid, p_plan_id uuid, p_version_policy text, p_pinned_version_id uuid, p_origin text, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_reason text, p_actor_user_id uuid, p_idempotency_key text DEFAULT NULL::text, p_replace_active boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_overlap BOOLEAN;
  v_new_id UUID;
  v_snapshot_version_id UUID;
  v_starts_status TEXT;
  v_lock_key BIGINT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_users
    WHERE user_id = p_actor_user_id AND status = 'active' AND role IN ('owner', 'admin')
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_new_id FROM user_plan_assignments WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object('success', true, 'assignment_id', v_new_id, 'idempotent', true);
    END IF;
  END IF;

  v_lock_key := ('x' || left(replace(p_user_id::text, '-', ''), 16))::bit(64)::bigint;
  PERFORM pg_advisory_xact_lock(v_lock_key);

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_new_id FROM user_plan_assignments WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object('success', true, 'assignment_id', v_new_id, 'idempotent', true);
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM user_plan_assignments
    WHERE user_id = p_user_id
    AND status IN ('active', 'scheduled')
    AND starts_at < COALESCE(p_ends_at, 'infinity'::TIMESTAMPTZ)
    AND p_starts_at < COALESCE(ends_at, 'infinity'::TIMESTAMPTZ)
  ) INTO v_overlap;

  IF v_overlap THEN
    IF NOT p_replace_active THEN
      RETURN jsonb_build_object('success', false, 'error', 'overlap', 'message', 'Já existe atribuição ativa neste período. Use replace_active=true para substituir.');
    END IF;
    UPDATE user_plan_assignments
    SET status = 'replaced',
        cancelled_at = NOW(),
        cancelled_by = p_actor_user_id,
        cancel_reason = 'Substituído por nova atribuição',
        updated_at = NOW()
    WHERE user_id = p_user_id
    AND status IN ('active', 'scheduled')
    AND starts_at < COALESCE(p_ends_at, 'infinity'::TIMESTAMPTZ)
    AND p_starts_at < COALESCE(ends_at, 'infinity'::TIMESTAMPTZ);
  END IF;

  IF p_version_policy = 'pinned_version' THEN
    v_snapshot_version_id := p_pinned_version_id;
  ELSE
    SELECT id INTO v_snapshot_version_id
    FROM plan_versions
    WHERE plan_id = p_plan_id AND status = 'published' AND effective_to IS NULL
    LIMIT 1;
  END IF;

  IF p_starts_at > NOW() THEN
    v_starts_status := 'scheduled';
  ELSE
    v_starts_status := 'active';
  END IF;

  INSERT INTO user_plan_assignments (
    user_id, plan_id, version_policy, pinned_version_id, snapshot_version_id,
    origin, starts_at, ends_at, status, created_by, reason, idempotency_key
  ) VALUES (
    p_user_id, p_plan_id, p_version_policy, p_pinned_version_id, v_snapshot_version_id,
    p_origin, p_starts_at, p_ends_at, v_starts_status,
    p_actor_user_id, p_reason, p_idempotency_key
  )
  RETURNING id INTO v_new_id;

  RETURN jsonb_build_object('success', true, 'assignment_id', v_new_id);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', 'exception', 'message', SQLERRM);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_cancel_assignment_v1(p_assignment_id uuid, p_actor_user_id uuid, p_reason text, p_new_status text DEFAULT 'cancelled'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- SECURITY FIX (Etapa 13): the actor must be a real, active admin with
  -- plan-management rights — never trust the client-supplied id alone.
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_users
    WHERE user_id = p_actor_user_id AND status = 'active' AND role IN ('owner', 'admin')
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');
  END IF;

  UPDATE user_plan_assignments
  SET status = p_new_status,
      cancelled_at = NOW(),
      cancelled_by = p_actor_user_id,
      cancel_reason = p_reason,
      updated_at = NOW()
  WHERE id = p_assignment_id
  AND status IN ('active', 'scheduled');

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_found_or_already_cancelled');
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_cancel_listening_generation_request_v1(p_request_id uuid, p_reason text, p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_status text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active' AND role IN ('owner','admin')) THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN RAISE EXCEPTION 'A reason is required to cancel a request'; END IF;

  SELECT status INTO v_status FROM listening_generation_requests WHERE id = p_request_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'Request not found: %', p_request_id; END IF;
  IF v_status NOT IN ('pending', 'scheduled') THEN
    RAISE EXCEPTION 'Request is %, only pending/scheduled requests can be cancelled from the dashboard', v_status;
  END IF;

  UPDATE listening_generation_requests SET
    status = 'cancelled', cancelled_at = now(), cancelled_by = p_actor_id, cancel_reason = p_reason
  WHERE id = p_request_id;

  RETURN jsonb_build_object('request_id', p_request_id, 'status', 'cancelled');
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_change_role_v1(p_target_user_id uuid, p_new_role text, p_actor_id uuid, p_reason text, p_client_revision integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor_role TEXT;
  v_target admin_users%ROWTYPE;
BEGIN
  SELECT role INTO v_actor_role FROM admin_users WHERE user_id = p_actor_id AND status = 'active';
  IF v_actor_role IS NULL THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;

  IF p_target_user_id = p_actor_id THEN
    PERFORM admin_record_security_event_v1('production', 'self_elevation_attempt', 'critical', p_actor_id, p_actor_id,
      jsonb_build_object('attempted_role', p_new_role), NULL);
    RAISE EXCEPTION 'SELF_ELEVATION_BLOCKED: an administrator cannot change their own role';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM admin_role_permissions WHERE role = v_actor_role AND permission_key = 'admins.manage') THEN
    RAISE EXCEPTION 'UNAUTHORIZED: missing admins.manage';
  END IF;
  IF p_new_role = 'owner' AND NOT EXISTS (
    SELECT 1 FROM admin_role_permissions WHERE role = v_actor_role AND permission_key = 'admins.promote_owner'
  ) THEN
    RAISE EXCEPTION 'UNAUTHORIZED: only an owner may promote another owner';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'A reason is required to change an administrator role';
  END IF;

  SELECT * INTO v_target FROM admin_users WHERE user_id = p_target_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Administrator not found: %', p_target_user_id; END IF;
  IF v_target.revision <> p_client_revision THEN
    RAISE EXCEPTION 'REVISION_CONFLICT: Expected %, got %', p_client_revision, v_target.revision USING ERRCODE = 'P0002';
  END IF;

  BEGIN
    UPDATE admin_users SET role = p_new_role, revision = revision + 1 WHERE user_id = p_target_user_id;
  EXCEPTION WHEN SQLSTATE 'P0003' THEN
    PERFORM admin_record_security_event_v1('production', 'last_owner_protection_triggered', 'warning', p_actor_id, p_target_user_id,
      jsonb_build_object('attempted_role', p_new_role), NULL);
    RETURN jsonb_build_object('success', false, 'error', 'LAST_OWNER_PROTECTED');
  END;

  PERFORM admin_record_security_event_v1('production', 'role_changed', 'warning', p_actor_id, p_target_user_id,
    jsonb_build_object('previous_role', v_target.role, 'new_role', p_new_role), NULL);

  RETURN jsonb_build_object('success', true, 'new_revision', v_target.revision + 1);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_check_permission_v1(p_actor_id uuid, p_permission_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_admin admin_users%ROWTYPE;
  v_perm admin_permissions%ROWTYPE;
  v_granted boolean;
BEGIN
  SELECT * INTO v_admin FROM admin_users WHERE user_id = p_actor_id;
  IF NOT FOUND OR v_admin.status <> 'active' THEN
    RETURN jsonb_build_object('allowed', false, 'error', 'ADMIN_INACTIVE');
  END IF;

  SELECT * INTO v_perm FROM admin_permissions WHERE key = p_permission_key;
  IF NOT FOUND THEN
    -- Deny by default: an unknown permission key is never implicitly granted.
    RETURN jsonb_build_object('allowed', false, 'error', 'UNKNOWN_PERMISSION');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM admin_role_permissions
    WHERE role = v_admin.role AND permission_key = p_permission_key
  ) INTO v_granted;

  IF NOT v_granted THEN
    RETURN jsonb_build_object('allowed', false, 'error', 'PERMISSION_DENIED', 'role', v_admin.role);
  END IF;

  UPDATE admin_users SET last_admin_access_at = now() WHERE user_id = p_actor_id;

  RETURN jsonb_build_object(
    'allowed', true,
    'role', v_admin.role,
    'requires_aal2', v_perm.requires_aal2,
    'requires_recent_auth', v_perm.requires_recent_auth
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_check_rate_limit_v1(p_actor_id uuid, p_action_key text, p_max_attempts integer, p_window_seconds integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_count INTEGER;
BEGIN
  v_window_start := to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds);

  INSERT INTO admin_rate_limit_buckets (actor_id, action_key, window_start, attempt_count)
  VALUES (p_actor_id, p_action_key, v_window_start, 1)
  ON CONFLICT (actor_id, action_key, window_start)
  DO UPDATE SET attempt_count = admin_rate_limit_buckets.attempt_count + 1, updated_at = now()
  RETURNING attempt_count INTO v_count;

  RETURN jsonb_build_object(
    'allowed', v_count <= p_max_attempts,
    'attempt_count', v_count,
    'max_attempts', p_max_attempts,
    'retry_after_seconds', GREATEST(0, EXTRACT(EPOCH FROM (v_window_start + make_interval(secs => p_window_seconds) - now()))::INTEGER)
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_create_config_draft_v1(p_environment text, p_actor_id uuid, p_based_on_version_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_next_version integer;
  v_new_id       uuid;
  v_existing_id  uuid;
  v_existing_num integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active'
                 AND role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id, version_number INTO v_existing_id, v_existing_num
    FROM app_config_versions
    WHERE environment = p_environment AND create_idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object('version_id', v_existing_id, 'version_number', v_existing_num, 'idempotent', true);
    END IF;
  END IF;

  SELECT COALESCE(MAX(version_number), 0) + 1 INTO v_next_version
  FROM app_config_versions WHERE environment = p_environment;

  INSERT INTO app_config_versions (environment, version_number, state, previous_version_id, created_by, create_idempotency_key)
  VALUES (p_environment, v_next_version, 'draft', p_based_on_version_id, p_actor_id, p_idempotency_key)
  RETURNING id INTO v_new_id;

  IF p_based_on_version_id IS NOT NULL THEN
    INSERT INTO app_config_values (version_id, definition_key, value, updated_by)
    SELECT v_new_id, definition_key, value, p_actor_id
    FROM app_config_values WHERE version_id = p_based_on_version_id;

    INSERT INTO app_config_values (version_id, definition_key, value, updated_by)
    SELECT v_new_id, d.key, d.default_value, p_actor_id
    FROM app_config_definitions d
    WHERE d.active = true AND p_environment = ANY(d.applicable_environments)
      AND NOT EXISTS (SELECT 1 FROM app_config_values WHERE version_id = v_new_id AND definition_key = d.key);
  ELSE
    INSERT INTO app_config_values (version_id, definition_key, value, updated_by)
    SELECT v_new_id, d.key, d.default_value, p_actor_id
    FROM app_config_definitions d
    WHERE d.active = true AND p_environment = ANY(d.applicable_environments);
  END IF;

  RETURN jsonb_build_object('version_id', v_new_id, 'version_number', v_next_version);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_create_control_switch_v1(p_environment text, p_scope text, p_provider text, p_model text, p_feature_key text, p_enabled boolean, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_reason text, p_actor_id uuid, p_client_revision integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_switch_id uuid;
  v_result    jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active'
                 AND get_admin_role() IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  INSERT INTO ai_control_switches (
    environment, scope, provider, model, feature_key, enabled,
    starts_at, ends_at, reason, created_by, revision
  ) VALUES (
    p_environment, p_scope, p_provider, p_model, p_feature_key, p_enabled,
    p_starts_at, p_ends_at, p_reason, p_actor_id, 1
  ) RETURNING id INTO v_switch_id;

  v_result := admin_publish_gateway_config_v1(
    p_environment, p_reason, 'switch_update', p_actor_id, p_client_revision, false, NULL
  );

  UPDATE ai_control_switches SET config_version = (v_result->>'version_number')::integer
  WHERE id = v_switch_id;

  RETURN jsonb_build_object('switch_id', v_switch_id) || v_result;
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_create_invitation_v1(p_email_normalized text, p_role text, p_actor_id uuid, p_reason text, p_expires_hours integer, p_token_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor_role TEXT;
  v_invitation_id UUID;
  v_snapshot jsonb;
BEGIN
  SELECT role INTO v_actor_role FROM admin_users WHERE user_id = p_actor_id AND status = 'active';
  IF v_actor_role IS NULL THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM admin_role_permissions WHERE role = v_actor_role AND permission_key = 'admins.invite') THEN
    RAISE EXCEPTION 'UNAUTHORIZED: missing admins.invite';
  END IF;
  IF p_role = 'owner' AND NOT EXISTS (
    SELECT 1 FROM admin_role_permissions WHERE role = v_actor_role AND permission_key = 'admins.promote_owner'
  ) THEN
    RAISE EXCEPTION 'UNAUTHORIZED: only an owner may invite another owner';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'A reason is required to invite an administrator';
  END IF;

  IF EXISTS (SELECT 1 FROM admin_users au JOIN auth.users u ON u.id = au.user_id WHERE lower(u.email) = p_email_normalized AND au.status = 'active') THEN
    RAISE EXCEPTION 'ALREADY_ACTIVE_ADMIN';
  END IF;
  IF EXISTS (SELECT 1 FROM admin_invitations WHERE email_normalized = p_email_normalized AND status = 'pending' AND expires_at > now()) THEN
    RAISE EXCEPTION 'INVITATION_ALREADY_PENDING';
  END IF;

  SELECT COALESCE(jsonb_agg(permission_key), '[]'::jsonb) INTO v_snapshot
  FROM admin_role_permissions WHERE role = p_role;

  INSERT INTO admin_invitations (
    email_normalized, role, permissions_snapshot, created_by, reason, expires_at, invitation_token_hash
  ) VALUES (
    p_email_normalized, p_role, v_snapshot, p_actor_id, p_reason, now() + make_interval(hours => p_expires_hours), p_token_hash
  ) RETURNING id INTO v_invitation_id;

  RETURN jsonb_build_object('invitation_id', v_invitation_id);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_create_listening_generation_request_v1(p_job_type text, p_episode_id uuid, p_block_id uuid, p_cefr_level text, p_topic text, p_priority integer, p_scheduled_for timestamp with time zone, p_actor_id uuid, p_reason text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_request_id uuid;
  v_existing_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active' AND role IN ('owner','admin')) THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing_id FROM listening_generation_requests WHERE idempotency_key = p_idempotency_key
      AND status IN ('pending','scheduled','processing');
    IF FOUND THEN RETURN jsonb_build_object('request_id', v_existing_id, 'idempotent', true); END IF;
  END IF;

  INSERT INTO listening_generation_requests (
    job_type, episode_id, block_id, cefr_level, topic, priority, scheduled_for,
    requested_by, reason, idempotency_key
  ) VALUES (
    p_job_type, p_episode_id, p_block_id, p_cefr_level, p_topic, COALESCE(p_priority, 100), p_scheduled_for,
    p_actor_id, p_reason, p_idempotency_key
  ) RETURNING id INTO v_request_id;

  RETURN jsonb_build_object('request_id', v_request_id);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'DUPLICATE_ACTIVE_REQUEST: an equivalent request is already pending/scheduled/processing';
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_create_pricing_draft_v1(p_environment text, p_name text, p_description text, p_currencies text[], p_effective_from timestamp with time zone, p_effective_to timestamp with time zone, p_actor_id uuid, p_based_on_version_id uuid DEFAULT NULL::uuid, p_origin_note text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_next_version integer;
  v_new_id       uuid;
  v_existing_id  uuid;
  v_existing_num integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active'
                 AND role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id, version_number INTO v_existing_id, v_existing_num
    FROM ai_pricing_versions
    WHERE environment = p_environment AND create_idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object('version_id', v_existing_id, 'version_number', v_existing_num, 'idempotent', true);
    END IF;
  END IF;

  SELECT COALESCE(MAX(version_number), 0) + 1 INTO v_next_version
  FROM ai_pricing_versions WHERE environment = p_environment;

  INSERT INTO ai_pricing_versions (
    environment, version_number, name, description, state, currencies,
    effective_from, effective_to, previous_version_id, created_by, origin_note,
    create_idempotency_key
  ) VALUES (
    p_environment, v_next_version, p_name, p_description, 'draft', COALESCE(p_currencies, '{}'),
    p_effective_from, p_effective_to, p_based_on_version_id, p_actor_id, p_origin_note,
    p_idempotency_key
  ) RETURNING id INTO v_new_id;

  IF p_based_on_version_id IS NOT NULL THEN
    INSERT INTO ai_pricing_rates (
      version_id, provider, model, operation, metric_key, feature_key, region,
      unit_type, unit_size, unit_price, currency, priority, source, source_url,
      verified_at, verified_by, notes, created_by
    )
    SELECT
      v_new_id, provider, model, operation, metric_key, feature_key, region,
      unit_type, unit_size, unit_price, currency, priority, source, source_url,
      verified_at, verified_by, notes, p_actor_id
    FROM ai_pricing_rates
    WHERE version_id = p_based_on_version_id;
  END IF;

  RETURN jsonb_build_object('version_id', v_new_id, 'version_number', v_next_version);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_delete_pricing_rate_v1(p_rate_id uuid, p_actor_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active'
                 AND role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  DELETE FROM ai_pricing_rates WHERE id = p_rate_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Rate not found: %', p_rate_id; END IF;
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_discard_config_draft_v1(p_version_id uuid, p_reason text, p_actor_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_state text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active'
                 AND role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;
  SELECT state INTO v_state FROM app_config_versions WHERE id = p_version_id;
  IF v_state IS NULL THEN RAISE EXCEPTION 'Config version not found: %', p_version_id; END IF;
  IF v_state NOT IN ('draft', 'scheduled') THEN
    RAISE EXCEPTION 'Only draft or scheduled versions can be discarded (current state: %)', v_state;
  END IF;
  UPDATE app_config_versions SET state = 'discarded', discarded_at = now(), discarded_by = p_actor_id, reason = p_reason
  WHERE id = p_version_id;
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_discard_pricing_draft_v1(p_version_id uuid, p_reason text, p_actor_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_state text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active'
                 AND role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  SELECT state INTO v_state FROM ai_pricing_versions WHERE id = p_version_id;
  IF v_state IS NULL THEN RAISE EXCEPTION 'Pricing version not found: %', p_version_id; END IF;
  IF v_state NOT IN ('draft', 'scheduled') THEN
    RAISE EXCEPTION 'Only draft or scheduled versions can be discarded (current state: %)', v_state;
  END IF;

  UPDATE ai_pricing_versions SET
    state = 'discarded', discarded_at = now(), discarded_by = p_actor_id, reason = p_reason
  WHERE id = p_version_id;
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_emergency_stop_v1(p_environment text, p_stop boolean, p_reason text, p_actor_id uuid, p_client_revision integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cfg     ai_gateway_configs%ROWTYPE;
  v_change  text;
  v_global  ai_runtime_controls%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active') THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  SELECT * INTO v_cfg FROM ai_gateway_configs WHERE environment = p_environment FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Environment not found: %', p_environment; END IF;
  IF v_cfg.revision != p_client_revision THEN
    RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE = 'P0002';
  END IF;

  v_change := CASE WHEN p_stop THEN 'emergency_stop' ELSE 'emergency_restore' END;

  UPDATE ai_gateway_configs SET
    emergency_stop        = p_stop,
    emergency_stop_at     = CASE WHEN p_stop THEN now() ELSE emergency_stop_at END,
    emergency_stop_by     = CASE WHEN p_stop THEN p_actor_id ELSE emergency_stop_by END,
    emergency_stop_reason = CASE WHEN p_stop THEN p_reason ELSE emergency_stop_reason END,
    updated_by            = p_actor_id,
    updated_at            = now()
  WHERE environment = p_environment;

  -- The REAL kill switch. No environment filter — see header comment.
  SELECT * INTO v_global FROM ai_runtime_controls
  WHERE scope_type = 'global' AND scope_key = 'global'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RUNTIME_CONTROL_NOT_FOUND: ai_runtime_controls has no scope_type=global row — the kill switch cannot be enforced. Refusing to report success.';
  END IF;

  UPDATE ai_runtime_controls SET
    runtime_status = CASE WHEN p_stop THEN 'disabled' ELSE 'enabled' END,
    reason         = p_reason,
    updated_by     = p_actor_id,
    updated_at     = now()
  WHERE id = v_global.id;

  RETURN admin_publish_gateway_config_v1(
    p_environment, p_reason, v_change, p_actor_id, p_client_revision, p_stop, NULL
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_fetch_events_for_reprocessing_v1(p_environment text, p_provider text DEFAULT NULL::text, p_model text DEFAULT NULL::text, p_feature_key text DEFAULT NULL::text, p_started_after timestamp with time zone DEFAULT NULL::timestamp with time zone, p_started_before timestamp with time zone DEFAULT NULL::timestamp with time zone, p_only_unpriced boolean DEFAULT true, p_cursor_started_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_cursor_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 200)
 RETURNS TABLE(id uuid, provider text, model text, operation text, feature_key text, region text, started_at timestamp with time zone, environment text, tokens_input integer, tokens_output integer, tokens_cached integer, chars_tts_billed integer, audio_input_seconds numeric, audio_output_seconds numeric, realtime_seconds numeric, images_count integer, cost_total_usd numeric, currency text, cost_status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_limit INTEGER;
BEGIN
  v_limit := LEAST(GREATEST(p_limit, 1), 500);

  RETURN QUERY
  WITH events AS (
    SELECT e.*
    FROM public.ai_usage_events e
    LEFT JOIN LATERAL (
      SELECT v.status FROM public.ai_cost_valuations v
      WHERE v.event_id = e.id ORDER BY v.created_at DESC LIMIT 1
    ) latest ON true
    WHERE (p_provider IS NULL OR e.provider = p_provider)
      AND (p_model IS NULL OR e.model = p_model)
      AND (p_feature_key IS NULL OR e.feature_key = p_feature_key)
      AND (p_started_after IS NULL OR e.started_at >= p_started_after)
      AND (p_started_before IS NULL OR e.started_at <= p_started_before)
      AND (
        p_cursor_started_at IS NULL
        OR e.started_at > p_cursor_started_at
        OR (e.started_at = p_cursor_started_at AND e.id > p_cursor_id)
      )
      AND (NOT p_only_unpriced OR latest.status IS DISTINCT FROM 'calculated')
  ),
  metrics AS (
    SELECT
      m.usage_event_id,
      SUM(m.quantity) FILTER (WHERE m.metric_key IN ('input_text_tokens', 'input_audio_tokens')) AS tokens_input,
      SUM(m.quantity) FILTER (WHERE m.metric_key IN ('output_text_tokens', 'output_audio_tokens')) AS tokens_output,
      SUM(m.quantity) FILTER (WHERE m.metric_key IN ('cached_input_tokens', 'cached_input_audio_tokens')) AS tokens_cached,
      SUM(m.quantity) FILTER (WHERE m.metric_key = 'tts_characters') AS chars_tts_billed,
      SUM(m.quantity) FILTER (WHERE m.metric_key = 'session_seconds') AS realtime_seconds
    FROM public.ai_usage_event_metrics m
    JOIN events e ON e.id = m.usage_event_id
    GROUP BY m.usage_event_id
  )
  SELECT
    e.id,
    e.provider,
    e.model,
    e.operation_part AS operation,
    e.feature_key,
    NULL::text AS region,
    e.started_at,
    p_environment AS environment,
    COALESCE(mt.tokens_input, 0)::integer AS tokens_input,
    COALESCE(mt.tokens_output, 0)::integer AS tokens_output,
    COALESCE(mt.tokens_cached, 0)::integer AS tokens_cached,
    COALESCE(mt.chars_tts_billed, 0)::integer AS chars_tts_billed,
    0::numeric AS audio_input_seconds,
    0::numeric AS audio_output_seconds,
    COALESCE(mt.realtime_seconds, 0) AS realtime_seconds,
    0::integer AS images_count,
    COALESCE(e.reconciled_cost_usd, e.calculated_cost_usd) AS cost_total_usd,
    CASE WHEN COALESCE(e.reconciled_cost_usd, e.calculated_cost_usd) IS NOT NULL THEN 'USD' ELSE NULL END AS currency,
    e.cost_status
  FROM events e
  LEFT JOIN metrics mt ON mt.usage_event_id = e.id
  ORDER BY e.started_at ASC, e.id ASC
  LIMIT v_limit;
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_flag_listening_audio_v1(p_block_id uuid, p_reason text, p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active' AND role IN ('owner','admin')) THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM listening_blocks WHERE id = p_block_id) THEN
    RAISE EXCEPTION 'Block not found: %', p_block_id;
  END IF;

  INSERT INTO listening_audio_flags (block_id, flagged_for_review, flagged_reason, flagged_by, flagged_at)
  VALUES (p_block_id, true, p_reason, p_actor_id, now())
  ON CONFLICT (block_id) DO UPDATE SET
    flagged_for_review = true, flagged_reason = p_reason, flagged_by = p_actor_id, flagged_at = now();

  RETURN jsonb_build_object('block_id', p_block_id, 'flagged', true);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_ack_status_v1(p_environment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cfg           ai_gateway_configs%ROWTYPE;
  v_current_ver   integer;
  v_current_hash  text;
BEGIN
  SELECT * INTO v_cfg FROM ai_gateway_configs WHERE environment = p_environment;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT version_number, config_hash INTO v_current_ver, v_current_hash
  FROM ai_gateway_config_versions WHERE id = v_cfg.current_version_id;

  RETURN jsonb_build_object(
    'environment',      p_environment,
    'current_version',  v_current_ver,
    'current_hash',     v_current_hash,
    'published_at',     (SELECT published_at FROM ai_gateway_config_versions WHERE id = v_cfg.current_version_id),
    'instances', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'instance_id',       a.instance_id,
        'version_received',  a.version_received,
        'hash_received',     a.hash_received,
        'version_applied',   a.version_applied,
        'hash_applied',      a.hash_applied,
        'gateway_version',   a.gateway_version,
        'result',            a.result,
        'acked_at',          a.acked_at,
        'is_current',        a.version_applied = v_current_ver AND a.hash_applied = v_current_hash,
        'has_drift',         a.hash_applied IS DISTINCT FROM v_current_hash AND a.hash_applied IS NOT NULL
      ))
      FROM (
        SELECT DISTINCT ON (instance_id) *
        FROM ai_gateway_config_acknowledgements
        WHERE environment = p_environment
        ORDER BY instance_id, acked_at DESC
      ) a
    ), '[]'::jsonb),
    'latest_heartbeat', (
      SELECT row_to_json(h) FROM gateway_heartbeats h
      WHERE environment = p_environment ORDER BY received_at DESC LIMIT 1
    )
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_active_users_product_last_30d()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_30d   TIMESTAMPTZ := NOW() - INTERVAL '30 days';
  v_count BIGINT;
BEGIN
  SELECT COUNT(DISTINCT user_id) INTO v_count
  FROM (
    SELECT user_id FROM public.writing_entries WHERE created_at >= v_30d
    UNION
    SELECT user_id FROM public.english_reviews WHERE created_at >= v_30d
    UNION
    SELECT user_id FROM public.conversation_sessions WHERE created_at >= v_30d
    UNION
    SELECT user_id FROM public.pronunciation_assessments
      WHERE completed_at >= v_30d AND status = 'completed'
    UNION
    SELECT user_id FROM public.user_listening_results WHERE created_at >= v_30d
  ) t;
  RETURN v_count;
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_active_users_product_timeseries_v1(p_after timestamp with time zone, p_before timestamp with time zone, p_granularity text DEFAULT 'day'::text)
 RETURNS TABLE(bucket timestamp with time zone, active_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_granularity NOT IN ('hour', 'day', 'week') THEN
    RAISE EXCEPTION 'Invalid granularity: %', p_granularity;
  END IF;

  RETURN QUERY
  SELECT date_trunc(p_granularity, ts) AS bucket, COUNT(DISTINCT uid) AS active_count
  FROM (
    SELECT user_id AS uid, created_at AS ts FROM public.writing_entries
      WHERE created_at >= p_after AND created_at < p_before
    UNION ALL
    SELECT user_id, created_at FROM public.english_reviews
      WHERE created_at >= p_after AND created_at < p_before
    UNION ALL
    SELECT user_id, created_at FROM public.conversation_sessions
      WHERE created_at >= p_after AND created_at < p_before
    UNION ALL
    SELECT user_id, completed_at FROM public.pronunciation_assessments
      WHERE status = 'completed' AND completed_at >= p_after AND completed_at < p_before
    UNION ALL
    SELECT user_id, created_at FROM public.user_listening_results
      WHERE created_at >= p_after AND created_at < p_before
  ) t
  GROUP BY bucket
  ORDER BY bucket ASC;
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_active_users_product_v1(p_after timestamp with time zone, p_before timestamp with time zone)
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COUNT(DISTINCT uid) FROM (
    SELECT user_id AS uid FROM public.writing_entries WHERE created_at >= p_after AND created_at < p_before
    UNION
    SELECT user_id FROM public.english_reviews WHERE created_at >= p_after AND created_at < p_before
    UNION
    SELECT user_id FROM public.conversation_sessions WHERE created_at >= p_after AND created_at < p_before
    UNION
    SELECT user_id FROM public.pronunciation_assessments
      WHERE status = 'completed' AND completed_at >= p_after AND completed_at < p_before
    UNION
    SELECT user_id FROM public.user_listening_results WHERE created_at >= p_after AND created_at < p_before
  ) t;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_ai_ranking_v1(p_environment text, p_started_after timestamp with time zone, p_started_before timestamp with time zone, p_dimension text, p_metric text, p_limit integer DEFAULT 10)
 RETURNS TABLE(dimension_value text, metric_value numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_limit integer;
BEGIN
  IF p_dimension NOT IN ('user_id', 'feature_key') THEN
    RAISE EXCEPTION 'Invalid dimension: %', p_dimension;
  END IF;
  IF p_metric NOT IN ('logical_calls', 'realtime_seconds') THEN
    RAISE EXCEPTION 'Invalid metric: %', p_metric;
  END IF;
  v_limit := LEAST(GREATEST(p_limit, 1), 50);

  IF p_dimension = 'user_id' THEN
    IF p_metric = 'logical_calls' THEN
      RETURN QUERY
      SELECT
        CASE WHEN user_id IS NOT NULL THEN user_id::text WHEN actor_type = 'system' THEN '(sistema)' ELSE '(não identificado)' END,
        COUNT(DISTINCT COALESCE(correlation_id, id))::numeric
      FROM public.ai_usage_events
      WHERE started_at >= p_started_after AND started_at < p_started_before
      GROUP BY 1 ORDER BY 2 DESC LIMIT v_limit;
    ELSE
      RETURN QUERY
      SELECT
        CASE WHEN e.user_id IS NOT NULL THEN e.user_id::text WHEN e.actor_type = 'system' THEN '(sistema)' ELSE '(não identificado)' END,
        COALESCE(SUM(m.quantity), 0)
      FROM public.ai_usage_events e
      LEFT JOIN public.ai_usage_event_metrics m ON m.usage_event_id = e.id AND m.metric_key = 'session_seconds'
      WHERE e.started_at >= p_started_after AND e.started_at < p_started_before
      GROUP BY 1 ORDER BY 2 DESC LIMIT v_limit;
    END IF;
  ELSE
    IF p_metric = 'logical_calls' THEN
      RETURN QUERY
      SELECT feature_key, COUNT(DISTINCT COALESCE(correlation_id, id))::numeric
      FROM public.ai_usage_events
      WHERE started_at >= p_started_after AND started_at < p_started_before
      GROUP BY feature_key ORDER BY 2 DESC LIMIT v_limit;
    ELSE
      RETURN QUERY
      SELECT e.feature_key, COALESCE(SUM(m.quantity), 0)
      FROM public.ai_usage_events e
      LEFT JOIN public.ai_usage_event_metrics m ON m.usage_event_id = e.id AND m.metric_key = 'session_seconds'
      WHERE e.started_at >= p_started_after AND e.started_at < p_started_before
      GROUP BY e.feature_key ORDER BY 2 DESC LIMIT v_limit;
    END IF;
  END IF;
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_alert_rules_v1(p_environment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(r) ORDER BY r.created_at)
    FROM ai_alert_rules r WHERE r.environment = p_environment
  ), '[]'::jsonb);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_alerts_v1(p_environment text, p_status text DEFAULT NULL::text, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(a) ORDER BY a.created_at DESC)
    FROM (
      SELECT * FROM ai_alerts
      WHERE environment = p_environment
        AND (p_status IS NULL OR status = p_status)
      ORDER BY created_at DESC
      LIMIT p_limit
    ) a
  ), '[]'::jsonb);
END;
$function$;



CREATE OR REPLACE FUNCTION public.admin_get_budget_status_v1(p_environment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'budget',          row_to_json(b),
      'known_cost_usd',  CASE WHEN b.metric = 'cost' THEN
                           COALESCE((
                             SELECT SUM(COALESCE(latest.cost_total, CASE WHEN latest.event_id IS NULL AND e.cost_status IN ('calculated', 'reconciled') THEN COALESCE(e.reconciled_cost_usd, e.calculated_cost_usd) ELSE NULL END))
                             FROM ai_usage_events e
                             LEFT JOIN LATERAL (
                               SELECT v.event_id, v.status, v.currency, v.cost_total FROM ai_cost_valuations v
                               WHERE v.event_id = e.id AND v.status = 'calculated' ORDER BY v.created_at DESC LIMIT 1
                             ) latest ON true
                             WHERE (latest.status = 'calculated' OR (latest.event_id IS NULL AND e.cost_status IN ('calculated', 'reconciled')))
                               AND COALESCE(latest.currency, 'USD') = b.currency
                               AND e.started_at >= CASE b.period
                                 WHEN 'daily'   THEN date_trunc('day',  now() AT TIME ZONE b.timezone) AT TIME ZONE b.timezone
                                 WHEN 'monthly' THEN date_trunc('month', now() AT TIME ZONE b.timezone) AT TIME ZONE b.timezone
                               END
                               AND (b.scope = 'global'
                                 OR (b.scope = 'provider'     AND e.provider     = b.scope_value)
                                 OR (b.scope = 'model'        AND e.model        = b.scope_value)
                                 OR (b.scope = 'feature'      AND e.feature_key  = b.scope_value)
                                 OR (b.scope = 'user'         AND e.user_id::text = b.scope_value)
                               )
                           ), 0)
                         ELSE NULL END,
      'known_count',    CASE WHEN b.metric = 'calls' THEN
                           COALESCE((
                             SELECT COUNT(*)
                             FROM ai_usage_events e
                             WHERE e.started_at >= CASE b.period
                                 WHEN 'daily'   THEN date_trunc('day',  now() AT TIME ZONE b.timezone) AT TIME ZONE b.timezone
                                 WHEN 'monthly' THEN date_trunc('month', now() AT TIME ZONE b.timezone) AT TIME ZONE b.timezone
                               END
                               AND (b.scope = 'global'
                                 OR (b.scope = 'provider'     AND e.provider     = b.scope_value)
                                 OR (b.scope = 'model'        AND e.model        = b.scope_value)
                                 OR (b.scope = 'feature'      AND e.feature_key  = b.scope_value)
                                 OR (b.scope = 'user'         AND e.user_id::text = b.scope_value)
                               )
                           ), 0)
                         ELSE NULL END,
      'unpriced_count', CASE WHEN b.metric = 'cost' THEN
                           COALESCE((
                             SELECT COUNT(*)
                             FROM ai_usage_events e
                             LEFT JOIN LATERAL (
                               SELECT v.status FROM ai_cost_valuations v
                               WHERE v.event_id = e.id ORDER BY v.created_at DESC LIMIT 1
                             ) latest ON true
                             WHERE NOT (latest.status = 'calculated' OR (latest.status IS NULL AND e.cost_status IN ('calculated', 'reconciled')))
                               AND e.started_at >= CASE b.period
                                 WHEN 'daily'   THEN date_trunc('day',  now() AT TIME ZONE b.timezone) AT TIME ZONE b.timezone
                                 WHEN 'monthly' THEN date_trunc('month', now() AT TIME ZONE b.timezone) AT TIME ZONE b.timezone
                               END
                           ), 0)
                         ELSE NULL END,
      'has_full_coverage', CASE WHEN b.metric = 'cost' THEN NOT EXISTS (
                             SELECT 1 FROM ai_usage_events e
                             LEFT JOIN LATERAL (
                               SELECT v.status FROM ai_cost_valuations v
                               WHERE v.event_id = e.id ORDER BY v.created_at DESC LIMIT 1
                             ) latest ON true
                             WHERE NOT (latest.status = 'calculated' OR (latest.status IS NULL AND e.cost_status IN ('calculated', 'reconciled')))
                               AND e.started_at >= CASE b.period
                                 WHEN 'daily'   THEN date_trunc('day',  now() AT TIME ZONE b.timezone) AT TIME ZONE b.timezone
                                 WHEN 'monthly' THEN date_trunc('month', now() AT TIME ZONE b.timezone) AT TIME ZONE b.timezone
                               END
                           ) ELSE NULL END
    ) ORDER BY b.priority, b.created_at)
    FROM ai_budget_policies b
    WHERE b.environment = p_environment AND b.active = true
  ), '[]'::jsonb);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_budgets_v1(p_environment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(b) ORDER BY b.priority, b.created_at)
    FROM ai_budget_policies b WHERE b.environment = p_environment
  ), '[]'::jsonb);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_config_ack_status_v1(p_environment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'application', a.application, 'instance_id', a.instance_id, 'version_received', a.version_received,
      'hash_received', a.hash_received, 'version_applied', a.version_applied, 'hash_applied', a.hash_applied,
      'app_version', a.app_version, 'result', a.result, 'acked_at', a.acked_at
    ))
    FROM (
      SELECT DISTINCT ON (application, instance_id) *
      FROM app_config_acknowledgements
      WHERE environment = p_environment
      ORDER BY application, instance_id, acked_at DESC
    ) a
  ), '[]'::jsonb);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_config_definitions_v1()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(row_to_json(d) ORDER BY d.category, d.key), '[]'::jsonb) FROM app_config_definitions d;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_config_version_detail_v1(p_version_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ver app_config_versions%ROWTYPE;
BEGIN
  SELECT * INTO v_ver FROM app_config_versions WHERE id = p_version_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(
    'version', row_to_json(v_ver),
    'values', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', val.id, 'definitionKey', val.definition_key, 'value', val.value, 'revision', val.revision,
        'updatedBy', val.updated_by, 'updatedAt', val.updated_at
      ) ORDER BY val.definition_key)
      FROM app_config_values val WHERE val.version_id = p_version_id
    ), '[]'::jsonb)
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_config_versions_v1(p_environment text, p_limit integer DEFAULT 20)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id',              id,
      'version_number',  version_number,
      'config_hash',     config_hash,
      'state',           state,
      'change_type',     change_type,
      'is_emergency',    is_emergency,
      'reason',          reason,
      'published_by',    published_by,
      'published_at',    published_at,
      'expires_at',      expires_at,
      'previous_version_id', previous_version_id
    ) ORDER BY version_number DESC)
    FROM (
      SELECT * FROM ai_gateway_config_versions
      WHERE environment = p_environment
      ORDER BY version_number DESC
      LIMIT p_limit
    ) v
  ), '[]'::jsonb);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_cost_breakdown_v1(p_dimension text, p_environment text DEFAULT 'production'::text, p_started_after timestamp with time zone DEFAULT (now() - '30 days'::interval), p_started_before timestamp with time zone DEFAULT now())
 RETURNS TABLE(dimension_value text, currency text, total_cost numeric, priced_events bigint, unpriced_events bigint, cost_origin text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_dimension NOT IN ('user_id', 'feature_key', 'provider', 'model') THEN
    RAISE EXCEPTION 'Invalid dimension: %', p_dimension;
  END IF;

  RETURN QUERY
  SELECT
    CASE p_dimension
      WHEN 'user_id' THEN CASE
        WHEN e.user_id IS NOT NULL THEN e.user_id::text
        WHEN e.actor_type = 'system' THEN '(sistema)'
        ELSE '(não identificado)'
      END
      WHEN 'feature_key' THEN e.feature_key
      WHEN 'provider' THEN COALESCE(e.provider, '(desconhecido)')
      ELSE CASE
        WHEN e.model IS NOT NULL THEN e.model
        WHEN e.provider = 'azure' AND e.service = 'tts_rest' THEN 'Azure Speech TTS'
        WHEN e.provider = 'azure' AND e.service = 'speech_sts' THEN 'Azure Speech (autenticação/token)'
        WHEN e.provider = 'azure' THEN 'Azure Speech (' || COALESCE(e.service, 'serviço não identificado') || ')'
        ELSE '(desconhecido)'
      END
    END AS dimension_value,
    COALESCE(latest.currency, 'USD') AS currency,
    SUM(COALESCE(latest.cost_total, CASE WHEN latest.event_id IS NULL AND e.cost_status IN ('calculated', 'reconciled') THEN COALESCE(e.reconciled_cost_usd, e.calculated_cost_usd) ELSE NULL END)) AS total_cost,
    COUNT(*) FILTER (WHERE latest.status = 'calculated' OR (latest.event_id IS NULL AND e.cost_status IN ('calculated', 'reconciled'))) AS priced_events,
    COUNT(*) FILTER (WHERE NOT (latest.status = 'calculated' OR (latest.event_id IS NULL AND e.cost_status IN ('calculated', 'reconciled')))) AS unpriced_events,
    CASE WHEN bool_or(latest.status = 'calculated') THEN 'recalculated' ELSE 'gateway_reported' END AS cost_origin
  FROM public.ai_usage_events e
  LEFT JOIN LATERAL (
    SELECT v.event_id, v.status, v.currency, v.cost_total FROM public.ai_cost_valuations v
    WHERE v.event_id = e.id ORDER BY v.created_at DESC LIMIT 1
  ) latest ON true
  WHERE e.started_at BETWEEN p_started_after AND p_started_before
  GROUP BY dimension_value, COALESCE(latest.currency, 'USD')
  ORDER BY total_cost DESC NULLS LAST
  LIMIT 100;
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_cost_timeseries_v1(p_environment text, p_started_after timestamp with time zone, p_started_before timestamp with time zone, p_granularity text DEFAULT 'day'::text)
 RETURNS TABLE(bucket timestamp with time zone, currency text, total_cost numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_granularity NOT IN ('hour', 'day', 'week') THEN
    RAISE EXCEPTION 'Invalid granularity: %', p_granularity;
  END IF;

  RETURN QUERY
  SELECT
    date_trunc(p_granularity, e.started_at) AS bucket,
    COALESCE(latest.currency, 'USD') AS currency,
    SUM(COALESCE(latest.cost_total, CASE WHEN latest.event_id IS NULL AND e.cost_status IN ('calculated', 'reconciled') THEN COALESCE(e.reconciled_cost_usd, e.calculated_cost_usd) ELSE NULL END)) AS total_cost
  FROM public.ai_usage_events e
  LEFT JOIN LATERAL (
    SELECT v.event_id, v.status, v.currency, v.cost_total FROM public.ai_cost_valuations v
    WHERE v.event_id = e.id AND v.status = 'calculated' ORDER BY v.created_at DESC LIMIT 1
  ) latest ON true
  WHERE e.started_at >= p_started_after AND e.started_at < p_started_before
    AND (latest.status = 'calculated' OR (latest.event_id IS NULL AND e.cost_status IN ('calculated', 'reconciled')))
  GROUP BY bucket, COALESCE(latest.currency, 'USD')
  ORDER BY bucket ASC;
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_data_quality_v1(p_environment text, p_started_after timestamp with time zone, p_started_before timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN jsonb_build_object(
    'events_without_user', (
      SELECT COUNT(*) FROM public.ai_usage_events
      WHERE started_at >= p_started_after AND started_at < p_started_before
        AND user_id IS NULL
    ),
    -- FIX: split by actor_type — 'system' rows are the backend content
    -- pipeline (legitimate shared/system generation, never a real user
    -- action missing attribution); anything else with user_id NULL is a
    -- genuine attribution gap. See migration header for live evidence.
    'events_without_user_system', (
      SELECT COUNT(*) FROM public.ai_usage_events
      WHERE started_at >= p_started_after AND started_at < p_started_before
        AND user_id IS NULL AND actor_type = 'system'
    ),
    'events_without_user_unidentified', (
      SELECT COUNT(*) FROM public.ai_usage_events
      WHERE started_at >= p_started_after AND started_at < p_started_before
        AND user_id IS NULL AND actor_type != 'system'
    ),
    'distinct_feature_keys', COALESCE((
      SELECT jsonb_agg(DISTINCT feature_key) FROM public.ai_usage_events
      WHERE started_at >= p_started_after AND started_at < p_started_before
    ), '[]'::jsonb),
    'invalid_metric_events', (
      SELECT COUNT(DISTINCT v.event_id) FROM public.ai_cost_valuations v
      JOIN public.ai_usage_events e ON e.id = v.event_id
      WHERE e.started_at >= p_started_after AND e.started_at < p_started_before
        AND v.status = 'invalid_metric'
    ),
    'last_ledger_event_at', (
      SELECT MAX(started_at) FROM public.ai_usage_events
    )
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_effective_permissions_v1(p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_role TEXT;
BEGIN
  SELECT role INTO v_role FROM admin_users WHERE user_id = p_actor_id AND status = 'active';
  IF v_role IS NULL THEN RETURN jsonb_build_object('role', null, 'permissions', '[]'::jsonb); END IF;

  RETURN jsonb_build_object(
    'role', v_role,
    'permissions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'key', p.key, 'category', p.category, 'label', p.label,
        'requires_aal2', p.requires_aal2, 'requires_recent_auth', p.requires_recent_auth
      ) ORDER BY p.category, p.key)
      FROM admin_role_permissions rp
      JOIN admin_permissions p ON p.key = rp.permission_key
      WHERE rp.role = v_role
    ), '[]'::jsonb)
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_gateway_activity_timeseries_v1(p_environment text, p_started_after timestamp with time zone, p_started_before timestamp with time zone, p_granularity text DEFAULT 'day'::text)
 RETURNS TABLE(bucket timestamp with time zone, logical_calls bigint, total_attempts bigint, total_retries bigint, total_errors bigint, total_blocked bigint, unique_users bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_granularity NOT IN ('hour', 'day', 'week') THEN
    RAISE EXCEPTION 'Invalid granularity: %', p_granularity;
  END IF;

  RETURN QUERY
  SELECT
    date_trunc(p_granularity, started_at) AS bucket,
    COUNT(DISTINCT COALESCE(correlation_id, id)) AS logical_calls,
    COUNT(*) AS total_attempts,
    COUNT(*) FILTER (WHERE attempt_number > 1) AS total_retries,
    COUNT(*) FILTER (WHERE status = 'failed') AS total_errors,
    COUNT(*) FILTER (WHERE status = 'blocked') AS total_blocked,
    COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL) AS unique_users
  FROM public.ai_usage_events
  WHERE started_at >= p_started_after AND started_at < p_started_before
  GROUP BY bucket
  ORDER BY bucket ASC;
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_gateway_breakdown_v1(p_dimension text, p_environment text DEFAULT 'production'::text, p_started_after timestamp with time zone DEFAULT (now() - '7 days'::interval), p_started_before timestamp with time zone DEFAULT now())
 RETURNS TABLE(dimension_value text, total_attempts bigint, total_success bigint, total_errors bigint, total_blocked bigint, total_cost_usd numeric, unique_users bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_dimension NOT IN ('feature_key', 'provider', 'model', 'status') THEN
    RAISE EXCEPTION 'Invalid dimension: %', p_dimension;
  END IF;

  RETURN QUERY
  SELECT
    CASE p_dimension
      WHEN 'feature_key' THEN e.feature_key
      WHEN 'provider' THEN COALESCE(e.provider, 'unknown')
      WHEN 'model' THEN COALESCE(e.model, 'unknown')
      ELSE CASE e.status
        WHEN 'succeeded' THEN 'success'
        WHEN 'failed' THEN 'error'
        WHEN 'expired' THEN 'timeout'
        WHEN 'started' THEN 'pending'
        ELSE e.status
      END
    END AS dimension_value,
    COUNT(*) AS total_attempts,
    COUNT(*) FILTER (WHERE e.status = 'succeeded') AS total_success,
    COUNT(*) FILTER (WHERE e.status = 'failed') AS total_errors,
    COUNT(*) FILTER (WHERE e.status = 'blocked') AS total_blocked,
    SUM(COALESCE(e.reconciled_cost_usd, e.calculated_cost_usd)) FILTER (WHERE COALESCE(e.reconciled_cost_usd, e.calculated_cost_usd) IS NOT NULL) AS total_cost_usd,
    COUNT(DISTINCT e.user_id) FILTER (WHERE e.user_id IS NOT NULL) AS unique_users
  FROM public.ai_usage_events e
  WHERE e.started_at BETWEEN p_started_after AND p_started_before
  GROUP BY 1
  ORDER BY 2 DESC
  LIMIT CASE WHEN p_dimension = 'status' THEN 50 WHEN p_dimension = 'feature_key' THEN 50 ELSE 20 END;
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_gateway_controls_v1(p_environment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cfg     ai_gateway_configs%ROWTYPE;
  v_ver     ai_gateway_config_versions%ROWTYPE;
BEGIN
  SELECT * INTO v_cfg FROM ai_gateway_configs WHERE environment = p_environment;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO v_ver FROM ai_gateway_config_versions WHERE id = v_cfg.current_version_id;

  RETURN jsonb_build_object(
    'config', row_to_json(v_cfg),
    'current_version', CASE WHEN v_ver.id IS NOT NULL THEN row_to_json(v_ver) ELSE NULL END,
    'switches', COALESCE((
      SELECT jsonb_agg(row_to_json(s) ORDER BY s.created_at)
      FROM ai_control_switches s
      WHERE s.environment = p_environment AND s.revoked_at IS NULL
    ), '[]'::jsonb),
    'switch_history', COALESCE((
      SELECT jsonb_agg(row_to_json(s) ORDER BY s.revoked_at DESC)
      FROM ai_control_switches s
      WHERE s.environment = p_environment AND s.revoked_at IS NOT NULL
      LIMIT 50
    ), '[]'::jsonb)
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_gateway_summary_v1(p_environment text DEFAULT 'production'::text, p_started_after timestamp with time zone DEFAULT NULL::timestamp with time zone, p_started_before timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(total_logical_calls bigint, total_attempts bigint, total_retries bigint, total_success bigint, total_errors bigint, total_blocked bigint, total_timeouts bigint, total_cancelled bigint, unique_users bigint, total_tokens_input bigint, total_tokens_output bigint, total_tokens_cached bigint, total_chars_tts_billed bigint, total_audio_input_seconds numeric, total_audio_output_seconds numeric, total_realtime_seconds numeric, total_cost_usd numeric, events_with_cost bigint, events_without_cost bigint, p50_latency_ms numeric, p95_latency_ms numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  WITH events AS (
    SELECT e.*, COALESCE(e.correlation_id, e.id) AS logical_call_id
    FROM public.ai_usage_events e
    WHERE (p_started_after IS NULL OR e.started_at >= p_started_after)
      AND (p_started_before IS NULL OR e.started_at <= p_started_before)
  ),
  metrics AS (
    SELECT
      m.usage_event_id,
      SUM(m.quantity) FILTER (WHERE m.metric_key IN ('input_text_tokens', 'input_audio_tokens')) AS tokens_input,
      SUM(m.quantity) FILTER (WHERE m.metric_key IN ('output_text_tokens', 'output_audio_tokens')) AS tokens_output,
      SUM(m.quantity) FILTER (WHERE m.metric_key IN ('cached_input_tokens', 'cached_input_audio_tokens')) AS tokens_cached,
      SUM(m.quantity) FILTER (WHERE m.metric_key = 'tts_characters') AS chars_tts_billed,
      SUM(m.quantity) FILTER (WHERE m.metric_key = 'session_seconds') AS realtime_seconds
    FROM public.ai_usage_event_metrics m
    JOIN events e ON e.id = m.usage_event_id
    GROUP BY m.usage_event_id
  )
  SELECT
    COUNT(DISTINCT e.logical_call_id) AS total_logical_calls,
    COUNT(*) AS total_attempts,
    -- FIX: a retry is a repeated attempt of the SAME step (attempt_number
    -- > 1), not "any extra row sharing a correlation_id" — the latter also
    -- counts legitimate distinct sub-steps (e.g. connect + usage) as
    -- retries. See migration header for the live evidence.
    COUNT(*) FILTER (WHERE e.attempt_number > 1) AS total_retries,
    COUNT(*) FILTER (WHERE e.status = 'succeeded') AS total_success,
    COUNT(*) FILTER (WHERE e.status = 'failed') AS total_errors,
    COUNT(*) FILTER (WHERE e.status = 'blocked') AS total_blocked,
    COUNT(*) FILTER (WHERE e.status = 'expired') AS total_timeouts,
    COUNT(*) FILTER (WHERE e.status = 'cancelled') AS total_cancelled,
    COUNT(DISTINCT e.user_id) FILTER (WHERE e.user_id IS NOT NULL) AS unique_users,
    COALESCE(SUM(mt.tokens_input), 0)::bigint AS total_tokens_input,
    COALESCE(SUM(mt.tokens_output), 0)::bigint AS total_tokens_output,
    COALESCE(SUM(mt.tokens_cached), 0)::bigint AS total_tokens_cached,
    COALESCE(SUM(mt.chars_tts_billed), 0)::bigint AS total_chars_tts_billed,
    0::numeric AS total_audio_input_seconds,
    0::numeric AS total_audio_output_seconds,
    COALESCE(SUM(mt.realtime_seconds), 0) AS total_realtime_seconds,
    SUM(COALESCE(e.reconciled_cost_usd, e.calculated_cost_usd)) FILTER (WHERE COALESCE(e.reconciled_cost_usd, e.calculated_cost_usd) IS NOT NULL) AS total_cost_usd,
    COUNT(*) FILTER (WHERE COALESCE(e.reconciled_cost_usd, e.calculated_cost_usd) IS NOT NULL) AS events_with_cost,
    COUNT(*) FILTER (WHERE COALESCE(e.reconciled_cost_usd, e.calculated_cost_usd) IS NULL) AS events_without_cost,
    (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY e.latency_ms))::numeric AS p50_latency_ms,
    (PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY e.latency_ms))::numeric AS p95_latency_ms
  FROM events e
  LEFT JOIN metrics mt ON mt.usage_event_id = e.id;
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_gateway_timeseries_v1(p_environment text DEFAULT 'production'::text, p_started_after timestamp with time zone DEFAULT (now() - '7 days'::interval), p_started_before timestamp with time zone DEFAULT now(), p_granularity text DEFAULT 'hour'::text)
 RETURNS TABLE(bucket timestamp with time zone, total_attempts bigint, total_success bigint, total_errors bigint, total_blocked bigint, total_cost_usd numeric, avg_latency_ms numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_granularity NOT IN ('hour', 'day') THEN
    RAISE EXCEPTION 'Invalid granularity: %', p_granularity;
  END IF;
  IF p_started_before - p_started_after > INTERVAL '90 days' THEN
    RAISE EXCEPTION 'Range exceeds 90 days maximum';
  END IF;

  RETURN QUERY
  SELECT
    date_trunc(p_granularity, e.started_at) AS bucket,
    COUNT(*) AS total_attempts,
    COUNT(*) FILTER (WHERE e.status = 'succeeded') AS total_success,
    COUNT(*) FILTER (WHERE e.status = 'failed') AS total_errors,
    COUNT(*) FILTER (WHERE e.status = 'blocked') AS total_blocked,
    SUM(COALESCE(e.reconciled_cost_usd, e.calculated_cost_usd)) FILTER (WHERE COALESCE(e.reconciled_cost_usd, e.calculated_cost_usd) IS NOT NULL) AS total_cost_usd,
    AVG(e.latency_ms)::NUMERIC AS avg_latency_ms
  FROM public.ai_usage_events e
  WHERE e.started_at >= p_started_after AND e.started_at <= p_started_before
  GROUP BY bucket
  ORDER BY bucket ASC;
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_invitation_by_token_v1(p_token_hash text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'id', id, 'email_normalized', email_normalized, 'role', role,
    'status', status, 'expires_at', expires_at
  )
  FROM admin_invitations WHERE invitation_token_hash = p_token_hash;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_listening_agenda_v1()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'episode_id', d.episode_id, 'title', e.title, 'cefr_level', e.cefr_level,
      'state', d.state, 'available_from', d.available_from, 'available_to', d.available_to,
      'eligible_levels', d.eligible_levels, 'priority', d.priority,
      'assignments_count', (SELECT COUNT(*) FROM user_listening_assignments ua WHERE ua.episode_id = d.episode_id),
      'started_count', (SELECT COUNT(*) FROM user_listening_progress up WHERE up.episode_id = d.episode_id AND up.status <> 'not_started'),
      'completions_count', (SELECT COUNT(*) FROM user_listening_progress up WHERE up.episode_id = d.episode_id AND up.status = 'completed')
    ) ORDER BY d.priority ASC, d.available_from ASC NULLS LAST)
    FROM listening_episode_distribution d
    JOIN listening_episodes e ON e.id = d.episode_id
    WHERE d.state IN ('published', 'scheduled', 'paused')
  ), '[]'::jsonb);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_listening_block_audio_location_v1(p_block_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'id', b.id,
    'audio_path', b.audio_path,
    'status', b.status,
    'is_quarantined', EXISTS (SELECT 1 FROM listening_audio_flags f WHERE f.block_id = b.id AND f.quarantined_at IS NOT NULL AND f.restored_at IS NULL)
  )
  FROM listening_blocks b
  WHERE b.id = p_block_id;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_listening_completion_diagnostics_v1(p_episode_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'user_id', ua.user_id,
      'assigned_at', ua.assigned_at,
      'started', up.status IS NOT NULL AND up.status <> 'not_started',
      'block_1_completed_at', up.block_1_completed_at,
      'block_2_completed_at', up.block_2_completed_at,
      'completed', up.status = 'completed',
      'completed_at', up.completed_at,
      'calendar_status', ua.status,
      'calendar_matches_completion', (up.status = 'completed') = (ua.status = 'completed')
    ))
    FROM user_listening_assignments ua
    LEFT JOIN user_listening_progress up ON up.user_id = ua.user_id AND up.episode_id = ua.episode_id
    WHERE ua.episode_id = p_episode_id
  ), '[]'::jsonb);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_listening_cost_v1(p_episode_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_request_ids uuid[];
  v_assignments bigint;
  v_completions bigint;
BEGIN
  SELECT COALESCE(array_agg(DISTINCT gid), '{}') INTO v_request_ids
  FROM listening_generation_requests r, unnest(r.gateway_request_ids) gid
  WHERE r.episode_id = p_episode_id;

  SELECT COUNT(*) INTO v_assignments FROM user_listening_assignments WHERE episode_id = p_episode_id;
  SELECT COUNT(*) INTO v_completions FROM user_listening_progress WHERE episode_id = p_episode_id AND status = 'completed';

  RETURN jsonb_build_object(
    'events', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'feature_key', e.feature_key,
        'cost_total_usd', COALESCE(e.reconciled_cost_usd, e.calculated_cost_usd),
        'currency', CASE WHEN COALESCE(e.reconciled_cost_usd, e.calculated_cost_usd) IS NOT NULL THEN 'USD' ELSE NULL END,
        'cost_status', e.cost_status
      ))
      FROM ai_usage_events e WHERE COALESCE(e.correlation_id, e.id) = ANY(v_request_ids)
    ), '[]'::jsonb),
    'assignments_count', v_assignments,
    'completions_count', v_completions
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_listening_episode_detail_v1(p_episode_id uuid, p_include_answers boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_episode listening_episodes%ROWTYPE;
BEGIN
  SELECT * INTO v_episode FROM listening_episodes WHERE id = p_episode_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  RETURN jsonb_build_object(
    'episode', row_to_json(v_episode),
    'distribution', (SELECT row_to_json(d) FROM listening_episode_distribution d WHERE d.episode_id = p_episode_id),
    'blocks', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', b.id, 'block_order', b.block_order, 'text_en', b.text_en, 'translation_pt', b.translation_pt,
        'duration_ms', b.duration_ms, 'status', b.status,
        'questions', COALESCE((
          SELECT jsonb_agg(
            CASE WHEN p_include_answers
              THEN jsonb_build_object('id', q.id, 'prompt', q.prompt, 'options_json', q.options_json, 'correct_option', q.correct_option, 'explanation_pt', q.explanation_pt, 'validation_status', q.validation_status)
              ELSE jsonb_build_object('id', q.id, 'prompt', q.prompt, 'options_json', q.options_json, 'validation_status', q.validation_status)
            END
          ) FROM listening_questions q WHERE q.block_id = b.id
        ), '[]'::jsonb),
        -- CORRECTED (Etapa 13 corretiva): audio is a single value directly on
        -- the block (audio_path/duration_ms), not a child collection — there
        -- is no separate assets table. 'flag' is singular for the same
        -- reason (listening_audio_flags.block_id is UNIQUE).
        'audio_path', b.audio_path,
        'flag', (SELECT row_to_json(f) FROM listening_audio_flags f WHERE f.block_id = b.id),
        'subtitles', COALESCE((
          SELECT jsonb_agg(jsonb_build_object('language', c.language, 'cue_order', c.cue_order, 'text', c.text, 'status', c.status) ORDER BY c.language, c.cue_order)
          FROM listening_subtitle_cues c WHERE c.block_id = b.id
        ), '[]'::jsonb)
      ) ORDER BY b.block_order)
      FROM listening_blocks b WHERE b.episode_id = p_episode_id
    ), '[]'::jsonb),
    'publications', COALESCE((
      SELECT jsonb_agg(row_to_json(p) ORDER BY p.created_at DESC) FROM listening_episode_publications p WHERE p.episode_id = p_episode_id
    ), '[]'::jsonb),
    'generation_requests', COALESCE((
      SELECT jsonb_agg(row_to_json(r) ORDER BY r.created_at DESC) FROM listening_generation_requests r WHERE r.episode_id = p_episode_id
    ), '[]'::jsonb),
    'ingles_jobs', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', j.id, 'job_type', j.job_type, 'status', j.status, 'attempts', j.attempts, 'error_code', j.error_code, 'created_at', j.created_at) ORDER BY j.created_at DESC)
      FROM listening_jobs j WHERE j.episode_id = p_episode_id
    ), '[]'::jsonb),
    'assignments_count', (SELECT COUNT(*) FROM user_listening_assignments ua WHERE ua.episode_id = p_episode_id),
    'started_count', (SELECT COUNT(*) FROM user_listening_progress up WHERE up.episode_id = p_episode_id AND up.status <> 'not_started'),
    'completions_count', (SELECT COUNT(*) FROM user_listening_progress up WHERE up.episode_id = p_episode_id AND up.status = 'completed')
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_listening_overview_v1()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total_assignments bigint;
  v_total_completions bigint;
  v_distinct_episodes_assigned bigint;
BEGIN
  SELECT COUNT(*) INTO v_total_assignments FROM user_listening_assignments WHERE episode_id IS NOT NULL;
  SELECT COUNT(*) INTO v_total_completions FROM user_listening_progress WHERE status = 'completed';
  SELECT COUNT(DISTINCT episode_id) INTO v_distinct_episodes_assigned FROM user_listening_assignments WHERE episode_id IS NOT NULL;

  RETURN jsonb_build_object(
    'published_count',  (SELECT COUNT(*) FROM listening_episode_distribution WHERE state = 'published'),
    'scheduled_count',  (SELECT COUNT(*) FROM listening_episode_distribution WHERE state = 'scheduled'),
    'paused_count',     (SELECT COUNT(*) FROM listening_episode_distribution WHERE state = 'paused'),
    'withdrawn_count',  (SELECT COUNT(*) FROM listening_episode_distribution WHERE state = 'withdrawn'),
    'not_distributed_count', (SELECT COUNT(*) FROM listening_episodes e WHERE NOT EXISTS (SELECT 1 FROM listening_episode_distribution d WHERE d.episode_id = e.id)),
    'failed_content_count', (SELECT COUNT(*) FROM listening_episodes WHERE status = 'failed'),
    'by_level', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('cefr_level', lvl, 'count', cnt) ORDER BY lvl)
      FROM (SELECT cefr_level AS lvl, COUNT(*) AS cnt FROM listening_episodes GROUP BY cefr_level) t
    ), '[]'::jsonb),
    'total_assignments', v_total_assignments,
    'total_completions', v_total_completions,
    'completion_rate_pct', CASE WHEN v_total_assignments > 0 THEN ROUND((v_total_completions::numeric / v_total_assignments) * 100, 2) ELSE NULL END,
    'reuse_avg_assignments_per_episode', CASE WHEN v_distinct_episodes_assigned > 0 THEN ROUND(v_total_assignments::numeric / v_distinct_episodes_assigned, 2) ELSE NULL END,
    'pending_generation_requests', (SELECT COUNT(*) FROM listening_generation_requests WHERE status IN ('pending','scheduled')),
    'processing_generation_requests', (SELECT COUNT(*) FROM listening_generation_requests WHERE status = 'processing')
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_listening_quality_v1()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN jsonb_build_object(
    'incomplete_episodes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('episode_id', e.id, 'title', e.title, 'block_count', bc))
      FROM listening_episodes e
      JOIN (SELECT episode_id, COUNT(*) AS bc FROM listening_blocks GROUP BY episode_id) b ON b.episode_id = e.id
      WHERE b.bc <> 2
    ), '[]'::jsonb),
    'blocks_missing_questions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('block_id', b.id, 'episode_id', b.episode_id, 'block_order', b.block_order))
      FROM listening_blocks b
      WHERE NOT EXISTS (SELECT 1 FROM listening_questions q WHERE q.block_id = b.id)
    ), '[]'::jsonb),
    'invalid_questions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('question_id', q.id, 'block_id', q.block_id, 'reason', 'validation_status_invalid'))
      FROM listening_questions q WHERE q.validation_status = 'invalid'
    ), '[]'::jsonb),
    'stuck_ingles_jobs', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('job_id', j.id, 'job_type', j.job_type, 'episode_id', j.episode_id, 'locked_at', j.locked_at))
      FROM listening_jobs j WHERE j.status = 'processing' AND j.locked_at IS NOT NULL AND j.locked_at < now() - interval '30 minutes'
    ), '[]'::jsonb),
    'stuck_generation_requests', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('request_id', r.id, 'job_type', r.job_type, 'episode_id', r.episode_id, 'started_at', r.started_at))
      FROM listening_generation_requests r WHERE r.status = 'processing' AND r.started_at IS NOT NULL AND r.started_at < now() - interval '30 minutes'
    ), '[]'::jsonb),
    -- completion vs "calendar" (user_listening_assignments) divergence — only comparable
    -- when the assignment row actually references an episode_id (story-mode sessions
    -- with a NULL episode_id cannot be cross-checked and are excluded, not assumed).
    'completed_without_calendar_update', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('user_id', up.user_id, 'episode_id', up.episode_id, 'completed_at', up.completed_at))
      FROM user_listening_progress up
      JOIN user_listening_assignments ua ON ua.user_id = up.user_id AND ua.episode_id = up.episode_id
      WHERE up.status = 'completed' AND ua.status <> 'completed'
    ), '[]'::jsonb),
    'calendar_completed_without_progress', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('user_id', ua.user_id, 'episode_id', ua.episode_id, 'activity_date', ua.activity_date))
      FROM user_listening_assignments ua
      LEFT JOIN user_listening_progress up ON up.user_id = ua.user_id AND up.episode_id = ua.episode_id
      WHERE ua.status = 'completed' AND ua.episode_id IS NOT NULL AND (up.status IS NULL OR up.status <> 'completed')
    ), '[]'::jsonb),
    'unpriced_listening_events_30d', (
      SELECT COUNT(*) FROM ai_usage_events
      WHERE feature_key LIKE 'listening.%' AND cost_status NOT IN ('calculated', 'reconciled') AND started_at >= now() - interval '30 days'
    )
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_listening_storage_summary_v1()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total_blocks integer;
  v_with_audio integer;
BEGIN
  SELECT COUNT(*) INTO v_total_blocks FROM listening_blocks;
  SELECT COUNT(*) INTO v_with_audio FROM listening_blocks WHERE audio_path IS NOT NULL AND length(trim(audio_path)) > 0;

  RETURN jsonb_build_object(
    'total_blocks', v_total_blocks,
    'blocks_with_audio', v_with_audio,
    'blocks_without_audio', v_total_blocks - v_with_audio,
    'audio_coverage_pct', CASE WHEN v_total_blocks > 0 THEN ROUND((v_with_audio::numeric / v_total_blocks) * 100, 2) ELSE NULL END,
    'distinct_audio_paths', (SELECT COUNT(DISTINCT audio_path) FROM listening_blocks WHERE audio_path IS NOT NULL AND length(trim(audio_path)) > 0),
    'duplicate_path_groups', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('audio_path', p, 'block_ids', ids, 'count', cnt))
      FROM (
        SELECT audio_path AS p, jsonb_agg(id ORDER BY id) AS ids, COUNT(*) AS cnt
        FROM listening_blocks
        WHERE audio_path IS NOT NULL AND length(trim(audio_path)) > 0
        GROUP BY audio_path HAVING COUNT(*) > 1
      ) t
    ), '[]'::jsonb),
    'missing_duration_count', (
      SELECT COUNT(*) FROM listening_blocks
      WHERE audio_path IS NOT NULL AND length(trim(audio_path)) > 0
        AND (duration_ms IS NULL OR duration_ms <= 0)
    ),
    'by_block_status', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('status', status, 'count', cnt) ORDER BY status)
      FROM (SELECT status::text AS status, COUNT(*) AS cnt FROM listening_blocks GROUP BY status) t
    ), '[]'::jsonb),
    'quarantined_count', (SELECT COUNT(*) FROM listening_audio_flags WHERE quarantined_at IS NOT NULL AND restored_at IS NULL),
    'flagged_count', (SELECT COUNT(*) FROM listening_audio_flags WHERE flagged_for_review = true),
    'checked_at', now()
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_new_users_timeseries_v1(p_after timestamp with time zone, p_before timestamp with time zone, p_granularity text DEFAULT 'day'::text)
 RETURNS TABLE(bucket timestamp with time zone, new_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'auth', 'public'
AS $function$
BEGIN
  IF p_granularity NOT IN ('hour', 'day', 'week') THEN
    RAISE EXCEPTION 'Invalid granularity: %', p_granularity;
  END IF;

  RETURN QUERY
  SELECT date_trunc(p_granularity, u.created_at) AS bucket, COUNT(*) AS new_count
  FROM auth.users u
  WHERE u.deleted_at IS NULL AND u.created_at >= p_after AND u.created_at < p_before
  GROUP BY bucket
  ORDER BY bucket ASC;
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_permission_matrix_v1()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'key', p.key, 'category', p.category, 'label', p.label,
    'requires_aal2', p.requires_aal2, 'requires_recent_auth', p.requires_recent_auth,
    'roles', (
      SELECT COALESCE(jsonb_agg(rp.role ORDER BY rp.role), '[]'::jsonb)
      FROM admin_role_permissions rp WHERE rp.permission_key = p.key
    )
  ) ORDER BY p.category, p.key), '[]'::jsonb)
  FROM admin_permissions p;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_plan_distribution_v1()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_total_users bigint;
  v_default_plan_id uuid;
  v_assigned_users bigint;
  v_suspended bigint;
BEGIN
  SELECT COUNT(*) INTO v_total_users FROM auth.users WHERE deleted_at IS NULL;
  SELECT id INTO v_default_plan_id FROM plans WHERE is_default = true AND status = 'active' LIMIT 1;

  SELECT COUNT(DISTINCT user_id) INTO v_assigned_users
  FROM user_plan_assignments
  WHERE status = 'active' AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now());

  SELECT COUNT(*) INTO v_suspended FROM user_access_controls WHERE is_suspended = true;

  RETURN jsonb_build_object(
    'total_users', v_total_users,
    'has_default_plan', v_default_plan_id IS NOT NULL,
    'users_on_default', CASE WHEN v_default_plan_id IS NOT NULL THEN GREATEST(v_total_users - v_assigned_users, 0) ELSE 0 END,
    'users_without_valid_plan', CASE WHEN v_default_plan_id IS NULL THEN GREATEST(v_total_users - v_assigned_users, 0) ELSE 0 END,
    'users_explicit_assignment', (
      SELECT COUNT(DISTINCT user_id) FROM user_plan_assignments
      WHERE status = 'active' AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now()) AND origin != 'trial'
    ),
    'users_active_trial', (
      SELECT COUNT(DISTINCT user_id) FROM user_plan_assignments
      WHERE status = 'active' AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now()) AND origin = 'trial'
    ),
    'trials_expiring_7d', (
      SELECT COUNT(*) FROM user_plan_assignments
      WHERE status = 'active' AND origin = 'trial' AND ends_at IS NOT NULL
        AND ends_at BETWEEN now() AND now() + interval '7 days'
    ),
    'scheduled_assignments', (
      SELECT COUNT(*) FROM user_plan_assignments WHERE status = 'scheduled' AND starts_at > now()
    ),
    'suspended_users', v_suspended,
    'by_plan', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'plan_id', p.id, 'plan_code', p.code, 'plan_name', p.name, 'is_default', p.is_default,
        'explicit_count', COALESCE(ex.cnt, 0), 'trial_count', COALESCE(tr.cnt, 0)
      ) ORDER BY p.display_order)
      FROM plans p
      LEFT JOIN (
        SELECT plan_id, COUNT(DISTINCT user_id) AS cnt FROM user_plan_assignments
        WHERE status = 'active' AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now()) AND origin != 'trial'
        GROUP BY plan_id
      ) ex ON ex.plan_id = p.id
      LEFT JOIN (
        SELECT plan_id, COUNT(DISTINCT user_id) AS cnt FROM user_plan_assignments
        WHERE status = 'active' AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now()) AND origin = 'trial'
        GROUP BY plan_id
      ) tr ON tr.plan_id = p.id
      WHERE p.status = 'active'
    ), '[]'::jsonb)
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_pricing_ack_status_v1(p_environment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'instance_id', a.instance_id, 'version_received', a.version_received, 'hash_received', a.hash_received,
      'version_applied', a.version_applied, 'hash_applied', a.hash_applied,
      'gateway_version', a.gateway_version, 'result', a.result, 'acked_at', a.acked_at
    ))
    FROM (
      SELECT DISTINCT ON (instance_id) *
      FROM ai_pricing_acknowledgements
      WHERE environment = p_environment
      ORDER BY instance_id, acked_at DESC
    ) a
  ), '[]'::jsonb);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_pricing_overview_v1(p_environment text, p_started_after timestamp with time zone DEFAULT (now() - '30 days'::interval), p_started_before timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_published ai_pricing_versions%ROWTYPE;
  v_scheduled ai_pricing_versions%ROWTYPE;
  v_total_events bigint;
  v_calculated bigint;
  v_ambiguous bigint;
  v_no_rate bigint;
  v_divergent bigint;
  v_ack_current boolean;
BEGIN
  PERFORM _promote_due_pricing_versions(p_environment);

  SELECT * INTO v_published FROM ai_pricing_versions WHERE environment = p_environment AND state = 'published';
  SELECT * INTO v_scheduled FROM ai_pricing_versions WHERE environment = p_environment AND state = 'scheduled';

  SELECT COUNT(*) INTO v_total_events
  FROM ai_usage_events e
  WHERE e.started_at BETWEEN p_started_after AND p_started_before;

  SELECT
    COUNT(*) FILTER (WHERE latest.status = 'calculated'),
    COUNT(*) FILTER (WHERE latest.status = 'ambiguous_rate'),
    COUNT(*) FILTER (WHERE latest.status IN ('no_rate', 'invalid_metric', 'incompatible_currency') OR latest.status IS NULL),
    COUNT(*) FILTER (WHERE latest.divergence_status = 'divergent')
  INTO v_calculated, v_ambiguous, v_no_rate, v_divergent
  FROM ai_usage_events e
  LEFT JOIN LATERAL (
    SELECT status, divergence_status FROM ai_cost_valuations v
    WHERE v.event_id = e.id ORDER BY v.created_at DESC LIMIT 1
  ) latest ON true
  WHERE e.started_at BETWEEN p_started_after AND p_started_before;

  v_ack_current := EXISTS (
    SELECT 1 FROM ai_pricing_acknowledgements a
    WHERE a.environment = p_environment
      AND v_published.id IS NOT NULL
      AND a.hash_applied = v_published.config_hash
      AND a.acked_at = (SELECT MAX(acked_at) FROM ai_pricing_acknowledgements WHERE environment = p_environment)
  );

  RETURN jsonb_build_object(
    'environment', p_environment,
    'effective_version', CASE WHEN v_published.id IS NOT NULL THEN row_to_json(v_published) ELSE NULL END,
    'next_scheduled_version', CASE WHEN v_scheduled.id IS NOT NULL THEN row_to_json(v_scheduled) ELSE NULL END,
    'gateway_acknowledged', v_ack_current,
    'total_events', v_total_events,
    'events_calculated', v_calculated,
    'events_ambiguous', v_ambiguous,
    'events_no_rate', v_no_rate,
    'events_divergent', v_divergent,
    'coverage_pct', CASE WHEN v_total_events > 0 THEN ROUND((v_calculated::numeric / v_total_events) * 100, 2) ELSE NULL END,
    'cost_by_currency', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('currency', currency, 'total', total, 'origin', origin))
      FROM (
        SELECT
          COALESCE(latest.currency, 'USD') AS currency,
          SUM(COALESCE(latest.cost_total, CASE WHEN latest.status IS NULL AND e.cost_status IN ('calculated', 'reconciled') THEN COALESCE(e.reconciled_cost_usd, e.calculated_cost_usd) ELSE NULL END)) AS total,
          CASE
            WHEN COUNT(*) FILTER (WHERE latest.status IS NULL) = 0 THEN 'recalculated'
            WHEN COUNT(*) FILTER (WHERE latest.status = 'calculated') = 0 THEN 'gateway_reported'
            ELSE 'mixed'
          END AS origin
        FROM ai_usage_events e
        LEFT JOIN LATERAL (
          SELECT currency, cost_total, status FROM ai_cost_valuations v
          WHERE v.event_id = e.id AND v.status = 'calculated' ORDER BY v.created_at DESC LIMIT 1
        ) latest ON true
        WHERE e.started_at BETWEEN p_started_after AND p_started_before
          AND (latest.status = 'calculated' OR (latest.status IS NULL AND e.cost_status IN ('calculated', 'reconciled')))
        GROUP BY COALESCE(latest.currency, 'USD')
      ) t
    ), '[]'::jsonb)
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_pricing_quality_v1(p_environment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_published_id uuid;
BEGIN
  PERFORM _promote_due_pricing_versions(p_environment);
  SELECT id INTO v_published_id FROM ai_pricing_versions WHERE environment = p_environment AND state = 'published';

  RETURN jsonb_build_object(
    'models_without_rate', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('provider', provider, 'model', model, 'event_count', cnt))
      FROM (
        SELECT e.provider, e.model, COUNT(*) AS cnt
        FROM ai_usage_events e
        WHERE e.provider IS NOT NULL AND e.model IS NOT NULL
          AND e.started_at > now() - interval '30 days'
          AND NOT EXISTS (
            SELECT 1 FROM ai_pricing_rates r
            WHERE r.version_id = v_published_id AND r.provider = e.provider
              AND (r.model IS NULL OR r.model = e.model)
          )
        GROUP BY e.provider, e.model
        ORDER BY COUNT(*) DESC LIMIT 25
      ) t
    ), '[]'::jsonb),
    'unpriced_events_30d', (
      SELECT COUNT(*) FROM ai_usage_events e
      WHERE e.started_at > now() - interval '30 days'
        AND NOT EXISTS (
          SELECT 1 FROM ai_cost_valuations v WHERE v.event_id = e.id AND v.status = 'calculated'
        )
    ),
    'ambiguous_events_30d', (
      SELECT COUNT(*) FROM ai_usage_events e
      JOIN LATERAL (
        SELECT status FROM ai_cost_valuations v WHERE v.event_id = e.id ORDER BY v.created_at DESC LIMIT 1
      ) latest ON true
      WHERE e.started_at > now() - interval '30 days'
        AND latest.status = 'ambiguous_rate'
    ),
    'unused_rates', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', r.id, 'provider', r.provider, 'model', r.model, 'metric_key', r.metric_key))
      FROM ai_pricing_rates r
      WHERE r.version_id = v_published_id
        AND NOT EXISTS (
          SELECT 1 FROM ai_cost_valuations v
          WHERE v.pricing_version_id = r.version_id
            AND v.components @> jsonb_build_array(jsonb_build_object('rateId', r.id::text))
        )
      LIMIT 50
    ), '[]'::jsonb),
    'unconfirmed_versions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', v.id, 'version_number', v.version_number, 'config_hash', v.config_hash))
      FROM ai_pricing_versions v
      WHERE v.environment = p_environment AND v.state = 'published'
        AND NOT EXISTS (
          SELECT 1 FROM ai_pricing_acknowledgements a
          WHERE a.environment = p_environment AND a.hash_applied = v.config_hash
        )
    ), '[]'::jsonb),
    'divergent_events_30d', (
      SELECT COUNT(*) FROM ai_usage_events e
      JOIN LATERAL (
        SELECT divergence_status FROM ai_cost_valuations v WHERE v.event_id = e.id ORDER BY v.created_at DESC LIMIT 1
      ) latest ON true
      WHERE e.started_at > now() - interval '30 days'
        AND latest.divergence_status = 'divergent'
    )
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_pricing_version_detail_v1(p_version_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ver ai_pricing_versions%ROWTYPE;
BEGIN
  SELECT * INTO v_ver FROM ai_pricing_versions WHERE id = p_version_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  RETURN jsonb_build_object(
    'version', row_to_json(v_ver),
    'rates', COALESCE((
      SELECT jsonb_agg(row_to_json(r) ORDER BY r.provider, r.metric_key, r.priority)
      FROM ai_pricing_rates r WHERE r.version_id = p_version_id
    ), '[]'::jsonb)
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_pricing_versions_v1(p_environment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM _promote_due_pricing_versions(p_environment);

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', v.id, 'environment', v.environment, 'version_number', v.version_number,
      'name', v.name, 'description', v.description, 'state', v.state,
      'currencies', v.currencies, 'effective_from', v.effective_from, 'effective_to', v.effective_to,
      'config_hash', v.config_hash, 'previous_version_id', v.previous_version_id,
      'created_by', v.created_by, 'published_by', v.published_by, 'reason', v.reason,
      'is_retroactive', v.is_retroactive, 'origin_note', v.origin_note, 'revision', v.revision,
      'created_at', v.created_at, 'updated_at', v.updated_at, 'published_at', v.published_at,
      'discarded_at', v.discarded_at,
      'rate_count', (SELECT COUNT(*) FROM ai_pricing_rates r WHERE r.version_id = v.id)
    ) ORDER BY v.version_number DESC)
    FROM ai_pricing_versions v
    WHERE v.environment = p_environment
  ), '[]'::jsonb);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_product_config_versions_v1(p_environment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM _promote_due_config_versions(p_environment);
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', v.id, 'environment', v.environment, 'version_number', v.version_number, 'state', v.state,
      'config_hash', v.config_hash, 'previous_version_id', v.previous_version_id, 'reason', v.reason,
      'is_high_risk', v.is_high_risk, 'created_by', v.created_by, 'published_by', v.published_by,
      'revision', v.revision, 'effective_from', v.effective_from, 'effective_to', v.effective_to,
      'created_at', v.created_at, 'updated_at', v.updated_at, 'published_at', v.published_at, 'discarded_at', v.discarded_at,
      'value_count', (SELECT COUNT(*) FROM app_config_values val WHERE val.version_id = v.id)
    ) ORDER BY v.version_number DESC)
    FROM app_config_versions v WHERE v.environment = p_environment
  ), '[]'::jsonb);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_security_policy_v1(p_environment text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'config', row_to_json(c),
    'versions', COALESCE((
      SELECT jsonb_agg(row_to_json(v) ORDER BY v.version_number DESC)
      FROM admin_security_policy_versions v WHERE v.environment = p_environment
    ), '[]'::jsonb)
  )
  FROM admin_security_configs c WHERE c.environment = p_environment;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_user_activity_batch(p_user_ids uuid[])
 RETURNS TABLE(user_id uuid, writing_entries_count bigint, english_reviews_count bigint, conversation_sessions_count bigint, pronunciation_assessments_count bigint, listening_results_count bigint, last_activity_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    u.uid AS user_id,
    COALESCE(we.cnt, 0)::BIGINT,
    COALESCE(er.cnt, 0)::BIGINT,
    COALESCE(cs.cnt, 0)::BIGINT,
    COALESCE(pa.cnt, 0)::BIGINT,
    COALESCE(lr.cnt, 0)::BIGINT,
    GREATEST(we.last_at, er.last_at, cs.last_at, pa.last_at, lr.last_at)
  FROM unnest(p_user_ids) u(uid)
  LEFT JOIN (
    SELECT user_id, COUNT(*) AS cnt, MAX(created_at) AS last_at
    FROM public.writing_entries
    WHERE user_id = ANY(p_user_ids)
    GROUP BY user_id
  ) we ON we.user_id = u.uid
  LEFT JOIN (
    SELECT user_id, COUNT(*) AS cnt, MAX(created_at) AS last_at
    FROM public.english_reviews
    WHERE user_id = ANY(p_user_ids)
    GROUP BY user_id
  ) er ON er.user_id = u.uid
  LEFT JOIN (
    SELECT user_id, COUNT(*) AS cnt, MAX(created_at) AS last_at
    FROM public.conversation_sessions
    WHERE user_id = ANY(p_user_ids)
    GROUP BY user_id
  ) cs ON cs.user_id = u.uid
  LEFT JOIN (
    SELECT user_id, COUNT(*) AS cnt, MAX(completed_at) AS last_at
    FROM public.pronunciation_assessments
    WHERE user_id = ANY(p_user_ids) AND status = 'completed'
    GROUP BY user_id
  ) pa ON pa.user_id = u.uid
  LEFT JOIN (
    SELECT user_id, COUNT(*) AS cnt, MAX(created_at) AS last_at
    FROM public.user_listening_results
    WHERE user_id = ANY(p_user_ids)
    GROUP BY user_id
  ) lr ON lr.user_id = u.uid;
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_user_ai_summary_v1(p_user_id uuid, p_started_after timestamp with time zone DEFAULT (now() - '30 days'::interval), p_started_before timestamp with time zone DEFAULT now())
 RETURNS TABLE(total_calls bigint, total_attempts bigint, total_success bigint, total_errors bigint, total_blocked bigint, total_tokens_input bigint, total_tokens_output bigint, total_chars_tts bigint, total_realtime_seconds numeric, total_cost_usd numeric, events_without_cost bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  WITH events AS (
    SELECT e.*, COALESCE(e.correlation_id, e.id) AS logical_call_id
    FROM public.ai_usage_events e
    WHERE e.user_id = p_user_id AND e.started_at BETWEEN p_started_after AND p_started_before
  ),
  metrics AS (
    SELECT
      m.usage_event_id,
      SUM(m.quantity) FILTER (WHERE m.metric_key IN ('input_text_tokens', 'input_audio_tokens')) AS tokens_input,
      SUM(m.quantity) FILTER (WHERE m.metric_key IN ('output_text_tokens', 'output_audio_tokens')) AS tokens_output,
      SUM(m.quantity) FILTER (WHERE m.metric_key = 'tts_characters') AS chars_tts,
      SUM(m.quantity) FILTER (WHERE m.metric_key = 'session_seconds') AS realtime_seconds
    FROM public.ai_usage_event_metrics m
    JOIN events e ON e.id = m.usage_event_id
    GROUP BY m.usage_event_id
  )
  SELECT
    COUNT(DISTINCT e.logical_call_id) AS total_calls,
    COUNT(*) AS total_attempts,
    COUNT(*) FILTER (WHERE e.status = 'succeeded') AS total_success,
    COUNT(*) FILTER (WHERE e.status = 'failed') AS total_errors,
    COUNT(*) FILTER (WHERE e.status = 'blocked') AS total_blocked,
    COALESCE(SUM(mt.tokens_input), 0)::bigint AS total_tokens_input,
    COALESCE(SUM(mt.tokens_output), 0)::bigint AS total_tokens_output,
    COALESCE(SUM(mt.chars_tts), 0)::bigint AS total_chars_tts,
    COALESCE(SUM(mt.realtime_seconds), 0) AS total_realtime_seconds,
    SUM(COALESCE(e.reconciled_cost_usd, e.calculated_cost_usd)) FILTER (WHERE COALESCE(e.reconciled_cost_usd, e.calculated_cost_usd) IS NOT NULL) AS total_cost_usd,
    COUNT(*) FILTER (WHERE COALESCE(e.reconciled_cost_usd, e.calculated_cost_usd) IS NULL) AS events_without_cost
  FROM events e
  LEFT JOIN metrics mt ON mt.usage_event_id = e.id;
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_user_labels_v1(p_user_ids uuid[])
 RETURNS TABLE(user_id uuid, email text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'auth', 'public'
AS $function$
  SELECT u.id, u.email FROM auth.users u WHERE u.id = ANY(p_user_ids) AND u.deleted_at IS NULL;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_user_pricing_summary_v1(p_user_id uuid, p_started_after timestamp with time zone DEFAULT (now() - '30 days'::interval), p_started_before timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total bigint;
  v_recalculated bigint;
  v_gateway_only bigint;
  v_uncalculated bigint;
  v_divergent bigint;
BEGIN
  SELECT COUNT(*) INTO v_total FROM ai_usage_events e
  WHERE e.user_id = p_user_id AND e.started_at BETWEEN p_started_after AND p_started_before;

  SELECT
    COUNT(*) FILTER (WHERE latest.status = 'calculated'),
    COUNT(*) FILTER (WHERE latest.status IS DISTINCT FROM 'calculated' AND e.cost_status IN ('calculated', 'reconciled')),
    COUNT(*) FILTER (WHERE latest.status IS DISTINCT FROM 'calculated' AND e.cost_status NOT IN ('calculated', 'reconciled')),
    COUNT(*) FILTER (WHERE latest.divergence_status = 'divergent')
  INTO v_recalculated, v_gateway_only, v_uncalculated, v_divergent
  FROM ai_usage_events e
  LEFT JOIN LATERAL (
    SELECT status, divergence_status FROM ai_cost_valuations v
    WHERE v.event_id = e.id ORDER BY v.created_at DESC LIMIT 1
  ) latest ON true
  WHERE e.user_id = p_user_id AND e.started_at BETWEEN p_started_after AND p_started_before;

  RETURN jsonb_build_object(
    'total_events', v_total,
    'events_recalculated', v_recalculated,
    'events_gateway_reported_only', v_gateway_only,
    'events_uncalculated', v_uncalculated,
    'events_divergent', v_divergent,
    'coverage_pct', CASE WHEN v_total > 0 THEN ROUND(((v_recalculated + v_gateway_only)::numeric / v_total) * 100, 2) ELSE NULL END,
    'cost_by_currency', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('currency', currency, 'total', total, 'origin', origin))
      FROM (
        SELECT COALESCE(latest.currency, 'USD') AS currency,
               SUM(COALESCE(latest.cost_total, COALESCE(e.reconciled_cost_usd, e.calculated_cost_usd))) AS total,
               CASE WHEN bool_or(latest.status = 'calculated') THEN 'recalculated' ELSE 'gateway_reported' END AS origin
        FROM ai_usage_events e
        LEFT JOIN LATERAL (
          SELECT currency, cost_total, status FROM ai_cost_valuations v
          WHERE v.event_id = e.id AND v.status = 'calculated' ORDER BY v.created_at DESC LIMIT 1
        ) latest ON true
        WHERE e.user_id = p_user_id AND e.started_at BETWEEN p_started_after AND p_started_before
          AND (latest.status = 'calculated' OR e.cost_status IN ('calculated', 'reconciled'))
        GROUP BY COALESCE(latest.currency, 'USD')
      ) t
    ), '[]'::jsonb)
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_user_stats()
 RETURNS TABLE(total_users bigint, new_last_7d bigint, new_last_30d bigint, login_last_30d bigint, never_logged_in bigint, email_unconfirmed bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'auth', 'public'
AS $function$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_7d  TIMESTAMPTZ := v_now - INTERVAL '7 days';
  v_30d TIMESTAMPTZ := v_now - INTERVAL '30 days';
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::BIGINT                                                     AS total_users,
    COUNT(*) FILTER (WHERE u.created_at >= v_7d)::BIGINT                AS new_last_7d,
    COUNT(*) FILTER (WHERE u.created_at >= v_30d)::BIGINT               AS new_last_30d,
    COUNT(*) FILTER (WHERE u.last_sign_in_at >= v_30d)::BIGINT          AS login_last_30d,
    COUNT(*) FILTER (WHERE u.last_sign_in_at IS NULL)::BIGINT           AS never_logged_in,
    COUNT(*) FILTER (WHERE u.email_confirmed_at IS NULL)::BIGINT        AS email_unconfirmed
  FROM auth.users u
  WHERE u.deleted_at IS NULL;
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_get_users_created_between_v1(p_after timestamp with time zone, p_before timestamp with time zone)
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'auth', 'public'
AS $function$
  SELECT COUNT(*) FROM auth.users
  WHERE deleted_at IS NULL AND created_at >= p_after AND created_at < p_before;
$function$;



CREATE OR REPLACE FUNCTION public.admin_list_admins_v1(p_page integer DEFAULT 1, p_page_size integer DEFAULT 25, p_role text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_search text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'auth', 'public'
AS $function$
DECLARE
  v_limit INTEGER := LEAST(GREATEST(p_page_size, 1), 100);
  v_offset INTEGER := (GREATEST(p_page, 1) - 1) * v_limit;
  v_total BIGINT;
  v_rows jsonb;
BEGIN
  SELECT COUNT(*) INTO v_total
  FROM admin_users au JOIN auth.users u ON u.id = au.user_id
  WHERE (p_role IS NULL OR au.role = p_role)
    AND (p_status IS NULL OR au.status = p_status)
    AND (p_search IS NULL OR u.email ILIKE '%' || p_search || '%');

  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) INTO v_rows FROM (
    SELECT
      au.user_id, u.email, au.role, au.status, au.revision,
      au.last_admin_access_at, au.created_at, au.status_changed_at, au.status_change_reason,
      EXISTS (SELECT 1 FROM auth.mfa_factors mf WHERE mf.user_id = au.user_id AND mf.status = 'verified') AS mfa_enrolled
    FROM admin_users au JOIN auth.users u ON u.id = au.user_id
    WHERE (p_role IS NULL OR au.role = p_role)
      AND (p_status IS NULL OR au.status = p_status)
      AND (p_search IS NULL OR u.email ILIKE '%' || p_search || '%')
    ORDER BY au.created_at DESC
    LIMIT v_limit OFFSET v_offset
  ) t;

  RETURN jsonb_build_object('total_count', v_total, 'rows', v_rows);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_list_audit_log_v1(p_page integer DEFAULT 1, p_page_size integer DEFAULT 25, p_actor_user_id uuid DEFAULT NULL::uuid, p_action text DEFAULT NULL::text, p_target_type text DEFAULT NULL::text, p_target_id text DEFAULT NULL::text, p_result text DEFAULT NULL::text, p_environment text DEFAULT NULL::text, p_correlation_id uuid DEFAULT NULL::uuid, p_started_after timestamp with time zone DEFAULT NULL::timestamp with time zone, p_started_before timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_limit INTEGER := LEAST(GREATEST(p_page_size, 1), 100);
  v_offset INTEGER := (GREATEST(p_page, 1) - 1) * v_limit;
  v_total BIGINT;
  v_rows jsonb;
BEGIN
  SELECT COUNT(*) INTO v_total FROM admin_audit_log l
  WHERE (p_actor_user_id IS NULL OR l.actor_user_id = p_actor_user_id)
    AND (p_action IS NULL OR l.action = p_action)
    AND (p_target_type IS NULL OR l.target_type = p_target_type)
    AND (p_target_id IS NULL OR l.target_id = p_target_id)
    AND (p_result IS NULL OR l.result = p_result)
    AND (p_environment IS NULL OR l.environment = p_environment)
    AND (p_correlation_id IS NULL OR l.correlation_id = p_correlation_id)
    AND (p_started_after IS NULL OR l.created_at >= p_started_after)
    AND (p_started_before IS NULL OR l.created_at <= p_started_before);

  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) INTO v_rows FROM (
    SELECT * FROM admin_audit_log l
    WHERE (p_actor_user_id IS NULL OR l.actor_user_id = p_actor_user_id)
      AND (p_action IS NULL OR l.action = p_action)
      AND (p_target_type IS NULL OR l.target_type = p_target_type)
      AND (p_target_id IS NULL OR l.target_id = p_target_id)
      AND (p_result IS NULL OR l.result = p_result)
      AND (p_environment IS NULL OR l.environment = p_environment)
      AND (p_correlation_id IS NULL OR l.correlation_id = p_correlation_id)
      AND (p_started_after IS NULL OR l.created_at >= p_started_after)
      AND (p_started_before IS NULL OR l.created_at <= p_started_before)
    ORDER BY l.created_at DESC
    LIMIT v_limit OFFSET v_offset
  ) t;

  RETURN jsonb_build_object('total_count', v_total, 'rows', v_rows);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_list_gateway_events_v1(p_page integer DEFAULT 1, p_page_size integer DEFAULT 25, p_environment text DEFAULT NULL::text, p_feature_key text DEFAULT NULL::text, p_provider text DEFAULT NULL::text, p_model text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_user_id uuid DEFAULT NULL::uuid, p_request_id text DEFAULT NULL::text, p_started_after timestamp with time zone DEFAULT NULL::timestamp with time zone, p_started_before timestamp with time zone DEFAULT NULL::timestamp with time zone, p_order_by text DEFAULT 'started_at'::text, p_order_dir text DEFAULT 'desc'::text)
 RETURNS TABLE(total_count bigint, id uuid, logical_call_id uuid, attempt_number integer, user_id uuid, feature_key text, provider text, model text, status text, gateway_mode text, policy_decision text, tokens_total integer, chars_tts_billed integer, realtime_seconds numeric, latency_total_ms integer, cost_total_usd numeric, cost_status text, started_at timestamp with time zone, finished_at timestamp with time zone, environment text, error_category text, error_message_sanitized text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_offset INTEGER;
  v_limit INTEGER;
  v_status_db TEXT;
BEGIN
  IF p_order_by NOT IN ('started_at', 'latency_total_ms', 'cost_total_usd', 'tokens_total') THEN
    p_order_by := 'started_at';
  END IF;
  IF p_order_dir NOT IN ('asc', 'desc') THEN
    p_order_dir := 'desc';
  END IF;

  v_limit := LEAST(GREATEST(p_page_size, 1), 100);
  v_offset := (GREATEST(p_page, 1) - 1) * v_limit;

  v_status_db := CASE p_status
    WHEN 'success' THEN 'succeeded'
    WHEN 'error' THEN 'failed'
    WHEN 'timeout' THEN 'expired'
    WHEN 'pending' THEN 'started'
    ELSE p_status
  END;

  RETURN QUERY
  WITH events AS (
    SELECT
      e.*,
      COALESCE(e.correlation_id, e.id) AS v_logical_call_id,
      (SELECT SUM(m.quantity) FROM public.ai_usage_event_metrics m
        WHERE m.usage_event_id = e.id
          AND m.metric_key IN ('input_text_tokens', 'output_text_tokens', 'cached_input_tokens',
                                'input_audio_tokens', 'output_audio_tokens', 'cached_input_audio_tokens')
      ) AS v_tokens_total,
      (SELECT SUM(m.quantity) FROM public.ai_usage_event_metrics m
        WHERE m.usage_event_id = e.id AND m.metric_key = 'tts_characters'
      ) AS v_chars_tts_billed,
      (SELECT SUM(m.quantity) FROM public.ai_usage_event_metrics m
        WHERE m.usage_event_id = e.id AND m.metric_key = 'session_seconds'
      ) AS v_realtime_seconds
    FROM public.ai_usage_events e
    WHERE
      (p_feature_key IS NULL OR e.feature_key = p_feature_key)
      AND (p_provider IS NULL OR e.provider = p_provider)
      AND (p_model IS NULL OR e.model = p_model)
      AND (v_status_db IS NULL OR e.status = v_status_db)
      AND (p_user_id IS NULL OR e.user_id = p_user_id)
      AND (p_request_id IS NULL OR e.id::text ILIKE '%' || p_request_id || '%' OR e.correlation_id::text ILIKE '%' || p_request_id || '%')
      AND (p_started_after IS NULL OR e.started_at >= p_started_after)
      AND (p_started_before IS NULL OR e.started_at <= p_started_before)
  )
  SELECT
    COUNT(*) OVER () AS total_count,
    e.id,
    e.v_logical_call_id,
    e.attempt_number,
    e.user_id,
    e.feature_key,
    e.provider,
    e.model,
    CASE e.status
      WHEN 'succeeded' THEN 'success' WHEN 'failed' THEN 'error'
      WHEN 'expired' THEN 'timeout' WHEN 'started' THEN 'pending'
      ELSE e.status
    END,
    'legacy'::text,
    CASE WHEN e.status = 'blocked' THEN 'blocked' ELSE 'allowed' END,
    e.v_tokens_total::integer,
    e.v_chars_tts_billed::integer,
    e.v_realtime_seconds,
    e.latency_ms,
    COALESCE(e.reconciled_cost_usd, e.calculated_cost_usd),
    e.cost_status,
    e.started_at,
    e.completed_at,
    'production'::text,
    e.error_category,
    e.sanitized_error_message
  FROM events e
  ORDER BY
    CASE WHEN p_order_by = 'started_at' AND p_order_dir = 'desc' THEN e.started_at END DESC,
    CASE WHEN p_order_by = 'started_at' AND p_order_dir = 'asc' THEN e.started_at END ASC,
    CASE WHEN p_order_by = 'latency_total_ms' AND p_order_dir = 'desc' THEN e.latency_ms END DESC NULLS LAST,
    CASE WHEN p_order_by = 'latency_total_ms' AND p_order_dir = 'asc' THEN e.latency_ms END ASC NULLS LAST,
    CASE WHEN p_order_by = 'cost_total_usd' AND p_order_dir = 'desc' THEN COALESCE(e.reconciled_cost_usd, e.calculated_cost_usd) END DESC NULLS LAST,
    CASE WHEN p_order_by = 'cost_total_usd' AND p_order_dir = 'asc' THEN COALESCE(e.reconciled_cost_usd, e.calculated_cost_usd) END ASC NULLS LAST,
    CASE WHEN p_order_by = 'tokens_total' AND p_order_dir = 'desc' THEN e.v_tokens_total END DESC NULLS LAST,
    CASE WHEN p_order_by = 'tokens_total' AND p_order_dir = 'asc' THEN e.v_tokens_total END ASC NULLS LAST
  LIMIT v_limit OFFSET v_offset;
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_list_invitations_v1(p_status text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(row_to_json(t) ORDER BY t.created_at DESC), '[]'::jsonb) FROM (
    SELECT i.* FROM admin_invitations i
    WHERE p_status IS NULL OR i.status = p_status
  ) t;
$function$;


CREATE OR REPLACE FUNCTION public.admin_list_listening_blocks_audio_v1(p_page integer DEFAULT 1, p_page_size integer DEFAULT 25, p_filter text DEFAULT 'all'::text, p_search text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_limit  integer := LEAST(GREATEST(p_page_size, 1), 100);
  v_offset integer := (GREATEST(p_page, 1) - 1) * v_limit;
  v_rows   jsonb;
  v_total  bigint;
BEGIN
  IF p_filter NOT IN ('all', 'no_audio', 'has_audio', 'duplicate_path') THEN
    RAISE EXCEPTION 'Invalid filter: %', p_filter;
  END IF;

  -- Matches the established pagination pattern in this file (see
  -- admin_list_listening_episodes_v1 above): a separate COUNT then a
  -- separate, LIMIT/OFFSET'd row query, rather than a session-scoped temp
  -- table (which would break if this function is ever called twice inside
  -- one transaction — plain SQL has no such restriction).
  SELECT COUNT(*) INTO v_total
  FROM listening_blocks b
  JOIN listening_episodes e ON e.id = b.episode_id
  WHERE
    (
      (p_filter = 'all')
      OR (p_filter = 'no_audio' AND (b.audio_path IS NULL OR length(trim(b.audio_path)) = 0))
      OR (p_filter = 'has_audio' AND b.audio_path IS NOT NULL AND length(trim(b.audio_path)) > 0)
      OR (p_filter = 'duplicate_path' AND b.audio_path IS NOT NULL AND EXISTS (
            SELECT 1 FROM listening_blocks b2
            WHERE b2.audio_path = b.audio_path
            GROUP BY b2.audio_path HAVING COUNT(*) > 1
          ))
    )
    AND (p_search IS NULL OR e.title ILIKE '%' || p_search || '%' OR b.audio_path ILIKE '%' || p_search || '%');

  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT
      b.id, b.episode_id, e.title AS episode_title, e.cefr_level, b.block_order,
      b.audio_path, b.duration_ms, b.status,
      d.state AS distribution_state,
      f.flagged_for_review, f.quarantined_at,
      (b.audio_path IS NOT NULL AND EXISTS (
        SELECT 1 FROM listening_blocks b2
        WHERE b2.audio_path = b.audio_path
        GROUP BY b2.audio_path HAVING COUNT(*) > 1
      )) AS is_duplicate_path
    FROM listening_blocks b
    JOIN listening_episodes e ON e.id = b.episode_id
    LEFT JOIN listening_episode_distribution d ON d.episode_id = b.episode_id
    LEFT JOIN listening_audio_flags f ON f.block_id = b.id
    WHERE
      (
        (p_filter = 'all')
        OR (p_filter = 'no_audio' AND (b.audio_path IS NULL OR length(trim(b.audio_path)) = 0))
        OR (p_filter = 'has_audio' AND b.audio_path IS NOT NULL AND length(trim(b.audio_path)) > 0)
        OR (p_filter = 'duplicate_path' AND b.audio_path IS NOT NULL AND EXISTS (
              SELECT 1 FROM listening_blocks b2
              WHERE b2.audio_path = b.audio_path
              GROUP BY b2.audio_path HAVING COUNT(*) > 1
            ))
      )
      AND (p_search IS NULL OR e.title ILIKE '%' || p_search || '%' OR b.audio_path ILIKE '%' || p_search || '%')
    ORDER BY e.title, b.block_order
    LIMIT v_limit OFFSET v_offset
  ) t;

  RETURN jsonb_build_object('total_count', v_total, 'rows', v_rows);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_list_listening_episodes_v1(p_page integer DEFAULT 1, p_page_size integer DEFAULT 25, p_status text DEFAULT NULL::text, p_cefr_level text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_order_by text DEFAULT 'created_at'::text, p_order_dir text DEFAULT 'desc'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_limit  integer := LEAST(GREATEST(p_page_size, 1), 100);
  v_offset integer := (GREATEST(p_page, 1) - 1) * v_limit;
  v_order_col text := CASE p_order_by WHEN 'cefr_level' THEN 'e.cefr_level' WHEN 'title' THEN 'e.title' ELSE 'e.created_at' END;
  v_order_dir text := CASE WHEN lower(p_order_dir) = 'asc' THEN 'ASC' ELSE 'DESC' END;
  v_rows jsonb;
  v_total bigint;
BEGIN
  SELECT COUNT(*) INTO v_total
  FROM listening_episodes e
  LEFT JOIN listening_episode_distribution d ON d.episode_id = e.id
  WHERE (p_status IS NULL OR COALESCE(d.state, 'draft') = p_status)
    AND (p_cefr_level IS NULL OR e.cefr_level = p_cefr_level)
    AND (p_search IS NULL OR e.title ILIKE '%' || p_search || '%');

  EXECUTE format(
    $q$
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (
      SELECT
        e.id, e.title, e.cefr_level, e.status AS content_status, e.content_version,
        COALESCE(d.state, 'draft') AS distribution_state,
        d.available_from, d.available_to, d.priority, d.revision,
        (SELECT COUNT(*) FROM listening_blocks b WHERE b.episode_id = e.id) AS block_count,
        -- CORRECTED (Etapa 13 corretiva): "ready" here means "has a recorded
        -- audio_path" — the DB has no way to confirm the file itself exists
        -- in Storage (see admin_list_listening_blocks_audio_v1 for that).
        (SELECT COUNT(*) FROM listening_blocks ab WHERE ab.episode_id = e.id AND ab.audio_path IS NOT NULL AND length(trim(ab.audio_path)) > 0) AS audio_ready_count,
        (SELECT COUNT(*) FROM user_listening_assignments ua WHERE ua.episode_id = e.id) AS assignments_count,
        (SELECT COUNT(*) FROM user_listening_progress up WHERE up.episode_id = e.id AND up.status = 'completed') AS completions_count
      FROM listening_episodes e
      LEFT JOIN listening_episode_distribution d ON d.episode_id = e.id
      WHERE (%L::text IS NULL OR COALESCE(d.state, 'draft') = %L::text)
        AND (%L::text IS NULL OR e.cefr_level = %L::text)
        AND (%L::text IS NULL OR e.title ILIKE '%%' || %L::text || '%%')
      ORDER BY %s %s NULLS LAST
      LIMIT %s OFFSET %s
    ) t
    $q$,
    p_status, p_status, p_cefr_level, p_cefr_level, p_search, p_search,
    v_order_col, v_order_dir, v_limit, v_offset
  ) INTO v_rows;

  RETURN jsonb_build_object('total_count', v_total, 'rows', v_rows);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_list_listening_generation_requests_v1(p_page integer DEFAULT 1, p_page_size integer DEFAULT 25, p_status text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_limit  integer := LEAST(GREATEST(p_page_size, 1), 100);
  v_offset integer := (GREATEST(p_page, 1) - 1) * v_limit;
  v_total  bigint;
  v_rows   jsonb;
BEGIN
  SELECT COUNT(*) INTO v_total FROM listening_generation_requests WHERE p_status IS NULL OR status = p_status;

  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) INTO v_rows FROM (
    SELECT r.*, e.title AS episode_title
    FROM listening_generation_requests r
    LEFT JOIN listening_episodes e ON e.id = r.episode_id
    WHERE p_status IS NULL OR r.status = p_status
    ORDER BY r.created_at DESC
    LIMIT v_limit OFFSET v_offset
  ) t;

  RETURN jsonb_build_object('total_count', v_total, 'rows', v_rows);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_list_listening_jobs_v1(p_page integer DEFAULT 1, p_page_size integer DEFAULT 25, p_status text DEFAULT NULL::text, p_job_type text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_limit INTEGER;
  v_offset INTEGER;
  v_total BIGINT;
  v_rows jsonb;
BEGIN
  v_limit := LEAST(GREATEST(p_page_size, 1), 100);
  v_offset := (GREATEST(p_page, 1) - 1) * v_limit;

  SELECT COUNT(*) INTO v_total
  FROM listening_jobs j
  WHERE (p_status IS NULL OR j.status = p_status)
    AND (p_job_type IS NULL OR j.job_type = p_job_type);

  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT j.id, j.job_type, j.status, j.priority, j.episode_id, j.block_id, j.cefr_level,
      j.attempts, j.max_attempts, j.locked_by, j.locked_at, j.lock_expires_at,
      j.next_attempt_at, j.started_at, j.finished_at, j.error_code, j.error_message,
      j.created_at, j.updated_at
    FROM listening_jobs j
    WHERE (p_status IS NULL OR j.status = p_status)
      AND (p_job_type IS NULL OR j.job_type = p_job_type)
    ORDER BY j.created_at DESC
    LIMIT v_limit OFFSET v_offset
  ) t;

  RETURN jsonb_build_object('total_count', v_total, 'rows', v_rows);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_list_security_events_v1(p_page integer DEFAULT 1, p_page_size integer DEFAULT 25, p_event_type text DEFAULT NULL::text, p_severity text DEFAULT NULL::text, p_actor_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_limit INTEGER := LEAST(GREATEST(p_page_size, 1), 100);
  v_offset INTEGER := (GREATEST(p_page, 1) - 1) * v_limit;
  v_total BIGINT;
  v_rows jsonb;
BEGIN
  SELECT COUNT(*) INTO v_total FROM admin_security_events e
  WHERE (p_event_type IS NULL OR e.event_type = p_event_type)
    AND (p_severity IS NULL OR e.severity = p_severity)
    AND (p_actor_user_id IS NULL OR e.actor_user_id = p_actor_user_id);

  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) INTO v_rows FROM (
    SELECT * FROM admin_security_events e
    WHERE (p_event_type IS NULL OR e.event_type = p_event_type)
      AND (p_severity IS NULL OR e.severity = p_severity)
      AND (p_actor_user_id IS NULL OR e.actor_user_id = p_actor_user_id)
    ORDER BY e.created_at DESC
    LIMIT v_limit OFFSET v_offset
  ) t;

  RETURN jsonb_build_object('total_count', v_total, 'rows', v_rows);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_list_sessions_v1(p_target_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'auth', 'public'
AS $function$
DECLARE
  v_current_session_id UUID;
BEGIN
  BEGIN
    v_current_session_id := (auth.jwt() ->> 'session_id')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_current_session_id := NULL;
  END;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', s.id,
      'created_at', s.created_at,
      'updated_at', s.updated_at,
      'not_after', s.not_after,
      'aal', s.aal,
      'user_agent', left(s.user_agent, 200),
      'is_current', s.id = v_current_session_id
    ) ORDER BY s.updated_at DESC)
    FROM auth.sessions s
    WHERE s.user_id = p_target_user_id
  ), '[]'::jsonb);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_list_users_v1(p_page integer DEFAULT 1, p_page_size integer DEFAULT 25, p_search text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_provider text DEFAULT NULL::text, p_cefr text DEFAULT NULL::text, p_order_by text DEFAULT 'created_at'::text, p_order_dir text DEFAULT 'desc'::text, p_created_after timestamp with time zone DEFAULT NULL::timestamp with time zone, p_created_before timestamp with time zone DEFAULT NULL::timestamp with time zone, p_last_login_after timestamp with time zone DEFAULT NULL::timestamp with time zone, p_last_login_before timestamp with time zone DEFAULT NULL::timestamp with time zone, p_never_logged_in boolean DEFAULT NULL::boolean, p_email_confirmed boolean DEFAULT NULL::boolean)
 RETURNS TABLE(total_count bigint, user_id uuid, email text, display_name text, created_at timestamp with time zone, last_sign_in_at timestamp with time zone, email_confirmed_at timestamp with time zone, is_banned boolean, provider text, cefr_level text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'auth', 'public'
AS $function$
DECLARE
  v_offset    INTEGER := (GREATEST(p_page, 1) - 1) * LEAST(GREATEST(p_page_size, 1), 100);
  v_limit     INTEGER := LEAST(GREATEST(p_page_size, 1), 100);
  v_order_col TEXT;
  v_order_dir TEXT;
BEGIN
  v_order_col := CASE p_order_by
    WHEN 'created_at'      THEN 'created_at'
    WHEN 'last_sign_in_at' THEN 'last_sign_in_at'
    WHEN 'email'           THEN 'email'
    ELSE 'created_at'
  END;

  v_order_dir := CASE WHEN lower(p_order_dir) = 'asc' THEN 'ASC' ELSE 'DESC' END;

  RETURN QUERY EXECUTE format(
    $q$
    WITH filtered AS (
      SELECT
        u.id,
        u.email::text AS email,
        COALESCE(
          u.raw_user_meta_data->>'full_name',
          u.raw_user_meta_data->>'name',
          u.raw_user_meta_data->>'display_name'
        ) AS display_name,
        u.created_at,
        u.last_sign_in_at,
        u.email_confirmed_at,
        (u.banned_until IS NOT NULL AND u.banned_until > NOW()) AS is_banned,
        COALESCE(u.raw_app_meta_data->>'provider', 'email') AS provider,
        elm.current_level AS cefr_level
      FROM auth.users u
      LEFT JOIN LATERAL (
        SELECT e.current_level
        FROM public.english_learning_memory e
        WHERE e.user_id = u.id
        ORDER BY e.updated_at DESC
        LIMIT 1
      ) elm ON true
      WHERE u.deleted_at IS NULL
        AND ($1 IS NULL OR (
          u.email ILIKE '%%' || $1 || '%%'
          OR COALESCE(u.raw_user_meta_data->>'full_name', '') ILIKE '%%' || $1 || '%%'
          OR COALESCE(u.raw_user_meta_data->>'name', '') ILIKE '%%' || $1 || '%%'
          OR u.id::text ILIKE '%%' || $1 || '%%'
        ))
        AND ($2 IS NULL OR (
          CASE $2
            WHEN 'active'            THEN u.email_confirmed_at IS NOT NULL AND (u.banned_until IS NULL OR u.banned_until <= NOW())
            WHEN 'email_unconfirmed' THEN u.email_confirmed_at IS NULL
            WHEN 'banned'            THEN u.banned_until IS NOT NULL AND u.banned_until > NOW()
            ELSE TRUE
          END
        ))
        AND ($3 IS NULL OR COALESCE(u.raw_app_meta_data->>'provider', 'email') = $3)
        AND ($4 IS NULL OR elm.current_level = $4)
        AND ($5 IS NULL OR u.created_at >= $5)
        AND ($6 IS NULL OR u.created_at < $6)
        AND ($7 IS NULL OR u.last_sign_in_at >= $7)
        AND ($8 IS NULL OR u.last_sign_in_at < $8)
        AND ($9 IS NULL OR (
          CASE WHEN $9 THEN u.last_sign_in_at IS NULL ELSE TRUE END
        ))
        AND ($10 IS NULL OR (
          CASE
            WHEN $10 THEN u.email_confirmed_at IS NOT NULL
            ELSE u.email_confirmed_at IS NULL
          END
        ))
    )
    SELECT
      COUNT(*) OVER ()          AS total_count,
      id                        AS user_id,
      email,
      display_name,
      created_at,
      last_sign_in_at,
      email_confirmed_at,
      is_banned,
      provider,
      cefr_level
    FROM filtered
    ORDER BY %s %s NULLS LAST, id ASC
    LIMIT %s OFFSET %s
    $q$,
    v_order_col,
    v_order_dir,
    v_limit,
    v_offset
  )
  USING
    p_search, p_status, p_provider, p_cefr,
    p_created_after, p_created_before,
    p_last_login_after, p_last_login_before,
    p_never_logged_in, p_email_confirmed;
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_pause_listening_distribution_v1(p_episode_id uuid, p_reason text, p_actor_id uuid, p_client_revision integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_dist listening_episode_distribution%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active' AND role IN ('owner','admin')) THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN RAISE EXCEPTION 'A reason is required to pause a distribution'; END IF;

  SELECT * INTO v_dist FROM listening_episode_distribution WHERE episode_id = p_episode_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Distribution not found for episode: %', p_episode_id; END IF;
  IF v_dist.revision <> p_client_revision THEN
    RAISE EXCEPTION 'REVISION_CONFLICT: Expected %, got %', p_client_revision, v_dist.revision USING ERRCODE = 'P0002';
  END IF;
  IF v_dist.state NOT IN ('published', 'scheduled') THEN
    RAISE EXCEPTION 'Distribution is %, cannot pause', v_dist.state;
  END IF;

  UPDATE listening_episode_distribution SET state = 'paused', revision = revision + 1, updated_by = p_actor_id WHERE episode_id = p_episode_id;

  INSERT INTO listening_episode_publications (episode_id, action, previous_state, new_state, reason, actor_id)
  VALUES (p_episode_id, 'pause', v_dist.state, 'paused', p_reason, p_actor_id);

  RETURN jsonb_build_object('episode_id', p_episode_id, 'state', 'paused', 'new_revision', v_dist.revision + 1);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_publish_config_version_v1(p_version_id uuid, p_reason text, p_actor_id uuid, p_client_revision integer, p_high_risk_confirmation text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ver          app_config_versions%ROWTYPE;
  v_role         text;
  v_target_from  timestamptz;
  v_current      app_config_versions%ROWTYPE;
  v_validation   jsonb;
  v_snapshot     jsonb;
  v_hash         text;
  v_final_state  text;
  v_existing_id  uuid;
BEGIN
  SELECT role INTO v_role FROM admin_users WHERE user_id = p_actor_id AND status = 'active';
  IF v_role IS NULL THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
  IF v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'UNAUTHORIZED: publishing config versions requires owner or admin role';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing_id FROM app_config_versions WHERE publish_idempotency_key = p_idempotency_key;
    IF FOUND THEN
      SELECT * INTO v_ver FROM app_config_versions WHERE id = v_existing_id;
      RETURN jsonb_build_object('version_id', v_ver.id, 'state', v_ver.state, 'config_hash', v_ver.config_hash, 'idempotent', true);
    END IF;
  END IF;

  SELECT * INTO v_ver FROM app_config_versions WHERE id = p_version_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Config version not found: %', p_version_id; END IF;
  IF v_ver.state NOT IN ('draft', 'scheduled') THEN
    RAISE EXCEPTION 'Version is already %, cannot publish', v_ver.state;
  END IF;
  IF v_ver.revision != p_client_revision THEN
    RAISE EXCEPTION 'REVISION_CONFLICT: Expected %, got %', p_client_revision, v_ver.revision
      USING ERRCODE = 'P0002';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'A reason is required to publish a config version';
  END IF;

  v_validation := admin_validate_config_version_v1(p_version_id);
  IF NOT (v_validation->>'valid')::boolean THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: %', v_validation->'errors';
  END IF;

  IF (v_validation->>'is_high_risk')::boolean THEN
    IF v_role != 'owner' THEN
      RAISE EXCEPTION 'UNAUTHORIZED: publishing high-risk config changes requires owner role';
    END IF;
    IF p_high_risk_confirmation IS NULL OR length(trim(p_high_risk_confirmation)) < 10 THEN
      RAISE EXCEPTION 'HIGH_RISK_CONFIRMATION_REQUIRED: type an explicit confirmation before publishing a high-risk change';
    END IF;
  END IF;

  v_target_from := COALESCE(v_ver.effective_from, now());
  v_snapshot := _build_config_snapshot(p_version_id);
  v_hash := md5(v_snapshot::text);
  v_final_state := CASE WHEN v_target_from <= now() THEN 'published' ELSE 'scheduled' END;

  IF v_final_state = 'published' THEN
    SELECT * INTO v_current FROM app_config_versions
    WHERE environment = v_ver.environment AND state = 'published' FOR UPDATE;
    IF FOUND THEN
      UPDATE app_config_versions SET state = 'superseded', effective_to = v_target_from WHERE id = v_current.id;
    END IF;
  END IF;

  UPDATE app_config_versions SET
    state                   = v_final_state,
    effective_from           = v_target_from,
    published_by            = p_actor_id,
    published_at            = now(),
    reason                  = p_reason,
    is_high_risk             = (v_validation->>'is_high_risk')::boolean,
    high_risk_confirmation   = p_high_risk_confirmation,
    snapshot                = v_snapshot,
    config_hash              = v_hash,
    revision                = revision + 1,
    publish_idempotency_key = p_idempotency_key
  WHERE id = p_version_id;

  RETURN jsonb_build_object('version_id', p_version_id, 'state', v_final_state, 'config_hash', v_hash, 'effective_from', v_target_from);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_publish_gateway_config_v1(p_environment text, p_reason text, p_change_type text, p_published_by uuid, p_client_revision integer, p_is_emergency boolean DEFAULT false, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cfg          ai_gateway_configs%ROWTYPE;
  v_next_version integer;
  v_snapshot     jsonb;
  v_hash         text;
  v_new_ver_id   uuid;
BEGIN
  SELECT * INTO v_cfg FROM ai_gateway_configs WHERE environment = p_environment FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Environment not found: %', p_environment;
  END IF;

  IF p_client_revision != v_cfg.revision THEN
    RAISE EXCEPTION 'REVISION_CONFLICT: Expected %, got %', p_client_revision, v_cfg.revision
      USING ERRCODE = 'P0002';
  END IF;

  SELECT COALESCE(MAX(version_number), 0) + 1 INTO v_next_version
  FROM ai_gateway_config_versions WHERE environment = p_environment;

  v_snapshot := _build_control_snapshot(p_environment, v_next_version);
  v_hash     := md5(v_snapshot::text);

  INSERT INTO ai_gateway_config_versions (
    environment, version_number, snapshot, config_hash, state,
    change_type, is_emergency, reason, published_by, published_at,
    expires_at, previous_version_id
  ) VALUES (
    p_environment, v_next_version, v_snapshot, v_hash, 'published',
    p_change_type, p_is_emergency, p_reason, p_published_by, now(),
    p_expires_at, v_cfg.current_version_id
  ) RETURNING id INTO v_new_ver_id;

  -- Supersede previous version
  IF v_cfg.current_version_id IS NOT NULL THEN
    UPDATE ai_gateway_config_versions SET state = 'superseded'
    WHERE id = v_cfg.current_version_id;
  END IF;

  UPDATE ai_gateway_configs SET
    current_version_id = v_new_ver_id,
    revision           = v_cfg.revision + 1,
    config_hash        = v_hash,
    updated_by         = p_published_by,
    updated_at         = now()
  WHERE environment = p_environment;

  RETURN jsonb_build_object(
    'version_number', v_next_version,
    'config_hash',    v_hash,
    'version_id',     v_new_ver_id,
    'new_revision',   v_cfg.revision + 1
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_publish_listening_distribution_v1(p_episode_id uuid, p_reason text, p_actor_id uuid, p_client_revision integer, p_available_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_available_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_eligible_levels text[] DEFAULT NULL::text[], p_priority integer DEFAULT NULL::integer, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_dist        listening_episode_distribution%ROWTYPE;
  v_episode     listening_episodes%ROWTYPE;
  v_validation  jsonb;
  v_target_from timestamptz;
  v_final_state text;
  v_hash        text;
  v_existing_pub uuid;
  v_cur_revision integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active' AND role IN ('owner','admin')) THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'A reason is required to publish a listening episode';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing_pub FROM listening_episode_publications
    WHERE episode_id = p_episode_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN RETURN jsonb_build_object('episode_id', p_episode_id, 'idempotent', true); END IF;
  END IF;

  SELECT * INTO v_episode FROM listening_episodes WHERE id = p_episode_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Episode not found: %', p_episode_id; END IF;

  v_validation := admin_validate_listening_episode_v1(p_episode_id);
  IF NOT (v_validation->>'valid')::boolean THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: %', v_validation->'errors';
  END IF;

  SELECT * INTO v_dist FROM listening_episode_distribution WHERE episode_id = p_episode_id FOR UPDATE;
  v_cur_revision := COALESCE(v_dist.revision, 0);
  IF v_cur_revision <> p_client_revision THEN
    RAISE EXCEPTION 'REVISION_CONFLICT: Expected %, got %', p_client_revision, v_cur_revision USING ERRCODE = 'P0002';
  END IF;
  IF v_dist.state IS NOT NULL AND v_dist.state NOT IN ('draft', 'withdrawn') THEN
    RAISE EXCEPTION 'Distribution is already %, cannot publish', v_dist.state;
  END IF;

  v_target_from := COALESCE(p_available_from, now());
  v_final_state := CASE WHEN v_target_from <= now() THEN 'published' ELSE 'scheduled' END;
  v_hash := _hash_listening_episode_content_v1(p_episode_id);

  INSERT INTO listening_episode_distribution (
    episode_id, state, available_from, available_to, eligible_levels, priority,
    content_hash, content_version_at_publish, revision, updated_by
  ) VALUES (
    p_episode_id, v_final_state, v_target_from, p_available_to,
    COALESCE(p_eligible_levels, ARRAY[v_episode.cefr_level]), COALESCE(p_priority, 100),
    v_hash, v_episode.content_version, 1, p_actor_id
  )
  ON CONFLICT (episode_id) DO UPDATE SET
    state = v_final_state, available_from = v_target_from, available_to = p_available_to,
    eligible_levels = COALESCE(p_eligible_levels, listening_episode_distribution.eligible_levels),
    priority = COALESCE(p_priority, listening_episode_distribution.priority),
    content_hash = v_hash, content_version_at_publish = v_episode.content_version,
    revision = listening_episode_distribution.revision + 1, updated_by = p_actor_id;

  INSERT INTO listening_episode_publications (
    episode_id, action, previous_state, new_state, available_from, available_to,
    eligible_levels, priority, content_hash, content_version_at_publish, reason, actor_id, idempotency_key
  ) VALUES (
    p_episode_id, CASE WHEN v_final_state = 'scheduled' THEN 'schedule' ELSE 'publish' END,
    v_dist.state, v_final_state, v_target_from, p_available_to,
    COALESCE(p_eligible_levels, ARRAY[v_episode.cefr_level]), COALESCE(p_priority, 100),
    v_hash, v_episode.content_version, p_reason, p_actor_id, p_idempotency_key
  );

  RETURN jsonb_build_object('episode_id', p_episode_id, 'state', v_final_state, 'new_revision', v_cur_revision + 1);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_publish_pricing_version_v1(p_version_id uuid, p_reason text, p_actor_id uuid, p_client_revision integer, p_retroactive_justification text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ver ai_pricing_versions%ROWTYPE;
  v_role text;
  v_target_from timestamptz;
  v_is_retroactive boolean;
  v_current ai_pricing_versions%ROWTYPE;
  v_validation jsonb;
  v_snapshot jsonb;
  v_hash text;
  v_final_state text;
  v_existing_id uuid;
BEGIN
  SELECT role INTO v_role FROM admin_users WHERE user_id = p_actor_id AND status = 'active';
  IF v_role IS NULL THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
  IF v_role != 'owner' THEN RAISE EXCEPTION 'UNAUTHORIZED: publishing pricing requires owner role'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing_id FROM ai_pricing_versions
    WHERE publish_idempotency_key = p_idempotency_key;
    IF FOUND THEN
      SELECT * INTO v_ver FROM ai_pricing_versions WHERE id = v_existing_id;
      RETURN jsonb_build_object('version_id', v_ver.id, 'state', v_ver.state, 'config_hash', v_ver.config_hash, 'effective_from', v_ver.effective_from, 'idempotent', true);
    END IF;
  END IF;

  SELECT * INTO v_ver FROM ai_pricing_versions WHERE id = p_version_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pricing version not found: %', p_version_id; END IF;
  IF v_ver.state NOT IN ('draft', 'scheduled') THEN
    RAISE EXCEPTION 'Version is already %, cannot publish', v_ver.state;
  END IF;
  IF v_ver.revision != p_client_revision THEN
    RAISE EXCEPTION 'REVISION_CONFLICT: Expected %, got %', p_client_revision, v_ver.revision
      USING ERRCODE = 'P0002';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'A reason is required to publish a pricing version';
  END IF;

  v_validation := admin_validate_pricing_version_v1(p_version_id);
  IF NOT (v_validation->>'valid')::boolean THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: %', v_validation->'errors';
  END IF;

  v_target_from := COALESCE(v_ver.effective_from, now());
  v_is_retroactive := v_target_from < now();

  IF v_is_retroactive THEN
    IF p_retroactive_justification IS NULL OR length(trim(p_retroactive_justification)) < 10 THEN
      RAISE EXCEPTION 'RETROACTIVE_JUSTIFICATION_REQUIRED: retroactive publication needs a detailed justification (min 10 chars)';
    END IF;
  END IF;

  v_snapshot := _build_pricing_snapshot(p_version_id);
  v_hash := md5(v_snapshot::text);

  v_final_state := CASE WHEN v_target_from <= now() THEN 'published' ELSE 'scheduled' END;

  IF v_final_state = 'published' THEN
    SELECT * INTO v_current FROM ai_pricing_versions
    WHERE environment = v_ver.environment AND state = 'published' FOR UPDATE;
    IF FOUND THEN
      UPDATE ai_pricing_versions SET state = 'superseded', effective_to = v_target_from
      WHERE id = v_current.id;
    END IF;
  END IF;

  UPDATE ai_pricing_versions SET
    state                      = v_final_state,
    effective_from             = v_target_from,
    published_by               = p_actor_id,
    published_at               = now(),
    reason                     = p_reason,
    is_retroactive             = v_is_retroactive,
    retroactive_justification  = p_retroactive_justification,
    snapshot                   = v_snapshot,
    config_hash                = v_hash,
    revision                   = revision + 1,
    publish_idempotency_key    = p_idempotency_key
  WHERE id = p_version_id;

  RETURN jsonb_build_object(
    'version_id', p_version_id,
    'state', v_final_state,
    'config_hash', v_hash,
    'effective_from', v_target_from
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_publish_security_policy_v1(p_environment text, p_reason text, p_change_type text, p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cfg admin_security_configs%ROWTYPE;
  v_next_version INTEGER;
  v_snapshot jsonb;
  v_hash TEXT;
  v_new_id UUID;
BEGIN
  SELECT * INTO v_cfg FROM admin_security_configs WHERE environment = p_environment FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Environment not found: %', p_environment; END IF;

  SELECT COALESCE(MAX(version_number), 0) + 1 INTO v_next_version
  FROM admin_security_policy_versions WHERE environment = p_environment;

  v_snapshot := _build_security_policy_snapshot_v1(p_environment);
  v_hash := md5(v_snapshot::text);

  INSERT INTO admin_security_policy_versions (environment, version_number, snapshot, config_hash, change_type, reason, published_by, previous_version_id)
  VALUES (p_environment, v_next_version, v_snapshot, v_hash, p_change_type, p_reason, p_actor_id, v_cfg.current_version_id)
  RETURNING id INTO v_new_id;

  IF v_cfg.current_version_id IS NOT NULL THEN
    UPDATE admin_security_policy_versions SET state = 'superseded' WHERE id = v_cfg.current_version_id;
  END IF;

  UPDATE admin_security_configs SET
    current_version_id = v_new_id, revision = v_cfg.revision + 1, config_hash = v_hash,
    updated_by = p_actor_id, updated_at = now()
  WHERE environment = p_environment;

  RETURN jsonb_build_object('version_number', v_next_version, 'config_hash', v_hash, 'new_revision', v_cfg.revision + 1);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_quarantine_listening_audio_v1(p_block_id uuid, p_reason text, p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active' AND role IN ('owner','admin')) THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN RAISE EXCEPTION 'A reason is required to quarantine an audio block'; END IF;
  IF NOT EXISTS (SELECT 1 FROM listening_blocks WHERE id = p_block_id) THEN
    RAISE EXCEPTION 'Block not found: %', p_block_id;
  END IF;

  INSERT INTO listening_audio_flags (block_id, quarantined_at, quarantined_by, quarantine_reason)
  VALUES (p_block_id, now(), p_actor_id, p_reason)
  ON CONFLICT (block_id) DO UPDATE SET
    quarantined_at = now(), quarantined_by = p_actor_id, quarantine_reason = p_reason,
    restored_at = NULL, restored_by = NULL, restore_reason = NULL;

  RETURN jsonb_build_object('block_id', p_block_id, 'quarantined', true);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_record_cost_valuation_v1(p_event_id uuid, p_pricing_version_id uuid, p_status text, p_currency text, p_cost_input numeric, p_cost_output numeric, p_cost_cache numeric, p_cost_audio numeric, p_cost_tts numeric, p_cost_fixed numeric, p_cost_other numeric, p_cost_total numeric, p_components jsonb, p_engine_version text, p_input_hash text, p_original_cost_total numeric, p_original_currency text, p_original_cost_status text, p_divergence_status text, p_divergence_abs numeric, p_divergence_pct numeric, p_reason text, p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prior_id    uuid;
  v_existing_id uuid;
  v_new_id      uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active') THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ai_usage_events WHERE id = p_event_id) THEN
    RAISE EXCEPTION 'Ledger event not found: %', p_event_id;
  END IF;

  SELECT id INTO v_existing_id FROM ai_cost_valuations
  WHERE event_id = p_event_id
    AND pricing_version_id IS NOT DISTINCT FROM p_pricing_version_id
    AND input_hash = p_input_hash
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    RETURN jsonb_build_object('inserted', false, 'id', v_existing_id, 'idempotent', true);
  END IF;

  SELECT id INTO v_prior_id FROM ai_cost_valuations
  WHERE event_id = p_event_id
  ORDER BY created_at DESC LIMIT 1;

  INSERT INTO ai_cost_valuations (
    event_id, pricing_version_id, status, currency,
    cost_input, cost_output, cost_cache, cost_audio, cost_tts, cost_fixed, cost_other, cost_total,
    components, engine_version, input_hash,
    original_cost_total, original_currency, original_cost_status,
    divergence_status, divergence_abs, divergence_pct,
    superseded_valuation_id, reason, created_by
  ) VALUES (
    p_event_id, p_pricing_version_id, p_status, p_currency,
    p_cost_input, p_cost_output, p_cost_cache, p_cost_audio, p_cost_tts, p_cost_fixed, p_cost_other, p_cost_total,
    p_components, p_engine_version, p_input_hash,
    p_original_cost_total, p_original_currency, p_original_cost_status,
    p_divergence_status, p_divergence_abs, p_divergence_pct,
    v_prior_id, p_reason, p_actor_id
  )
  ON CONFLICT (event_id, pricing_version_id, input_hash) DO NOTHING
  RETURNING id INTO v_new_id;

  IF v_new_id IS NOT NULL THEN
    RETURN jsonb_build_object('inserted', true, 'id', v_new_id);
  END IF;

  SELECT id INTO v_new_id FROM ai_cost_valuations
  WHERE event_id = p_event_id AND pricing_version_id IS NOT DISTINCT FROM p_pricing_version_id AND input_hash = p_input_hash;
  RETURN jsonb_build_object('inserted', false, 'id', v_new_id, 'idempotent', true);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_record_security_event_v1(p_environment text, p_event_type text, p_severity text, p_actor_user_id uuid, p_target_user_id uuid, p_detail jsonb, p_correlation_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_id UUID;
BEGIN
  INSERT INTO admin_security_events (environment, event_type, severity, actor_user_id, target_user_id, detail, correlation_id)
  VALUES (COALESCE(p_environment, 'production'), p_event_type, COALESCE(p_severity, 'info'), p_actor_user_id, p_target_user_id, p_detail, p_correlation_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_register_config_definition_v1(p_key text, p_label text, p_category text, p_description text, p_value_type text, p_value_schema jsonb, p_default_value jsonb, p_applicable_environments text[], p_exposure text, p_risk_level text, p_consumer_component text, p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active' AND role = 'owner') THEN
    RAISE EXCEPTION 'UNAUTHORIZED: only owners can register new config definitions';
  END IF;
  IF p_key !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' THEN
    RAISE EXCEPTION 'Invalid key format: %', p_key;
  END IF;
  IF p_key ~* '(secret|token|password|api[_-]?key|private[_-]?key|service[_-]?role)' THEN
    RAISE EXCEPTION 'REJECTED_SECRET_LIKE_KEY: keys resembling credentials are never allowed in the config catalog';
  END IF;
  IF p_category NOT IN ('signup', 'maintenance', 'audio_azure', 'audio_openai', 'features', 'product') THEN
    RAISE EXCEPTION 'Invalid category: %', p_category;
  END IF;
  IF p_value_type NOT IN ('boolean', 'integer', 'decimal', 'string', 'enum', 'url', 'object', 'list') THEN
    RAISE EXCEPTION 'Invalid value_type: %', p_value_type;
  END IF;
  IF p_exposure NOT IN ('public', 'server_only') THEN
    RAISE EXCEPTION 'Invalid exposure: %', p_exposure;
  END IF;

  INSERT INTO app_config_definitions (
    key, label, category, description, value_type, value_schema, default_value,
    applicable_environments, exposure, risk_level, consumer_component, created_by
  ) VALUES (
    p_key, p_label, p_category, p_description, p_value_type, p_value_schema, p_default_value,
    p_applicable_environments, p_exposure, COALESCE(p_risk_level, 'low'), p_consumer_component, p_actor_id
  );

  RETURN jsonb_build_object('key', p_key);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_resolve_alert_v1(p_alert_id uuid, p_reason text, p_actor_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active') THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  UPDATE ai_alerts SET
    status         = 'resolved',
    resolved_by    = p_actor_id,
    resolved_at    = now(),
    resolve_reason = p_reason,
    updated_at     = now()
  WHERE id = p_alert_id AND status IN ('open', 'acknowledged');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Alert not found or already resolved: %', p_alert_id;
  END IF;
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_resolve_effective_plan_v1(p_user_id uuid, p_at timestamp with time zone DEFAULT now())
 RETURNS TABLE(user_id uuid, access_allowed boolean, plan_id uuid, plan_code text, plan_name text, plan_version_id uuid, version_number integer, assignment_origin text, assignment_id uuid, starts_at timestamp with time zone, ends_at timestamp with time zone, is_suspended boolean, version_policy text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_is_suspended BOOLEAN := FALSE;
  v_assignment RECORD;
  v_default_plan RECORD;
  v_version_id UUID;
  v_version_num INTEGER;
BEGIN
  -- SECURITY FIX (Etapa 13): block cross-user reads from a real end-user
  -- session. auth.uid() is NULL for the service-role client (always passes)
  -- and equals the caller's own id for an authenticated session (only "self"
  -- passes) — see comment above the function for the full rationale.
  IF auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- Check suspension
  SELECT uac.is_suspended INTO v_is_suspended
  FROM user_access_controls uac
  WHERE uac.user_id = p_user_id;
  IF NOT FOUND THEN v_is_suspended := FALSE; END IF;

  -- Find active explicit assignment at p_at
  SELECT upa.id, upa.plan_id, upa.version_policy, upa.pinned_version_id,
         upa.origin, upa.starts_at, upa.ends_at,
         p.code AS plan_code_val, p.name AS plan_name_val
  INTO v_assignment
  FROM user_plan_assignments upa
  JOIN plans p ON p.id = upa.plan_id
  WHERE upa.user_id = p_user_id
  AND upa.status IN ('active', 'scheduled')
  AND upa.starts_at <= p_at
  AND (upa.ends_at IS NULL OR upa.ends_at > p_at)
  ORDER BY upa.starts_at DESC
  LIMIT 1;

  IF FOUND THEN
    -- Resolve version
    IF v_assignment.version_policy = 'pinned_version' THEN
      SELECT pv.id, pv.version_number INTO v_version_id, v_version_num
      FROM plan_versions pv
      WHERE pv.id = v_assignment.pinned_version_id AND pv.status = 'published';
    ELSE
      SELECT pv.id, pv.version_number INTO v_version_id, v_version_num
      FROM plan_versions pv
      WHERE pv.plan_id = v_assignment.plan_id AND pv.status = 'published' AND pv.effective_to IS NULL;
    END IF;

    RETURN QUERY SELECT
      p_user_id,
      NOT v_is_suspended,
      v_assignment.plan_id,
      v_assignment.plan_code_val,
      v_assignment.plan_name_val,
      v_version_id,
      v_version_num,
      v_assignment.origin::TEXT,
      v_assignment.id,
      v_assignment.starts_at,
      v_assignment.ends_at,
      v_is_suspended,
      v_assignment.version_policy;
    RETURN;
  END IF;

  -- Fallback: default active plan
  SELECT p.id, p.code, p.name INTO v_default_plan
  FROM plans p
  WHERE p.is_default = TRUE AND p.status = 'active'
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      p_user_id, NOT v_is_suspended,
      NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::UUID, NULL::INTEGER,
      'default'::TEXT, NULL::UUID, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ,
      v_is_suspended, NULL::TEXT;
    RETURN;
  END IF;

  SELECT pv.id, pv.version_number INTO v_version_id, v_version_num
  FROM plan_versions pv
  WHERE pv.plan_id = v_default_plan.id AND pv.status = 'published' AND pv.effective_to IS NULL;

  RETURN QUERY SELECT
    p_user_id, NOT v_is_suspended,
    v_default_plan.id, v_default_plan.code, v_default_plan.name,
    v_version_id, v_version_num,
    'default'::TEXT, NULL::UUID, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ,
    v_is_suspended, 'follow_current_published'::TEXT;
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_resolve_eligible_listening_episodes_v1(p_cefr_level text, p_exclude_episode_ids uuid[] DEFAULT '{}'::uuid[], p_limit integer DEFAULT 10)
 RETURNS TABLE(episode_id uuid, priority integer, available_from timestamp with time zone, available_to timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT d.episode_id, d.priority, d.available_from, d.available_to
  FROM listening_episode_distribution d
  WHERE d.state = 'published'
    AND (d.available_from IS NULL OR d.available_from <= now())
    AND (d.available_to IS NULL OR d.available_to > now())
    AND (p_cefr_level = ANY(d.eligible_levels) OR cardinality(d.eligible_levels) = 0)
    AND NOT (d.episode_id = ANY(p_exclude_episode_ids))
  ORDER BY d.priority ASC, d.available_from ASC NULLS LAST
  LIMIT LEAST(GREATEST(p_limit, 1), 100);
$function$;


CREATE OR REPLACE FUNCTION public.admin_resolve_pricing_version_for_event_v1(p_environment text, p_started_at timestamp with time zone)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT id FROM ai_pricing_versions
  WHERE environment = p_environment
    AND state IN ('published', 'superseded')
    AND effective_from <= p_started_at
    AND (effective_to IS NULL OR p_started_at < effective_to)
  ORDER BY effective_from DESC
  LIMIT 1;
$function$;


CREATE OR REPLACE FUNCTION public.admin_restore_listening_audio_v1(p_block_id uuid, p_reason text, p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_quarantined_at timestamptz;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active' AND role IN ('owner','admin')) THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  SELECT quarantined_at INTO v_quarantined_at FROM listening_audio_flags WHERE block_id = p_block_id;
  IF v_quarantined_at IS NULL THEN RAISE EXCEPTION 'Block % is not currently quarantined', p_block_id; END IF;

  UPDATE listening_audio_flags SET
    restored_at = now(), restored_by = p_actor_id, restore_reason = p_reason,
    quarantined_at = NULL, quarantined_by = NULL, quarantine_reason = NULL
  WHERE block_id = p_block_id;

  RETURN jsonb_build_object('block_id', p_block_id, 'restored', true);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_resume_listening_distribution_v1(p_episode_id uuid, p_reason text, p_actor_id uuid, p_client_revision integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_dist listening_episode_distribution%ROWTYPE; v_final_state text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active' AND role IN ('owner','admin')) THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN RAISE EXCEPTION 'A reason is required to resume a distribution'; END IF;

  SELECT * INTO v_dist FROM listening_episode_distribution WHERE episode_id = p_episode_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Distribution not found for episode: %', p_episode_id; END IF;
  IF v_dist.revision <> p_client_revision THEN
    RAISE EXCEPTION 'REVISION_CONFLICT: Expected %, got %', p_client_revision, v_dist.revision USING ERRCODE = 'P0002';
  END IF;
  IF v_dist.state <> 'paused' THEN RAISE EXCEPTION 'Distribution is %, cannot resume', v_dist.state; END IF;

  v_final_state := CASE WHEN v_dist.available_from IS NOT NULL AND v_dist.available_from > now() THEN 'scheduled' ELSE 'published' END;

  UPDATE listening_episode_distribution SET state = v_final_state, revision = revision + 1, updated_by = p_actor_id WHERE episode_id = p_episode_id;

  INSERT INTO listening_episode_publications (episode_id, action, previous_state, new_state, reason, actor_id)
  VALUES (p_episode_id, 'resume', 'paused', v_final_state, p_reason, p_actor_id);

  RETURN jsonb_build_object('episode_id', p_episode_id, 'state', v_final_state, 'new_revision', v_dist.revision + 1);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_revoke_all_sessions_v1(p_target_user_id uuid, p_actor_id uuid, p_reason text, p_except_current boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'auth', 'public'
AS $function$
DECLARE
  v_actor_role TEXT;
  v_current_session_id UUID;
  v_deleted INTEGER;
BEGIN
  IF p_target_user_id <> p_actor_id THEN
    SELECT role INTO v_actor_role FROM public.admin_users WHERE user_id = p_actor_id AND status = 'active';
    IF v_actor_role IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.admin_role_permissions WHERE role = v_actor_role AND permission_key = 'admins.sessions.revoke'
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');
    END IF;
  END IF;

  IF p_except_current THEN
    BEGIN
      v_current_session_id := (auth.jwt() ->> 'session_id')::uuid;
    EXCEPTION WHEN OTHERS THEN
      v_current_session_id := NULL;
    END;
  END IF;

  DELETE FROM auth.sessions
  WHERE user_id = p_target_user_id
    AND (v_current_session_id IS NULL OR id <> v_current_session_id);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN jsonb_build_object('success', true, 'revoked_count', v_deleted);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_revoke_control_switch_v1(p_switch_id uuid, p_reason text, p_actor_id uuid, p_client_revision integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_env text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active') THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  UPDATE ai_control_switches SET
    revoked_at    = now(),
    revoked_by    = p_actor_id,
    revoke_reason = p_reason,
    updated_at    = now()
  WHERE id = p_switch_id AND revoked_at IS NULL
  RETURNING environment INTO v_env;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Switch not found or already revoked: %', p_switch_id;
  END IF;

  RETURN admin_publish_gateway_config_v1(
    v_env, p_reason, 'switch_update', p_actor_id, p_client_revision, false, NULL
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_revoke_invitation_v1(p_invitation_id uuid, p_actor_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_actor_role TEXT;
BEGIN
  SELECT role INTO v_actor_role FROM admin_users WHERE user_id = p_actor_id AND status = 'active';
  IF v_actor_role IS NULL OR NOT EXISTS (SELECT 1 FROM admin_role_permissions WHERE role = v_actor_role AND permission_key = 'admins.invite') THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN RAISE EXCEPTION 'A reason is required to revoke an invitation'; END IF;

  UPDATE admin_invitations SET status = 'revoked', revoked_at = now(), revoked_by = p_actor_id, revoke_reason = p_reason
  WHERE id = p_invitation_id AND status = 'pending';

  IF NOT FOUND THEN RAISE EXCEPTION 'Invitation not found or not pending: %', p_invitation_id; END IF;
  RETURN jsonb_build_object('invitation_id', p_invitation_id, 'status', 'revoked');
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_revoke_session_v1(p_session_id uuid, p_actor_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'auth', 'public'
AS $function$
DECLARE
  v_session_owner UUID;
  v_actor_role TEXT;
BEGIN
  SELECT user_id INTO v_session_owner FROM auth.sessions WHERE id = p_session_id;
  IF v_session_owner IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'NOT_FOUND');
  END IF;

  IF v_session_owner <> p_actor_id THEN
    SELECT role INTO v_actor_role FROM public.admin_users WHERE user_id = p_actor_id AND status = 'active';
    IF v_actor_role IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.admin_role_permissions WHERE role = v_actor_role AND permission_key = 'admins.sessions.revoke'
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');
    END IF;
  END IF;

  DELETE FROM auth.sessions WHERE id = p_session_id;
  RETURN jsonb_build_object('success', true, 'target_user_id', v_session_owner);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_rollback_config_v1(p_environment text, p_target_version_num integer, p_reason text, p_actor_id uuid, p_client_revision integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_target  ai_gateway_config_versions%ROWTYPE;
  v_snap    jsonb;
  v_cfg     ai_gateway_configs%ROWTYPE;
  v_result  jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active') THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  SELECT * INTO v_target
  FROM ai_gateway_config_versions
  WHERE environment = p_environment AND version_number = p_target_version_num;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target version not found: %', p_target_version_num;
  END IF;

  v_snap := v_target.snapshot;

  SELECT * INTO v_cfg FROM ai_gateway_configs WHERE environment = p_environment FOR UPDATE;
  IF v_cfg.revision != p_client_revision THEN
    RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE = 'P0002';
  END IF;

  -- Restore config settings from the target snapshot
  UPDATE ai_gateway_configs SET
    gateway_mode      = v_snap->>'gateway_mode',
    ai_enabled        = (v_snap->>'ai_enabled')::boolean,
    emergency_stop    = (v_snap->>'emergency_stop')::boolean,
    failure_strategy  = v_snap->>'failure_strategy',
    cache_ttl_seconds = (v_snap->>'cache_ttl_seconds')::integer,
    max_stale_seconds = (v_snap->>'max_stale_seconds')::integer,
    updated_by        = p_actor_id,
    updated_at        = now()
  WHERE environment = p_environment;

  -- Note: We do NOT restore switches/budgets from the snapshot — they are live tables.
  -- Rollback only restores config-level settings. Document this in the UI.

  v_result := admin_publish_gateway_config_v1(
    p_environment, p_reason, 'rollback', p_actor_id, p_client_revision, false, NULL
  );

  RETURN v_result;
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_set_status_v1(p_target_user_id uuid, p_new_status text, p_actor_id uuid, p_reason text, p_client_revision integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor_role TEXT;
  v_target admin_users%ROWTYPE;
  v_permission_key TEXT;
BEGIN
  SELECT role INTO v_actor_role FROM admin_users WHERE user_id = p_actor_id AND status = 'active';
  IF v_actor_role IS NULL THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;

  IF p_target_user_id = p_actor_id AND p_new_status <> 'active' THEN
    PERFORM admin_record_security_event_v1('production', 'self_elevation_attempt', 'critical', p_actor_id, p_actor_id,
      jsonb_build_object('attempted_status', p_new_status), NULL);
    RAISE EXCEPTION 'SELF_DEACTIVATION_BLOCKED: an administrator cannot deactivate their own account through this path';
  END IF;

  v_permission_key := CASE WHEN p_new_status = 'active' THEN 'admins.manage' ELSE 'admins.deactivate' END;
  IF NOT EXISTS (SELECT 1 FROM admin_role_permissions WHERE role = v_actor_role AND permission_key = v_permission_key) THEN
    RAISE EXCEPTION 'UNAUTHORIZED: missing %', v_permission_key;
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'A reason is required to change administrator status';
  END IF;

  SELECT * INTO v_target FROM admin_users WHERE user_id = p_target_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Administrator not found: %', p_target_user_id; END IF;
  IF v_target.revision <> p_client_revision THEN
    RAISE EXCEPTION 'REVISION_CONFLICT: Expected %, got %', p_client_revision, v_target.revision USING ERRCODE = 'P0002';
  END IF;

  BEGIN
    UPDATE admin_users SET
      status = p_new_status, revision = revision + 1,
      status_changed_at = now(), status_changed_by = p_actor_id, status_change_reason = p_reason
    WHERE user_id = p_target_user_id;
  EXCEPTION WHEN SQLSTATE 'P0003' THEN
    PERFORM admin_record_security_event_v1('production', 'last_owner_protection_triggered', 'warning', p_actor_id, p_target_user_id,
      jsonb_build_object('attempted_status', p_new_status), NULL);
    RETURN jsonb_build_object('success', false, 'error', 'LAST_OWNER_PROTECTED');
  END;

  IF p_new_status <> 'active' THEN
    -- Revoking admin access also revokes all of that admin's live sessions —
    -- a deactivated admin must not keep an already-authenticated session alive.
    -- This is an unconditional side effect of deactivation (already authorized
    -- above via admins.deactivate), NOT gated separately by admins.sessions.revoke
    -- — deleting directly here (rather than calling admin_revoke_all_sessions_v1,
    -- which has its own independent permission gate for the standalone "revoke
    -- sessions" action) avoids silently skipping revocation via PERFORM if that
    -- separate permission happens to be missing.
    DELETE FROM auth.sessions WHERE user_id = p_target_user_id;
    PERFORM admin_record_security_event_v1('production', 'sessions_revoked', 'info', p_actor_id, p_target_user_id, jsonb_build_object('reason', 'admin_deactivated'), NULL);
    PERFORM admin_record_security_event_v1('production', 'admin_deactivated', 'warning', p_actor_id, p_target_user_id, jsonb_build_object('reason', p_reason), NULL);
  ELSE
    PERFORM admin_record_security_event_v1('production', 'admin_activated', 'info', p_actor_id, p_target_user_id, jsonb_build_object('reason', p_reason), NULL);
  END IF;

  RETURN jsonb_build_object('success', true, 'new_revision', v_target.revision + 1);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_toggle_budget_policy_v1(p_budget_id uuid, p_active boolean, p_reason text, p_actor_id uuid, p_client_revision integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_env text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active') THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  UPDATE ai_budget_policies SET active = p_active, updated_at = now(), updated_by = p_actor_id
  WHERE id = p_budget_id
  RETURNING environment INTO v_env;

  IF NOT FOUND THEN RAISE EXCEPTION 'Budget not found: %', p_budget_id; END IF;

  RETURN admin_publish_gateway_config_v1(
    v_env, p_reason, 'budget_update', p_actor_id, p_client_revision, false, NULL
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_update_gateway_mode_v1(p_environment text, p_gateway_mode text, p_ai_enabled boolean, p_failure_strategy text, p_cache_ttl integer, p_max_stale integer, p_reason text, p_change_type text, p_published_by uuid, p_client_revision integer, p_is_emergency boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_published_by AND status = 'active') THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  UPDATE ai_gateway_configs SET
    gateway_mode     = p_gateway_mode,
    ai_enabled       = p_ai_enabled,
    failure_strategy = p_failure_strategy,
    cache_ttl_seconds = p_cache_ttl,
    max_stale_seconds = p_max_stale,
    updated_by       = p_published_by,
    updated_at       = now()
  WHERE environment = p_environment AND revision = p_client_revision;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'REVISION_CONFLICT or environment not found'
      USING ERRCODE = 'P0002';
  END IF;

  RETURN admin_publish_gateway_config_v1(
    p_environment, p_reason, p_change_type, p_published_by,
    p_client_revision, p_is_emergency, NULL
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_update_pricing_draft_v1(p_version_id uuid, p_name text, p_description text, p_currencies text[], p_effective_from timestamp with time zone, p_effective_to timestamp with time zone, p_actor_id uuid, p_client_revision integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ver ai_pricing_versions%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active'
                 AND role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  SELECT * INTO v_ver FROM ai_pricing_versions WHERE id = p_version_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pricing version not found: %', p_version_id; END IF;
  IF v_ver.state NOT IN ('draft', 'scheduled') THEN
    RAISE EXCEPTION 'Only draft or scheduled versions can be edited (current state: %)', v_ver.state;
  END IF;
  IF v_ver.revision != p_client_revision THEN
    RAISE EXCEPTION 'REVISION_CONFLICT: Expected %, got %', p_client_revision, v_ver.revision
      USING ERRCODE = 'P0002';
  END IF;

  UPDATE ai_pricing_versions SET
    name           = p_name,
    description    = p_description,
    currencies     = COALESCE(p_currencies, '{}'),
    effective_from = p_effective_from,
    effective_to   = p_effective_to,
    revision       = revision + 1
  WHERE id = p_version_id;

  RETURN jsonb_build_object('version_id', p_version_id, 'new_revision', v_ver.revision + 1);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_update_security_policy_v1(p_environment text, p_mfa_required boolean, p_recent_auth_window_seconds integer, p_max_admin_session_hours integer, p_max_idle_minutes integer, p_invitation_expiry_hours integer, p_rate_limit_max_attempts integer, p_rate_limit_window_seconds integer, p_lockout_duration_seconds integer, p_min_reason_length integer, p_reason text, p_actor_id uuid, p_client_revision integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cfg admin_security_configs%ROWTYPE;
  v_change_type TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active' AND role = 'owner') THEN
    RAISE EXCEPTION 'UNAUTHORIZED: only owner may change security policy';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'A reason is required to change security policy';
  END IF;

  SELECT * INTO v_cfg FROM admin_security_configs WHERE environment = p_environment FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Environment not found: %', p_environment; END IF;
  IF v_cfg.revision <> p_client_revision THEN
    RAISE EXCEPTION 'REVISION_CONFLICT: Expected %, got %', p_client_revision, v_cfg.revision USING ERRCODE = 'P0002';
  END IF;

  -- Never allow enabling mandatory MFA before at least one active owner has a
  -- verified TOTP factor — that would lock every admin out simultaneously.
  IF p_mfa_required AND NOT v_cfg.mfa_required THEN
    IF NOT EXISTS (
      SELECT 1 FROM auth.mfa_factors mf
      JOIN admin_users au ON au.user_id = mf.user_id
      WHERE au.role = 'owner' AND au.status = 'active'
        AND mf.factor_type = 'totp' AND mf.status = 'verified'
    ) THEN
      RAISE EXCEPTION 'MFA_REQUIRES_VERIFIED_OWNER_FACTOR: at least one active owner must have a verified TOTP factor first';
    END IF;
  END IF;

  v_change_type := CASE
    WHEN p_mfa_required IS DISTINCT FROM v_cfg.mfa_required THEN 'mfa_required_change'
    WHEN p_recent_auth_window_seconds IS DISTINCT FROM v_cfg.recent_auth_window_seconds THEN 'recent_auth_change'
    WHEN p_max_admin_session_hours IS DISTINCT FROM v_cfg.max_admin_session_hours OR p_max_idle_minutes IS DISTINCT FROM v_cfg.max_idle_minutes THEN 'session_change'
    WHEN p_invitation_expiry_hours IS DISTINCT FROM v_cfg.invitation_expiry_hours THEN 'invitation_expiry_change'
    WHEN p_rate_limit_max_attempts IS DISTINCT FROM v_cfg.rate_limit_max_attempts
      OR p_rate_limit_window_seconds IS DISTINCT FROM v_cfg.rate_limit_window_seconds
      OR p_lockout_duration_seconds IS DISTINCT FROM v_cfg.lockout_duration_seconds THEN 'rate_limit_change'
    ELSE 'update'
  END;

  UPDATE admin_security_configs SET
    mfa_required = p_mfa_required,
    recent_auth_window_seconds = p_recent_auth_window_seconds,
    max_admin_session_hours = p_max_admin_session_hours,
    max_idle_minutes = p_max_idle_minutes,
    invitation_expiry_hours = p_invitation_expiry_hours,
    rate_limit_max_attempts = p_rate_limit_max_attempts,
    rate_limit_window_seconds = p_rate_limit_window_seconds,
    lockout_duration_seconds = p_lockout_duration_seconds,
    min_reason_length = p_min_reason_length
  WHERE environment = p_environment;

  RETURN admin_publish_security_policy_v1(p_environment, p_reason, v_change_type, p_actor_id);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_upsert_alert_rule_v1(p_id uuid, p_environment text, p_alert_type text, p_scope text, p_window_seconds integer, p_threshold_value numeric, p_min_event_count integer, p_severity text, p_active boolean, p_cooldown_seconds integer, p_actor_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active') THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO ai_alert_rules (
      environment, alert_type, scope, window_seconds, threshold_value,
      min_event_count, severity, active, cooldown_seconds, created_by
    ) VALUES (
      p_environment, p_alert_type, p_scope, p_window_seconds, p_threshold_value,
      p_min_event_count, p_severity, p_active, p_cooldown_seconds, p_actor_id
    ) RETURNING id INTO v_id;
  ELSE
    UPDATE ai_alert_rules SET
      alert_type        = p_alert_type,
      scope             = p_scope,
      window_seconds    = p_window_seconds,
      threshold_value   = p_threshold_value,
      min_event_count   = p_min_event_count,
      severity          = p_severity,
      active            = p_active,
      cooldown_seconds  = p_cooldown_seconds,
      updated_at        = now()
    WHERE id = p_id AND environment = p_environment
    RETURNING id INTO v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Alert rule not found: %', p_id; END IF;
  END IF;

  RETURN v_id;
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_upsert_alert_v1(p_environment text, p_rule_id uuid, p_alert_type text, p_scope text, p_severity text, p_title text, p_detail jsonb, p_dedup_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id     uuid;
  v_is_new boolean;
BEGIN
  -- Check cooldown: if a resolved alert with this dedup_key was resolved within cooldown, skip
  IF EXISTS (
    SELECT 1 FROM ai_alerts a
    JOIN ai_alert_rules r ON r.id = p_rule_id
    WHERE a.dedup_key = p_dedup_key AND a.environment = p_environment AND a.status = 'resolved'
      AND a.resolved_at > now() - (r.cooldown_seconds || ' seconds')::interval
  ) THEN
    RETURN jsonb_build_object('action', 'cooldown_active');
  END IF;

  -- Idempotent insert (dedup index prevents duplicates)
  INSERT INTO ai_alerts (environment, rule_id, alert_type, scope, severity, status, title, detail, dedup_key)
  VALUES (p_environment, p_rule_id, p_alert_type, p_scope, p_severity, 'open', p_title, p_detail, p_dedup_key)
  ON CONFLICT (dedup_key, environment) WHERE status != 'resolved' DO NOTHING
  RETURNING id INTO v_id;

  v_is_new := v_id IS NOT NULL;

  RETURN jsonb_build_object('action', CASE WHEN v_is_new THEN 'created' ELSE 'deduped' END, 'id', v_id);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_upsert_budget_policy_v1(p_id uuid, p_environment text, p_name text, p_scope text, p_scope_value text, p_metric text, p_currency text, p_limit_value numeric, p_period text, p_timezone text, p_alert_thresholds integer[], p_action text, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_priority integer, p_reason text, p_actor_id uuid, p_client_revision integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_budget_id uuid;
  v_result    jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active') THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO ai_budget_policies (
      environment, name, scope, scope_value, metric, currency, limit_value,
      period, timezone, alert_thresholds, action, starts_at, ends_at,
      priority, reason, created_by, updated_by, revision
    ) VALUES (
      p_environment, p_name, p_scope, p_scope_value, p_metric, p_currency, p_limit_value,
      p_period, p_timezone, p_alert_thresholds, p_action, p_starts_at, p_ends_at,
      p_priority, p_reason, p_actor_id, p_actor_id, 1
    ) RETURNING id INTO v_budget_id;
  ELSE
    UPDATE ai_budget_policies SET
      name              = p_name,
      scope             = p_scope,
      scope_value       = p_scope_value,
      metric            = p_metric,
      currency          = p_currency,
      limit_value       = p_limit_value,
      period            = p_period,
      timezone          = p_timezone,
      alert_thresholds  = p_alert_thresholds,
      action            = p_action,
      starts_at         = p_starts_at,
      ends_at           = p_ends_at,
      priority          = p_priority,
      reason            = p_reason,
      updated_by        = p_actor_id,
      revision          = revision + 1,
      updated_at        = now()
    WHERE id = p_id AND environment = p_environment
    RETURNING id INTO v_budget_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Budget not found: %', p_id;
    END IF;
  END IF;

  v_result := admin_publish_gateway_config_v1(
    p_environment, p_reason, 'budget_update', p_actor_id, p_client_revision, false, NULL
  );

  RETURN jsonb_build_object('budget_id', v_budget_id) || v_result;
END;
$function$;



CREATE OR REPLACE FUNCTION public.admin_upsert_config_value_v1(p_version_id uuid, p_definition_key text, p_value jsonb, p_actor_id uuid, p_client_revision integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id  uuid;
  v_cur_revision integer;
  v_value_type text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active'
                 AND role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  SELECT value_type INTO v_value_type FROM app_config_definitions WHERE key = p_definition_key AND active = true;
  IF v_value_type IS NULL THEN
    RAISE EXCEPTION 'Unknown or inactive config definition: %', p_definition_key;
  END IF;

  IF v_value_type = 'boolean' AND jsonb_typeof(p_value) != 'boolean' THEN
    RAISE EXCEPTION 'Value for % must be boolean', p_definition_key;
  ELSIF v_value_type IN ('integer', 'decimal') AND jsonb_typeof(p_value) != 'number' THEN
    RAISE EXCEPTION 'Value for % must be numeric', p_definition_key;
  ELSIF v_value_type IN ('string', 'enum', 'url') AND jsonb_typeof(p_value) != 'string' THEN
    RAISE EXCEPTION 'Value for % must be a string', p_definition_key;
  ELSIF v_value_type = 'object' AND jsonb_typeof(p_value) != 'object' THEN
    RAISE EXCEPTION 'Value for % must be an object', p_definition_key;
  ELSIF v_value_type = 'list' AND jsonb_typeof(p_value) != 'array' THEN
    RAISE EXCEPTION 'Value for % must be an array', p_definition_key;
  END IF;

  SELECT id, revision INTO v_id, v_cur_revision
  FROM app_config_values WHERE version_id = p_version_id AND definition_key = p_definition_key;

  IF v_id IS NULL THEN
    INSERT INTO app_config_values (version_id, definition_key, value, updated_by)
    VALUES (p_version_id, p_definition_key, p_value, p_actor_id)
    RETURNING id INTO v_id;
  ELSE
    IF p_client_revision IS NOT NULL AND v_cur_revision != p_client_revision THEN
      RAISE EXCEPTION 'REVISION_CONFLICT: Expected %, got %', p_client_revision, v_cur_revision
        USING ERRCODE = 'P0002';
    END IF;
    UPDATE app_config_values SET value = p_value, updated_by = p_actor_id, revision = revision + 1
    WHERE id = v_id;
  END IF;

  RETURN jsonb_build_object('value_id', v_id);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_upsert_pricing_rate_v1(p_id uuid, p_version_id uuid, p_provider text, p_model text, p_operation text, p_metric_key text, p_feature_key text, p_region text, p_unit_type text, p_unit_size numeric, p_unit_price numeric, p_currency text, p_priority integer, p_source text, p_source_url text, p_verified boolean, p_notes text, p_actor_id uuid, p_client_revision integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rate_id uuid;
  v_cur_revision integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active'
                 AND role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO ai_pricing_rates (
      version_id, provider, model, operation, metric_key, feature_key, region,
      unit_type, unit_size, unit_price, currency, priority, source, source_url,
      verified_at, verified_by, notes, created_by
    ) VALUES (
      p_version_id, p_provider, p_model, p_operation, p_metric_key, p_feature_key, p_region,
      p_unit_type, p_unit_size, p_unit_price, p_currency, p_priority, p_source, p_source_url,
      CASE WHEN p_verified THEN now() ELSE NULL END,
      CASE WHEN p_verified THEN p_actor_id ELSE NULL END,
      p_notes, p_actor_id
    ) RETURNING id INTO v_rate_id;
  ELSE
    SELECT revision INTO v_cur_revision FROM ai_pricing_rates WHERE id = p_id;
    IF v_cur_revision IS NULL THEN RAISE EXCEPTION 'Rate not found: %', p_id; END IF;
    IF p_client_revision IS NOT NULL AND v_cur_revision != p_client_revision THEN
      RAISE EXCEPTION 'REVISION_CONFLICT: Expected %, got %', p_client_revision, v_cur_revision
        USING ERRCODE = 'P0002';
    END IF;

    UPDATE ai_pricing_rates SET
      provider    = p_provider,
      model       = p_model,
      operation   = p_operation,
      metric_key  = p_metric_key,
      feature_key = p_feature_key,
      region      = p_region,
      unit_type   = p_unit_type,
      unit_size   = p_unit_size,
      unit_price  = p_unit_price,
      currency    = p_currency,
      priority    = p_priority,
      source      = p_source,
      source_url  = p_source_url,
      verified_at = CASE WHEN p_verified THEN COALESCE(verified_at, now()) ELSE NULL END,
      verified_by = CASE WHEN p_verified THEN COALESCE(verified_by, p_actor_id) ELSE NULL END,
      notes       = p_notes,
      revision    = revision + 1
    WHERE id = p_id
    RETURNING id INTO v_rate_id;
  END IF;

  RETURN jsonb_build_object('rate_id', v_rate_id);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_validate_config_version_v1(p_version_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ver app_config_versions%ROWTYPE;
  v_missing text[];
  v_errors jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_is_high_risk boolean := false;
  v_signup_enabled boolean;
  v_maintenance_mode text;
BEGIN
  SELECT * INTO v_ver FROM app_config_versions WHERE id = p_version_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Config version not found: %', p_version_id; END IF;

  SELECT array_agg(d.key) INTO v_missing
  FROM app_config_definitions d
  WHERE d.active = true AND v_ver.environment = ANY(d.applicable_environments)
    AND NOT EXISTS (SELECT 1 FROM app_config_values val WHERE val.version_id = p_version_id AND val.definition_key = d.key);

  IF v_missing IS NOT NULL AND array_length(v_missing, 1) > 0 THEN
    v_errors := v_errors || jsonb_build_object('key', 'missing_values', 'message', format('Definições sem valor: %s', array_to_string(v_missing, ', ')));
  END IF;

  SELECT (value->>'enabled')::boolean INTO v_signup_enabled
  FROM app_config_values WHERE version_id = p_version_id AND definition_key = 'signup.registration';
  IF v_signup_enabled IS FALSE THEN
    v_is_high_risk := true;
    v_warnings := v_warnings || jsonb_build_object('key', 'signup_closed', 'message', 'Esta versão fecha o cadastro de novos usuários — alteração de alto risco.');
  END IF;

  SELECT value->>'mode' INTO v_maintenance_mode
  FROM app_config_values WHERE version_id = p_version_id AND definition_key = 'maintenance.mode';
  IF v_maintenance_mode = 'unavailable' THEN
    v_is_high_risk := true;
    v_warnings := v_warnings || jsonb_build_object('key', 'maintenance_unavailable', 'message', 'Esta versão coloca o aplicativo em modo indisponível — alteração de alto risco.');
  END IF;

  RETURN jsonb_build_object(
    'valid', jsonb_array_length(v_errors) = 0,
    'errors', v_errors,
    'warnings', v_warnings,
    'is_high_risk', v_is_high_risk
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_validate_listening_episode_v1(p_episode_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_episode listening_episodes%ROWTYPE;
  v_part_count integer;
  v_errors jsonb := '[]'::jsonb;
  v_block record;
  v_question_count integer;
  v_has_active_ingles_job boolean;
  v_has_active_request boolean;
BEGIN
  SELECT * INTO v_episode FROM listening_episodes WHERE id = p_episode_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Episode not found: %', p_episode_id; END IF;

  IF v_episode.cefr_level NOT IN ('A1','A2','B1','B2','C1','C2') THEN
    v_errors := v_errors || jsonb_build_object('key', 'INVALID_CEFR_LEVEL', 'message', format('Nível CEFR inválido: %s', v_episode.cefr_level));
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM listening_jobs WHERE episode_id = p_episode_id AND status IN ('pending','processing','retry')
  ) INTO v_has_active_ingles_job;
  SELECT EXISTS (
    SELECT 1 FROM listening_generation_requests WHERE episode_id = p_episode_id AND status IN ('pending','scheduled','processing')
  ) INTO v_has_active_request;
  IF v_has_active_ingles_job OR v_has_active_request THEN
    v_errors := v_errors || jsonb_build_object('key', 'ACTIVE_JOB_IN_PROGRESS', 'message', 'Existe um job de geração em andamento para este episódio.');
  END IF;

  SELECT COUNT(*) INTO v_part_count FROM listening_blocks WHERE episode_id = p_episode_id;
  IF v_part_count <> 2 THEN
    v_errors := v_errors || jsonb_build_object('key', 'PART_COUNT', 'message', format('Esperado exatamente 2 blocos, encontrado %s.', v_part_count));
  END IF;

  IF (SELECT COUNT(DISTINCT block_order) FROM listening_blocks WHERE episode_id = p_episode_id AND block_order IN (1,2)) <> LEAST(v_part_count, 2) THEN
    v_errors := v_errors || jsonb_build_object('key', 'PART_ORDER_INVALID', 'message', 'Ordem dos blocos deve ser 1 e 2, sem duplicidade.');
  END IF;

  FOR v_block IN SELECT * FROM listening_blocks WHERE episode_id = p_episode_id ORDER BY block_order LOOP
    IF v_block.text_en IS NULL OR length(trim(v_block.text_en)) = 0 THEN
      v_errors := v_errors || jsonb_build_object('key', 'MISSING_TEXT_EN', 'partOrder', v_block.block_order, 'message', format('Bloco %s: texto em inglês ausente.', v_block.block_order));
    END IF;
    IF v_block.translation_pt IS NULL OR length(trim(v_block.translation_pt)) = 0 THEN
      v_errors := v_errors || jsonb_build_object('key', 'MISSING_CAPTION_PT', 'partOrder', v_block.block_order, 'message', format('Bloco %s: tradução em português ausente.', v_block.block_order));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM listening_subtitle_cues c WHERE c.block_id = v_block.id AND c.language = 'en') THEN
      v_errors := v_errors || jsonb_build_object('key', 'MISSING_SUBTITLES_EN', 'partOrder', v_block.block_order, 'message', format('Bloco %s: legendas em inglês ausentes (necessárias para o replay).', v_block.block_order));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM listening_subtitle_cues c WHERE c.block_id = v_block.id AND c.language = 'pt-BR') THEN
      v_errors := v_errors || jsonb_build_object('key', 'MISSING_SUBTITLES_PT', 'partOrder', v_block.block_order, 'message', format('Bloco %s: legendas em português ausentes.', v_block.block_order));
    END IF;

    SELECT COUNT(*) INTO v_question_count FROM listening_questions WHERE block_id = v_block.id;
    IF v_question_count = 0 THEN
      v_errors := v_errors || jsonb_build_object('key', 'MISSING_QUESTION', 'partOrder', v_block.block_order, 'message', format('Bloco %s: nenhuma pergunta cadastrada.', v_block.block_order));
    ELSIF v_question_count > 1 THEN
      v_errors := v_errors || jsonb_build_object('key', 'MULTIPLE_QUESTIONS', 'partOrder', v_block.block_order, 'message', format('Bloco %s: deve haver exatamente uma pergunta.', v_block.block_order));
    END IF;

    -- CORRECTED (Etapa 13 corretiva): audio lives directly on the block —
    -- listening_blocks.audio_path/duration_ms — there is no separate assets
    -- table. Storage file existence cannot be checked from SQL (no network
    -- access from Postgres); this only validates what the database itself
    -- can know, matching the same principle applied dashboard-wide.
    IF v_block.audio_path IS NULL OR length(trim(v_block.audio_path)) = 0
       OR v_block.duration_ms IS NULL OR v_block.duration_ms <= 0 THEN
      v_errors := v_errors || jsonb_build_object('key', 'MISSING_AUDIO', 'partOrder', v_block.block_order, 'message', format('Bloco %s: áudio ausente ou incompleto (audio_path/duration_ms).', v_block.block_order));
    END IF;
  END LOOP;

  RETURN jsonb_build_object('valid', jsonb_array_length(v_errors) = 0, 'errors', v_errors);
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_validate_pricing_version_v1(p_version_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ver ai_pricing_versions%ROWTYPE;
  v_rate_count integer;
  v_currency_count integer;
  v_conflict record;
  v_errors jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_ver FROM ai_pricing_versions WHERE id = p_version_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pricing version not found: %', p_version_id; END IF;

  SELECT COUNT(*), COUNT(DISTINCT currency) INTO v_rate_count, v_currency_count
  FROM ai_pricing_rates WHERE version_id = p_version_id;

  IF v_rate_count = 0 THEN
    v_errors := v_errors || jsonb_build_object('key', 'no_rates', 'message', 'A versão não possui nenhuma tarifa. Publicação bloqueada.');
  END IF;

  FOR v_conflict IN
    SELECT id, version_number, effective_from, effective_to
    FROM ai_pricing_versions
    WHERE environment = v_ver.environment
      AND id != p_version_id
      AND state IN ('published', 'scheduled')
      AND NOT (
        COALESCE(effective_to, 'infinity'::timestamptz) <= COALESCE(v_ver.effective_from, now())
        OR COALESCE(v_ver.effective_to, 'infinity'::timestamptz) <= COALESCE(effective_from, now())
      )
  LOOP
    v_errors := v_errors || jsonb_build_object(
      'key', 'period_conflict',
      'message', format('Período conflita com a versão %s (%s a %s)', v_conflict.version_number, v_conflict.effective_from, v_conflict.effective_to)
    );
  END LOOP;

  IF v_ver.effective_from IS NOT NULL AND v_ver.effective_from < now() THEN
    v_warnings := v_warnings || jsonb_build_object('key', 'retroactive', 'message', 'Data de início efetiva é no passado — publicação retroativa exige owner e justificativa.');
  END IF;

  RETURN jsonb_build_object(
    'valid', jsonb_array_length(v_errors) = 0,
    'errors', v_errors,
    'warnings', v_warnings,
    'rate_count', v_rate_count,
    'currency_count', v_currency_count
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.admin_withdraw_listening_distribution_v1(p_episode_id uuid, p_reason text, p_actor_id uuid, p_client_revision integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_dist listening_episode_distribution%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_actor_id AND status = 'active' AND role IN ('owner','admin')) THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN RAISE EXCEPTION 'A reason is required to withdraw a distribution'; END IF;

  SELECT * INTO v_dist FROM listening_episode_distribution WHERE episode_id = p_episode_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Distribution not found for episode: %', p_episode_id; END IF;
  IF v_dist.revision <> p_client_revision THEN
    RAISE EXCEPTION 'REVISION_CONFLICT: Expected %, got %', p_client_revision, v_dist.revision USING ERRCODE = 'P0002';
  END IF;
  IF v_dist.state NOT IN ('published', 'scheduled', 'paused') THEN
    RAISE EXCEPTION 'Distribution is %, cannot withdraw', v_dist.state;
  END IF;

  UPDATE listening_episode_distribution SET state = 'withdrawn', revision = revision + 1, updated_by = p_actor_id WHERE episode_id = p_episode_id;

  INSERT INTO listening_episode_publications (episode_id, action, previous_state, new_state, reason, actor_id)
  VALUES (p_episode_id, 'withdraw', v_dist.state, 'withdrawn', p_reason, p_actor_id);

  RETURN jsonb_build_object('episode_id', p_episode_id, 'state', 'withdrawn', 'new_revision', v_dist.revision + 1);
END;
$function$;


CREATE OR REPLACE FUNCTION public.app_ack_config_snapshot_v1(p_environment text, p_application text, p_instance_id text, p_version_received integer, p_hash_received text, p_version_applied integer, p_hash_applied text, p_app_version text, p_result text, p_error_sanitized text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO app_config_acknowledgements (
    environment, application, instance_id, version_received, hash_received,
    version_applied, hash_applied, app_version, result, error_sanitized
  ) VALUES (
    p_environment, p_application, p_instance_id, p_version_received, p_hash_received,
    p_version_applied, p_hash_applied, p_app_version, p_result, left(p_error_sanitized, 1000)
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.app_get_public_config_snapshot_v1(p_environment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ver app_config_versions%ROWTYPE;
  v_public_values jsonb;
BEGIN
  PERFORM _promote_due_config_versions(p_environment);
  SELECT * INTO v_ver FROM app_config_versions WHERE environment = p_environment AND state = 'published';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('environment', p_environment, 'version_number', 0, 'config_hash', '', 'values', '{}'::jsonb);
  END IF;

  SELECT COALESCE(jsonb_object_agg(key, entry->'value'), '{}'::jsonb)
  INTO v_public_values
  FROM jsonb_each(v_ver.snapshot->'values') AS t(key, entry)
  WHERE entry->>'exposure' = 'public';

  RETURN jsonb_build_object(
    'environment', p_environment,
    'version_number', v_ver.version_number,
    'config_hash', v_ver.config_hash,
    'etag', v_ver.config_hash,
    'effective_from', v_ver.effective_from,
    'values', v_public_values
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.app_get_server_config_snapshot_v1(p_environment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ver app_config_versions%ROWTYPE;
  v_values jsonb;
BEGIN
  PERFORM _promote_due_config_versions(p_environment);
  SELECT * INTO v_ver FROM app_config_versions WHERE environment = p_environment AND state = 'published';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('environment', p_environment, 'version_number', 0, 'config_hash', '', 'values', '{}'::jsonb);
  END IF;

  SELECT COALESCE(jsonb_object_agg(key, entry->'value'), '{}'::jsonb)
  INTO v_values
  FROM jsonb_each(v_ver.snapshot->'values') AS t(key, entry);

  RETURN jsonb_build_object(
    'environment', p_environment,
    'version_number', v_ver.version_number,
    'config_hash', v_ver.config_hash,
    'etag', v_ver.config_hash,
    'effective_from', v_ver.effective_from,
    'values', v_values
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.apply_review_schedule(p_attempt_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_attempt        record;
  v_group          record;
  v_prev_level     integer;
  v_prev_status    text;
  v_prev_next      timestamptz;
  v_new_level      integer;
  v_new_status     text;
  v_new_next       timestamptz;
  v_interval_days  integer;
  v_weekdays       integer[];
  v_candidate      timestamptz;
  v_iter           integer;
begin
  -- Carregar e verificar a tentativa (RLS garante user_id = auth.uid())
  select * into v_attempt
  from public.review_attempts
  where id = p_attempt_id and user_id = auth.uid();

  if not found then
    raise exception 'Tentativa não encontrada ou não autorizada';
  end if;

  -- Bloquear o grupo para evitar processamento simultâneo
  select * into v_group
  from public.review_groups
  where id = v_attempt.review_group_id and user_id = auth.uid()
  for update;

  if not found then
    raise exception 'Grupo de revisão não encontrado ou não autorizado';
  end if;

  -- Idempotência: verificar se esta tentativa já foi processada (após o lock)
  if exists (
    select 1 from public.review_schedule_history
    where review_attempt_id = p_attempt_id
  ) then
    return jsonb_build_object('skipped', true, 'reason', 'already_processed');
  end if;

  -- Grupo já dominado: não alterar
  if v_group.status = 'mastered' or v_group.review_level >= 4 then
    return jsonb_build_object('skipped', true, 'reason', 'already_mastered');
  end if;

  v_prev_level  := v_group.review_level;
  v_prev_status := v_group.status;
  v_prev_next   := v_group.next_review_at;

  -- Carregar dias ativos do usuário (fallback: seg-sex)
  select array(select jsonb_array_elements_text(active_weekdays)::integer)
  into v_weekdays
  from public.user_learning_settings
  where user_id = auth.uid();

  if v_weekdays is null or array_length(v_weekdays, 1) = 0 then
    v_weekdays := array[1,2,3,4,5];
  end if;

  -- Calcular novo agendamento (lógica determinística, em UTC)
  if v_attempt.overall_result = 'passed' then
    case v_group.review_level
      when 0 then
        v_new_level := 1; v_interval_days := 7;
        v_new_next  := (now() at time zone 'utc') + interval '7 days';
        v_new_status := 'scheduled';
      when 1 then
        v_new_level := 2; v_interval_days := 21;
        v_new_next  := (now() at time zone 'utc') + interval '21 days';
        v_new_status := 'scheduled';
      when 2 then
        v_new_level := 3; v_interval_days := 60;
        v_new_next  := (now() at time zone 'utc') + interval '60 days';
        v_new_status := 'scheduled';
      when 3 then
        v_new_level := 4; v_interval_days := null;
        v_new_next  := null;
        v_new_status := 'mastered';
      else
        return jsonb_build_object('skipped', true, 'reason', 'already_mastered');
    end case;
  else
    -- failed: redefinir para nível 0, revisão em 2 dias
    v_new_level := 0; v_interval_days := 2;
    v_new_next  := (now() at time zone 'utc') + interval '2 days';
    v_new_status := 'scheduled';
  end if;

  -- Ajustar next_review_at ao próximo dia ativo
  if v_new_next is not null then
    v_candidate := v_new_next;
    v_iter := 0;
    while not (extract(dow from v_candidate)::integer = any(v_weekdays)) and v_iter < 8 loop
      v_candidate := v_candidate + interval '1 day';
      v_iter := v_iter + 1;
    end loop;
    v_new_next := v_candidate;
  end if;

  -- Atualizar grupo (proteção extra: só aplica se nível não mudou desde o lock)
  update public.review_groups
  set
    review_level   = v_new_level,
    status         = v_new_status,
    next_review_at = v_new_next,
    updated_at     = now()
  where id = v_group.id
    and review_level = v_prev_level;

  if not found then
    return jsonb_build_object('skipped', true, 'reason', 'concurrent_update');
  end if;

  -- Registrar histórico do ciclo
  insert into public.review_schedule_history (
    user_id, review_group_id, review_attempt_id,
    previous_level, new_level, overall_result,
    previous_status, new_status,
    previous_next_review_at, new_next_review_at
  ) values (
    auth.uid(), v_group.id, p_attempt_id,
    v_prev_level, v_new_level, v_attempt.overall_result,
    v_prev_status, v_new_status,
    v_prev_next, v_new_next
  );

  return jsonb_build_object(
    'applied',       true,
    'newLevel',      v_new_level,
    'newStatus',     v_new_status,
    'nextReviewAt',  v_new_next,
    'intervalDays',  v_interval_days,
    'overallResult', v_attempt.overall_result
  );
end;
$function$;


CREATE OR REPLACE FUNCTION public.begin_gateway_idempotent_op_v1(p_scope text, p_idempotency_key text, p_lease_seconds integer)
 RETURNS TABLE(lock_id uuid, outcome text, result_ref text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now        TIMESTAMPTZ := NOW();
  v_id         UUID;
  v_status     TEXT;
  v_result_ref TEXT;
  v_was_insert BOOLEAN;
BEGIN
  IF p_scope IS NULL OR char_length(p_scope) = 0 OR char_length(p_scope) > 128 THEN
    RAISE EXCEPTION 'invalid scope';
  END IF;
  IF p_idempotency_key IS NULL OR char_length(p_idempotency_key) = 0 OR char_length(p_idempotency_key) > 256 THEN
    RAISE EXCEPTION 'invalid idempotency_key';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds <= 0 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'lease_seconds must be between 1 and 3600';
  END IF;

  INSERT INTO public.ai_gateway_idempotency_locks AS agil (scope, idempotency_key, status, expires_at)
  VALUES (p_scope, p_idempotency_key, 'in_progress', v_now + (p_lease_seconds * INTERVAL '1 second'))
  ON CONFLICT (scope, idempotency_key) DO UPDATE
    SET status     = 'in_progress',
        result_ref = NULL,
        expires_at = v_now + (p_lease_seconds * INTERVAL '1 second'),
        updated_at = v_now
    WHERE agil.status = 'failed'
       OR agil.expires_at <= v_now
  RETURNING agil.id, agil.status, agil.result_ref, (agil.xmax = 0) INTO v_id, v_status, v_result_ref, v_was_insert;

  IF FOUND THEN
    RETURN QUERY SELECT v_id, (CASE WHEN v_was_insert THEN 'started' ELSE 'reclaimed' END), v_result_ref;
    RETURN;
  END IF;

  SELECT agil.id, agil.status, agil.result_ref INTO v_id, v_status, v_result_ref
    FROM public.ai_gateway_idempotency_locks agil
    WHERE agil.scope = p_scope AND agil.idempotency_key = p_idempotency_key;

  RETURN QUERY SELECT v_id, v_status, v_result_ref;
END;
$function$;


CREATE OR REPLACE FUNCTION public.can_manage_plans()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.admin_users
    WHERE user_id = auth.uid()
      AND status = 'active'
      AND role IN ('owner', 'admin')
  );
$function$;


CREATE OR REPLACE FUNCTION public.can_publish_plans()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.admin_users
    WHERE user_id = auth.uid()
      AND role IN ('owner', 'admin')
      AND status = 'active'
  );
$function$;


CREATE OR REPLACE FUNCTION public.check_and_increment_rate_limit(p_user_id uuid, p_route_key text, p_window_seconds integer, p_max_requests integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_count        INTEGER;
  v_now          TIMESTAMPTZ := NOW();
  v_retry_after  INTEGER;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'retry_after', 60);
  END IF;
  IF char_length(p_route_key) > 64 THEN
    RETURN jsonb_build_object('allowed', false, 'retry_after', 60);
  END IF;
  IF p_window_seconds <= 0 OR p_window_seconds > 86400 THEN
    RETURN jsonb_build_object('allowed', false, 'retry_after', 60);
  END IF;
  IF p_max_requests <= 0 OR p_max_requests > 10000 THEN
    RETURN jsonb_build_object('allowed', false, 'retry_after', 60);
  END IF;

  INSERT INTO public.api_rate_limits (user_id, route_key, window_start, request_count)
  VALUES (p_user_id, p_route_key, v_now, 1)
  ON CONFLICT (user_id, route_key) DO UPDATE
    SET
      window_start  = CASE
                        WHEN public.api_rate_limits.window_start
                             + (p_window_seconds * INTERVAL '1 second') <= v_now
                        THEN v_now
                        ELSE public.api_rate_limits.window_start
                      END,
      request_count = CASE
                        WHEN public.api_rate_limits.window_start
                             + (p_window_seconds * INTERVAL '1 second') <= v_now
                        THEN 1
                        ELSE public.api_rate_limits.request_count + 1
                      END
  RETURNING window_start, request_count
    INTO v_window_start, v_count;

  IF v_count > p_max_requests THEN
    v_retry_after := GREATEST(
      1,
      EXTRACT(EPOCH FROM (
        v_window_start + (p_window_seconds * INTERVAL '1 second') - v_now
      ))::INTEGER
    );
    RETURN jsonb_build_object('allowed', false, 'retry_after', v_retry_after);
  END IF;

  RETURN jsonb_build_object('allowed', true);
END;
$function$;


CREATE OR REPLACE FUNCTION public.claim_next_listening_job(p_worker_id text, p_job_types text[], p_lock_ms integer DEFAULT 600000)
 RETURNS SETOF listening_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_job listening_jobs;
BEGIN
  SELECT * INTO v_job
  FROM listening_jobs
  WHERE status IN ('pending', 'retry')
    AND job_type = ANY(p_job_types)
    AND next_attempt_at <= now()
    AND (lock_expires_at IS NULL OR lock_expires_at < now())
  ORDER BY priority DESC, next_attempt_at ASC, created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_job.id IS NULL THEN RETURN; END IF;

  UPDATE listening_jobs SET
    status          = 'processing',
    locked_by       = p_worker_id,
    locked_at       = now(),
    lock_expires_at = now() + make_interval(secs => p_lock_ms::FLOAT / 1000.0),
    attempts        = attempts + 1,
    started_at      = COALESCE(started_at, now()),
    updated_at      = now()
  WHERE id = v_job.id
  RETURNING * INTO v_job;

  RETURN NEXT v_job;
END;
$function$;


CREATE OR REPLACE FUNCTION public.commit_gateway_reservation_v1(p_reservation_id uuid, p_usage_event_id uuid, p_actual_cost_usd numeric, p_actual_metrics jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now  TIMESTAMPTZ := NOW();
  v_item RECORD;
  v_actual NUMERIC;
BEGIN
  PERFORM 1 FROM public.usage_reservations WHERE id = p_reservation_id AND status = 'pending' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  FOR v_item IN
    SELECT id, quota_key, reserved_quantity, quota_bucket_id
      FROM public.usage_reservation_items
      WHERE reservation_id = p_reservation_id AND quota_bucket_id IS NOT NULL
      ORDER BY quota_bucket_id
  LOOP
    v_actual := v_item.reserved_quantity;
    IF p_actual_metrics IS NOT NULL THEN
      SELECT (elem->>'actual_quantity')::NUMERIC INTO v_actual
        FROM jsonb_array_elements(p_actual_metrics) elem
        WHERE elem->>'quota_key' = v_item.quota_key
        LIMIT 1;
      v_actual := COALESCE(v_actual, v_item.reserved_quantity);
    END IF;

    UPDATE public.ai_gateway_quota_buckets
      SET reserved_quantity = GREATEST(0, reserved_quantity - v_item.reserved_quantity),
          committed_quantity = committed_quantity + v_actual,
          updated_at = v_now
      WHERE id = v_item.quota_bucket_id;

    UPDATE public.usage_reservation_items
      SET consumed_quantity = v_actual,
          released_quantity = GREATEST(0, v_item.reserved_quantity - v_actual),
          overage = (v_actual > v_item.reserved_quantity)
      WHERE id = v_item.id;
  END LOOP;

  FOR v_item IN
    SELECT budget_bucket_id, reserved_cost_usd FROM public.ai_gateway_reservation_budget_links
      WHERE reservation_id = p_reservation_id ORDER BY budget_bucket_id
  LOOP
    UPDATE public.ai_gateway_budget_buckets
      SET reserved_cost_usd = GREATEST(0, reserved_cost_usd - v_item.reserved_cost_usd),
          committed_cost_usd = committed_cost_usd + COALESCE(p_actual_cost_usd, 0),
          updated_at = v_now
      WHERE id = v_item.budget_bucket_id;
  END LOOP;

  UPDATE public.usage_reservations
    SET status = 'committed', usage_event_id = p_usage_event_id, actual_cost_usd = p_actual_cost_usd,
        finalized_at = v_now, updated_at = v_now
    WHERE id = p_reservation_id AND status = 'pending';
END;
$function$;


CREATE OR REPLACE FUNCTION public.compensate_pronunciation_assessment(p_assessment_id uuid, p_error_code text, p_error_message text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  -- Only update if the row is still 'processing' and belongs to this user.
  -- If the row has advanced (completed / failed by another path) this is a no-op.
  -- Safe for concurrent calls: both would produce the same failed_retryable result.
  UPDATE pronunciation_assessments
     SET status        = 'failed_retryable',
         error_code    = p_error_code,
         error_message = p_error_message
   WHERE id      = p_assessment_id
     AND user_id = v_user_id
     AND status  = 'processing';
END;
$function$;


CREATE OR REPLACE FUNCTION public.compensate_pronunciation_training_assessment(p_session_id uuid, p_error_code text, p_error_message text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE pronunciation_training_sessions
     SET status        = 'failed_retryable',
         error_code    = p_error_code,
         error_message = p_error_message
   WHERE id      = p_session_id
     AND user_id = v_user_id
     AND status  = 'processing';
END;
$function$;


CREATE OR REPLACE FUNCTION public.complete_gateway_idempotent_op_v1(p_lock_id uuid, p_result_ref text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  UPDATE public.ai_gateway_idempotency_locks
  SET status = 'completed', result_ref = p_result_ref, updated_at = NOW()
  WHERE id = p_lock_id AND status = 'in_progress';
$function$;


CREATE OR REPLACE FUNCTION public.complete_pronunciation_assessment(p_assessment_id uuid, p_attempt_id uuid, p_pronunciation_score numeric, p_accuracy_score numeric, p_fluency_score numeric, p_completeness_score numeric, p_prosody_score numeric, p_recognized_text text, p_words_json jsonb, p_raw_result_json jsonb, p_audio_duration_s numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID;
  v_status  TEXT;
  v_attempt UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  SELECT status, active_attempt_id
  INTO   v_status, v_attempt
  FROM   pronunciation_assessments
  WHERE  id      = p_assessment_id
    AND  user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'NOT_FOUND');
  END IF;

  IF v_status = 'completed' AND v_attempt = p_attempt_id THEN
    RETURN jsonb_build_object('action', 'already_completed');
  END IF;

  IF v_status = 'completed' THEN
    RETURN jsonb_build_object('error', 'ASSESSMENT_ALREADY_COMPLETED');
  END IF;

  IF v_status <> 'processing' THEN
    RETURN jsonb_build_object('error', 'ASSESSMENT_NOT_PROCESSING', 'currentStatus', v_status);
  END IF;

  IF v_attempt IS DISTINCT FROM p_attempt_id THEN
    RETURN jsonb_build_object('error', 'ATTEMPT_MISMATCH');
  END IF;

  UPDATE pronunciation_assessments
     SET status                 = 'completed',
         completed_at           = NOW(),
         pronunciation_score    = p_pronunciation_score,
         accuracy_score         = p_accuracy_score,
         fluency_score          = p_fluency_score,
         completeness_score     = p_completeness_score,
         prosody_score          = p_prosody_score,
         recognized_text        = p_recognized_text,
         words_json             = p_words_json,
         raw_result_json        = p_raw_result_json,
         audio_duration_seconds = p_audio_duration_s
   WHERE id                = p_assessment_id
     AND user_id           = v_user_id
     AND status            = 'processing'
     AND active_attempt_id = p_attempt_id;

  RETURN jsonb_build_object('action', 'completed');
END;
$function$;


CREATE OR REPLACE FUNCTION public.complete_pronunciation_training_assessment(p_session_id uuid, p_attempt_id uuid, p_pronunciation_score numeric, p_accuracy_score numeric, p_fluency_score numeric, p_completeness_score numeric, p_prosody_score numeric, p_recognized_text text, p_words_json jsonb, p_raw_result_json jsonb, p_audio_duration_s numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID;
  v_status  TEXT;
  v_attempt UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  SELECT status, active_attempt_id
  INTO   v_status, v_attempt
  FROM   pronunciation_training_sessions
  WHERE  id = p_session_id AND user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'NOT_FOUND');
  END IF;

  IF v_status = 'completed' AND v_attempt = p_attempt_id THEN
    RETURN jsonb_build_object('action', 'already_completed');
  END IF;

  IF v_status = 'completed' THEN
    RETURN jsonb_build_object('error', 'ASSESSMENT_ALREADY_COMPLETED');
  END IF;

  IF v_status <> 'processing' THEN
    RETURN jsonb_build_object('error', 'ASSESSMENT_NOT_PROCESSING', 'currentStatus', v_status);
  END IF;

  IF v_attempt IS DISTINCT FROM p_attempt_id THEN
    RETURN jsonb_build_object('error', 'ATTEMPT_MISMATCH');
  END IF;

  UPDATE pronunciation_training_sessions
     SET status                 = 'completed',
         completed_at           = NOW(),
         pronunciation_score    = p_pronunciation_score,
         accuracy_score         = p_accuracy_score,
         fluency_score          = p_fluency_score,
         completeness_score     = p_completeness_score,
         prosody_score          = p_prosody_score,
         recognized_text        = p_recognized_text,
         words_json             = p_words_json,
         raw_result_json        = p_raw_result_json,
         audio_duration_seconds = p_audio_duration_s
   WHERE id                = p_session_id
     AND user_id           = v_user_id
     AND status            = 'processing'
     AND active_attempt_id = p_attempt_id;

  RETURN jsonb_build_object('action', 'completed');
END;
$function$;


CREATE OR REPLACE FUNCTION public.complete_writing_review_reservation(p_attempt_id uuid, p_review_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID;
  v_id      UUID;
  v_status  TEXT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  SELECT id, status
  INTO   v_id, v_status
  FROM   writing_review_reservations
  WHERE  user_id = v_user_id AND attempt_id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'NOT_FOUND');
  END IF;

  IF v_status = 'completed' THEN
    RETURN jsonb_build_object('action', 'already_completed', 'reservationId', v_id);
  END IF;

  IF v_status <> 'reserved' THEN
    RETURN jsonb_build_object('error', 'RESERVATION_NOT_ACTIVE', 'currentStatus', v_status);
  END IF;

  UPDATE writing_review_reservations
     SET status = 'completed', review_id = p_review_id, updated_at = now()
   WHERE id = v_id;

  RETURN jsonb_build_object('action', 'completed', 'reservationId', v_id);
END;
$function$;


CREATE OR REPLACE FUNCTION public.conversation_cron_sweep_stale_sessions()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_secret TEXT;
  v_url    TEXT;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret'  LIMIT 1;
    SELECT decrypted_secret INTO v_url    FROM vault.decrypted_secrets WHERE name = 'app_base_url' LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'conversation_cron_sweep_stale_sessions: vault read failed: %', SQLERRM;
    RETURN;
  END;

  IF v_secret IS NULL OR v_url IS NULL THEN
    RAISE WARNING 'conversation_cron_sweep_stale_sessions: vault secrets missing (cron_secret or app_base_url)';
    RETURN;
  END IF;

  PERFORM net.http_get(
    url     := v_url || '/api/internal/listening/conversation-sweep',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret)
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.create_pronunciation_training_text(p_practice_date date, p_level text, p_generated_text text, p_force_new boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID;
  v_row     RECORD;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  IF p_generated_text IS NULL OR length(trim(p_generated_text)) = 0 THEN
    RETURN jsonb_build_object('error', 'INVALID_TEXT');
  END IF;

  IF p_force_new THEN
    UPDATE pronunciation_training_sessions
       SET level                  = p_level,
           generated_text         = p_generated_text,
           status                 = 'text_generated',
           pronunciation_score    = NULL,
           accuracy_score         = NULL,
           fluency_score          = NULL,
           completeness_score     = NULL,
           prosody_score          = NULL,
           recognized_text        = NULL,
           words_json             = NULL,
           raw_result_json        = NULL,
           audio_duration_seconds = NULL,
           error_code             = NULL,
           error_message          = NULL,
           active_attempt_id      = NULL,
           attempt_started_at     = NULL,
           started_at             = NULL,
           completed_at           = NULL
     WHERE user_id = v_user_id AND practice_date = p_practice_date AND status = 'completed';
  END IF;

  INSERT INTO pronunciation_training_sessions (user_id, practice_date, level, generated_text, status)
  VALUES (v_user_id, p_practice_date, p_level, p_generated_text, 'text_generated')
  ON CONFLICT ON CONSTRAINT uq_pts_user_date DO NOTHING;

  SELECT id, level, generated_text, status,
         pronunciation_score, accuracy_score, fluency_score, completeness_score, prosody_score,
         recognized_text, words_json, raw_result_json, audio_duration_seconds
  INTO   v_row
  FROM   pronunciation_training_sessions
  WHERE  user_id = v_user_id AND practice_date = p_practice_date;

  RETURN jsonb_build_object(
    'sessionId',    v_row.id,
    'level',        v_row.level,
    'text',         v_row.generated_text,
    'status',       v_row.status,
    'result', CASE WHEN v_row.status = 'completed' THEN jsonb_build_object(
      'pronunciationScore',   v_row.pronunciation_score,
      'accuracyScore',        v_row.accuracy_score,
      'fluencyScore',         v_row.fluency_score,
      'completenessScore',    v_row.completeness_score,
      'prosodyScore',         v_row.prosody_score,
      'recognizedText',       v_row.recognized_text,
      'wordsJson',            v_row.words_json,
      'rawSegments',          v_row.raw_result_json,
      'audioDurationSeconds', v_row.audio_duration_seconds
    ) ELSE NULL END
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.expire_stale_gateway_reservations_v1(p_limit integer DEFAULT 500)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_reservation_id UUID;
  v_count INTEGER := 0;
  v_item RECORD;
BEGIN
  FOR v_reservation_id IN
    SELECT id FROM public.usage_reservations
      WHERE status = 'pending' AND expires_at < v_now
      ORDER BY expires_at
      LIMIT GREATEST(1, LEAST(p_limit, 5000))
      FOR UPDATE SKIP LOCKED
  LOOP
    FOR v_item IN
      SELECT reserved_quantity, quota_bucket_id FROM public.usage_reservation_items
        WHERE reservation_id = v_reservation_id AND quota_bucket_id IS NOT NULL
        ORDER BY quota_bucket_id
    LOOP
      UPDATE public.ai_gateway_quota_buckets
        SET reserved_quantity = GREATEST(0, reserved_quantity - v_item.reserved_quantity), updated_at = v_now
        WHERE id = v_item.quota_bucket_id;
    END LOOP;

    FOR v_item IN
      SELECT budget_bucket_id, reserved_cost_usd FROM public.ai_gateway_reservation_budget_links
        WHERE reservation_id = v_reservation_id ORDER BY budget_bucket_id
    LOOP
      UPDATE public.ai_gateway_budget_buckets
        SET reserved_cost_usd = GREATEST(0, reserved_cost_usd - v_item.reserved_cost_usd), updated_at = v_now
        WHERE id = v_item.budget_bucket_id;
    END LOOP;

    UPDATE public.usage_reservations
      SET status = 'expired', finalized_at = v_now, updated_at = v_now
      WHERE id = v_reservation_id AND status = 'pending';

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;


CREATE OR REPLACE FUNCTION public.fail_gateway_idempotent_op_v1(p_lock_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  UPDATE public.ai_gateway_idempotency_locks
  SET status = 'failed', updated_at = NOW()
  WHERE id = p_lock_id AND status = 'in_progress';
$function$;


CREATE OR REPLACE FUNCTION public.fail_pronunciation_assessment(p_assessment_id uuid, p_attempt_id uuid, p_error_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id    UUID;
  v_status     TEXT;
  v_attempt    UUID;
  v_prev_score NUMERIC;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  SELECT status, active_attempt_id, pronunciation_score
  INTO   v_status, v_attempt, v_prev_score
  FROM   pronunciation_assessments
  WHERE  id      = p_assessment_id
    AND  user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'NOT_FOUND');
  END IF;

  IF v_status = 'completed' OR v_status = 'failed_final' THEN
    RETURN jsonb_build_object('action', 'no_op', 'reason', v_status);
  END IF;

  IF v_status <> 'processing' OR v_attempt IS DISTINCT FROM p_attempt_id THEN
    RETURN jsonb_build_object('action', 'no_op', 'reason', 'not_owner');
  END IF;

  IF v_prev_score IS NOT NULL THEN
    UPDATE pronunciation_assessments
       SET status             = 'completed',
           active_attempt_id  = NULL,
           attempt_started_at = NULL
     WHERE id      = p_assessment_id
       AND user_id = v_user_id;
    RETURN jsonb_build_object('action', 'restored_previous');
  END IF;

  UPDATE pronunciation_assessments
     SET status        = 'failed_retryable',
         error_code    = p_error_code,
         error_message = CASE p_error_code
           WHEN 'AUDIO_DECODE_FAILED'  THEN 'Não foi possível preparar o áudio para análise.'
           WHEN 'AUDIO_EMPTY'          THEN 'A gravação está vazia ou corrompida.'
           WHEN 'AZURE_NO_MATCH'       THEN 'O Azure não reconheceu fala no áudio.'
           WHEN 'AZURE_CANCELED'       THEN 'A análise foi cancelada pelo serviço.'
           WHEN 'AZURE_TIMEOUT'        THEN 'O serviço de pronúncia demorou para responder.'
           WHEN 'AZURE_NETWORK_ERROR'  THEN 'Erro de rede durante a análise de pronúncia.'
           WHEN 'RESULT_INVALID'       THEN 'O resultado retornado pelo serviço é inválido.'
           WHEN 'CLIENT_INTERRUPTED'   THEN 'A análise foi interrompida antes de ser concluída.'
           ELSE                             'Falha técnica durante a análise de pronúncia.'
         END
   WHERE id                = p_assessment_id
     AND user_id           = v_user_id
     AND status            = 'processing'
     AND active_attempt_id = p_attempt_id;

  RETURN jsonb_build_object('action', 'failed_retryable');
END;
$function$;


CREATE OR REPLACE FUNCTION public.fail_pronunciation_training_assessment(p_session_id uuid, p_attempt_id uuid, p_error_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID;
  v_status  TEXT;
  v_attempt UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  SELECT status, active_attempt_id
  INTO   v_status, v_attempt
  FROM   pronunciation_training_sessions
  WHERE  id = p_session_id AND user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'NOT_FOUND');
  END IF;

  IF v_status = 'completed' OR v_status = 'failed_final' THEN
    RETURN jsonb_build_object('action', 'no_op', 'reason', v_status);
  END IF;

  IF v_status <> 'processing' OR v_attempt IS DISTINCT FROM p_attempt_id THEN
    RETURN jsonb_build_object('action', 'no_op', 'reason', 'not_owner');
  END IF;

  UPDATE pronunciation_training_sessions
     SET status             = 'failed_retryable',
         active_attempt_id  = NULL,
         attempt_started_at = NULL,
         error_code         = p_error_code,
         error_message      = CASE p_error_code
           WHEN 'AUDIO_DECODE_FAILED'  THEN 'Não foi possível preparar o áudio para análise.'
           WHEN 'AUDIO_EMPTY'          THEN 'A gravação está vazia ou corrompida.'
           WHEN 'AZURE_NO_MATCH'       THEN 'O Azure não reconheceu fala no áudio.'
           WHEN 'AZURE_CANCELED'       THEN 'A análise foi cancelada pelo serviço.'
           WHEN 'AZURE_TIMEOUT'        THEN 'O serviço de pronúncia demorou para responder.'
           WHEN 'AZURE_NETWORK_ERROR'  THEN 'Erro de rede durante a análise de pronúncia.'
           WHEN 'RESULT_INVALID'       THEN 'O resultado retornado pelo serviço é inválido.'
           WHEN 'CLIENT_INTERRUPTED'   THEN 'A análise foi interrompida antes de ser concluída.'
           ELSE                             'Falha técnica durante a análise de pronúncia.'
         END
   WHERE id      = p_session_id
     AND user_id = v_user_id;

  RETURN jsonb_build_object('action', 'failed_retryable');
END;
$function$;


CREATE OR REPLACE FUNCTION public.fail_writing_review_reservation(p_attempt_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID;
  v_id      UUID;
  v_status  TEXT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  SELECT id, status
  INTO   v_id, v_status
  FROM   writing_review_reservations
  WHERE  user_id = v_user_id AND attempt_id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('action', 'no_op', 'reason', 'not_found');
  END IF;

  IF v_status <> 'reserved' THEN
    RETURN jsonb_build_object('action', 'no_op', 'reason', v_status);
  END IF;

  UPDATE writing_review_reservations
     SET status = 'failed', updated_at = now()
   WHERE id = v_id;

  RETURN jsonb_build_object('action', 'failed', 'reservationId', v_id);
END;
$function$;


CREATE OR REPLACE FUNCTION public.fn_admin_security_events_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'Security events are immutable and append-only';
END;
$function$;


CREATE OR REPLACE FUNCTION public.fn_admin_security_policy_version_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.id = NEW.id AND OLD.environment = NEW.environment AND OLD.version_number = NEW.version_number
      AND OLD.snapshot = NEW.snapshot AND OLD.config_hash = NEW.config_hash AND OLD.change_type = NEW.change_type
      AND OLD.reason = NEW.reason AND OLD.published_by = NEW.published_by AND OLD.published_at = NEW.published_at
      AND OLD.previous_version_id IS NOT DISTINCT FROM NEW.previous_version_id
    THEN
      RETURN NEW; -- only `state` may transition (published -> superseded/revoked)
    END IF;
    RAISE EXCEPTION 'Security policy versions are immutable (only state transitions allowed)';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Security policy versions cannot be deleted';
  END IF;
  RETURN NEW;
END;
$function$;


CREATE OR REPLACE FUNCTION public.fn_admin_users_owner_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_other_active_owners INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.role = 'owner' AND OLD.status = 'active' THEN
    IF NEW.role <> 'owner' OR NEW.status <> 'active' THEN
      SELECT COUNT(*) INTO v_other_active_owners
      FROM public.admin_users
      WHERE role = 'owner' AND status = 'active' AND user_id <> OLD.user_id;

      IF v_other_active_owners = 0 THEN
        RAISE EXCEPTION 'LAST_OWNER_PROTECTED: cannot demote or deactivate the last active owner'
          USING ERRCODE = 'P0003';
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' AND OLD.role = 'owner' AND OLD.status = 'active' THEN
    SELECT COUNT(*) INTO v_other_active_owners
    FROM public.admin_users
    WHERE role = 'owner' AND status = 'active' AND user_id <> OLD.user_id;
    IF v_other_active_owners = 0 THEN
      RAISE EXCEPTION 'LAST_OWNER_PROTECTED: cannot delete the last active owner'
        USING ERRCODE = 'P0003';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;


CREATE OR REPLACE FUNCTION public.fn_config_value_editable_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_state text;
  v_version_id uuid;
BEGIN
  v_version_id := COALESCE(NEW.version_id, OLD.version_id);
  SELECT state INTO v_state FROM app_config_versions WHERE id = v_version_id;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'Config version not found: %', v_version_id;
  END IF;
  IF v_state NOT IN ('draft', 'scheduled') THEN
    RAISE EXCEPTION 'Values cannot be modified once the version is %', v_state;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;


CREATE OR REPLACE FUNCTION public.fn_config_version_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.state IN ('published', 'superseded', 'discarded') THEN
      IF OLD.id = NEW.id
        AND OLD.environment          = NEW.environment
        AND OLD.version_number       = NEW.version_number
        AND OLD.config_hash          IS NOT DISTINCT FROM NEW.config_hash
        AND OLD.previous_version_id  IS NOT DISTINCT FROM NEW.previous_version_id
        AND OLD.snapshot             IS NOT DISTINCT FROM NEW.snapshot
        AND OLD.reason               IS NOT DISTINCT FROM NEW.reason
        AND OLD.is_high_risk         = NEW.is_high_risk
        AND OLD.high_risk_confirmation IS NOT DISTINCT FROM NEW.high_risk_confirmation
        AND OLD.created_by           = NEW.created_by
        AND OLD.published_by         IS NOT DISTINCT FROM NEW.published_by
        AND OLD.published_at         IS NOT DISTINCT FROM NEW.published_at
        AND OLD.created_at           = NEW.created_at
      THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'Published config versions are immutable (only controlled state transitions allowed)';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Config versions cannot be deleted';
  END IF;
  RETURN NEW;
END;
$function$;


CREATE OR REPLACE FUNCTION public.fn_cost_valuation_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'Cost valuations are immutable and append-only';
END;
$function$;


CREATE OR REPLACE FUNCTION public.fn_gateway_version_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Allow state transitions only (published → superseded/revoked)
  IF TG_OP = 'UPDATE' THEN
    IF OLD.id = NEW.id
      AND OLD.environment         = NEW.environment
      AND OLD.version_number      = NEW.version_number
      AND OLD.snapshot            = NEW.snapshot
      AND OLD.config_hash         = NEW.config_hash
      AND OLD.change_type         = NEW.change_type
      AND OLD.is_emergency        = NEW.is_emergency
      AND OLD.reason              = NEW.reason
      AND OLD.published_by        = NEW.published_by
      AND OLD.published_at        = NEW.published_at
      AND OLD.previous_version_id IS NOT DISTINCT FROM NEW.previous_version_id
    THEN
      RETURN NEW; -- only state/expires_at changed — allowed
    END IF;
    RAISE EXCEPTION 'Gateway config versions are immutable (only state transitions allowed)';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Gateway config versions cannot be deleted';
  END IF;
  RETURN NEW;
END;
$function$;


CREATE OR REPLACE FUNCTION public.fn_listening_publication_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'Listening episode publication history is immutable and append-only';
END;
$function$;


CREATE OR REPLACE FUNCTION public.fn_listening_request_terminal_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.status IN ('completed', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'Listening generation request % is already terminal (%) and cannot be modified', OLD.id, OLD.status;
  END IF;
  RETURN NEW;
END;
$function$;


CREATE OR REPLACE FUNCTION public.fn_pricing_rate_editable_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_state text;
  v_version_id uuid;
BEGIN
  v_version_id := COALESCE(NEW.version_id, OLD.version_id);
  SELECT state INTO v_state FROM ai_pricing_versions WHERE id = v_version_id;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'Pricing version not found: %', v_version_id;
  END IF;
  IF v_state NOT IN ('draft', 'scheduled') THEN
    RAISE EXCEPTION 'Rates cannot be modified once the version is %', v_state;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;


CREATE OR REPLACE FUNCTION public.fn_pricing_version_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.state IN ('published', 'superseded', 'discarded') THEN
      IF OLD.id = NEW.id
        AND OLD.environment               = NEW.environment
        AND OLD.version_number            = NEW.version_number
        AND OLD.name                      = NEW.name
        AND OLD.description               IS NOT DISTINCT FROM NEW.description
        AND OLD.currencies                = NEW.currencies
        AND OLD.effective_from            IS NOT DISTINCT FROM NEW.effective_from
        AND OLD.config_hash               IS NOT DISTINCT FROM NEW.config_hash
        AND OLD.previous_version_id       IS NOT DISTINCT FROM NEW.previous_version_id
        AND OLD.created_by                = NEW.created_by
        AND OLD.published_by              IS NOT DISTINCT FROM NEW.published_by
        AND OLD.reason                    IS NOT DISTINCT FROM NEW.reason
        AND OLD.is_retroactive            = NEW.is_retroactive
        AND OLD.retroactive_justification IS NOT DISTINCT FROM NEW.retroactive_justification
        AND OLD.snapshot                  IS NOT DISTINCT FROM NEW.snapshot
        AND OLD.published_at              IS NOT DISTINCT FROM NEW.published_at
        AND OLD.created_at                = NEW.created_at
      THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'Published pricing versions are immutable (only controlled state transitions allowed)';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Pricing versions cannot be deleted';
  END IF;
  RETURN NEW;
END;
$function$;



CREATE OR REPLACE FUNCTION public.gateway_ack_control_snapshot_v1(p_environment text, p_instance_id text, p_version_received integer, p_hash_received text, p_version_applied integer, p_hash_applied text, p_gateway_version text, p_result text, p_error_sanitized text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO ai_gateway_config_acknowledgements (
    environment, instance_id, version_received, hash_received,
    version_applied, hash_applied, gateway_version, result, error_sanitized
  ) VALUES (
    p_environment, p_instance_id, p_version_received, p_hash_received,
    p_version_applied, p_hash_applied, p_gateway_version, p_result,
    left(p_error_sanitized, 1000)
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.gateway_ack_pricing_snapshot_v1(p_environment text, p_instance_id text, p_version_received integer, p_hash_received text, p_version_applied integer, p_hash_applied text, p_gateway_version text, p_result text, p_error_sanitized text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO ai_pricing_acknowledgements (
    environment, instance_id, version_received, hash_received,
    version_applied, hash_applied, gateway_version, result, error_sanitized
  ) VALUES (
    p_environment, p_instance_id, p_version_received, p_hash_received,
    p_version_applied, p_hash_applied, p_gateway_version, p_result,
    left(p_error_sanitized, 1000)
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.gateway_get_control_snapshot_v1(p_environment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ver ai_gateway_config_versions%ROWTYPE;
BEGIN
  SELECT * INTO v_ver
  FROM ai_gateway_config_versions
  WHERE environment = p_environment AND state = 'published'
  ORDER BY version_number DESC
  LIMIT 1;

  IF NOT FOUND THEN
    -- Return a safe default if no version published yet
    RETURN jsonb_build_object(
      'environment',       p_environment,
      'version_number',    0,
      'config_hash',       '',
      'gateway_mode',      'legacy',
      'ai_enabled',        true,
      'emergency_stop',    false,
      'failure_strategy',  'use_last_known',
      'cache_ttl_seconds', 30,
      'max_stale_seconds', 300,
      'published_at',      NULL,
      'switches',          jsonb_build_object('providers', '[]'::jsonb, 'models', '[]'::jsonb, 'features', '[]'::jsonb, 'routes', '[]'::jsonb),
      'budgets',           '[]'::jsonb
    );
  END IF;

  RETURN v_ver.snapshot || jsonb_build_object(
    'config_hash', v_ver.config_hash,
    'etag',        v_ver.config_hash
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.gateway_get_pricing_snapshot_v1(p_environment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ver ai_pricing_versions%ROWTYPE;
BEGIN
  PERFORM _promote_due_pricing_versions(p_environment);

  SELECT * INTO v_ver FROM ai_pricing_versions
  WHERE environment = p_environment AND state = 'published';

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'environment', p_environment,
      'version_number', 0,
      'config_hash', '',
      'effective_from', NULL,
      'effective_to', NULL,
      'currencies', '[]'::jsonb,
      'providers', '[]'::jsonb,
      'models', '[]'::jsonb,
      'operations', '[]'::jsonb,
      'metrics', '[]'::jsonb,
      'units', '[]'::jsonb,
      'rates', '[]'::jsonb
    );
  END IF;

  RETURN v_ver.snapshot || jsonb_build_object(
    'config_hash', v_ver.config_hash,
    'etag', v_ver.config_hash,
    'effective_to', v_ver.effective_to,
    'providers', COALESCE((SELECT jsonb_agg(DISTINCT provider) FROM ai_pricing_rates WHERE version_id = v_ver.id), '[]'::jsonb),
    'models', COALESCE((SELECT jsonb_agg(DISTINCT model) FROM ai_pricing_rates WHERE version_id = v_ver.id AND model IS NOT NULL), '[]'::jsonb),
    'operations', COALESCE((SELECT jsonb_agg(DISTINCT operation) FROM ai_pricing_rates WHERE version_id = v_ver.id AND operation IS NOT NULL), '[]'::jsonb),
    'metrics', COALESCE((SELECT jsonb_agg(DISTINCT metric_key) FROM ai_pricing_rates WHERE version_id = v_ver.id), '[]'::jsonb),
    'units', COALESCE((SELECT jsonb_agg(DISTINCT unit_type) FROM ai_pricing_rates WHERE version_id = v_ver.id), '[]'::jsonb)
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.gateway_publish_budget_policies_v1()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_row RECORD;
BEGIN
  FOR v_row IN
    SELECT rc.id, rc.scope_type, rc.scope_key
      FROM public.ai_runtime_controls rc
      WHERE rc.scope_type IN ('global', 'provider', 'feature', 'user')
      ORDER BY rc.scope_type, rc.scope_key
  LOOP
    UPDATE public.ai_runtime_controls
      SET daily_budget_usd = (
            SELECT bp.limit_value
              FROM public.ai_budget_policies bp
              WHERE bp.environment = 'production'
                AND bp.active = TRUE
                AND bp.metric = 'cost'
                AND bp.period = 'daily'
                AND bp.scope = v_row.scope_type
                AND (
                  (v_row.scope_type = 'global' AND bp.scope_value IS NULL)
                  OR bp.scope_value = v_row.scope_key
                )
                AND bp.starts_at <= v_now
                AND (bp.ends_at IS NULL OR bp.ends_at > v_now)
              ORDER BY bp.priority ASC, bp.updated_at DESC
              LIMIT 1
          ),
          monthly_budget_usd = (
            SELECT bp.limit_value
              FROM public.ai_budget_policies bp
              WHERE bp.environment = 'production'
                AND bp.active = TRUE
                AND bp.metric = 'cost'
                AND bp.period = 'monthly'
                AND bp.scope = v_row.scope_type
                AND (
                  (v_row.scope_type = 'global' AND bp.scope_value IS NULL)
                  OR bp.scope_value = v_row.scope_key
                )
                AND bp.starts_at <= v_now
                AND (bp.ends_at IS NULL OR bp.ends_at > v_now)
              ORDER BY bp.priority ASC, bp.updated_at DESC
              LIMIT 1
          ),
          updated_at = v_now
      WHERE id = v_row.id;
  END LOOP;
END;
$function$;


CREATE OR REPLACE FUNCTION public.gateway_publish_pricing_v1()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_version RECORD;
  v_rate    RECORD;
  v_mapped_metric TEXT;
  v_tag     TEXT;
BEGIN
  SELECT id, effective_from, effective_to INTO v_version
    FROM public.ai_pricing_versions
    WHERE environment = 'production' AND state = 'published'
    ORDER BY version_number DESC LIMIT 1;

  -- Deactivate every previously-published row this function owns — a
  -- full resync, so a rollback (a different/no version now published)
  -- correctly stops applying a superseded/discarded version's prices
  -- without leaving stale active rows behind.
  UPDATE public.provider_pricing
    SET is_active = FALSE, updated_at = NOW()
    WHERE source_reference LIKE 'dashboard_publish:%' AND is_active = TRUE;

  IF NOT FOUND OR v_version.id IS NULL THEN
    RETURN; -- nothing published — provider_pricing keeps only the
             -- manually-seeded rows, which this function never touched.
  END IF;

  v_tag := 'dashboard_publish:' || v_version.id::TEXT;

  FOR v_rate IN
    SELECT provider, model, metric_key, feature_key, unit_type, unit_size, unit_price, currency
    FROM public.ai_pricing_rates WHERE version_id = v_version.id
  LOOP
    v_mapped_metric := CASE v_rate.metric_key
      WHEN 'tokens_input'       THEN 'input_text_tokens'
      WHEN 'tokens_output'      THEN 'output_text_tokens'
      WHEN 'tokens_cached'      THEN 'cached_input_tokens'
      WHEN 'chars_tts_billed'   THEN 'tts_characters'
      WHEN 'audio_input_seconds' THEN 'audio_seconds'
      WHEN 'realtime_seconds'   THEN 'session_seconds'
      ELSE NULL
    END;

    IF v_mapped_metric IS NULL THEN
      RAISE NOTICE 'gateway_publish_pricing_v1: skipping unmapped metric_key % (provider=%, model=%)', v_rate.metric_key, v_rate.provider, v_rate.model;
      CONTINUE;
    END IF;

    INSERT INTO public.provider_pricing (
      provider, service, model, metric_key, currency, unit_size, price_per_unit,
      valid_from, valid_until, is_active, source_reference
    ) VALUES (
      v_rate.provider, NULL, v_rate.model, v_mapped_metric, v_rate.currency, v_rate.unit_size, v_rate.unit_price,
      COALESCE(v_version.effective_from, NOW()), v_version.effective_to, TRUE, v_tag
    );
  END LOOP;
END;
$function$;


CREATE OR REPLACE FUNCTION public.gateway_publish_runtime_controls_v1()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now    TIMESTAMPTZ := NOW();
  v_config RECORD;
  v_switch RECORD;
BEGIN
  SELECT gateway_mode, ai_enabled, emergency_stop INTO v_config
    FROM public.ai_gateway_configs WHERE environment = 'production';

  IF FOUND THEN
    UPDATE public.ai_runtime_controls
    SET gateway_mode = v_config.gateway_mode,
        runtime_status = CASE WHEN v_config.emergency_stop OR NOT v_config.ai_enabled THEN 'disabled' ELSE 'enabled' END,
        updated_at = v_now
    WHERE scope_type = 'global' AND scope_key = 'global';
  END IF;

  FOR v_switch IN
    SELECT scope, provider, feature_key, bool_and(effective_enabled) AS all_enabled
    FROM (
      SELECT scope, provider, feature_key,
             (enabled AND revoked_at IS NULL AND starts_at <= v_now AND (ends_at IS NULL OR ends_at > v_now)) AS effective_enabled
      FROM public.ai_control_switches
      WHERE environment = 'production' AND scope IN ('provider', 'feature')
    ) s
    GROUP BY scope, provider, feature_key
  LOOP
    IF v_switch.scope = 'provider' THEN
      UPDATE public.ai_runtime_controls
      SET runtime_status = CASE WHEN v_switch.all_enabled THEN 'enabled' ELSE 'disabled' END, updated_at = v_now
      WHERE scope_type = 'provider' AND scope_key = v_switch.provider;
    ELSIF v_switch.scope = 'feature' THEN
      UPDATE public.ai_runtime_controls
      SET runtime_status = CASE WHEN v_switch.all_enabled THEN 'enabled' ELSE 'disabled' END, updated_at = v_now
      WHERE scope_type = 'feature' AND scope_key = v_switch.feature_key;
    END IF;
  END LOOP;
END;
$function$;


CREATE OR REPLACE FUNCTION public.get_admin_role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT role FROM public.admin_users
  WHERE user_id = auth.uid() AND status = 'active'
  LIMIT 1;
$function$;


CREATE OR REPLACE FUNCTION public.get_gateway_breaker_state_v1(p_provider text, p_model text, p_feature_key text)
 RETURNS TABLE(state text, probe_allowed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row         public.ai_gateway_circuit_breakers%ROWTYPE;
  v_now         TIMESTAMPTZ := NOW();
  v_cooldown    INTEGER;
  v_probe_limit INTEGER;
BEGIN
  SELECT * INTO v_row FROM public.ai_gateway_circuit_breakers
    WHERE provider = p_provider AND COALESCE(model, '') = COALESCE(p_model, '') AND feature_key = p_feature_key
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'closed'::TEXT, TRUE;
    RETURN;
  END IF;

  IF v_row.state = 'closed' THEN
    RETURN QUERY SELECT 'closed'::TEXT, TRUE;
    RETURN;
  END IF;

  v_cooldown    := COALESCE(v_row.cooldown_seconds, 30);
  v_probe_limit := COALESCE(v_row.half_open_probe_count, 1);

  IF v_row.state = 'open' THEN
    IF v_row.opened_at IS NOT NULL AND v_now >= v_row.opened_at + (v_cooldown * INTERVAL '1 second') THEN
      UPDATE public.ai_gateway_circuit_breakers
      SET state = 'half_open', half_open_at = v_now, half_open_probes_used = 1, updated_at = v_now
      WHERE id = v_row.id;
      RETURN QUERY SELECT 'half_open'::TEXT, TRUE;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'open'::TEXT, FALSE;
    RETURN;
  END IF;

  IF v_row.half_open_probes_used < v_probe_limit THEN
    UPDATE public.ai_gateway_circuit_breakers
    SET half_open_probes_used = half_open_probes_used + 1, updated_at = v_now
    WHERE id = v_row.id;
    RETURN QUERY SELECT 'half_open'::TEXT, TRUE;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'half_open'::TEXT, FALSE;
END;
$function$;


CREATE OR REPLACE FUNCTION public.heartbeat_listening_job(p_job_id uuid, p_worker_id text, p_extension_ms integer DEFAULT 600000)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  UPDATE listening_jobs SET
    lock_expires_at = now() + make_interval(secs => p_extension_ms::FLOAT / 1000.0),
    updated_at      = now()
  WHERE id          = p_job_id
    AND locked_by   = p_worker_id
    AND status      = 'processing';
  RETURN FOUND;
END;
$function$;


CREATE OR REPLACE FUNCTION public.is_active_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.admin_users
    WHERE user_id = auth.uid() AND status = 'active'
  );
$function$;


CREATE OR REPLACE FUNCTION public.list_usage_daily_buckets_for_date(p_usage_date date, p_limit integer DEFAULT 200, p_after_key text DEFAULT NULL::text)
 RETURNS TABLE(bucket_key text, user_id uuid, actor_type text, feature_key text, provider text, model text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT DISTINCT
    COALESCE(e.user_id::TEXT, '00000000-0000-0000-0000-000000000000')
      || '|' || e.actor_type || '|' || e.feature_key || '|' || e.provider || '|' || COALESCE(e.model, '') AS bucket_key,
    e.user_id, e.actor_type, e.feature_key, e.provider, e.model
  FROM public.ai_usage_events e
  WHERE DATE(e.started_at AT TIME ZONE 'UTC') = p_usage_date
    AND (
      p_after_key IS NULL
      OR (COALESCE(e.user_id::TEXT, '00000000-0000-0000-0000-000000000000')
          || '|' || e.actor_type || '|' || e.feature_key || '|' || e.provider || '|' || COALESCE(e.model, '')) > p_after_key
    )
  ORDER BY bucket_key
  LIMIT GREATEST(p_limit, 0);
$function$;


CREATE OR REPLACE FUNCTION public.listening_cron_dispatch_jobs()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$           
  DECLARE                                                        
    v_secret TEXT;
    v_url    TEXT;
  BEGIN
    BEGIN
      SELECT decrypted_secret INTO v_secret FROM
  vault.decrypted_secrets WHERE name = 'cron_secret'  LIMIT 1;
      SELECT decrypted_secret INTO v_url    FROM
  vault.decrypted_secrets WHERE name = 'app_base_url' LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'listening_cron_dispatch_jobs: vault read
  failed: %', SQLERRM;
      RETURN;
    END;

    IF v_secret IS NULL OR v_url IS NULL THEN
      RAISE WARNING 'listening_cron_dispatch_jobs: vault secrets
  missing (cron_secret or app_base_url)';
      RETURN;
    END IF;

    PERFORM net.http_get(
      url     := v_url || '/api/internal/listening/dispatch',
      headers := jsonb_build_object('Authorization', 'Bearer ' ||
   v_secret)
    );
  END;
  $function$;


CREATE OR REPLACE FUNCTION public.listening_cron_ensure_inventory()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_secret TEXT;
  v_url    TEXT;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret'  LIMIT 1;
    SELECT decrypted_secret INTO v_url    FROM vault.decrypted_secrets WHERE name = 'app_base_url' LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'listening_cron_ensure_inventory: vault read failed: %', SQLERRM;
    RETURN;
  END;
  IF v_secret IS NULL OR v_url IS NULL THEN
    RAISE WARNING 'listening_cron_ensure_inventory: vault secrets missing (cron_secret or app_base_url)';
    RETURN;
  END IF;
  PERFORM net.http_post(
    url     := v_url || '/api/internal/listening/supply',
    headers := jsonb_build_object(
                 'Authorization', 'Bearer ' || v_secret,
                 'Content-Type',  'application/json'
               ),
    body    := '{"action":"generate"}'::jsonb
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.listening_cron_repair_stuck_jobs()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_secret TEXT;
  v_url    TEXT;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret'  LIMIT 1;
    SELECT decrypted_secret INTO v_url    FROM vault.decrypted_secrets WHERE name = 'app_base_url' LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'listening_cron_repair_stuck_jobs: vault read failed: %', SQLERRM;
    RETURN;
  END;
  IF v_secret IS NULL OR v_url IS NULL THEN
    RAISE WARNING 'listening_cron_repair_stuck_jobs: vault secrets missing (cron_secret or app_base_url)';
    RETURN;
  END IF;
  PERFORM net.http_get(
    url     := v_url || '/api/internal/listening/repair',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret)
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.listening_generation_jobs_set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;


CREATE OR REPLACE FUNCTION public.listening_jobs_set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;


CREATE OR REPLACE FUNCTION public.listening_level_group_for_cefr(p_cefr_level text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN p_cefr_level IN ('A1', 'A2') THEN 'A1_A2'
    WHEN p_cefr_level IN ('B1', 'B2') THEN 'B1_B2'
    WHEN p_cefr_level IN ('C1', 'C2') THEN 'C1_C2'
    ELSE NULL
  END;
$function$;


CREATE OR REPLACE FUNCTION public.listening_shared_stories_set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;


CREATE OR REPLACE FUNCTION public.mark_gateway_reservation_reconciliation_required_v1(p_reservation_id uuid, p_reason text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  UPDATE public.usage_reservations
  SET status = 'reconciliation_required', updated_at = NOW(),
      metadata = metadata || jsonb_build_object('reconciliation_reason', p_reason)
  WHERE id = p_reservation_id AND status IN ('pending', 'committed');
$function$;


CREATE OR REPLACE FUNCTION public.protect_rewrite_submission_immutability()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.submitted_at IS NOT NULL THEN
    IF NEW.rewrite_text              IS DISTINCT FROM OLD.rewrite_text             OR
       NEW.original_text_snapshot   IS DISTINCT FROM OLD.original_text_snapshot   OR
       NEW.review_id                IS DISTINCT FROM OLD.review_id                OR
       NEW.mission_id               IS DISTINCT FROM OLD.mission_id               OR
       NEW.user_id                  IS DISTINCT FROM OLD.user_id                  OR
       NEW.rewrite_sequence         IS DISTINCT FROM OLD.rewrite_sequence         OR
       NEW.submitted_at             IS DISTINCT FROM OLD.submitted_at             OR
       NEW.support_usage_snapshot   IS DISTINCT FROM OLD.support_usage_snapshot
    THEN
      RAISE EXCEPTION
        'Rewrite content is immutable after submission (attempt_id: %)', OLD.id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;


CREATE OR REPLACE FUNCTION public.publish_plan_version(p_plan_id uuid, p_draft_version_id uuid, p_client_revision integer, p_publication_notes text, p_change_summary text, p_config_hash text, p_actor_user_id uuid, p_activate_plan boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_draft public.plan_versions%rowtype;
  v_published public.plan_versions%rowtype;
  v_now timestamptz := now();
  v_retired_id uuid := null;
  v_missing_capabilities text[];
begin
  if not exists (
    select 1 from public.admin_users
    where user_id = p_actor_user_id and status = 'active' and role in ('owner', 'admin')
  ) then
    return jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');
  end if;

  select * into v_draft
  from public.plan_versions
  where id = p_draft_version_id and plan_id = p_plan_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'error', 'Rascunho não encontrado');
  end if;

  if v_draft.status <> 'draft' then
    return jsonb_build_object('success', false, 'error', 'Versão não está em rascunho');
  end if;

  if v_draft.revision <> p_client_revision then
    return jsonb_build_object(
      'success', false,
      'error', 'Conflito: outro administrador modificou este rascunho. Recarregue e tente novamente.',
      'conflict', true
    );
  end if;

  select array_agg(req.key order by req.key) into v_missing_capabilities
  from (values
    ('writing.enabled'), ('listening.enabled'), ('pronunciation.enabled'),
    ('conversation.enabled'), ('conversation.extra_purchase_enabled')
  ) as req(key)
  where not exists (
    select 1 from public.plan_capability_values pcv
    where pcv.plan_version_id = p_draft_version_id and pcv.capability_key = req.key
  );

  select v_missing_capabilities || coalesce(array_agg(pair.base_key order by pair.base_key), '{}')
  into v_missing_capabilities
  from (values
    ('writing.theme_generations_per_day', 'writing.theme_generations_per_day.unlimited'),
    ('writing.max_characters_per_text', 'writing.max_characters_per_text.unlimited'),
    ('writing.reviews_per_day', 'writing.reviews_per_day.unlimited'),
    ('listening.stories_per_day', 'listening.stories_per_day.unlimited'),
    ('pronunciation.evaluations_per_day', 'pronunciation.evaluations_per_day.unlimited'),
    ('pronunciation.max_recording_seconds', 'pronunciation.max_recording_seconds.unlimited'),
    ('conversation.realtime.seconds.monthly', 'conversation.realtime.seconds.monthly.unlimited'),
    ('conversation.max_recording_seconds', 'conversation.max_recording_seconds.unlimited')
  ) as pair(base_key, unlimited_key)
  where not exists (
    select 1 from public.plan_capability_values pcv
    where pcv.plan_version_id = p_draft_version_id
      and (
        pcv.capability_key = pair.base_key
        or (pcv.capability_key = pair.unlimited_key and pcv.value = 'true'::jsonb)
      )
  );

  if v_missing_capabilities is not null and array_length(v_missing_capabilities, 1) > 0 then
    return jsonb_build_object(
      'success', false,
      'error', 'Configuração incompleta: faltam capabilities obrigatórias para publicar esta versão.',
      'missing_capabilities', to_jsonb(v_missing_capabilities)
    );
  end if;

  select * into v_published
  from public.plan_versions
  where plan_id = p_plan_id
    and status = 'published'
    and effective_to is null
  for update;

  if found then
    update public.plan_versions
    set status = 'retired',
        effective_to = v_now
    where id = v_published.id;
    v_retired_id := v_published.id;
  end if;

  update public.plan_versions
  set
    status = 'published',
    effective_from = v_now,
    effective_to = null,
    published_at = v_now,
    published_by = p_actor_user_id,
    config_hash = p_config_hash,
    publication_notes = p_publication_notes,
    change_summary = p_change_summary
  where id = p_draft_version_id;

  if p_activate_plan then
    update public.plans
    set status = 'active',
        updated_at = v_now
    where id = p_plan_id and status = 'draft';
  end if;

  return jsonb_build_object(
    'success', true,
    'retired_version_id', v_retired_id,
    'new_version_id', p_draft_version_id
  );
end;
$function$;


CREATE OR REPLACE FUNCTION public.rebuild_usage_daily_bucket(p_usage_date date, p_user_id uuid, p_actor_type text, p_feature_key text, p_provider text, p_model text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_lock_key       BIGINT;
  v_usage_daily_id UUID;
BEGIN
  v_lock_key := hashtextextended(
    p_usage_date::TEXT || '|' ||
    COALESCE(p_user_id::TEXT, '00000000-0000-0000-0000-000000000000') || '|' ||
    p_actor_type || '|' || p_feature_key || '|' || p_provider || '|' || COALESCE(p_model, ''),
    0
  );
  PERFORM pg_advisory_xact_lock(v_lock_key);

  WITH bucket_events AS (
    SELECT e.*
    FROM public.ai_usage_events e
    WHERE DATE(e.started_at AT TIME ZONE 'UTC') = p_usage_date
      AND COALESCE(e.user_id::TEXT, '00000000-0000-0000-0000-000000000000')
          = COALESCE(p_user_id::TEXT, '00000000-0000-0000-0000-000000000000')
      AND e.actor_type  = p_actor_type
      AND e.feature_key = p_feature_key
      AND e.provider    = p_provider
      AND COALESCE(e.model, '') = COALESCE(p_model, '')
  ),
  agg AS (
    SELECT
      COUNT(*)                                                       AS total_requests,
      COUNT(*) FILTER (WHERE status = 'succeeded')                   AS successful_requests,
      COUNT(*) FILTER (WHERE status = 'failed')                      AS failed_requests,
      COUNT(*) FILTER (WHERE status = 'blocked')                     AS blocked_requests,
      COUNT(*) FILTER (WHERE cache_hit)                              AS cache_hits,
      -- pending/unpriced: any cost_status not yet resolved to a final state.
      -- Non-billable events are always 'not_applicable' from creation, so
      -- they never appear here — no separate is_billable check needed.
      COUNT(*) FILTER (WHERE cost_status NOT IN ('calculated', 'reconciled', 'not_applicable')) AS unpriced_events,
      -- Logical requests: one per distinct correlation_id, plus one for
      -- each event that has no correlation_id at all (never merged).
      COUNT(DISTINCT correlation_id) FILTER (WHERE correlation_id IS NOT NULL) AS distinct_correlation_requests,
      COUNT(*) FILTER (WHERE correlation_id IS NULL)                  AS requests_without_correlation,
      COALESCE(SUM(latency_ms), 0)                                   AS total_latency_ms,
      -- NULL calculated_cost_usd (unknown) is never treated as 0 — only
      -- non-NULL values are summed; a bucket with zero priced events
      -- correctly sums to 0, not to "we don't know".
      COALESCE(SUM(calculated_cost_usd) FILTER (WHERE calculated_cost_usd IS NOT NULL), 0) AS calculated_cost_usd,
      MAX(started_at)                                                AS last_event_at
    FROM bucket_events
  )
  INSERT INTO public.usage_daily (
    usage_date, user_id, actor_type, feature_key, provider, model,
    total_requests, successful_requests, failed_requests, blocked_requests,
    cache_hits, unpriced_events, distinct_logical_requests,
    estimated_cost_usd, calculated_cost_usd, reconciled_cost_usd,
    total_latency_ms, last_event_at, last_rebuilt_at
  )
  SELECT
    p_usage_date, p_user_id, p_actor_type, p_feature_key, p_provider, p_model,
    agg.total_requests, agg.successful_requests, agg.failed_requests, agg.blocked_requests,
    agg.cache_hits, agg.unpriced_events,
    agg.distinct_correlation_requests + agg.requests_without_correlation,
    0, agg.calculated_cost_usd, 0,
    agg.total_latency_ms, agg.last_event_at, NOW()
  FROM agg
  ON CONFLICT (usage_date, COALESCE(user_id::TEXT, '00000000-0000-0000-0000-000000000000'), actor_type, feature_key, provider, COALESCE(model, ''))
  DO UPDATE SET
    total_requests             = EXCLUDED.total_requests,
    successful_requests        = EXCLUDED.successful_requests,
    failed_requests             = EXCLUDED.failed_requests,
    blocked_requests            = EXCLUDED.blocked_requests,
    cache_hits                  = EXCLUDED.cache_hits,
    unpriced_events              = EXCLUDED.unpriced_events,
    distinct_logical_requests    = EXCLUDED.distinct_logical_requests,
    estimated_cost_usd           = EXCLUDED.estimated_cost_usd,
    calculated_cost_usd          = EXCLUDED.calculated_cost_usd,
    reconciled_cost_usd          = EXCLUDED.reconciled_cost_usd,
    total_latency_ms             = EXCLUDED.total_latency_ms,
    last_event_at                = EXCLUDED.last_event_at,
    last_rebuilt_at               = EXCLUDED.last_rebuilt_at
  RETURNING id INTO v_usage_daily_id;

  WITH bucket_events AS (
    SELECT e.id
    FROM public.ai_usage_events e
    WHERE DATE(e.started_at AT TIME ZONE 'UTC') = p_usage_date
      AND COALESCE(e.user_id::TEXT, '00000000-0000-0000-0000-000000000000')
          = COALESCE(p_user_id::TEXT, '00000000-0000-0000-0000-000000000000')
      AND e.actor_type  = p_actor_type
      AND e.feature_key = p_feature_key
      AND e.provider    = p_provider
      AND COALESCE(e.model, '') = COALESCE(p_model, '')
  ),
  metric_agg AS (
    SELECT
      m.metric_key,
      m.unit_type,
      SUM(m.quantity)                                    AS total_quantity,
      SUM(COALESCE(m.billable_quantity, 0))               AS billable_quantity,
      SUM(COALESCE(m.calculated_cost_usd, 0))             AS calculated_cost_usd
    FROM public.ai_usage_event_metrics m
    JOIN bucket_events be ON be.id = m.usage_event_id
    WHERE m.is_final = TRUE
    GROUP BY m.metric_key, m.unit_type
  ),
  ins AS (
    INSERT INTO public.usage_daily_metrics (
      usage_daily_id, metric_key, unit_type, total_quantity, billable_quantity, calculated_cost_usd
    )
    SELECT v_usage_daily_id, metric_key, unit_type, total_quantity, billable_quantity, calculated_cost_usd
    FROM metric_agg
    ON CONFLICT (usage_daily_id, metric_key, unit_type) DO UPDATE SET
      total_quantity      = EXCLUDED.total_quantity,
      billable_quantity   = EXCLUDED.billable_quantity,
      calculated_cost_usd = EXCLUDED.calculated_cost_usd
    RETURNING id
  )
  -- Full recompute means metric_key/unit_type combinations no longer present
  -- (should not normally happen — raw events are immutable) are dropped too,
  -- so the breakdown never carries stale rows forward.
  DELETE FROM public.usage_daily_metrics dm
  WHERE dm.usage_daily_id = v_usage_daily_id
    AND NOT EXISTS (
      SELECT 1 FROM metric_agg ma
      WHERE ma.metric_key = dm.metric_key AND ma.unit_type = dm.unit_type
    );

  RETURN v_usage_daily_id;
END;
$function$;


CREATE OR REPLACE FUNCTION public.rebuild_usage_daily_bucket_for_event(p_event_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event      RECORD;
  v_usage_date DATE;
BEGIN
  SELECT user_id, actor_type, feature_key, provider, model, started_at
  INTO v_event
  FROM public.ai_usage_events
  WHERE id = p_event_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'rebuild_usage_daily_bucket_for_event: event % not found', p_event_id;
  END IF;

  v_usage_date := DATE(v_event.started_at AT TIME ZONE 'UTC');

  RETURN public.rebuild_usage_daily_bucket(
    v_usage_date, v_event.user_id, v_event.actor_type, v_event.feature_key, v_event.provider, v_event.model
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.record_gateway_breaker_outcome_v1(p_provider text, p_model text, p_feature_key text, p_success boolean)
 RETURNS TABLE(state text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row           public.ai_gateway_circuit_breakers%ROWTYPE;
  v_now           TIMESTAMPTZ := NOW();
  v_min_samples   INTEGER;
  v_fail_thresh   NUMERIC;
  v_consec_thresh INTEGER;
BEGIN
  IF p_provider IS NULL OR p_feature_key IS NULL OR p_success IS NULL THEN
    RAISE EXCEPTION 'provider, feature_key and success are required';
  END IF;

  INSERT INTO public.ai_gateway_circuit_breakers (provider, model, feature_key)
  VALUES (p_provider, p_model, p_feature_key)
  ON CONFLICT (provider, (COALESCE(model, '')), feature_key) DO NOTHING;

  SELECT * INTO v_row FROM public.ai_gateway_circuit_breakers
    WHERE provider = p_provider AND COALESCE(model, '') = COALESCE(p_model, '') AND feature_key = p_feature_key
    FOR UPDATE;

  v_min_samples   := COALESCE(v_row.min_samples, 20);
  v_fail_thresh   := COALESCE(v_row.failure_rate_threshold, 0.5);
  v_consec_thresh := COALESCE(v_row.consecutive_failure_threshold, 5);

  IF v_row.state = 'half_open' THEN
    IF p_success THEN
      UPDATE public.ai_gateway_circuit_breakers
      SET state = 'closed', consecutive_failures = 0, window_failure_count = 0, window_sample_count = 0,
          window_started_at = v_now, opened_at = NULL, half_open_at = NULL, half_open_probes_used = 0,
          updated_at = v_now
      WHERE id = v_row.id;
      RETURN QUERY SELECT 'closed'::TEXT;
    ELSE
      UPDATE public.ai_gateway_circuit_breakers
      SET state = 'open', opened_at = v_now, half_open_at = NULL, half_open_probes_used = 0, updated_at = v_now
      WHERE id = v_row.id;
      RETURN QUERY SELECT 'open'::TEXT;
    END IF;
    RETURN;
  END IF;

  UPDATE public.ai_gateway_circuit_breakers
  SET consecutive_failures = CASE WHEN p_success THEN 0 ELSE consecutive_failures + 1 END,
      window_sample_count  = window_sample_count + 1,
      window_failure_count = window_failure_count + (CASE WHEN p_success THEN 0 ELSE 1 END),
      updated_at = v_now
  WHERE id = v_row.id
  RETURNING * INTO v_row;

  IF v_row.state = 'closed'
     AND (v_row.consecutive_failures >= v_consec_thresh
          OR (v_row.window_sample_count >= v_min_samples
              AND v_row.window_failure_count::NUMERIC / v_row.window_sample_count >= v_fail_thresh))
  THEN
    UPDATE public.ai_gateway_circuit_breakers
    SET state = 'open', opened_at = v_now, updated_at = v_now
    WHERE id = v_row.id;
    RETURN QUERY SELECT 'open'::TEXT;
    RETURN;
  END IF;

  RETURN QUERY SELECT v_row.state;
END;
$function$;


CREATE OR REPLACE FUNCTION public.record_gateway_concurrency_validation_v1(p_migration_version text, p_validation_script_path text, p_validation_script_sha256 text, p_status text, p_executed_by text, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id UUID;
BEGIN
  IF p_migration_version IS NULL OR char_length(p_migration_version) = 0 THEN
    RAISE EXCEPTION 'migration_version is required';
  END IF;
  IF p_validation_script_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'validation_script_sha256 must be a 64-char lowercase hex SHA-256 digest';
  END IF;
  IF p_status NOT IN ('passed', 'failed') THEN
    RAISE EXCEPTION 'status must be passed or failed';
  END IF;
  IF p_executed_by IS NULL OR char_length(p_executed_by) = 0 THEN
    RAISE EXCEPTION 'executed_by is required (a technical identifier for audit — who actually ran the scenarios)';
  END IF;

  INSERT INTO public.ai_gateway_concurrency_validations (
    migration_version, validation_script_path, validation_script_sha256, status, executed_at, executed_by, notes
  ) VALUES (
    p_migration_version, p_validation_script_path, p_validation_script_sha256, p_status, NOW(), p_executed_by, p_notes
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;


CREATE OR REPLACE FUNCTION public.record_realtime_hard_control_validation_v1(p_hard_control_version text, p_validation_script_path text, p_validation_script_sha256 text, p_git_sha text, p_environment text, p_scenario_results jsonb, p_executed_by text, p_notes text DEFAULT NULL::text, p_evidence jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id UUID;
  v_required_keys TEXT[] := ARRAY[
    'reservation_authorization', 'concurrency', 'limit_rejection', 'normal_termination',
    'disconnection', 'timeout', 'reservation_release', 'orphan_cleanup'
  ];
  v_key TEXT;
  v_val TEXT;
  v_all_passed BOOLEAN := TRUE;
  v_derived_status TEXT;
  v_evidence_text TEXT;
BEGIN
  IF p_hard_control_version IS NULL OR char_length(p_hard_control_version) = 0 THEN
    RAISE EXCEPTION 'hard_control_version is required';
  END IF;
  IF p_validation_script_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'validation_script_sha256 must be a 64-char lowercase hex SHA-256 digest';
  END IF;
  IF p_git_sha !~ '^[0-9a-f]{40}$' THEN
    RAISE EXCEPTION 'git_sha must be a 40-char lowercase hex commit SHA';
  END IF;
  IF p_environment NOT IN ('production', 'preview', 'development') THEN
    RAISE EXCEPTION 'environment must be one of production, preview, development';
  END IF;
  IF p_executed_by IS NULL OR char_length(p_executed_by) = 0 THEN
    RAISE EXCEPTION 'executed_by is required (a technical identifier for audit — who actually ran the scenarios)';
  END IF;
  IF p_scenario_results IS NULL OR jsonb_typeof(p_scenario_results) <> 'object' THEN
    RAISE EXCEPTION 'scenario_results must be a JSON object';
  END IF;

  IF (SELECT COUNT(*) FROM jsonb_object_keys(p_scenario_results)) <> array_length(v_required_keys, 1) THEN
    RAISE EXCEPTION 'scenario_results must contain exactly the % required scenario keys, got % keys', array_length(v_required_keys, 1), (SELECT COUNT(*) FROM jsonb_object_keys(p_scenario_results));
  END IF;

  FOREACH v_key IN ARRAY v_required_keys LOOP
    IF NOT (p_scenario_results ? v_key) THEN
      RAISE EXCEPTION 'scenario_results missing required key: %', v_key;
    END IF;
    IF jsonb_typeof(p_scenario_results -> v_key) <> 'string' THEN
      RAISE EXCEPTION 'scenario_results.% must be a string (''passed'' or ''failed'')', v_key;
    END IF;
    v_val := p_scenario_results ->> v_key;
    IF v_val NOT IN ('passed', 'failed') THEN
      RAISE EXCEPTION 'scenario_results.% must be ''passed'' or ''failed'', got %', v_key, v_val;
    END IF;
    IF v_val = 'failed' THEN
      v_all_passed := FALSE;
    END IF;
  END LOOP;

  v_derived_status := CASE WHEN v_all_passed THEN 'passed' ELSE 'failed' END;

  IF jsonb_typeof(p_evidence) <> 'object' THEN
    RAISE EXCEPTION 'evidence must be a JSON object';
  END IF;
  v_evidence_text := p_evidence::text;
  IF char_length(v_evidence_text) > 20000 THEN
    RAISE EXCEPTION 'evidence payload too large (max 20000 chars) — summarize, do not paste raw logs';
  END IF;
  IF v_evidence_text ~ 'sk-[A-Za-z0-9_-]{10,}' OR v_evidence_text ~* 'bearer\s+[A-Za-z0-9._-]{10,}' THEN
    RAISE EXCEPTION 'evidence appears to contain a raw API key or bearer token — never persist secrets here';
  END IF;

  INSERT INTO public.realtime_hard_control_validations (
    hard_control_version, validation_script_path, validation_script_sha256,
    git_sha, environment, scenario_results, status, executed_at, executed_by, notes, evidence
  ) VALUES (
    p_hard_control_version, p_validation_script_path, p_validation_script_sha256,
    p_git_sha, p_environment, p_scenario_results, v_derived_status, NOW(), p_executed_by, p_notes, p_evidence
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;


CREATE OR REPLACE FUNCTION public.release_gateway_reservation_v1(p_reservation_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now  TIMESTAMPTZ := NOW();
  v_item RECORD;
BEGIN
  PERFORM 1 FROM public.usage_reservations WHERE id = p_reservation_id AND status = 'pending' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  FOR v_item IN
    SELECT reserved_quantity, quota_bucket_id FROM public.usage_reservation_items
      WHERE reservation_id = p_reservation_id AND quota_bucket_id IS NOT NULL
      ORDER BY quota_bucket_id
  LOOP
    UPDATE public.ai_gateway_quota_buckets
      SET reserved_quantity = GREATEST(0, reserved_quantity - v_item.reserved_quantity), updated_at = v_now
      WHERE id = v_item.quota_bucket_id;
  END LOOP;

  FOR v_item IN
    SELECT budget_bucket_id, reserved_cost_usd FROM public.ai_gateway_reservation_budget_links
      WHERE reservation_id = p_reservation_id ORDER BY budget_bucket_id
  LOOP
    UPDATE public.ai_gateway_budget_buckets
      SET reserved_cost_usd = GREATEST(0, reserved_cost_usd - v_item.reserved_cost_usd), updated_at = v_now
      WHERE id = v_item.budget_bucket_id;
  END LOOP;

  UPDATE public.usage_reservations
    SET status = 'released', finalized_at = v_now, updated_at = v_now,
        metadata = metadata || jsonb_build_object('release_reason', p_reason)
    WHERE id = p_reservation_id AND status = 'pending';
END;
$function$;


CREATE OR REPLACE FUNCTION public.reserve_gateway_usage_v1(p_idempotency_key text, p_user_id uuid, p_initiated_by_user_id uuid, p_feature_key text, p_provider text, p_model text, p_metrics jsonb, p_budget_scopes jsonb, p_estimated_cost_usd numeric, p_expires_in_seconds integer)
 RETURNS TABLE(reservation_id uuid, status text, expires_at timestamp with time zone, blocked_reason text, blocked_detail text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now             TIMESTAMPTZ := NOW();
  v_expires_at      TIMESTAMPTZ;
  v_id              UUID;
  v_status          TEXT;
  v_subject_type    TEXT;
  v_item            JSONB;
  v_bucket          public.ai_gateway_quota_buckets;
  v_budget_bucket   public.ai_gateway_budget_buckets;
  v_available       NUMERIC;
  v_blocked_reason  TEXT := NULL;
  v_blocked_detail  TEXT := NULL;
  v_scope_priority  INTEGER;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(p_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'idempotency_key is required';
  END IF;
  IF p_feature_key IS NULL OR p_provider IS NULL THEN
    RAISE EXCEPTION 'feature_key and provider are required';
  END IF;
  IF p_expires_in_seconds IS NULL OR p_expires_in_seconds <= 0 OR p_expires_in_seconds > 3600 THEN
    RAISE EXCEPTION 'expires_in_seconds must be between 1 and 3600';
  END IF;
  IF p_estimated_cost_usd IS NOT NULL AND p_estimated_cost_usd < 0 THEN
    RAISE EXCEPTION 'estimated_cost_usd must not be negative';
  END IF;

  SELECT ur.id, ur.status, ur.expires_at INTO v_id, v_status, v_expires_at
    FROM public.usage_reservations ur WHERE ur.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN QUERY SELECT v_id, v_status, v_expires_at, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  v_subject_type := CASE WHEN p_user_id IS NOT NULL THEN 'user' ELSE 'system' END;
  v_expires_at := v_now + (p_expires_in_seconds * INTERVAL '1 second');

  -- ── Phase 1: lock + validate every quota bucket, deterministic order ──────
  FOR v_item IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_metrics, '[]'::jsonb)) AS value
    ORDER BY (value->>'quota_key')
  LOOP
    IF v_item->>'quota_key' IS NULL THEN
      RAISE EXCEPTION 'each metrics item requires quota_key';
    END IF;

    IF v_item->'limit_quantity' IS NOT NULL AND jsonb_typeof(v_item->'limit_quantity') != 'null' THEN
      v_bucket := public._gateway_touch_quota_bucket_v1(
        v_subject_type, p_user_id, p_feature_key, v_item->>'quota_key',
        v_item->>'period_type', (v_item->>'period_start')::TIMESTAMPTZ, (v_item->>'period_end')::TIMESTAMPTZ
      );
      v_available := (v_item->>'limit_quantity')::NUMERIC - v_bucket.committed_quantity - v_bucket.reserved_quantity;
      IF (v_item->>'reserved_quantity')::NUMERIC > GREATEST(v_available, 0) THEN
        v_blocked_reason := 'QUOTA_EXCEEDED';
        v_blocked_detail := v_item->>'quota_key';
        EXIT;
      END IF;
    END IF;
  END LOOP;

  -- ── Phase 2: lock + validate every budget scope, deterministic order ──────
  IF v_blocked_reason IS NULL THEN
    FOR v_item IN
      SELECT value FROM jsonb_array_elements(COALESCE(p_budget_scopes, '[]'::jsonb)) AS value
      ORDER BY
        (CASE value->>'scope_type'
          WHEN 'user' THEN 1 WHEN 'plan' THEN 2 WHEN 'feature' THEN 3 WHEN 'provider' THEN 4 WHEN 'global' THEN 5 ELSE 6
        END),
        (value->>'scope_key')
    LOOP
      IF v_item->'limit_usd' IS NULL OR jsonb_typeof(v_item->'limit_usd') = 'null' THEN
        CONTINUE;
      END IF;

      -- FIX (this migration): a NULL estimate against a scope that DOES have
      -- a configured limit must never be treated as "$0 / this call is
      -- free" — that was the exact bug (COALESCE(p_estimated_cost_usd, 0)
      -- below, previously the ONLY handling). "We cannot prove this call's
      -- worst-case cost is affordable" now fails closed here, exactly like
      -- an estimate that resolved to a number larger than what remains —
      -- checked BEFORE touching/locking the bucket, since there is nothing
      -- to increment when blocking. A scope with no configured limit was
      -- already skipped above (CONTINUE) and stays skipped — this never
      -- blocks a call in a scope where no real budget is in effect.
      IF p_estimated_cost_usd IS NULL THEN
        v_blocked_reason := 'BUDGET_EXCEEDED';
        v_blocked_detail := v_item->>'scope_type' || ':' || (v_item->>'scope_key') || ':estimate_unavailable';
        EXIT;
      END IF;

      v_budget_bucket := public._gateway_touch_budget_bucket_v1(
        v_item->>'scope_type', v_item->>'scope_key', v_item->>'period_type',
        (v_item->>'period_start')::TIMESTAMPTZ, (v_item->>'period_end')::TIMESTAMPTZ
      );
      v_available := (v_item->>'limit_usd')::NUMERIC - v_budget_bucket.committed_cost_usd - v_budget_bucket.reserved_cost_usd;
      IF p_estimated_cost_usd > GREATEST(v_available, 0) THEN
        v_blocked_reason := 'BUDGET_EXCEEDED';
        v_blocked_detail := v_item->>'scope_type' || ':' || (v_item->>'scope_key');
        EXIT;
      END IF;
    END LOOP;
  END IF;

  IF v_blocked_reason IS NOT NULL THEN
    RETURN QUERY SELECT NULL::UUID, 'blocked'::TEXT, NULL::TIMESTAMPTZ, v_blocked_reason, v_blocked_detail;
    RETURN;
  END IF;

  -- ── Phase 3: everything validated — create the reservation and apply increments ──
  BEGIN
    INSERT INTO public.usage_reservations (
      request_id, idempotency_key, user_id, initiated_by_user_id,
      feature_key, status, estimated_cost_usd, expires_at, metadata
    ) VALUES (
      gen_random_uuid(), p_idempotency_key, p_user_id, p_initiated_by_user_id,
      p_feature_key, 'pending', p_estimated_cost_usd, v_expires_at,
      jsonb_build_object('provider', p_provider, 'model', p_model)
    )
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT ur.id, ur.status, ur.expires_at INTO v_id, v_status, v_expires_at
      FROM public.usage_reservations ur WHERE ur.idempotency_key = p_idempotency_key;
    RETURN QUERY SELECT v_id, v_status, v_expires_at, NULL::TEXT, NULL::TEXT;
    RETURN;
  END;

  FOR v_item IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_metrics, '[]'::jsonb)) AS value
    ORDER BY (value->>'quota_key')
  LOOP
    v_bucket.id := NULL;
    IF v_item->'limit_quantity' IS NOT NULL AND jsonb_typeof(v_item->'limit_quantity') != 'null' THEN
      v_bucket := public._gateway_touch_quota_bucket_v1(
        v_subject_type, p_user_id, p_feature_key, v_item->>'quota_key',
        v_item->>'period_type', (v_item->>'period_start')::TIMESTAMPTZ, (v_item->>'period_end')::TIMESTAMPTZ
      );
      UPDATE public.ai_gateway_quota_buckets
        SET reserved_quantity = reserved_quantity + (v_item->>'reserved_quantity')::NUMERIC, updated_at = v_now
        WHERE id = v_bucket.id;
    END IF;

    INSERT INTO public.usage_reservation_items (
      reservation_id, quota_key, unit_type, reserved_quantity, quota_bucket_id
    ) VALUES (
      v_id, v_item->>'quota_key', COALESCE(v_item->>'unit_type', 'unit'),
      COALESCE((v_item->>'reserved_quantity')::NUMERIC, 0), v_bucket.id
    );
  END LOOP;

  FOR v_item IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_budget_scopes, '[]'::jsonb)) AS value
  LOOP
    IF v_item->'limit_usd' IS NULL OR jsonb_typeof(v_item->'limit_usd') = 'null' THEN
      CONTINUE;
    END IF;
    v_budget_bucket := public._gateway_touch_budget_bucket_v1(
      v_item->>'scope_type', v_item->>'scope_key', v_item->>'period_type',
      (v_item->>'period_start')::TIMESTAMPTZ, (v_item->>'period_end')::TIMESTAMPTZ
    );
    UPDATE public.ai_gateway_budget_buckets
      SET reserved_cost_usd = reserved_cost_usd + COALESCE(p_estimated_cost_usd, 0), updated_at = v_now
      WHERE id = v_budget_bucket.id;

    INSERT INTO public.ai_gateway_reservation_budget_links (reservation_id, budget_bucket_id, reserved_cost_usd)
      VALUES (v_id, v_budget_bucket.id, COALESCE(p_estimated_cost_usd, 0))
      ON CONFLICT ON CONSTRAINT uq_agrbl_reservation_bucket DO NOTHING;
  END LOOP;

  RETURN QUERY SELECT v_id, 'pending'::TEXT, v_expires_at, NULL::TEXT, NULL::TEXT;
END;
$function$;


CREATE OR REPLACE FUNCTION public.reserve_pronunciation_assessment(p_text_version_id uuid, p_azure_region text, p_attempt_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id        UUID;
  v_reference_text TEXT;
  v_id             UUID;
  v_status         TEXT;
  v_active_attempt UUID;
  v_rows_inserted  INTEGER;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  IF p_attempt_id IS NULL THEN
    RETURN jsonb_build_object('error', 'INVALID_ATTEMPT_ID');
  END IF;

  -- Validate ownership and resolve the reference text.
  SELECT COALESCE(
    NULLIF(trim(version_2_text), ''),
    NULLIF(trim(corrected_text), '')
  )
  INTO v_reference_text
  FROM english_reviews
  WHERE id      = p_text_version_id
    AND user_id = v_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'TEXT_VERSION_NOT_FOUND');
  END IF;

  IF v_reference_text IS NULL THEN
    RETURN jsonb_build_object('error', 'TEXT_VERSION_NOT_ELIGIBLE');
  END IF;

  -- Atomic reservation: one INSERT wins; concurrent inserts hit the unique constraint.
  INSERT INTO pronunciation_assessments (
    user_id, text_version_id, status, reference_text,
    language_code, azure_region, started_at,
    active_attempt_id, attempt_started_at
  )
  VALUES (
    v_user_id, p_text_version_id, 'processing', v_reference_text,
    'en-US', p_azure_region, NOW(),
    p_attempt_id, NOW()
  )
  ON CONFLICT ON CONSTRAINT uq_pronunciation_per_text_version DO NOTHING;

  GET DIAGNOSTICS v_rows_inserted = ROW_COUNT;

  -- Lock the row for the rest of this transaction.
  SELECT id, status, active_attempt_id
  INTO   v_id, v_status, v_active_attempt
  FROM   pronunciation_assessments
  WHERE  user_id         = v_user_id
    AND  text_version_id = p_text_version_id
  FOR UPDATE;

  IF v_rows_inserted = 1 THEN
    RETURN jsonb_build_object(
      'action',        'created',
      'assessmentId',  v_id,
      'referenceText', v_reference_text
    );
  END IF;

  CASE v_status

    WHEN 'processing' THEN
      IF v_active_attempt = p_attempt_id THEN
        -- Same attempt re-requesting (e.g. token expired): idempotent
        RETURN jsonb_build_object(
          'action',        'existing_processing',
          'assessmentId',  v_id,
          'referenceText', v_reference_text
        );
      ELSE
        -- Different attempt: another tab/request holds the active slot
        RETURN jsonb_build_object(
          'error',        'ASSESSMENT_IN_PROGRESS',
          'assessmentId', v_id
        );
      END IF;

    WHEN 'failed_retryable', 'failed_final' THEN
      -- Allow retry regardless of how many times the user has failed
      UPDATE pronunciation_assessments
         SET status             = 'processing',
             started_at         = NOW(),
             active_attempt_id  = p_attempt_id,
             attempt_started_at = NOW(),
             error_code         = NULL,
             error_message      = NULL
       WHERE id      = v_id
         AND user_id = v_user_id;

      RETURN jsonb_build_object(
        'action',        'reactivated',
        'assessmentId',  v_id,
        'referenceText', v_reference_text
      );

    WHEN 'completed' THEN
      -- Allow a new attempt: switch to processing, keep previous scores for fallback
      UPDATE pronunciation_assessments
         SET status             = 'processing',
             started_at         = NOW(),
             active_attempt_id  = p_attempt_id,
             attempt_started_at = NOW(),
             error_code         = NULL,
             error_message      = NULL
       WHERE id      = v_id
         AND user_id = v_user_id;

      RETURN jsonb_build_object(
        'action',        'restarted',
        'assessmentId',  v_id,
        'referenceText', v_reference_text
      );

    ELSE
      RETURN jsonb_build_object('error', 'ASSESSMENT_UNAVAILABLE');

  END CASE;
END;
$function$;


CREATE OR REPLACE FUNCTION public.reserve_pronunciation_training_assessment(p_practice_date date, p_azure_region text, p_attempt_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id        UUID;
  v_id             UUID;
  v_status         TEXT;
  v_active_attempt UUID;
  v_generated_text TEXT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  IF p_attempt_id IS NULL THEN
    RETURN jsonb_build_object('error', 'INVALID_ATTEMPT_ID');
  END IF;

  SELECT id, status, active_attempt_id, generated_text
  INTO   v_id, v_status, v_active_attempt, v_generated_text
  FROM   pronunciation_training_sessions
  WHERE  user_id = v_user_id AND practice_date = p_practice_date
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'TEXT_NOT_GENERATED');
  END IF;

  CASE v_status

    WHEN 'text_generated', 'failed_retryable', 'failed_final' THEN
      UPDATE pronunciation_training_sessions
         SET status             = 'processing',
             started_at         = NOW(),
             active_attempt_id  = p_attempt_id,
             attempt_started_at = NOW(),
             azure_region       = p_azure_region,
             error_code         = NULL,
             error_message      = NULL
       WHERE id = v_id;

      RETURN jsonb_build_object('action', 'reserved', 'sessionId', v_id, 'referenceText', v_generated_text);

    WHEN 'processing' THEN
      IF v_active_attempt = p_attempt_id THEN
        -- Mesma tentativa reconsultando (ex.: token expirado): idempotente.
        RETURN jsonb_build_object('action', 'existing_processing', 'sessionId', v_id, 'referenceText', v_generated_text);
      ELSE
        RETURN jsonb_build_object('error', 'ASSESSMENT_IN_PROGRESS', 'sessionId', v_id);
      END IF;

    WHEN 'completed' THEN
      -- Regra obrigatoria: nao ha reinicio depois de concluida. Bloqueio
      -- termina apenas na virada do dia (nova practice_date).
      RETURN jsonb_build_object('error', 'DAILY_LIMIT_REACHED', 'sessionId', v_id);

    ELSE
      RETURN jsonb_build_object('error', 'ASSESSMENT_UNAVAILABLE');

  END CASE;
END;
$function$;


CREATE OR REPLACE FUNCTION public.reserve_writing_review(p_attempt_id uuid, p_unlimited boolean, p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id      UUID;
  v_id           UUID;
  v_status       TEXT;
  v_review_id    UUID;
  v_found        BOOLEAN;
  v_today_start  TIMESTAMPTZ;
  v_today_end    TIMESTAMPTZ;
  v_consumed     INTEGER;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  IF p_attempt_id IS NULL THEN
    RETURN jsonb_build_object('error', 'INVALID_ATTEMPT_ID');
  END IF;

  p_unlimited := coalesce(p_unlimited, false);
  p_limit := coalesce(p_limit, 0);

  PERFORM pg_advisory_xact_lock(hashtext('writing_review'), hashtext(v_user_id::text));

  SELECT id, status, review_id
  INTO   v_id, v_status, v_review_id
  FROM   writing_review_reservations
  WHERE  user_id = v_user_id AND attempt_id = p_attempt_id
  FOR UPDATE;
  v_found := FOUND;

  IF v_found AND v_status = 'completed' THEN
    RETURN jsonb_build_object('status', 'completed', 'reservationId', v_id, 'reviewId', v_review_id, 'fresh', false);
  END IF;
  IF v_found AND v_status = 'reserved' THEN
    RETURN jsonb_build_object('status', 'in_progress', 'reservationId', v_id, 'fresh', false);
  END IF;

  IF NOT p_unlimited THEN
    v_today_start := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    v_today_end   := v_today_start + interval '1 day';

    SELECT count(*) INTO v_consumed
    FROM   writing_review_reservations
    WHERE  user_id = v_user_id
      AND  status IN ('reserved', 'completed')
      AND  created_at >= v_today_start
      AND  created_at < v_today_end;

    IF v_consumed >= p_limit THEN
      RETURN jsonb_build_object('error', 'DAILY_LIMIT_REACHED');
    END IF;
  END IF;

  IF v_found THEN
    UPDATE writing_review_reservations
       SET status = 'reserved', review_id = NULL, updated_at = now()
     WHERE id = v_id;
  ELSE
    INSERT INTO writing_review_reservations (user_id, attempt_id, status)
    VALUES (v_user_id, p_attempt_id, 'reserved')
    RETURNING id INTO v_id;
  END IF;

  RETURN jsonb_build_object('status', 'reserved', 'reservationId', v_id, 'fresh', true);
END;
$function$;


CREATE OR REPLACE FUNCTION public.set_ai_prefs_user_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.user_id  := COALESCE(NEW.user_id, auth.uid());
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$function$;


CREATE OR REPLACE FUNCTION public.set_conversation_session_user_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.user_id := COALESCE(NEW.user_id, auth.uid());
  RETURN NEW;
END;
$function$;


CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$;


CREATE OR REPLACE FUNCTION public.tg_plan_capability_values_immutability()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_status TEXT;
  v_version_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_version_id := OLD.plan_version_id;
  ELSE
    v_version_id := NEW.plan_version_id;
  END IF;

  SELECT status INTO v_status
  FROM public.plan_versions
  WHERE id = v_version_id;

  IF v_status IS NULL THEN
    -- Version was already deleted (CASCADE); allow row removal.
    RETURN COALESCE(OLD, NEW);
  END IF;

  IF v_status IN ('published', 'retired', 'discarded') THEN
    RAISE EXCEPTION 'Cannot modify capability values for non-draft versions (version %, status %)', v_version_id, v_status;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;


CREATE OR REPLACE FUNCTION public.tg_plan_versions_immutability()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.plan_id IS DISTINCT FROM NEW.plan_id THEN
    RAISE EXCEPTION 'plan_id is immutable on plan_versions';
  END IF;

  IF OLD.version_number IS DISTINCT FROM NEW.version_number THEN
    RAISE EXCEPTION 'version_number is immutable on plan_versions';
  END IF;

  IF OLD.status IN ('published', 'retired', 'discarded') AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'Cannot revert status % to draft', OLD.status;
  END IF;

  IF OLD.status = 'discarded' AND NEW.status IS DISTINCT FROM 'discarded' THEN
    RAISE EXCEPTION 'Cannot change status of a discarded version';
  END IF;

  RETURN NEW;
END;
$function$;


CREATE OR REPLACE FUNCTION public.tg_plan_versions_no_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.status IN ('published', 'retired') THEN
    RAISE EXCEPTION 'Cannot delete plan_versions with status % (id=%)', OLD.status, OLD.id;
  END IF;
  RETURN OLD;
END;
$function$;


CREATE OR REPLACE FUNCTION public.tg_plan_versions_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$function$;


CREATE OR REPLACE FUNCTION public.update_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$;



CREATE OR REPLACE FUNCTION public.user_listening_shared_progress_set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;


CREATE OR REPLACE FUNCTION public.validate_listening_question_block_episode()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM listening_blocks b
    WHERE b.id = NEW.block_id AND b.episode_id = NEW.episode_id
  ) THEN
    RAISE EXCEPTION
      'listening_questions: block_id % does not belong to episode_id %',
      NEW.block_id, NEW.episode_id
      USING ERRCODE = 'P0002';
  END IF;
  RETURN NEW;
END;
$function$;


-- ---------------------------------------------------------------------
-- 10. COLUNA GERADA (depende de listening_level_group_for_cefr, criada na secao 9)
-- ---------------------------------------------------------------------
ALTER TABLE public.listening_episodes
  ADD COLUMN level_group text GENERATED ALWAYS AS (public.listening_level_group_for_cefr(cefr_level)) STORED;

-- ---------------------------------------------------------------------
-- 10b. CONSTRAINT/INDEX que dependem da coluna gerada acima (movidos das
--      Secoes 6 e 7 originais -- nao podiam ser criados antes da coluna existir)
-- ---------------------------------------------------------------------
ALTER TABLE ONLY public.listening_episodes ADD CONSTRAINT chk_le_level_group CHECK ((level_group = ANY (ARRAY['A1_A2'::text, 'B1_B2'::text, 'C1_C2'::text])));
CREATE INDEX idx_le_level_group_status_level ON public.listening_episodes USING btree (level_group, cefr_level, status);

-- ---------------------------------------------------------------------
-- 11. TRIGGERS (59 objetos; information_schema conta 78 porque cada evento
--     combinado - INSERT OR UPDATE etc. - aparece como linha separada ali)
-- ---------------------------------------------------------------------
CREATE TRIGGER tg_admin_invitations_updated_at BEFORE UPDATE ON public.admin_invitations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tg_admin_security_events_immutable BEFORE DELETE OR UPDATE ON public.admin_security_events FOR EACH ROW EXECUTE FUNCTION fn_admin_security_events_immutable();
CREATE TRIGGER tg_admin_security_policy_versions_immutable BEFORE DELETE OR UPDATE ON public.admin_security_policy_versions FOR EACH ROW EXECUTE FUNCTION fn_admin_security_policy_version_immutable();
CREATE TRIGGER tg_admin_users_owner_guard BEFORE DELETE OR UPDATE ON public.admin_users FOR EACH ROW EXECUTE FUNCTION fn_admin_users_owner_guard();
CREATE TRIGGER tg_admin_users_updated_at BEFORE UPDATE ON public.admin_users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_publish_runtime_controls_on_switch AFTER INSERT OR UPDATE ON public.ai_control_switches FOR EACH ROW EXECUTE FUNCTION _gateway_publish_runtime_controls_trigger_v1();
CREATE TRIGGER trg_ai_prefs_user_id BEFORE INSERT OR UPDATE ON public.ai_conversation_preferences FOR EACH ROW EXECUTE FUNCTION set_ai_prefs_user_id();
CREATE TRIGGER tg_cost_valuations_immutable BEFORE DELETE OR UPDATE ON public.ai_cost_valuations FOR EACH ROW EXECUTE FUNCTION fn_cost_valuation_immutable();
CREATE TRIGGER trg_ai_features_updated_at BEFORE UPDATE ON public.ai_features FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_ai_gateway_budget_buckets_updated_at BEFORE UPDATE ON public.ai_gateway_budget_buckets FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_ai_gateway_circuit_breakers_updated_at BEFORE UPDATE ON public.ai_gateway_circuit_breakers FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tg_gateway_versions_immutable BEFORE DELETE OR UPDATE ON public.ai_gateway_config_versions FOR EACH ROW EXECUTE FUNCTION fn_gateway_version_immutable();
CREATE TRIGGER trg_publish_runtime_controls_on_config AFTER INSERT OR UPDATE ON public.ai_gateway_configs FOR EACH ROW EXECUTE FUNCTION _gateway_publish_runtime_controls_trigger_v1();
CREATE TRIGGER trg_ai_gateway_idempotency_locks_updated_at BEFORE UPDATE ON public.ai_gateway_idempotency_locks FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_ai_gateway_quota_buckets_updated_at BEFORE UPDATE ON public.ai_gateway_quota_buckets FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tg_pricing_rates_editable_guard BEFORE INSERT OR DELETE OR UPDATE ON public.ai_pricing_rates FOR EACH ROW EXECUTE FUNCTION fn_pricing_rate_editable_guard();
CREATE TRIGGER tg_pricing_rates_updated_at BEFORE UPDATE ON public.ai_pricing_rates FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tg_pricing_versions_immutable BEFORE DELETE OR UPDATE ON public.ai_pricing_versions FOR EACH ROW EXECUTE FUNCTION fn_pricing_version_immutable();
CREATE TRIGGER tg_pricing_versions_updated_at BEFORE UPDATE ON public.ai_pricing_versions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_publish_pricing_on_version AFTER INSERT OR UPDATE ON public.ai_pricing_versions FOR EACH ROW EXECUTE FUNCTION _gateway_publish_pricing_trigger_v1();
CREATE TRIGGER trg_ai_provider_sessions_updated_at BEFORE UPDATE ON public.ai_provider_sessions FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_ai_runtime_controls_updated_at BEFORE UPDATE ON public.ai_runtime_controls FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tg_config_definitions_updated_at BEFORE UPDATE ON public.app_config_definitions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tg_config_values_editable_guard BEFORE INSERT OR DELETE OR UPDATE ON public.app_config_values FOR EACH ROW EXECUTE FUNCTION fn_config_value_editable_guard();
CREATE TRIGGER tg_config_values_updated_at BEFORE UPDATE ON public.app_config_values FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tg_config_versions_immutable BEFORE DELETE OR UPDATE ON public.app_config_versions FOR EACH ROW EXECUTE FUNCTION fn_config_version_immutable();
CREATE TRIGGER tg_config_versions_updated_at BEFORE UPDATE ON public.app_config_versions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_conv_session_user_id BEFORE INSERT ON public.conversation_sessions FOR EACH ROW EXECUTE FUNCTION set_conversation_session_user_id();
CREATE TRIGGER tg_listening_audio_flags_updated_at BEFORE UPDATE ON public.listening_audio_flags FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tg_listening_episode_distribution_updated_at BEFORE UPDATE ON public.listening_episode_distribution FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tg_listening_publications_immutable BEFORE DELETE OR UPDATE ON public.listening_episode_publications FOR EACH ROW EXECUTE FUNCTION fn_listening_publication_immutable();
CREATE TRIGGER trg_listening_generation_jobs_updated_at BEFORE UPDATE ON public.listening_generation_jobs FOR EACH ROW EXECUTE FUNCTION listening_generation_jobs_set_updated_at();
CREATE TRIGGER tg_listening_requests_terminal_guard BEFORE UPDATE ON public.listening_generation_requests FOR EACH ROW EXECUTE FUNCTION fn_listening_request_terminal_guard();
CREATE TRIGGER tg_listening_requests_updated_at BEFORE UPDATE ON public.listening_generation_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_listening_jobs_updated_at BEFORE UPDATE ON public.listening_jobs FOR EACH ROW EXECUTE FUNCTION listening_jobs_set_updated_at();
CREATE TRIGGER trg_lq_validate_block_episode BEFORE INSERT OR UPDATE ON public.listening_questions FOR EACH ROW EXECUTE FUNCTION validate_listening_question_block_episode();
CREATE TRIGGER trg_listening_shared_stories_updated_at BEFORE UPDATE ON public.listening_shared_stories FOR EACH ROW EXECUTE FUNCTION listening_shared_stories_set_updated_at();
CREATE TRIGGER plan_capability_values_immutability BEFORE INSERT OR DELETE OR UPDATE ON public.plan_capability_values FOR EACH ROW EXECUTE FUNCTION tg_plan_capability_values_immutability();
CREATE TRIGGER trg_plan_trial_policies_updated_at BEFORE UPDATE ON public.plan_trial_policies FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER plan_versions_immutability BEFORE UPDATE ON public.plan_versions FOR EACH ROW EXECUTE FUNCTION tg_plan_versions_immutability();
CREATE TRIGGER plan_versions_no_delete BEFORE DELETE ON public.plan_versions FOR EACH ROW EXECUTE FUNCTION tg_plan_versions_no_delete();
CREATE TRIGGER plan_versions_updated_at BEFORE UPDATE ON public.plan_versions FOR EACH ROW EXECUTE FUNCTION tg_plan_versions_updated_at();
CREATE TRIGGER pa_set_updated_at BEFORE UPDATE ON public.pronunciation_assessments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_pts_updated_at BEFORE UPDATE ON public.pronunciation_training_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_provider_pricing_updated_at BEFORE UPDATE ON public.provider_pricing FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_usage_daily_updated_at BEFORE UPDATE ON public.usage_daily FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_usage_daily_metrics_updated_at BEFORE UPDATE ON public.usage_daily_metrics FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_usage_reservations_updated_at BEFORE UPDATE ON public.usage_reservations FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_user_access_controls_updated_at BEFORE UPDATE ON public.user_access_controls FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_user_account_deactivations_updated_at BEFORE UPDATE ON public.user_account_deactivations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_user_billing_blocks_updated_at BEFORE UPDATE ON public.user_billing_blocks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_user_capability_overrides_updated_at BEFORE UPDATE ON public.user_capability_overrides FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_user_communication_blocks_updated_at BEFORE UPDATE ON public.user_communication_blocks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_user_conversation_credits_updated_at BEFORE UPDATE ON public.user_conversation_credits FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_user_listening_shared_progress_updated_at BEFORE UPDATE ON public.user_listening_shared_progress FOR EACH ROW EXECUTE FUNCTION user_listening_shared_progress_set_updated_at();
CREATE TRIGGER trg_user_plan_assignments_updated_at BEFORE UPDATE ON public.user_plan_assignments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER writing_entries_updated_at BEFORE UPDATE ON public.writing_entries FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_wrr_updated_at BEFORE UPDATE ON public.writing_review_reservations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_protect_rewrite_submission_immutability BEFORE UPDATE ON public.writing_rewrite_attempts FOR EACH ROW EXECUTE FUNCTION protect_rewrite_submission_immutability();

-- ---------------------------------------------------------------------
-- 12. RLS ENABLE (todas as 107 tabelas) + POLICIES (172)
-- ---------------------------------------------------------------------
ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_rate_limit_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_security_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_security_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_alert_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_budget_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_control_switches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_conversation_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_cost_valuations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_gateway_budget_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_gateway_circuit_breakers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_gateway_concurrency_validations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_gateway_config_acknowledgements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_gateway_config_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_gateway_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_gateway_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_gateway_idempotency_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_gateway_quota_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_gateway_reservation_budget_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_pricing_acknowledgements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_pricing_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_pricing_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_provider_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_runtime_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage_event_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_config_acknowledgements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_config_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_config_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_config_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capability_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_session_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.engine_activation_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.english_learning_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.english_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gateway_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generated_themes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grammar_explanations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learner_skill_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_day_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listening_audio_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listening_audio_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listening_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listening_bookmark_timings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listening_episode_distribution ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listening_episode_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listening_episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listening_generation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listening_generation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listening_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listening_operational_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listening_publication_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listening_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listening_sentence_timings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listening_sentences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listening_shared_stories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listening_subtitle_cues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listening_word_timings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_capability_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_trial_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pronunciation_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pronunciation_training_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.realtime_hard_control_validations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_attempt_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_group_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_schedule_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_daily_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_reservation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_access_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_account_deactivations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_billing_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_capability_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_communication_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_conversation_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_learning_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_listening_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_listening_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_listening_block_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_listening_generation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_listening_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_listening_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_listening_shared_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_plan_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.writing_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.writing_review_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.writing_rewrite_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.writing_rewrite_correction_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.writing_rewrite_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.writing_rewrite_evidence_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.writing_rewrite_status_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_log_insert ON public.admin_audit_log AS PERMISSIVE FOR INSERT TO public WITH CHECK (is_active_admin());
CREATE POLICY audit_log_read ON public.admin_audit_log AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY admin_invitations_read ON public.admin_invitations AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY admin_invitations_write ON public.admin_invitations AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY admin_permissions_read ON public.admin_permissions AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY admin_permissions_write ON public.admin_permissions AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY admin_rate_limit_buckets_read ON public.admin_rate_limit_buckets AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY admin_rate_limit_buckets_write ON public.admin_rate_limit_buckets AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY admin_role_permissions_read ON public.admin_role_permissions AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY admin_role_permissions_write ON public.admin_role_permissions AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY admin_roles_read ON public.admin_roles AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY admin_roles_write ON public.admin_roles AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY admin_security_configs_read ON public.admin_security_configs AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY admin_security_configs_write ON public.admin_security_configs AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY admin_security_events_read ON public.admin_security_events AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY admin_security_events_write ON public.admin_security_events AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY admin_security_versions_read ON public.admin_security_policy_versions AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY admin_security_versions_write ON public.admin_security_policy_versions AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY admin_users_read ON public.admin_users AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY admin_users_write ON public.admin_users AS PERMISSIVE FOR ALL TO public USING ((get_admin_role() = 'owner'::text));
CREATE POLICY gateway_alert_rules_read ON public.ai_alert_rules AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY gateway_alert_rules_write ON public.ai_alert_rules AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY gateway_alerts_read ON public.ai_alerts AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY gateway_alerts_write ON public.ai_alerts AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY gateway_budgets_read ON public.ai_budget_policies AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY gateway_budgets_write ON public.ai_budget_policies AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY gateway_switches_read ON public.ai_control_switches AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY gateway_switches_write ON public.ai_control_switches AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY "Users manage own AI preferences" ON public.ai_conversation_preferences AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));
CREATE POLICY cost_valuations_read ON public.ai_cost_valuations AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY cost_valuations_write ON public.ai_cost_valuations AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY gateway_acks_read ON public.ai_gateway_config_acknowledgements AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY gateway_acks_write ON public.ai_gateway_config_acknowledgements AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY gateway_versions_read ON public.ai_gateway_config_versions AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY gateway_versions_write ON public.ai_gateway_config_versions AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY gateway_configs_read ON public.ai_gateway_configs AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY gateway_configs_write ON public.ai_gateway_configs AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY pricing_acks_read ON public.ai_pricing_acknowledgements AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY pricing_acks_write ON public.ai_pricing_acknowledgements AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY pricing_rates_read ON public.ai_pricing_rates AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY pricing_rates_write ON public.ai_pricing_rates AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY pricing_versions_read ON public.ai_pricing_versions AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY pricing_versions_write ON public.ai_pricing_versions AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY config_acks_read ON public.app_config_acknowledgements AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY config_acks_write ON public.app_config_acknowledgements AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY config_definitions_read ON public.app_config_definitions AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY config_definitions_write ON public.app_config_definitions AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY config_values_read ON public.app_config_values AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY config_values_write ON public.app_config_values AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY config_versions_read ON public.app_config_versions AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY config_versions_write ON public.app_config_versions AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY capability_definitions_read ON public.capability_definitions AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY capability_definitions_write ON public.capability_definitions AS PERMISSIVE FOR ALL TO public USING (can_manage_plans());
CREATE POLICY "Users view own conversation sessions" ON public.conversation_sessions AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));
CREATE POLICY "Allow insert english learning memory" ON public.english_learning_memory AS PERMISSIVE FOR INSERT TO public WITH CHECK (((auth.uid() = user_id) OR (user_id IS NULL)));
CREATE POLICY "Allow select english learning memory" ON public.english_learning_memory AS PERMISSIVE FOR SELECT TO public USING (((auth.uid() = user_id) OR (user_id IS NULL)));
CREATE POLICY "Allow update english learning memory" ON public.english_learning_memory AS PERMISSIVE FOR UPDATE TO public USING (((auth.uid() = user_id) OR (user_id IS NULL))) WITH CHECK (((auth.uid() = user_id) OR (user_id IS NULL)));
CREATE POLICY elm_delete ON public.english_learning_memory AS PERMISSIVE FOR DELETE TO authenticated USING ((auth.uid() = user_id));
CREATE POLICY elm_insert ON public.english_learning_memory AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));
CREATE POLICY elm_select ON public.english_learning_memory AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));
CREATE POLICY elm_update ON public.english_learning_memory AS PERMISSIVE FOR UPDATE TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Allow insert english reviews" ON public.english_reviews AS PERMISSIVE FOR INSERT TO public WITH CHECK (((auth.uid() = user_id) OR (user_id IS NULL)));
CREATE POLICY "Allow read english reviews" ON public.english_reviews AS PERMISSIVE FOR SELECT TO public USING (((auth.uid() = user_id) OR (user_id IS NULL)));
CREATE POLICY er_delete ON public.english_reviews AS PERMISSIVE FOR DELETE TO authenticated USING ((auth.uid() = user_id));
CREATE POLICY er_insert ON public.english_reviews AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));
CREATE POLICY er_select ON public.english_reviews AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));
CREATE POLICY er_update ON public.english_reviews AS PERMISSIVE FOR UPDATE TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "active admins can read heartbeats" ON public.gateway_heartbeats AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY gt_delete ON public.generated_themes AS PERMISSIVE FOR DELETE TO authenticated USING ((auth.uid() = user_id));
CREATE POLICY gt_insert ON public.generated_themes AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));
CREATE POLICY gt_select ON public.generated_themes AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));
CREATE POLICY gt_update ON public.generated_themes AS PERMISSIVE FOR UPDATE TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));
CREATE POLICY ge_insert ON public.grammar_explanations AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY ge_select ON public.grammar_explanations AS PERMISSIVE FOR SELECT TO authenticated USING (true);
CREATE POLICY ge_update ON public.grammar_explanations AS PERMISSIVE FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY lsp_select ON public.learner_skill_profiles AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));
CREATE POLICY ldo_all ON public.learning_day_overrides AS PERMISSIVE FOR ALL TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));
CREATE POLICY listening_audio_flags_read ON public.listening_audio_flags AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY listening_audio_flags_write ON public.listening_audio_flags AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY "Users read blocks of published episodes" ON public.listening_blocks AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM listening_episodes e
  WHERE ((e.id = listening_blocks.episode_id) AND (e.status = 'published'::listening_episode_status)))));
CREATE POLICY deny_authenticated_lbt ON public.listening_bookmark_timings AS PERMISSIVE FOR ALL TO authenticated USING (false);
CREATE POLICY service_role_all_lbt ON public.listening_bookmark_timings AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY listening_distribution_read ON public.listening_episode_distribution AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY listening_distribution_write ON public.listening_episode_distribution AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY listening_publications_read ON public.listening_episode_publications AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY listening_publications_write ON public.listening_episode_publications AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY "Users read published episodes" ON public.listening_episodes AS PERMISSIVE FOR SELECT TO authenticated USING ((status = 'published'::listening_episode_status));
CREATE POLICY listening_requests_read ON public.listening_generation_requests AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY listening_requests_write ON public.listening_generation_requests AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY deny_authenticated_lst ON public.listening_sentence_timings AS PERMISSIVE FOR ALL TO authenticated USING (false);
CREATE POLICY service_role_all_lst ON public.listening_sentence_timings AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Users read sentences of published blocks" ON public.listening_sentences AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (listening_blocks b
     JOIN listening_episodes e ON ((e.id = b.episode_id)))
  WHERE ((b.id = listening_sentences.block_id) AND (e.status = 'published'::listening_episode_status)))));
CREATE POLICY "Users read cues of published blocks" ON public.listening_subtitle_cues AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (listening_blocks b
     JOIN listening_episodes e ON ((e.id = b.episode_id)))
  WHERE ((b.id = listening_subtitle_cues.block_id) AND (e.status = 'published'::listening_episode_status)))));
CREATE POLICY deny_authenticated_lwt ON public.listening_word_timings AS PERMISSIVE FOR ALL TO authenticated USING (false);
CREATE POLICY service_role_all_lwt ON public.listening_word_timings AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY plan_capability_values_delete ON public.plan_capability_values AS PERMISSIVE FOR DELETE TO public USING (can_manage_plans());
CREATE POLICY plan_capability_values_read ON public.plan_capability_values AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY plan_capability_values_update ON public.plan_capability_values AS PERMISSIVE FOR UPDATE TO public USING (can_manage_plans());
CREATE POLICY plan_capability_values_write ON public.plan_capability_values AS PERMISSIVE FOR INSERT TO public WITH CHECK (can_manage_plans());
CREATE POLICY "admin can read trial policies" ON public.plan_trial_policies AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY "managers can update trial policies" ON public.plan_trial_policies AS PERMISSIVE FOR UPDATE TO public USING (can_manage_plans());
CREATE POLICY "managers can write trial policies" ON public.plan_trial_policies AS PERMISSIVE FOR INSERT TO public WITH CHECK (can_manage_plans());
CREATE POLICY plan_versions_delete ON public.plan_versions AS PERMISSIVE FOR DELETE TO public USING (can_manage_plans());
CREATE POLICY plan_versions_read ON public.plan_versions AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY plan_versions_update ON public.plan_versions AS PERMISSIVE FOR UPDATE TO public USING (can_manage_plans());
CREATE POLICY plan_versions_write ON public.plan_versions AS PERMISSIVE FOR INSERT TO public WITH CHECK (can_manage_plans());
CREATE POLICY plans_delete ON public.plans AS PERMISSIVE FOR DELETE TO public USING ((get_admin_role() = 'owner'::text));
CREATE POLICY plans_read ON public.plans AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY plans_update ON public.plans AS PERMISSIVE FOR UPDATE TO public USING (can_manage_plans());
CREATE POLICY plans_write ON public.plans AS PERMISSIVE FOR INSERT TO public WITH CHECK (can_manage_plans());
CREATE POLICY pa_select ON public.pronunciation_assessments AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));
CREATE POLICY pts_select ON public.pronunciation_training_sessions AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));
CREATE POLICY rai_delete ON public.review_attempt_items AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM review_attempts ra
  WHERE ((ra.id = review_attempt_items.review_attempt_id) AND (ra.user_id = auth.uid())))));
CREATE POLICY rai_insert ON public.review_attempt_items AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM review_attempts ra
  WHERE ((ra.id = review_attempt_items.review_attempt_id) AND (ra.user_id = auth.uid())))));
CREATE POLICY rai_select ON public.review_attempt_items AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM review_attempts ra
  WHERE ((ra.id = review_attempt_items.review_attempt_id) AND (ra.user_id = auth.uid())))));
CREATE POLICY ra_delete ON public.review_attempts AS PERMISSIVE FOR DELETE TO authenticated USING ((auth.uid() = user_id));
CREATE POLICY ra_insert ON public.review_attempts AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));
CREATE POLICY ra_select ON public.review_attempts AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));
CREATE POLICY rgi_delete ON public.review_group_items AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM review_groups rg
  WHERE ((rg.id = review_group_items.review_group_id) AND (rg.user_id = auth.uid())))));
CREATE POLICY rgi_insert ON public.review_group_items AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM review_groups rg
  WHERE ((rg.id = review_group_items.review_group_id) AND (rg.user_id = auth.uid())))));
CREATE POLICY rgi_select ON public.review_group_items AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM review_groups rg
  WHERE ((rg.id = review_group_items.review_group_id) AND (rg.user_id = auth.uid())))));
CREATE POLICY rg_delete ON public.review_groups AS PERMISSIVE FOR DELETE TO authenticated USING ((auth.uid() = user_id));
CREATE POLICY rg_insert ON public.review_groups AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));
CREATE POLICY rg_select ON public.review_groups AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));
CREATE POLICY rg_update ON public.review_groups AS PERMISSIVE FOR UPDATE TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));
CREATE POLICY rsh_delete ON public.review_schedule_history AS PERMISSIVE FOR DELETE TO authenticated USING ((auth.uid() = user_id));
CREATE POLICY rsh_insert ON public.review_schedule_history AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));
CREATE POLICY rsh_select ON public.review_schedule_history AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));
CREATE POLICY "admin can read access controls" ON public.user_access_controls AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY "managers can update access controls" ON public.user_access_controls AS PERMISSIVE FOR UPDATE TO public USING (can_manage_plans());
CREATE POLICY "managers can write access controls" ON public.user_access_controls AS PERMISSIVE FOR INSERT TO public WITH CHECK (can_manage_plans());
CREATE POLICY user_account_deactivations_read ON public.user_account_deactivations AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY user_account_deactivations_update ON public.user_account_deactivations AS PERMISSIVE FOR UPDATE TO public USING (can_manage_plans());
CREATE POLICY user_account_deactivations_write ON public.user_account_deactivations AS PERMISSIVE FOR INSERT TO public WITH CHECK (can_manage_plans());
CREATE POLICY user_billing_blocks_read ON public.user_billing_blocks AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY user_billing_blocks_update ON public.user_billing_blocks AS PERMISSIVE FOR UPDATE TO public USING (can_manage_plans());
CREATE POLICY user_billing_blocks_write ON public.user_billing_blocks AS PERMISSIVE FOR INSERT TO public WITH CHECK (can_manage_plans());
CREATE POLICY "admin can read overrides" ON public.user_capability_overrides AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY "managers can update overrides" ON public.user_capability_overrides AS PERMISSIVE FOR UPDATE TO public USING (can_manage_plans());
CREATE POLICY "managers can write overrides" ON public.user_capability_overrides AS PERMISSIVE FOR INSERT TO public WITH CHECK (can_manage_plans());
CREATE POLICY user_communication_blocks_read ON public.user_communication_blocks AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY user_communication_blocks_update ON public.user_communication_blocks AS PERMISSIVE FOR UPDATE TO public USING (can_manage_plans());
CREATE POLICY user_communication_blocks_write ON public.user_communication_blocks AS PERMISSIVE FOR INSERT TO public WITH CHECK (can_manage_plans());
CREATE POLICY user_conversation_credits_read ON public.user_conversation_credits AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY user_conversation_credits_update ON public.user_conversation_credits AS PERMISSIVE FOR UPDATE TO public USING (can_manage_plans());
CREATE POLICY user_conversation_credits_write ON public.user_conversation_credits AS PERMISSIVE FOR INSERT TO public WITH CHECK (can_manage_plans());
CREATE POLICY uls_all ON public.user_learning_settings AS PERMISSIVE FOR ALL TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users insert own listening assignments" ON public.user_listening_assignments AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users read own listening assignments" ON public.user_listening_assignments AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));
CREATE POLICY "Users update own listening assignments" ON public.user_listening_assignments AS PERMISSIVE FOR UPDATE TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users read own listening attempts" ON public.user_listening_attempts AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));
CREATE POLICY "Users read own block sessions" ON public.user_listening_block_sessions AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));
CREATE POLICY "Users read own generation sessions" ON public.user_listening_generation_sessions AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));
CREATE POLICY "Users read own listening progress" ON public.user_listening_progress AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));
CREATE POLICY "Users read own listening results" ON public.user_listening_results AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));
CREATE POLICY "Users insert own shared listening progress" ON public.user_listening_shared_progress AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users read own shared listening progress" ON public.user_listening_shared_progress AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));
CREATE POLICY "Users update own shared listening progress" ON public.user_listening_shared_progress AS PERMISSIVE FOR UPDATE TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "admin can read assignments" ON public.user_plan_assignments AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY "managers can update assignments" ON public.user_plan_assignments AS PERMISSIVE FOR UPDATE TO public USING (can_manage_plans());
CREATE POLICY "managers can write assignments" ON public.user_plan_assignments AS PERMISSIVE FOR INSERT TO public WITH CHECK (can_manage_plans());
CREATE POLICY we_delete ON public.writing_entries AS PERMISSIVE FOR DELETE TO authenticated USING ((auth.uid() = user_id));
CREATE POLICY we_insert ON public.writing_entries AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));
CREATE POLICY we_select ON public.writing_entries AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));
CREATE POLICY we_update ON public.writing_entries AS PERMISSIVE FOR UPDATE TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));
CREATE POLICY wrr_select ON public.writing_review_reservations AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));
CREATE POLICY "Users insert own rewrite draft" ON public.writing_rewrite_attempts AS PERMISSIVE FOR INSERT TO public WITH CHECK (((auth.uid() = user_id) AND (status = 'draft'::rewrite_status) AND (author_type = 'learner'::text) AND (submission_type = 'rewrite_v2'::text)));
CREATE POLICY "Users read own rewrite attempts" ON public.writing_rewrite_attempts AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));
CREATE POLICY "Users update own draft rewrite text" ON public.writing_rewrite_attempts AS PERMISSIVE FOR UPDATE TO public USING (((auth.uid() = user_id) AND (status = 'draft'::rewrite_status))) WITH CHECK (((auth.uid() = user_id) AND (status = 'draft'::rewrite_status)));
CREATE POLICY "Users read own outcomes via evaluation" ON public.writing_rewrite_correction_outcomes AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM writing_rewrite_evaluations wre
  WHERE ((wre.id = writing_rewrite_correction_outcomes.rewrite_evaluation_id) AND (wre.user_id = auth.uid())))));
CREATE POLICY "Users read own evaluations" ON public.writing_rewrite_evaluations AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));
CREATE POLICY "Users read own evidence candidates" ON public.writing_rewrite_evidence_candidates AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));

-- ---------------------------------------------------------------------
-- 13. GRANTS (schema public: identico ao default do Supabase, ja coberto na secao de
--     extensions/instalacao; grants de tabelas/funcoes fieis a producao abaixo)
-- ---------------------------------------------------------------------

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_audit_log TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_audit_log TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_audit_log TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_audit_log TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_invitations TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_invitations TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_invitations TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_invitations TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_permissions TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_permissions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_permissions TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_permissions TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_rate_limit_buckets TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_rate_limit_buckets TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_rate_limit_buckets TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_rate_limit_buckets TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_role_permissions TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_role_permissions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_role_permissions TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_role_permissions TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_roles TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_roles TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_roles TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_roles TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_security_configs TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_security_configs TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_security_configs TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_security_configs TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_security_events TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_security_events TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_security_events TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_security_events TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_security_policy_versions TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_security_policy_versions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_security_policy_versions TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_security_policy_versions TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_users TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_users TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_users TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_users TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_alert_rules TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_alert_rules TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_alert_rules TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_alert_rules TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_alerts TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_alerts TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_alerts TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_alerts TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_budget_policies TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_budget_policies TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_budget_policies TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_budget_policies TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_control_switches TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_control_switches TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_control_switches TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_control_switches TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_conversation_preferences TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_conversation_preferences TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_conversation_preferences TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_conversation_preferences TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_cost_valuations TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_cost_valuations TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_cost_valuations TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_cost_valuations TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_features TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_features TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_features TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_features TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_gateway_budget_buckets TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_gateway_budget_buckets TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_gateway_circuit_breakers TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_gateway_circuit_breakers TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_gateway_concurrency_validations TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_gateway_concurrency_validations TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_gateway_config_acknowledgements TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_gateway_config_acknowledgements TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_gateway_config_acknowledgements TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_gateway_config_acknowledgements TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_gateway_config_versions TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_gateway_config_versions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_gateway_config_versions TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_gateway_config_versions TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_gateway_configs TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_gateway_configs TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_gateway_configs TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_gateway_configs TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_gateway_decisions TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_gateway_decisions TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_gateway_idempotency_locks TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_gateway_idempotency_locks TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_gateway_quota_buckets TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_gateway_quota_buckets TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_gateway_reservation_budget_links TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_gateway_reservation_budget_links TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_pricing_acknowledgements TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_pricing_acknowledgements TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_pricing_acknowledgements TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_pricing_acknowledgements TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_pricing_rates TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_pricing_rates TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_pricing_rates TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_pricing_rates TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_pricing_versions TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_pricing_versions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_pricing_versions TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_pricing_versions TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_provider_sessions TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_provider_sessions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_provider_sessions TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_provider_sessions TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_runtime_controls TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_runtime_controls TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_runtime_controls TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_runtime_controls TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_usage_event_metrics TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_usage_event_metrics TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_usage_event_metrics TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_usage_event_metrics TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_usage_events TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_usage_events TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_usage_events TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.ai_usage_events TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.api_rate_limits TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.api_rate_limits TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.app_config_acknowledgements TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.app_config_acknowledgements TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.app_config_acknowledgements TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.app_config_acknowledgements TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.app_config_definitions TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.app_config_definitions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.app_config_definitions TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.app_config_definitions TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.app_config_values TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.app_config_values TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.app_config_values TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.app_config_values TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.app_config_versions TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.app_config_versions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.app_config_versions TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.app_config_versions TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.capability_definitions TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.capability_definitions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.capability_definitions TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.capability_definitions TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.conversation_session_authorizations TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.conversation_session_authorizations TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.conversation_sessions TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.conversation_sessions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.conversation_sessions TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.conversation_sessions TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.engine_activation_log TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.engine_activation_log TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.engine_activation_log TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.engine_activation_log TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.english_learning_memory TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.english_learning_memory TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.english_learning_memory TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.english_learning_memory TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.english_reviews TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.english_reviews TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.english_reviews TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.english_reviews TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.gateway_heartbeats TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.gateway_heartbeats TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.gateway_heartbeats TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.gateway_heartbeats TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.generated_themes TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.generated_themes TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.generated_themes TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.generated_themes TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.grammar_explanations TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.grammar_explanations TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.grammar_explanations TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.grammar_explanations TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.learner_skill_profiles TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.learner_skill_profiles TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.learner_skill_profiles TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.learner_skill_profiles TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.learning_day_overrides TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.learning_day_overrides TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.learning_day_overrides TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.learning_day_overrides TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_audio_assets TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_audio_assets TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_audio_assets TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_audio_assets TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_audio_flags TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_audio_flags TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_audio_flags TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_audio_flags TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_blocks TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_blocks TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_blocks TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_blocks TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_bookmark_timings TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_bookmark_timings TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_episode_distribution TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_episode_distribution TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_episode_distribution TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_episode_distribution TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_episode_publications TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_episode_publications TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_episode_publications TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_episode_publications TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_episodes TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_episodes TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_episodes TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_episodes TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_generation_jobs TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_generation_jobs TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_generation_jobs TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_generation_jobs TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_generation_requests TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_generation_requests TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_generation_requests TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_generation_requests TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_jobs TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_jobs TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_jobs TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_jobs TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_operational_alerts TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_operational_alerts TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_operational_alerts TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_operational_alerts TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_publication_log TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_publication_log TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_publication_log TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_publication_log TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_questions TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_questions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_questions TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_questions TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_questions_public TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_questions_public TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_questions_public TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_questions_public TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_sentence_timings TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_sentence_timings TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_sentence_timings TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_sentence_timings TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_sentences TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_sentences TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_sentences TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_sentences TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_shared_stories TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_shared_stories TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_subtitle_cues TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_subtitle_cues TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_subtitle_cues TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_subtitle_cues TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_word_timings TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.listening_word_timings TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.plan_capability_values TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.plan_capability_values TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.plan_capability_values TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.plan_capability_values TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.plan_trial_policies TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.plan_trial_policies TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.plan_trial_policies TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.plan_trial_policies TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.plan_versions TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.plan_versions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.plan_versions TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.plan_versions TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.plans TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.plans TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.plans TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.plans TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.pronunciation_assessments TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.pronunciation_assessments TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.pronunciation_assessments TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.pronunciation_assessments TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.pronunciation_training_sessions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.pronunciation_training_sessions TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.pronunciation_training_sessions TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.provider_pricing TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.provider_pricing TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.provider_pricing TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.provider_pricing TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.realtime_hard_control_validations TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.realtime_hard_control_validations TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.review_attempt_items TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.review_attempt_items TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.review_attempt_items TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.review_attempt_items TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.review_attempts TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.review_attempts TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.review_attempts TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.review_attempts TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.review_group_items TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.review_group_items TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.review_group_items TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.review_group_items TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.review_groups TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.review_groups TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.review_groups TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.review_groups TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.review_schedule_history TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.review_schedule_history TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.review_schedule_history TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.review_schedule_history TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.usage_daily TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.usage_daily TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.usage_daily TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.usage_daily TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.usage_daily_metrics TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.usage_daily_metrics TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.usage_daily_metrics TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.usage_daily_metrics TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.usage_reservation_items TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.usage_reservation_items TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.usage_reservation_items TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.usage_reservation_items TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.usage_reservations TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.usage_reservations TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.usage_reservations TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.usage_reservations TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_access_controls TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_access_controls TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_access_controls TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_access_controls TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_account_deactivations TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_account_deactivations TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_account_deactivations TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_billing_blocks TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_billing_blocks TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_billing_blocks TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_capability_overrides TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_capability_overrides TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_capability_overrides TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_capability_overrides TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_communication_blocks TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_communication_blocks TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_communication_blocks TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_conversation_credits TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_conversation_credits TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_conversation_credits TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_conversation_credits TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_learning_settings TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_learning_settings TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_learning_settings TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_learning_settings TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_listening_assignments TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_listening_assignments TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_listening_assignments TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_listening_assignments TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_listening_attempts TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_listening_attempts TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_listening_attempts TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_listening_attempts TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_listening_block_sessions TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_listening_block_sessions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_listening_block_sessions TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_listening_block_sessions TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_listening_generation_sessions TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_listening_generation_sessions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_listening_generation_sessions TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_listening_generation_sessions TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_listening_progress TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_listening_progress TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_listening_progress TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_listening_progress TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_listening_results TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_listening_results TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_listening_results TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_listening_results TO service_role;
GRANT INSERT, SELECT, UPDATE ON TABLE public.user_listening_shared_progress TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_listening_shared_progress TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_listening_shared_progress TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_plan_assignments TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_plan_assignments TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_plan_assignments TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.user_plan_assignments TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.writing_entries TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.writing_entries TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.writing_entries TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.writing_entries TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.writing_review_reservations TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.writing_review_reservations TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.writing_review_reservations TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.writing_rewrite_attempts TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.writing_rewrite_attempts TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.writing_rewrite_attempts TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.writing_rewrite_attempts TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.writing_rewrite_correction_outcomes TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.writing_rewrite_correction_outcomes TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.writing_rewrite_correction_outcomes TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.writing_rewrite_correction_outcomes TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.writing_rewrite_evaluations TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.writing_rewrite_evaluations TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.writing_rewrite_evaluations TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.writing_rewrite_evaluations TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.writing_rewrite_evidence_candidates TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.writing_rewrite_evidence_candidates TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.writing_rewrite_evidence_candidates TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.writing_rewrite_evidence_candidates TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.writing_rewrite_status_history TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.writing_rewrite_status_history TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.writing_rewrite_status_history TO postgres;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.writing_rewrite_status_history TO service_role;
GRANT EXECUTE ON FUNCTION public._build_config_snapshot(p_version_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public._build_config_snapshot(p_version_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public._build_control_snapshot(p_environment text, p_version_number integer) TO postgres;
GRANT EXECUTE ON FUNCTION public._build_control_snapshot(p_environment text, p_version_number integer) TO service_role;
GRANT EXECUTE ON FUNCTION public._build_pricing_snapshot(p_version_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public._build_pricing_snapshot(p_version_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public._build_security_policy_snapshot_v1(p_environment text) TO postgres;
GRANT EXECUTE ON FUNCTION public._build_security_policy_snapshot_v1(p_environment text) TO service_role;
GRANT EXECUTE ON FUNCTION public._gateway_audit_database_privileges_v1() TO postgres;
GRANT EXECUTE ON FUNCTION public._gateway_audit_database_privileges_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public._gateway_publish_pricing_trigger_v1() TO postgres;
GRANT EXECUTE ON FUNCTION public._gateway_publish_pricing_trigger_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public._gateway_publish_runtime_controls_trigger_v1() TO postgres;
GRANT EXECUTE ON FUNCTION public._gateway_publish_runtime_controls_trigger_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public._gateway_touch_budget_bucket_v1(p_scope_type text, p_scope_key text, p_period_type text, p_period_start timestamp with time zone, p_period_end timestamp with time zone) TO postgres;
GRANT EXECUTE ON FUNCTION public._gateway_touch_budget_bucket_v1(p_scope_type text, p_scope_key text, p_period_type text, p_period_start timestamp with time zone, p_period_end timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public._gateway_touch_quota_bucket_v1(p_subject_type text, p_subject_id uuid, p_feature_key text, p_metric_key text, p_period_type text, p_period_start timestamp with time zone, p_period_end timestamp with time zone) TO postgres;
GRANT EXECUTE ON FUNCTION public._gateway_touch_quota_bucket_v1(p_subject_type text, p_subject_id uuid, p_feature_key text, p_metric_key text, p_period_type text, p_period_start timestamp with time zone, p_period_end timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public._hash_listening_episode_content_v1(p_episode_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public._hash_listening_episode_content_v1(p_episode_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public._promote_due_config_versions(p_environment text) TO postgres;
GRANT EXECUTE ON FUNCTION public._promote_due_config_versions(p_environment text) TO service_role;
GRANT EXECUTE ON FUNCTION public._promote_due_pricing_versions(p_environment text) TO postgres;
GRANT EXECUTE ON FUNCTION public._promote_due_pricing_versions(p_environment text) TO service_role;
GRANT EXECUTE ON FUNCTION public.acquire_or_get_listening_shared_story(p_level_group text, p_target_level text, p_practice_date date, p_lock_duration_seconds integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.acquire_or_get_listening_shared_story(p_level_group text, p_target_level text, p_practice_date date, p_lock_duration_seconds integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_accept_invitation_v1(p_invitation_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_accept_invitation_v1(p_invitation_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_accept_invitation_v1(p_invitation_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_acknowledge_alert_v1(p_alert_id uuid, p_reason text, p_actor_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_acknowledge_alert_v1(p_alert_id uuid, p_reason text, p_actor_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_activate_global_runtime_enforcement_v1(p_control_id uuid, p_expected_mode text, p_reason text, p_actor_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_activate_global_runtime_enforcement_v1(p_control_id uuid, p_expected_mode text, p_reason text, p_actor_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_assign_plan_v1(p_user_id uuid, p_plan_id uuid, p_version_policy text, p_pinned_version_id uuid, p_origin text, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_reason text, p_actor_user_id uuid, p_idempotency_key text, p_replace_active boolean) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_assign_plan_v1(p_user_id uuid, p_plan_id uuid, p_version_policy text, p_pinned_version_id uuid, p_origin text, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_reason text, p_actor_user_id uuid, p_idempotency_key text, p_replace_active boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_cancel_assignment_v1(p_assignment_id uuid, p_actor_user_id uuid, p_reason text, p_new_status text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_cancel_assignment_v1(p_assignment_id uuid, p_actor_user_id uuid, p_reason text, p_new_status text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_cancel_listening_generation_request_v1(p_request_id uuid, p_reason text, p_actor_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_cancel_listening_generation_request_v1(p_request_id uuid, p_reason text, p_actor_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_change_role_v1(p_target_user_id uuid, p_new_role text, p_actor_id uuid, p_reason text, p_client_revision integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_change_role_v1(p_target_user_id uuid, p_new_role text, p_actor_id uuid, p_reason text, p_client_revision integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_check_permission_v1(p_actor_id uuid, p_permission_key text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_check_permission_v1(p_actor_id uuid, p_permission_key text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_check_rate_limit_v1(p_actor_id uuid, p_action_key text, p_max_attempts integer, p_window_seconds integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_check_rate_limit_v1(p_actor_id uuid, p_action_key text, p_max_attempts integer, p_window_seconds integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_create_config_draft_v1(p_environment text, p_actor_id uuid, p_based_on_version_id uuid, p_idempotency_key text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_create_config_draft_v1(p_environment text, p_actor_id uuid, p_based_on_version_id uuid, p_idempotency_key text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_create_control_switch_v1(p_environment text, p_scope text, p_provider text, p_model text, p_feature_key text, p_enabled boolean, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_reason text, p_actor_id uuid, p_client_revision integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_create_control_switch_v1(p_environment text, p_scope text, p_provider text, p_model text, p_feature_key text, p_enabled boolean, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_reason text, p_actor_id uuid, p_client_revision integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_create_invitation_v1(p_email_normalized text, p_role text, p_actor_id uuid, p_reason text, p_expires_hours integer, p_token_hash text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_create_invitation_v1(p_email_normalized text, p_role text, p_actor_id uuid, p_reason text, p_expires_hours integer, p_token_hash text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_create_listening_generation_request_v1(p_job_type text, p_episode_id uuid, p_block_id uuid, p_cefr_level text, p_topic text, p_priority integer, p_scheduled_for timestamp with time zone, p_actor_id uuid, p_reason text, p_idempotency_key text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_create_listening_generation_request_v1(p_job_type text, p_episode_id uuid, p_block_id uuid, p_cefr_level text, p_topic text, p_priority integer, p_scheduled_for timestamp with time zone, p_actor_id uuid, p_reason text, p_idempotency_key text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_create_pricing_draft_v1(p_environment text, p_name text, p_description text, p_currencies text[], p_effective_from timestamp with time zone, p_effective_to timestamp with time zone, p_actor_id uuid, p_based_on_version_id uuid, p_origin_note text, p_idempotency_key text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_create_pricing_draft_v1(p_environment text, p_name text, p_description text, p_currencies text[], p_effective_from timestamp with time zone, p_effective_to timestamp with time zone, p_actor_id uuid, p_based_on_version_id uuid, p_origin_note text, p_idempotency_key text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_delete_pricing_rate_v1(p_rate_id uuid, p_actor_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_delete_pricing_rate_v1(p_rate_id uuid, p_actor_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_discard_config_draft_v1(p_version_id uuid, p_reason text, p_actor_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_discard_config_draft_v1(p_version_id uuid, p_reason text, p_actor_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_discard_pricing_draft_v1(p_version_id uuid, p_reason text, p_actor_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_discard_pricing_draft_v1(p_version_id uuid, p_reason text, p_actor_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_emergency_stop_v1(p_environment text, p_stop boolean, p_reason text, p_actor_id uuid, p_client_revision integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_emergency_stop_v1(p_environment text, p_stop boolean, p_reason text, p_actor_id uuid, p_client_revision integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_fetch_events_for_reprocessing_v1(p_environment text, p_provider text, p_model text, p_feature_key text, p_started_after timestamp with time zone, p_started_before timestamp with time zone, p_only_unpriced boolean, p_cursor_started_at timestamp with time zone, p_cursor_id uuid, p_limit integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_fetch_events_for_reprocessing_v1(p_environment text, p_provider text, p_model text, p_feature_key text, p_started_after timestamp with time zone, p_started_before timestamp with time zone, p_only_unpriced boolean, p_cursor_started_at timestamp with time zone, p_cursor_id uuid, p_limit integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_flag_listening_audio_v1(p_block_id uuid, p_reason text, p_actor_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_flag_listening_audio_v1(p_block_id uuid, p_reason text, p_actor_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_ack_status_v1(p_environment text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_ack_status_v1(p_environment text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_active_users_product_last_30d() TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_active_users_product_last_30d() TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_active_users_product_timeseries_v1(p_after timestamp with time zone, p_before timestamp with time zone, p_granularity text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_active_users_product_timeseries_v1(p_after timestamp with time zone, p_before timestamp with time zone, p_granularity text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_active_users_product_v1(p_after timestamp with time zone, p_before timestamp with time zone) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_active_users_product_v1(p_after timestamp with time zone, p_before timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_ai_ranking_v1(p_environment text, p_started_after timestamp with time zone, p_started_before timestamp with time zone, p_dimension text, p_metric text, p_limit integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_ai_ranking_v1(p_environment text, p_started_after timestamp with time zone, p_started_before timestamp with time zone, p_dimension text, p_metric text, p_limit integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_alert_rules_v1(p_environment text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_alert_rules_v1(p_environment text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_alerts_v1(p_environment text, p_status text, p_limit integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_alerts_v1(p_environment text, p_status text, p_limit integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_budget_status_v1(p_environment text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_budget_status_v1(p_environment text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_budgets_v1(p_environment text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_budgets_v1(p_environment text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_config_ack_status_v1(p_environment text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_config_ack_status_v1(p_environment text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_config_definitions_v1() TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_config_definitions_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_config_version_detail_v1(p_version_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_config_version_detail_v1(p_version_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_config_versions_v1(p_environment text, p_limit integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_config_versions_v1(p_environment text, p_limit integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_cost_breakdown_v1(p_dimension text, p_environment text, p_started_after timestamp with time zone, p_started_before timestamp with time zone) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_cost_breakdown_v1(p_dimension text, p_environment text, p_started_after timestamp with time zone, p_started_before timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_cost_timeseries_v1(p_environment text, p_started_after timestamp with time zone, p_started_before timestamp with time zone, p_granularity text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_cost_timeseries_v1(p_environment text, p_started_after timestamp with time zone, p_started_before timestamp with time zone, p_granularity text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_data_quality_v1(p_environment text, p_started_after timestamp with time zone, p_started_before timestamp with time zone) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_data_quality_v1(p_environment text, p_started_after timestamp with time zone, p_started_before timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_effective_permissions_v1(p_actor_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_effective_permissions_v1(p_actor_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_gateway_activity_timeseries_v1(p_environment text, p_started_after timestamp with time zone, p_started_before timestamp with time zone, p_granularity text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_gateway_activity_timeseries_v1(p_environment text, p_started_after timestamp with time zone, p_started_before timestamp with time zone, p_granularity text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_gateway_breakdown_v1(p_dimension text, p_environment text, p_started_after timestamp with time zone, p_started_before timestamp with time zone) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_gateway_breakdown_v1(p_dimension text, p_environment text, p_started_after timestamp with time zone, p_started_before timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_gateway_controls_v1(p_environment text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_gateway_controls_v1(p_environment text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_gateway_summary_v1(p_environment text, p_started_after timestamp with time zone, p_started_before timestamp with time zone) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_gateway_summary_v1(p_environment text, p_started_after timestamp with time zone, p_started_before timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_gateway_timeseries_v1(p_environment text, p_started_after timestamp with time zone, p_started_before timestamp with time zone, p_granularity text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_gateway_timeseries_v1(p_environment text, p_started_after timestamp with time zone, p_started_before timestamp with time zone, p_granularity text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_invitation_by_token_v1(p_token_hash text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_invitation_by_token_v1(p_token_hash text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_invitation_by_token_v1(p_token_hash text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_listening_agenda_v1() TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_listening_agenda_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_listening_block_audio_location_v1(p_block_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_listening_block_audio_location_v1(p_block_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_listening_completion_diagnostics_v1(p_episode_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_listening_completion_diagnostics_v1(p_episode_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_listening_cost_v1(p_episode_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_listening_cost_v1(p_episode_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_listening_episode_detail_v1(p_episode_id uuid, p_include_answers boolean) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_listening_episode_detail_v1(p_episode_id uuid, p_include_answers boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_listening_overview_v1() TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_listening_overview_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_listening_quality_v1() TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_listening_quality_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_listening_storage_summary_v1() TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_listening_storage_summary_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_new_users_timeseries_v1(p_after timestamp with time zone, p_before timestamp with time zone, p_granularity text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_new_users_timeseries_v1(p_after timestamp with time zone, p_before timestamp with time zone, p_granularity text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_permission_matrix_v1() TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_permission_matrix_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_plan_distribution_v1() TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_plan_distribution_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_pricing_ack_status_v1(p_environment text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_pricing_ack_status_v1(p_environment text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_pricing_overview_v1(p_environment text, p_started_after timestamp with time zone, p_started_before timestamp with time zone) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_pricing_overview_v1(p_environment text, p_started_after timestamp with time zone, p_started_before timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_pricing_quality_v1(p_environment text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_pricing_quality_v1(p_environment text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_pricing_version_detail_v1(p_version_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_pricing_version_detail_v1(p_version_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_pricing_versions_v1(p_environment text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_pricing_versions_v1(p_environment text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_product_config_versions_v1(p_environment text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_product_config_versions_v1(p_environment text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_security_policy_v1(p_environment text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_security_policy_v1(p_environment text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_user_activity_batch(p_user_ids uuid[]) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_user_activity_batch(p_user_ids uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_user_ai_summary_v1(p_user_id uuid, p_started_after timestamp with time zone, p_started_before timestamp with time zone) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_user_ai_summary_v1(p_user_id uuid, p_started_after timestamp with time zone, p_started_before timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_user_labels_v1(p_user_ids uuid[]) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_user_labels_v1(p_user_ids uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_user_pricing_summary_v1(p_user_id uuid, p_started_after timestamp with time zone, p_started_before timestamp with time zone) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_user_pricing_summary_v1(p_user_id uuid, p_started_after timestamp with time zone, p_started_before timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_user_stats() TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_user_stats() TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_users_created_between_v1(p_after timestamp with time zone, p_before timestamp with time zone) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_get_users_created_between_v1(p_after timestamp with time zone, p_before timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_admins_v1(p_page integer, p_page_size integer, p_role text, p_status text, p_search text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_list_admins_v1(p_page integer, p_page_size integer, p_role text, p_status text, p_search text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_audit_log_v1(p_page integer, p_page_size integer, p_actor_user_id uuid, p_action text, p_target_type text, p_target_id text, p_result text, p_environment text, p_correlation_id uuid, p_started_after timestamp with time zone, p_started_before timestamp with time zone) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_list_audit_log_v1(p_page integer, p_page_size integer, p_actor_user_id uuid, p_action text, p_target_type text, p_target_id text, p_result text, p_environment text, p_correlation_id uuid, p_started_after timestamp with time zone, p_started_before timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_gateway_events_v1(p_page integer, p_page_size integer, p_environment text, p_feature_key text, p_provider text, p_model text, p_status text, p_user_id uuid, p_request_id text, p_started_after timestamp with time zone, p_started_before timestamp with time zone, p_order_by text, p_order_dir text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_list_gateway_events_v1(p_page integer, p_page_size integer, p_environment text, p_feature_key text, p_provider text, p_model text, p_status text, p_user_id uuid, p_request_id text, p_started_after timestamp with time zone, p_started_before timestamp with time zone, p_order_by text, p_order_dir text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_invitations_v1(p_status text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_list_invitations_v1(p_status text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_listening_blocks_audio_v1(p_page integer, p_page_size integer, p_filter text, p_search text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_list_listening_blocks_audio_v1(p_page integer, p_page_size integer, p_filter text, p_search text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_listening_episodes_v1(p_page integer, p_page_size integer, p_status text, p_cefr_level text, p_search text, p_order_by text, p_order_dir text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_list_listening_episodes_v1(p_page integer, p_page_size integer, p_status text, p_cefr_level text, p_search text, p_order_by text, p_order_dir text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_listening_generation_requests_v1(p_page integer, p_page_size integer, p_status text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_list_listening_generation_requests_v1(p_page integer, p_page_size integer, p_status text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_listening_jobs_v1(p_page integer, p_page_size integer, p_status text, p_job_type text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_list_listening_jobs_v1(p_page integer, p_page_size integer, p_status text, p_job_type text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_security_events_v1(p_page integer, p_page_size integer, p_event_type text, p_severity text, p_actor_user_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_list_security_events_v1(p_page integer, p_page_size integer, p_event_type text, p_severity text, p_actor_user_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_sessions_v1(p_target_user_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_list_sessions_v1(p_target_user_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_users_v1(p_page integer, p_page_size integer, p_search text, p_status text, p_provider text, p_cefr text, p_order_by text, p_order_dir text, p_created_after timestamp with time zone, p_created_before timestamp with time zone, p_last_login_after timestamp with time zone, p_last_login_before timestamp with time zone, p_never_logged_in boolean, p_email_confirmed boolean) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_list_users_v1(p_page integer, p_page_size integer, p_search text, p_status text, p_provider text, p_cefr text, p_order_by text, p_order_dir text, p_created_after timestamp with time zone, p_created_before timestamp with time zone, p_last_login_after timestamp with time zone, p_last_login_before timestamp with time zone, p_never_logged_in boolean, p_email_confirmed boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_pause_listening_distribution_v1(p_episode_id uuid, p_reason text, p_actor_id uuid, p_client_revision integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_pause_listening_distribution_v1(p_episode_id uuid, p_reason text, p_actor_id uuid, p_client_revision integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_publish_config_version_v1(p_version_id uuid, p_reason text, p_actor_id uuid, p_client_revision integer, p_high_risk_confirmation text, p_idempotency_key text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_publish_config_version_v1(p_version_id uuid, p_reason text, p_actor_id uuid, p_client_revision integer, p_high_risk_confirmation text, p_idempotency_key text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_publish_gateway_config_v1(p_environment text, p_reason text, p_change_type text, p_published_by uuid, p_client_revision integer, p_is_emergency boolean, p_expires_at timestamp with time zone) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_publish_gateway_config_v1(p_environment text, p_reason text, p_change_type text, p_published_by uuid, p_client_revision integer, p_is_emergency boolean, p_expires_at timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_publish_listening_distribution_v1(p_episode_id uuid, p_reason text, p_actor_id uuid, p_client_revision integer, p_available_from timestamp with time zone, p_available_to timestamp with time zone, p_eligible_levels text[], p_priority integer, p_idempotency_key text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_publish_listening_distribution_v1(p_episode_id uuid, p_reason text, p_actor_id uuid, p_client_revision integer, p_available_from timestamp with time zone, p_available_to timestamp with time zone, p_eligible_levels text[], p_priority integer, p_idempotency_key text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_publish_pricing_version_v1(p_version_id uuid, p_reason text, p_actor_id uuid, p_client_revision integer, p_retroactive_justification text, p_idempotency_key text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_publish_pricing_version_v1(p_version_id uuid, p_reason text, p_actor_id uuid, p_client_revision integer, p_retroactive_justification text, p_idempotency_key text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_publish_security_policy_v1(p_environment text, p_reason text, p_change_type text, p_actor_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_publish_security_policy_v1(p_environment text, p_reason text, p_change_type text, p_actor_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_quarantine_listening_audio_v1(p_block_id uuid, p_reason text, p_actor_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_quarantine_listening_audio_v1(p_block_id uuid, p_reason text, p_actor_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_record_cost_valuation_v1(p_event_id uuid, p_pricing_version_id uuid, p_status text, p_currency text, p_cost_input numeric, p_cost_output numeric, p_cost_cache numeric, p_cost_audio numeric, p_cost_tts numeric, p_cost_fixed numeric, p_cost_other numeric, p_cost_total numeric, p_components jsonb, p_engine_version text, p_input_hash text, p_original_cost_total numeric, p_original_currency text, p_original_cost_status text, p_divergence_status text, p_divergence_abs numeric, p_divergence_pct numeric, p_reason text, p_actor_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_record_cost_valuation_v1(p_event_id uuid, p_pricing_version_id uuid, p_status text, p_currency text, p_cost_input numeric, p_cost_output numeric, p_cost_cache numeric, p_cost_audio numeric, p_cost_tts numeric, p_cost_fixed numeric, p_cost_other numeric, p_cost_total numeric, p_components jsonb, p_engine_version text, p_input_hash text, p_original_cost_total numeric, p_original_currency text, p_original_cost_status text, p_divergence_status text, p_divergence_abs numeric, p_divergence_pct numeric, p_reason text, p_actor_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_record_security_event_v1(p_environment text, p_event_type text, p_severity text, p_actor_user_id uuid, p_target_user_id uuid, p_detail jsonb, p_correlation_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_record_security_event_v1(p_environment text, p_event_type text, p_severity text, p_actor_user_id uuid, p_target_user_id uuid, p_detail jsonb, p_correlation_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_register_config_definition_v1(p_key text, p_label text, p_category text, p_description text, p_value_type text, p_value_schema jsonb, p_default_value jsonb, p_applicable_environments text[], p_exposure text, p_risk_level text, p_consumer_component text, p_actor_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_register_config_definition_v1(p_key text, p_label text, p_category text, p_description text, p_value_type text, p_value_schema jsonb, p_default_value jsonb, p_applicable_environments text[], p_exposure text, p_risk_level text, p_consumer_component text, p_actor_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_resolve_alert_v1(p_alert_id uuid, p_reason text, p_actor_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_resolve_alert_v1(p_alert_id uuid, p_reason text, p_actor_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_resolve_effective_plan_v1(p_user_id uuid, p_at timestamp with time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_resolve_effective_plan_v1(p_user_id uuid, p_at timestamp with time zone) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_resolve_effective_plan_v1(p_user_id uuid, p_at timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_resolve_eligible_listening_episodes_v1(p_cefr_level text, p_exclude_episode_ids uuid[], p_limit integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_resolve_eligible_listening_episodes_v1(p_cefr_level text, p_exclude_episode_ids uuid[], p_limit integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_resolve_pricing_version_for_event_v1(p_environment text, p_started_at timestamp with time zone) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_resolve_pricing_version_for_event_v1(p_environment text, p_started_at timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_restore_listening_audio_v1(p_block_id uuid, p_reason text, p_actor_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_restore_listening_audio_v1(p_block_id uuid, p_reason text, p_actor_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_resume_listening_distribution_v1(p_episode_id uuid, p_reason text, p_actor_id uuid, p_client_revision integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_resume_listening_distribution_v1(p_episode_id uuid, p_reason text, p_actor_id uuid, p_client_revision integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_revoke_all_sessions_v1(p_target_user_id uuid, p_actor_id uuid, p_reason text, p_except_current boolean) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_revoke_all_sessions_v1(p_target_user_id uuid, p_actor_id uuid, p_reason text, p_except_current boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_revoke_control_switch_v1(p_switch_id uuid, p_reason text, p_actor_id uuid, p_client_revision integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_revoke_control_switch_v1(p_switch_id uuid, p_reason text, p_actor_id uuid, p_client_revision integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_revoke_invitation_v1(p_invitation_id uuid, p_actor_id uuid, p_reason text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_revoke_invitation_v1(p_invitation_id uuid, p_actor_id uuid, p_reason text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_revoke_session_v1(p_session_id uuid, p_actor_id uuid, p_reason text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_revoke_session_v1(p_session_id uuid, p_actor_id uuid, p_reason text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_rollback_config_v1(p_environment text, p_target_version_num integer, p_reason text, p_actor_id uuid, p_client_revision integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_rollback_config_v1(p_environment text, p_target_version_num integer, p_reason text, p_actor_id uuid, p_client_revision integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_status_v1(p_target_user_id uuid, p_new_status text, p_actor_id uuid, p_reason text, p_client_revision integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_set_status_v1(p_target_user_id uuid, p_new_status text, p_actor_id uuid, p_reason text, p_client_revision integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_toggle_budget_policy_v1(p_budget_id uuid, p_active boolean, p_reason text, p_actor_id uuid, p_client_revision integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_toggle_budget_policy_v1(p_budget_id uuid, p_active boolean, p_reason text, p_actor_id uuid, p_client_revision integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_update_gateway_mode_v1(p_environment text, p_gateway_mode text, p_ai_enabled boolean, p_failure_strategy text, p_cache_ttl integer, p_max_stale integer, p_reason text, p_change_type text, p_published_by uuid, p_client_revision integer, p_is_emergency boolean) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_update_gateway_mode_v1(p_environment text, p_gateway_mode text, p_ai_enabled boolean, p_failure_strategy text, p_cache_ttl integer, p_max_stale integer, p_reason text, p_change_type text, p_published_by uuid, p_client_revision integer, p_is_emergency boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_update_pricing_draft_v1(p_version_id uuid, p_name text, p_description text, p_currencies text[], p_effective_from timestamp with time zone, p_effective_to timestamp with time zone, p_actor_id uuid, p_client_revision integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_update_pricing_draft_v1(p_version_id uuid, p_name text, p_description text, p_currencies text[], p_effective_from timestamp with time zone, p_effective_to timestamp with time zone, p_actor_id uuid, p_client_revision integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_update_security_policy_v1(p_environment text, p_mfa_required boolean, p_recent_auth_window_seconds integer, p_max_admin_session_hours integer, p_max_idle_minutes integer, p_invitation_expiry_hours integer, p_rate_limit_max_attempts integer, p_rate_limit_window_seconds integer, p_lockout_duration_seconds integer, p_min_reason_length integer, p_reason text, p_actor_id uuid, p_client_revision integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_update_security_policy_v1(p_environment text, p_mfa_required boolean, p_recent_auth_window_seconds integer, p_max_admin_session_hours integer, p_max_idle_minutes integer, p_invitation_expiry_hours integer, p_rate_limit_max_attempts integer, p_rate_limit_window_seconds integer, p_lockout_duration_seconds integer, p_min_reason_length integer, p_reason text, p_actor_id uuid, p_client_revision integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_upsert_alert_rule_v1(p_id uuid, p_environment text, p_alert_type text, p_scope text, p_window_seconds integer, p_threshold_value numeric, p_min_event_count integer, p_severity text, p_active boolean, p_cooldown_seconds integer, p_actor_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_upsert_alert_rule_v1(p_id uuid, p_environment text, p_alert_type text, p_scope text, p_window_seconds integer, p_threshold_value numeric, p_min_event_count integer, p_severity text, p_active boolean, p_cooldown_seconds integer, p_actor_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_upsert_alert_v1(p_environment text, p_rule_id uuid, p_alert_type text, p_scope text, p_severity text, p_title text, p_detail jsonb, p_dedup_key text) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_upsert_alert_v1(p_environment text, p_rule_id uuid, p_alert_type text, p_scope text, p_severity text, p_title text, p_detail jsonb, p_dedup_key text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_upsert_budget_policy_v1(p_id uuid, p_environment text, p_name text, p_scope text, p_scope_value text, p_metric text, p_currency text, p_limit_value numeric, p_period text, p_timezone text, p_alert_thresholds integer[], p_action text, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_priority integer, p_reason text, p_actor_id uuid, p_client_revision integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_upsert_budget_policy_v1(p_id uuid, p_environment text, p_name text, p_scope text, p_scope_value text, p_metric text, p_currency text, p_limit_value numeric, p_period text, p_timezone text, p_alert_thresholds integer[], p_action text, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_priority integer, p_reason text, p_actor_id uuid, p_client_revision integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_upsert_config_value_v1(p_version_id uuid, p_definition_key text, p_value jsonb, p_actor_id uuid, p_client_revision integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_upsert_config_value_v1(p_version_id uuid, p_definition_key text, p_value jsonb, p_actor_id uuid, p_client_revision integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_upsert_pricing_rate_v1(p_id uuid, p_version_id uuid, p_provider text, p_model text, p_operation text, p_metric_key text, p_feature_key text, p_region text, p_unit_type text, p_unit_size numeric, p_unit_price numeric, p_currency text, p_priority integer, p_source text, p_source_url text, p_verified boolean, p_notes text, p_actor_id uuid, p_client_revision integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_upsert_pricing_rate_v1(p_id uuid, p_version_id uuid, p_provider text, p_model text, p_operation text, p_metric_key text, p_feature_key text, p_region text, p_unit_type text, p_unit_size numeric, p_unit_price numeric, p_currency text, p_priority integer, p_source text, p_source_url text, p_verified boolean, p_notes text, p_actor_id uuid, p_client_revision integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_validate_config_version_v1(p_version_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_validate_config_version_v1(p_version_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_validate_listening_episode_v1(p_episode_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_validate_listening_episode_v1(p_episode_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_validate_pricing_version_v1(p_version_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_validate_pricing_version_v1(p_version_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_withdraw_listening_distribution_v1(p_episode_id uuid, p_reason text, p_actor_id uuid, p_client_revision integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_withdraw_listening_distribution_v1(p_episode_id uuid, p_reason text, p_actor_id uuid, p_client_revision integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.app_ack_config_snapshot_v1(p_environment text, p_application text, p_instance_id text, p_version_received integer, p_hash_received text, p_version_applied integer, p_hash_applied text, p_app_version text, p_result text, p_error_sanitized text) TO postgres;
GRANT EXECUTE ON FUNCTION public.app_ack_config_snapshot_v1(p_environment text, p_application text, p_instance_id text, p_version_received integer, p_hash_received text, p_version_applied integer, p_hash_applied text, p_app_version text, p_result text, p_error_sanitized text) TO service_role;
GRANT EXECUTE ON FUNCTION public.app_get_public_config_snapshot_v1(p_environment text) TO postgres;
GRANT EXECUTE ON FUNCTION public.app_get_public_config_snapshot_v1(p_environment text) TO service_role;
GRANT EXECUTE ON FUNCTION public.app_get_server_config_snapshot_v1(p_environment text) TO postgres;
GRANT EXECUTE ON FUNCTION public.app_get_server_config_snapshot_v1(p_environment text) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_review_schedule(p_attempt_id uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_review_schedule(p_attempt_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.apply_review_schedule(p_attempt_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_review_schedule(p_attempt_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.apply_review_schedule(p_attempt_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_gateway_idempotent_op_v1(p_scope text, p_idempotency_key text, p_lease_seconds integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.begin_gateway_idempotent_op_v1(p_scope text, p_idempotency_key text, p_lease_seconds integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.can_manage_plans() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_manage_plans() TO anon;
GRANT EXECUTE ON FUNCTION public.can_manage_plans() TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_plans() TO postgres;
GRANT EXECUTE ON FUNCTION public.can_manage_plans() TO service_role;
GRANT EXECUTE ON FUNCTION public.can_publish_plans() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_publish_plans() TO anon;
GRANT EXECUTE ON FUNCTION public.can_publish_plans() TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_publish_plans() TO postgres;
GRANT EXECUTE ON FUNCTION public.can_publish_plans() TO service_role;
GRANT EXECUTE ON FUNCTION public.check_and_increment_rate_limit(p_user_id uuid, p_route_key text, p_window_seconds integer, p_max_requests integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.check_and_increment_rate_limit(p_user_id uuid, p_route_key text, p_window_seconds integer, p_max_requests integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_next_listening_job(p_worker_id text, p_job_types text[], p_lock_ms integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_next_listening_job(p_worker_id text, p_job_types text[], p_lock_ms integer) TO anon;
GRANT EXECUTE ON FUNCTION public.claim_next_listening_job(p_worker_id text, p_job_types text[], p_lock_ms integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_listening_job(p_worker_id text, p_job_types text[], p_lock_ms integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.claim_next_listening_job(p_worker_id text, p_job_types text[], p_lock_ms integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_gateway_reservation_v1(p_reservation_id uuid, p_usage_event_id uuid, p_actual_cost_usd numeric, p_actual_metrics jsonb) TO postgres;
GRANT EXECUTE ON FUNCTION public.commit_gateway_reservation_v1(p_reservation_id uuid, p_usage_event_id uuid, p_actual_cost_usd numeric, p_actual_metrics jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.compensate_pronunciation_assessment(p_assessment_id uuid, p_error_code text, p_error_message text) TO anon;
GRANT EXECUTE ON FUNCTION public.compensate_pronunciation_assessment(p_assessment_id uuid, p_error_code text, p_error_message text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.compensate_pronunciation_assessment(p_assessment_id uuid, p_error_code text, p_error_message text) TO postgres;
GRANT EXECUTE ON FUNCTION public.compensate_pronunciation_assessment(p_assessment_id uuid, p_error_code text, p_error_message text) TO service_role;
GRANT EXECUTE ON FUNCTION public.compensate_pronunciation_training_assessment(p_session_id uuid, p_error_code text, p_error_message text) TO anon;
GRANT EXECUTE ON FUNCTION public.compensate_pronunciation_training_assessment(p_session_id uuid, p_error_code text, p_error_message text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.compensate_pronunciation_training_assessment(p_session_id uuid, p_error_code text, p_error_message text) TO postgres;
GRANT EXECUTE ON FUNCTION public.compensate_pronunciation_training_assessment(p_session_id uuid, p_error_code text, p_error_message text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_gateway_idempotent_op_v1(p_lock_id uuid, p_result_ref text) TO postgres;
GRANT EXECUTE ON FUNCTION public.complete_gateway_idempotent_op_v1(p_lock_id uuid, p_result_ref text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_pronunciation_assessment(p_assessment_id uuid, p_attempt_id uuid, p_pronunciation_score numeric, p_accuracy_score numeric, p_fluency_score numeric, p_completeness_score numeric, p_prosody_score numeric, p_recognized_text text, p_words_json jsonb, p_raw_result_json jsonb, p_audio_duration_s numeric) TO anon;
GRANT EXECUTE ON FUNCTION public.complete_pronunciation_assessment(p_assessment_id uuid, p_attempt_id uuid, p_pronunciation_score numeric, p_accuracy_score numeric, p_fluency_score numeric, p_completeness_score numeric, p_prosody_score numeric, p_recognized_text text, p_words_json jsonb, p_raw_result_json jsonb, p_audio_duration_s numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_pronunciation_assessment(p_assessment_id uuid, p_attempt_id uuid, p_pronunciation_score numeric, p_accuracy_score numeric, p_fluency_score numeric, p_completeness_score numeric, p_prosody_score numeric, p_recognized_text text, p_words_json jsonb, p_raw_result_json jsonb, p_audio_duration_s numeric) TO postgres;
GRANT EXECUTE ON FUNCTION public.complete_pronunciation_assessment(p_assessment_id uuid, p_attempt_id uuid, p_pronunciation_score numeric, p_accuracy_score numeric, p_fluency_score numeric, p_completeness_score numeric, p_prosody_score numeric, p_recognized_text text, p_words_json jsonb, p_raw_result_json jsonb, p_audio_duration_s numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_pronunciation_training_assessment(p_session_id uuid, p_attempt_id uuid, p_pronunciation_score numeric, p_accuracy_score numeric, p_fluency_score numeric, p_completeness_score numeric, p_prosody_score numeric, p_recognized_text text, p_words_json jsonb, p_raw_result_json jsonb, p_audio_duration_s numeric) TO anon;
GRANT EXECUTE ON FUNCTION public.complete_pronunciation_training_assessment(p_session_id uuid, p_attempt_id uuid, p_pronunciation_score numeric, p_accuracy_score numeric, p_fluency_score numeric, p_completeness_score numeric, p_prosody_score numeric, p_recognized_text text, p_words_json jsonb, p_raw_result_json jsonb, p_audio_duration_s numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_pronunciation_training_assessment(p_session_id uuid, p_attempt_id uuid, p_pronunciation_score numeric, p_accuracy_score numeric, p_fluency_score numeric, p_completeness_score numeric, p_prosody_score numeric, p_recognized_text text, p_words_json jsonb, p_raw_result_json jsonb, p_audio_duration_s numeric) TO postgres;
GRANT EXECUTE ON FUNCTION public.complete_pronunciation_training_assessment(p_session_id uuid, p_attempt_id uuid, p_pronunciation_score numeric, p_accuracy_score numeric, p_fluency_score numeric, p_completeness_score numeric, p_prosody_score numeric, p_recognized_text text, p_words_json jsonb, p_raw_result_json jsonb, p_audio_duration_s numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_writing_review_reservation(p_attempt_id uuid, p_review_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_writing_review_reservation(p_attempt_id uuid, p_review_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.complete_writing_review_reservation(p_attempt_id uuid, p_review_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.conversation_cron_sweep_stale_sessions() TO postgres;
GRANT EXECUTE ON FUNCTION public.conversation_cron_sweep_stale_sessions() TO service_role;
GRANT EXECUTE ON FUNCTION public.create_pronunciation_training_text(p_practice_date date, p_level text, p_generated_text text, p_force_new boolean) TO anon;
GRANT EXECUTE ON FUNCTION public.create_pronunciation_training_text(p_practice_date date, p_level text, p_generated_text text, p_force_new boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_pronunciation_training_text(p_practice_date date, p_level text, p_generated_text text, p_force_new boolean) TO postgres;
GRANT EXECUTE ON FUNCTION public.create_pronunciation_training_text(p_practice_date date, p_level text, p_generated_text text, p_force_new boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.expire_stale_gateway_reservations_v1(p_limit integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.expire_stale_gateway_reservations_v1(p_limit integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_gateway_idempotent_op_v1(p_lock_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.fail_gateway_idempotent_op_v1(p_lock_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_pronunciation_assessment(p_assessment_id uuid, p_attempt_id uuid, p_error_code text) TO anon;
GRANT EXECUTE ON FUNCTION public.fail_pronunciation_assessment(p_assessment_id uuid, p_attempt_id uuid, p_error_code text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fail_pronunciation_assessment(p_assessment_id uuid, p_attempt_id uuid, p_error_code text) TO postgres;
GRANT EXECUTE ON FUNCTION public.fail_pronunciation_assessment(p_assessment_id uuid, p_attempt_id uuid, p_error_code text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_pronunciation_training_assessment(p_session_id uuid, p_attempt_id uuid, p_error_code text) TO anon;
GRANT EXECUTE ON FUNCTION public.fail_pronunciation_training_assessment(p_session_id uuid, p_attempt_id uuid, p_error_code text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fail_pronunciation_training_assessment(p_session_id uuid, p_attempt_id uuid, p_error_code text) TO postgres;
GRANT EXECUTE ON FUNCTION public.fail_pronunciation_training_assessment(p_session_id uuid, p_attempt_id uuid, p_error_code text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_writing_review_reservation(p_attempt_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fail_writing_review_reservation(p_attempt_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.fail_writing_review_reservation(p_attempt_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_admin_security_events_immutable() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_admin_security_events_immutable() TO anon;
GRANT EXECUTE ON FUNCTION public.fn_admin_security_events_immutable() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_admin_security_events_immutable() TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_admin_security_events_immutable() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_admin_security_policy_version_immutable() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_admin_security_policy_version_immutable() TO anon;
GRANT EXECUTE ON FUNCTION public.fn_admin_security_policy_version_immutable() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_admin_security_policy_version_immutable() TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_admin_security_policy_version_immutable() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_admin_users_owner_guard() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_admin_users_owner_guard() TO anon;
GRANT EXECUTE ON FUNCTION public.fn_admin_users_owner_guard() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_admin_users_owner_guard() TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_admin_users_owner_guard() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_config_value_editable_guard() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_config_value_editable_guard() TO anon;
GRANT EXECUTE ON FUNCTION public.fn_config_value_editable_guard() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_config_value_editable_guard() TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_config_value_editable_guard() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_config_version_immutable() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_config_version_immutable() TO anon;
GRANT EXECUTE ON FUNCTION public.fn_config_version_immutable() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_config_version_immutable() TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_config_version_immutable() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_cost_valuation_immutable() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_cost_valuation_immutable() TO anon;
GRANT EXECUTE ON FUNCTION public.fn_cost_valuation_immutable() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cost_valuation_immutable() TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_cost_valuation_immutable() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_gateway_version_immutable() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_gateway_version_immutable() TO anon;
GRANT EXECUTE ON FUNCTION public.fn_gateway_version_immutable() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gateway_version_immutable() TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_gateway_version_immutable() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_listening_publication_immutable() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_listening_publication_immutable() TO anon;
GRANT EXECUTE ON FUNCTION public.fn_listening_publication_immutable() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_listening_publication_immutable() TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_listening_publication_immutable() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_listening_request_terminal_guard() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_listening_request_terminal_guard() TO anon;
GRANT EXECUTE ON FUNCTION public.fn_listening_request_terminal_guard() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_listening_request_terminal_guard() TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_listening_request_terminal_guard() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_pricing_rate_editable_guard() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_pricing_rate_editable_guard() TO anon;
GRANT EXECUTE ON FUNCTION public.fn_pricing_rate_editable_guard() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_pricing_rate_editable_guard() TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_pricing_rate_editable_guard() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_pricing_version_immutable() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_pricing_version_immutable() TO anon;
GRANT EXECUTE ON FUNCTION public.fn_pricing_version_immutable() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_pricing_version_immutable() TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_pricing_version_immutable() TO service_role;
GRANT EXECUTE ON FUNCTION public.gateway_ack_control_snapshot_v1(p_environment text, p_instance_id text, p_version_received integer, p_hash_received text, p_version_applied integer, p_hash_applied text, p_gateway_version text, p_result text, p_error_sanitized text) TO postgres;
GRANT EXECUTE ON FUNCTION public.gateway_ack_control_snapshot_v1(p_environment text, p_instance_id text, p_version_received integer, p_hash_received text, p_version_applied integer, p_hash_applied text, p_gateway_version text, p_result text, p_error_sanitized text) TO service_role;
GRANT EXECUTE ON FUNCTION public.gateway_ack_pricing_snapshot_v1(p_environment text, p_instance_id text, p_version_received integer, p_hash_received text, p_version_applied integer, p_hash_applied text, p_gateway_version text, p_result text, p_error_sanitized text) TO postgres;
GRANT EXECUTE ON FUNCTION public.gateway_ack_pricing_snapshot_v1(p_environment text, p_instance_id text, p_version_received integer, p_hash_received text, p_version_applied integer, p_hash_applied text, p_gateway_version text, p_result text, p_error_sanitized text) TO service_role;
GRANT EXECUTE ON FUNCTION public.gateway_get_control_snapshot_v1(p_environment text) TO postgres;
GRANT EXECUTE ON FUNCTION public.gateway_get_control_snapshot_v1(p_environment text) TO service_role;
GRANT EXECUTE ON FUNCTION public.gateway_get_pricing_snapshot_v1(p_environment text) TO postgres;
GRANT EXECUTE ON FUNCTION public.gateway_get_pricing_snapshot_v1(p_environment text) TO service_role;
GRANT EXECUTE ON FUNCTION public.gateway_publish_budget_policies_v1() TO postgres;
GRANT EXECUTE ON FUNCTION public.gateway_publish_budget_policies_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.gateway_publish_pricing_v1() TO postgres;
GRANT EXECUTE ON FUNCTION public.gateway_publish_pricing_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.gateway_publish_runtime_controls_v1() TO postgres;
GRANT EXECUTE ON FUNCTION public.gateway_publish_runtime_controls_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_admin_role() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_role() TO anon;
GRANT EXECUTE ON FUNCTION public.get_admin_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_role() TO postgres;
GRANT EXECUTE ON FUNCTION public.get_admin_role() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_gateway_breaker_state_v1(p_provider text, p_model text, p_feature_key text) TO postgres;
GRANT EXECUTE ON FUNCTION public.get_gateway_breaker_state_v1(p_provider text, p_model text, p_feature_key text) TO service_role;
GRANT EXECUTE ON FUNCTION public.heartbeat_listening_job(p_job_id uuid, p_worker_id text, p_extension_ms integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.heartbeat_listening_job(p_job_id uuid, p_worker_id text, p_extension_ms integer) TO anon;
GRANT EXECUTE ON FUNCTION public.heartbeat_listening_job(p_job_id uuid, p_worker_id text, p_extension_ms integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_listening_job(p_job_id uuid, p_worker_id text, p_extension_ms integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.heartbeat_listening_job(p_job_id uuid, p_worker_id text, p_extension_ms integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.is_active_admin() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_active_admin() TO anon;
GRANT EXECUTE ON FUNCTION public.is_active_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_active_admin() TO postgres;
GRANT EXECUTE ON FUNCTION public.is_active_admin() TO service_role;
GRANT EXECUTE ON FUNCTION public.list_usage_daily_buckets_for_date(p_usage_date date, p_limit integer, p_after_key text) TO postgres;
GRANT EXECUTE ON FUNCTION public.list_usage_daily_buckets_for_date(p_usage_date date, p_limit integer, p_after_key text) TO service_role;
GRANT EXECUTE ON FUNCTION public.listening_cron_dispatch_jobs() TO anon;
GRANT EXECUTE ON FUNCTION public.listening_cron_dispatch_jobs() TO authenticated;
GRANT EXECUTE ON FUNCTION public.listening_cron_dispatch_jobs() TO postgres;
GRANT EXECUTE ON FUNCTION public.listening_cron_dispatch_jobs() TO service_role;
GRANT EXECUTE ON FUNCTION public.listening_cron_ensure_inventory() TO anon;
GRANT EXECUTE ON FUNCTION public.listening_cron_ensure_inventory() TO authenticated;
GRANT EXECUTE ON FUNCTION public.listening_cron_ensure_inventory() TO postgres;
GRANT EXECUTE ON FUNCTION public.listening_cron_ensure_inventory() TO service_role;
GRANT EXECUTE ON FUNCTION public.listening_cron_repair_stuck_jobs() TO anon;
GRANT EXECUTE ON FUNCTION public.listening_cron_repair_stuck_jobs() TO authenticated;
GRANT EXECUTE ON FUNCTION public.listening_cron_repair_stuck_jobs() TO postgres;
GRANT EXECUTE ON FUNCTION public.listening_cron_repair_stuck_jobs() TO service_role;
GRANT EXECUTE ON FUNCTION public.listening_generation_jobs_set_updated_at() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.listening_generation_jobs_set_updated_at() TO anon;
GRANT EXECUTE ON FUNCTION public.listening_generation_jobs_set_updated_at() TO authenticated;
GRANT EXECUTE ON FUNCTION public.listening_generation_jobs_set_updated_at() TO postgres;
GRANT EXECUTE ON FUNCTION public.listening_generation_jobs_set_updated_at() TO service_role;
GRANT EXECUTE ON FUNCTION public.listening_jobs_set_updated_at() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.listening_jobs_set_updated_at() TO anon;
GRANT EXECUTE ON FUNCTION public.listening_jobs_set_updated_at() TO authenticated;
GRANT EXECUTE ON FUNCTION public.listening_jobs_set_updated_at() TO postgres;
GRANT EXECUTE ON FUNCTION public.listening_jobs_set_updated_at() TO service_role;
GRANT EXECUTE ON FUNCTION public.listening_level_group_for_cefr(p_cefr_level text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.listening_level_group_for_cefr(p_cefr_level text) TO anon;
GRANT EXECUTE ON FUNCTION public.listening_level_group_for_cefr(p_cefr_level text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.listening_level_group_for_cefr(p_cefr_level text) TO postgres;
GRANT EXECUTE ON FUNCTION public.listening_level_group_for_cefr(p_cefr_level text) TO service_role;
GRANT EXECUTE ON FUNCTION public.listening_shared_stories_set_updated_at() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.listening_shared_stories_set_updated_at() TO anon;
GRANT EXECUTE ON FUNCTION public.listening_shared_stories_set_updated_at() TO authenticated;
GRANT EXECUTE ON FUNCTION public.listening_shared_stories_set_updated_at() TO postgres;
GRANT EXECUTE ON FUNCTION public.listening_shared_stories_set_updated_at() TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_gateway_reservation_reconciliation_required_v1(p_reservation_id uuid, p_reason text) TO postgres;
GRANT EXECUTE ON FUNCTION public.mark_gateway_reservation_reconciliation_required_v1(p_reservation_id uuid, p_reason text) TO service_role;
GRANT EXECUTE ON FUNCTION public.protect_rewrite_submission_immutability() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.protect_rewrite_submission_immutability() TO anon;
GRANT EXECUTE ON FUNCTION public.protect_rewrite_submission_immutability() TO authenticated;
GRANT EXECUTE ON FUNCTION public.protect_rewrite_submission_immutability() TO postgres;
GRANT EXECUTE ON FUNCTION public.protect_rewrite_submission_immutability() TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_plan_version(p_plan_id uuid, p_draft_version_id uuid, p_client_revision integer, p_publication_notes text, p_change_summary text, p_config_hash text, p_actor_user_id uuid, p_activate_plan boolean) TO postgres;
GRANT EXECUTE ON FUNCTION public.publish_plan_version(p_plan_id uuid, p_draft_version_id uuid, p_client_revision integer, p_publication_notes text, p_change_summary text, p_config_hash text, p_actor_user_id uuid, p_activate_plan boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.rebuild_usage_daily_bucket(p_usage_date date, p_user_id uuid, p_actor_type text, p_feature_key text, p_provider text, p_model text) TO postgres;
GRANT EXECUTE ON FUNCTION public.rebuild_usage_daily_bucket(p_usage_date date, p_user_id uuid, p_actor_type text, p_feature_key text, p_provider text, p_model text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rebuild_usage_daily_bucket_for_event(p_event_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.rebuild_usage_daily_bucket_for_event(p_event_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_gateway_breaker_outcome_v1(p_provider text, p_model text, p_feature_key text, p_success boolean) TO postgres;
GRANT EXECUTE ON FUNCTION public.record_gateway_breaker_outcome_v1(p_provider text, p_model text, p_feature_key text, p_success boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_gateway_concurrency_validation_v1(p_migration_version text, p_validation_script_path text, p_validation_script_sha256 text, p_status text, p_executed_by text, p_notes text) TO postgres;
GRANT EXECUTE ON FUNCTION public.record_gateway_concurrency_validation_v1(p_migration_version text, p_validation_script_path text, p_validation_script_sha256 text, p_status text, p_executed_by text, p_notes text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_realtime_hard_control_validation_v1(p_hard_control_version text, p_validation_script_path text, p_validation_script_sha256 text, p_git_sha text, p_environment text, p_scenario_results jsonb, p_executed_by text, p_notes text, p_evidence jsonb) TO postgres;
GRANT EXECUTE ON FUNCTION public.record_realtime_hard_control_validation_v1(p_hard_control_version text, p_validation_script_path text, p_validation_script_sha256 text, p_git_sha text, p_environment text, p_scenario_results jsonb, p_executed_by text, p_notes text, p_evidence jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_gateway_reservation_v1(p_reservation_id uuid, p_reason text) TO postgres;
GRANT EXECUTE ON FUNCTION public.release_gateway_reservation_v1(p_reservation_id uuid, p_reason text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_gateway_usage_v1(p_idempotency_key text, p_user_id uuid, p_initiated_by_user_id uuid, p_feature_key text, p_provider text, p_model text, p_metrics jsonb, p_budget_scopes jsonb, p_estimated_cost_usd numeric, p_expires_in_seconds integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.reserve_gateway_usage_v1(p_idempotency_key text, p_user_id uuid, p_initiated_by_user_id uuid, p_feature_key text, p_provider text, p_model text, p_metrics jsonb, p_budget_scopes jsonb, p_estimated_cost_usd numeric, p_expires_in_seconds integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_pronunciation_assessment(p_text_version_id uuid, p_azure_region text, p_attempt_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.reserve_pronunciation_assessment(p_text_version_id uuid, p_azure_region text, p_attempt_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_pronunciation_assessment(p_text_version_id uuid, p_azure_region text, p_attempt_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.reserve_pronunciation_assessment(p_text_version_id uuid, p_azure_region text, p_attempt_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_pronunciation_training_assessment(p_practice_date date, p_azure_region text, p_attempt_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.reserve_pronunciation_training_assessment(p_practice_date date, p_azure_region text, p_attempt_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_pronunciation_training_assessment(p_practice_date date, p_azure_region text, p_attempt_id uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.reserve_pronunciation_training_assessment(p_practice_date date, p_azure_region text, p_attempt_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_writing_review(p_attempt_id uuid, p_unlimited boolean, p_limit integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_writing_review(p_attempt_id uuid, p_unlimited boolean, p_limit integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.reserve_writing_review(p_attempt_id uuid, p_unlimited boolean, p_limit integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_ai_prefs_user_id() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_ai_prefs_user_id() TO anon;
GRANT EXECUTE ON FUNCTION public.set_ai_prefs_user_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_ai_prefs_user_id() TO postgres;
GRANT EXECUTE ON FUNCTION public.set_ai_prefs_user_id() TO service_role;
GRANT EXECUTE ON FUNCTION public.set_conversation_session_user_id() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_conversation_session_user_id() TO anon;
GRANT EXECUTE ON FUNCTION public.set_conversation_session_user_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_conversation_session_user_id() TO postgres;
GRANT EXECUTE ON FUNCTION public.set_conversation_session_user_id() TO service_role;
GRANT EXECUTE ON FUNCTION public.set_updated_at() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_updated_at() TO anon;
GRANT EXECUTE ON FUNCTION public.set_updated_at() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_updated_at() TO postgres;
GRANT EXECUTE ON FUNCTION public.set_updated_at() TO service_role;
GRANT EXECUTE ON FUNCTION public.tg_plan_capability_values_immutability() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.tg_plan_capability_values_immutability() TO anon;
GRANT EXECUTE ON FUNCTION public.tg_plan_capability_values_immutability() TO authenticated;
GRANT EXECUTE ON FUNCTION public.tg_plan_capability_values_immutability() TO postgres;
GRANT EXECUTE ON FUNCTION public.tg_plan_capability_values_immutability() TO service_role;
GRANT EXECUTE ON FUNCTION public.tg_plan_versions_immutability() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.tg_plan_versions_immutability() TO anon;
GRANT EXECUTE ON FUNCTION public.tg_plan_versions_immutability() TO authenticated;
GRANT EXECUTE ON FUNCTION public.tg_plan_versions_immutability() TO postgres;
GRANT EXECUTE ON FUNCTION public.tg_plan_versions_immutability() TO service_role;
GRANT EXECUTE ON FUNCTION public.tg_plan_versions_no_delete() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.tg_plan_versions_no_delete() TO anon;
GRANT EXECUTE ON FUNCTION public.tg_plan_versions_no_delete() TO authenticated;
GRANT EXECUTE ON FUNCTION public.tg_plan_versions_no_delete() TO postgres;
GRANT EXECUTE ON FUNCTION public.tg_plan_versions_no_delete() TO service_role;
GRANT EXECUTE ON FUNCTION public.tg_plan_versions_updated_at() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.tg_plan_versions_updated_at() TO anon;
GRANT EXECUTE ON FUNCTION public.tg_plan_versions_updated_at() TO authenticated;
GRANT EXECUTE ON FUNCTION public.tg_plan_versions_updated_at() TO postgres;
GRANT EXECUTE ON FUNCTION public.tg_plan_versions_updated_at() TO service_role;
GRANT EXECUTE ON FUNCTION public.update_updated_at() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_updated_at() TO anon;
GRANT EXECUTE ON FUNCTION public.update_updated_at() TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_updated_at() TO postgres;
GRANT EXECUTE ON FUNCTION public.update_updated_at() TO service_role;
GRANT EXECUTE ON FUNCTION public.user_listening_shared_progress_set_updated_at() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_listening_shared_progress_set_updated_at() TO anon;
GRANT EXECUTE ON FUNCTION public.user_listening_shared_progress_set_updated_at() TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_listening_shared_progress_set_updated_at() TO postgres;
GRANT EXECUTE ON FUNCTION public.user_listening_shared_progress_set_updated_at() TO service_role;
GRANT EXECUTE ON FUNCTION public.validate_listening_question_block_episode() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_listening_question_block_episode() TO anon;
GRANT EXECUTE ON FUNCTION public.validate_listening_question_block_episode() TO authenticated;
GRANT EXECUTE ON FUNCTION public.validate_listening_question_block_episode() TO postgres;
GRANT EXECUTE ON FUNCTION public.validate_listening_question_block_episode() TO service_role;


-- ---------------------------------------------------------------------
-- 14. CUSTOMIZACOES EM storage.* (auth.* nao tem customizacoes - verificado, 0 triggers/functions extras)
--     Bucket "listening-audio" (privado, 100MB, mp3) + 2 policies proprias em storage.objects.
--     storage.buckets_analytics / buckets_vectors / vector_indexes sao objetos padrao da
--     versao atual da extensao Storage (nao sao customizacao do Lemon/dashboard).
-- ---------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, owner, public, file_size_limit, allowed_mime_types, avif_autodetection)
VALUES ('listening-audio', 'listening-audio', NULL, false, 104857600, ARRAY['audio/mpeg','audio/mp3'], false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY deny_authed_listening_audio ON storage.objects AS PERMISSIVE FOR SELECT TO authenticated USING (bucket_id <> 'listening-audio'::text);
CREATE POLICY service_role_all_listening_audio ON storage.objects AS PERMISSIVE FOR ALL TO service_role USING (bucket_id = 'listening-audio'::text) WITH CHECK (bucket_id = 'listening-audio'::text);

-- ---------------------------------------------------------------------
-- 15. CRON (pg_cron) -- 1 job em producao. Documentado aqui, NAO agendado
--     automaticamente neste baseline: rodar a cada minuto em homologacao antes de
--     haver dados/RLS validado pode gerar ruido/custos sem necessidade.
--     Decisao de agendar ou nao fica para o usuario (ver README.md desta pasta).
--     Comando de referencia, caso deseje habilitar:
--
--     SELECT cron.schedule(
--       'conversation-sweep-stale-sessions',
--       '* * * * *',
--       $$SELECT public.conversation_cron_sweep_stale_sessions()$$
--     );
-- ---------------------------------------------------------------------
