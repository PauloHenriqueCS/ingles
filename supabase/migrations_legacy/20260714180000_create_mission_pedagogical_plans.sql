-- Migration: create mission_pedagogical_plans
-- Purpose: persist deterministic pedagogical plans produced by the planner
--
-- Security notes:
-- - INSERT/UPDATE/DELETE: service role only
-- - SELECT: authenticated user can read own rows
-- - full_plan JSONB stores the complete contract (no sensitive PII)
-- - search_path fixed in all SECURITY DEFINER functions

set search_path = public;

-- ── Table ─────────────────────────────────────────────────────────────────────

create table if not exists public.mission_pedagogical_plans (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references auth.users(id) on delete cascade,
  skill                    text not null check (skill in ('writing', 'pronunciation', 'conversation', 'listening')),

  -- Versioning
  planner_version          text not null,
  catalog_version          int  not null,

  -- Level & assessment state at plan time
  learner_level            text check (learner_level in ('A1','A2','B1','B2','C1','C2')),
  effective_level          text not null check (effective_level in ('A1','A2','B1','B2','C1','C2')),
  assessment_status        text not null check (assessment_status in ('unknown','provisional','calibrating','confirmed','stale')),
  assessment_confidence    numeric(4,3) not null default 0 check (assessment_confidence between 0 and 1),

  -- Plan identity
  mode                     text not null check (mode in ('diagnostic','calibration','normal','recovery','maintenance','checkpoint')),
  difficulty               text not null check (difficulty in ('easy','medium','hard')),
  reason                   text not null,
  communicative_objective_id text not null,
  communicative_functions  text[] not null default '{}',

  -- Selected topics (denormalized for easy querying)
  primary_topic_ids        text[] not null default '{}',
  secondary_topic_ids      text[] not null default '{}',
  review_topic_ids         text[] not null default '{}',
  forbidden_topic_ids      text[] not null default '{}',

  -- Vocabulary, support, and budgets (stored as JSONB for flexibility)
  vocabulary_items         jsonb not null default '[]',
  support_level            text not null check (support_level in ('minimal','standard','high')),
  support_configuration    jsonb not null default '{}',
  novelty_budget           jsonb not null default '{}',
  recovery_budget          jsonb not null default '{}',
  generation_constraints   jsonb not null default '{}',
  validation_rules         jsonb not null default '{}',

  -- Full plan JSONB (immutable after acceptance)
  full_plan                jsonb not null default '{}',

  -- Reproducibility
  seed                     text not null,
  shadow_mode              boolean not null default false,

  -- Lifecycle
  created_at               timestamptz not null default now(),
  accepted_at              timestamptz,
  superseded_at            timestamptz
);

-- ── Indexes ────────────────────────────────────────────────────────────────────

-- Fast lookup by user
create index if not exists mpp_user_id_idx on public.mission_pedagogical_plans(user_id);

-- Active (non-superseded) plans per user
create index if not exists mpp_user_active_idx
  on public.mission_pedagogical_plans(user_id, created_at desc)
  where superseded_at is null;

-- Idempotency: same plan id must be unique (PK handles this, but explicit)
-- PK already enforces uniqueness on id

-- ── RLS ───────────────────────────────────────────────────────────────────────

alter table public.mission_pedagogical_plans enable row level security;

-- Users can read their own plans
create policy mpp_select
  on public.mission_pedagogical_plans
  for select
  to authenticated
  using (auth.uid() = user_id);

-- No direct insert/update/delete for authenticated users
-- All writes use service role

-- ── Permissions ───────────────────────────────────────────────────────────────

revoke all on public.mission_pedagogical_plans from anon;
grant select on public.mission_pedagogical_plans to authenticated;

-- Comments
comment on table public.mission_pedagogical_plans is
  'Deterministic pedagogical plans produced by PEDAGOGICAL_PLANNER_V1 before mission generation. Immutable after accepted_at is set.';

comment on column public.mission_pedagogical_plans.shadow_mode is
  'True when planner was in shadow mode — plan was produced and persisted but did not alter the generated mission.';

comment on column public.mission_pedagogical_plans.full_plan is
  'Complete MissionPedagogicalPlan as JSON. Not exposed directly to the browser; only queried server-side.';
