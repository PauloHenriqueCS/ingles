-- ============================================================================
-- Admin: Retention & Subscription metrics (read-only, server-side aggregation).
-- ----------------------------------------------------------------------------
-- Powers the dashboard "Retenção e assinaturas" section. All heavy aggregation
-- happens here in Postgres (never N+1 in the browser). Every function is
-- SECURITY DEFINER and reachable ONLY by the service-role admin client
-- (REVOKE from public/anon/authenticated; GRANT to service_role) — same access
-- boundary as the other admin_*_v1 RPCs. No PII, no raw content is returned;
-- only counts and derived rates.
--
-- SOURCES OF TRUTH (audited against the live database, not assumed):
--   * Signup .................. auth.users.created_at
--   * Completed activity ...... strict per-modality "completed" predicates,
--                               bucketed to America/Sao_Paulo calendar days
--                               (see admin_retention_activity_days below). NOT
--                               login / app-open / abandoned generations.
--   * First real payment ...... user_billing_facts.first_paid_at — write-once,
--                               set only for honored RevenueCat store payments
--                               (the app's DB-granted trial never sets it). This
--                               is the AUTHORITATIVE "converted to paid" fact and
--                               is never recomputed here.
--   * Paid coverage / churn ... user_plan_assignments (origin='subscription',
--                               commercial plans 'essencial'/'plus'), using the
--                               persisted starts_at/ends_at/status history. Rows
--                               for ended periods are retained, so historical
--                               coverage is reconstructable.
--   * Cancellation events ..... revenuecat_webhook_events (event_type), used for
--                               "cancellation requested" and transfer exclusion.
--
-- DEFINITIONS (documented so the dashboard and the report agree exactly):
--   Paid COVERAGE model (per user, from user_plan_assignments paid rows):
--     p_start   = min(starts_at)              -- when the user first held paid coverage
--     ongoing   = EXISTS an active paid row with ends_at IS NULL or ends_at>now()
--     p_extent  = ongoing ? 'infinity' : max(ends_at)   -- how far coverage reaches
--     covered_at(T) = p_start IS NOT NULL AND T >= p_start AND p_extent >= T
--   This makes renewals (extend p_extent), Essencial<->Plus changes (a second
--   covering row) and duplicate webhooks all NON-churn by construction. The one
--   known limitation: a resubscribe after a true coverage GAP is treated as
--   continuously covered across the gap (a small over-count of retention), and a
--   same-subscription renewal that rewrites a single row forward is still handled
--   because we take max(ends_at)/ongoing, never the current row's start alone.
--
--   Cancellation REQUESTED  != Churn EFFECTIVE:
--     requested = a CANCELLATION webhook in the period (auto-renew off; the user
--                 keeps access until ends_at) — NOT counted as churn.
--     churn     = coverage actually ENDED in the period: covered_at(P0)=true and
--                 covered_at(P1)=false (p_extent in [P0,P1), not ongoing),
--                 excluding users with a TRANSFER webhook in the period.
--
--   D1/D7/D30 = a completed activity on the exact relative day N (signup day=0).
--     Denominator = users whose account already reached day N (matured).
--   "3+ days in first week" = >=3 distinct completed-activity days in the first
--     7 calendar days [signup .. signup+6]; denominator = accounts matured 7d.
--
--   M1/M2/M3 = the paid cohort still has paid coverage at first_paid_at+30/60/90:
--     covered_at(first_paid_at + interval '30 days'*k). Uses coverage HISTORY,
--     not current status. Immature cohorts (first_paid_at newer than 30k days)
--     are excluded from the denominator (surfaced as NULL, rendered as "—").
--
-- Financial note: no per-transaction amount/currency is persisted anywhere
-- (revenuecat_webhook_events stores no price; only plans.monthly_price_cents, a
-- hardcoded single-currency figure, exists). Auditable MRR is therefore NOT
-- computed here — deliberately omitted rather than fabricated.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Helper 1: strict "completed activity" days per user, America/Sao_Paulo.
-- One (user_id, day) row per calendar day on which the user genuinely COMPLETED
-- at least one activity in some modality. Deduped by the caller as needed.
-- Excludes logins, app opens, abandoned generations and in-flight attempts.
-- ---------------------------------------------------------------------------
create or replace function public.admin_retention_activity_days()
returns table (user_id uuid, day date)
language sql
stable
security definer
set search_path = public
as $$
  with tz as (select 'America/Sao_Paulo'::text as zone)
  -- Escrita: each english_reviews row is a submitted, AI-scored writing review.
  select er.user_id,
         coalesce(er.entry_date, (er.created_at at time zone (select zone from tz))::date) as day
    from public.english_reviews er
  union
  -- Pronúncia: only a completed (scored) training session counts.
  select pts.user_id, pts.practice_date
    from public.pronunciation_training_sessions pts
   where pts.status = 'completed' and pts.practice_date is not null
  union
  -- Listening: a finished shared story (completed=true).
  select ulsp.user_id, (ulsp.completed_at at time zone (select zone from tz))::date
    from public.user_listening_shared_progress ulsp
   where ulsp.completed = true and ulsp.completed_at is not null
  union
  -- Listening (legacy assignment-based completion).
  select ula.user_id, (ula.completed_at at time zone (select zone from tz))::date
    from public.user_listening_assignments ula
   where ula.status = 'completed' and ula.completed_at is not null
  union
  -- Listening (scored result rows).
  select ulr.user_id, (ulr.created_at at time zone (select zone from tz))::date
    from public.user_listening_results ulr
  union
  -- Revisão (SRS): a row exists only for an answer genuinely submitted.
  select ria.user_id, ria.activity_date
    from public.review_item_attempts ria
   where ria.activity_date is not null
  union
  -- Conversação: a realtime session that actually consumed time.
  select cs.user_id, cs.session_date
    from public.conversation_sessions cs
   where cs.duration_sec > 0 and cs.session_date is not null;
$$;

revoke all on function public.admin_retention_activity_days() from public;
revoke all on function public.admin_retention_activity_days() from anon;
revoke all on function public.admin_retention_activity_days() from authenticated;
grant execute on function public.admin_retention_activity_days() to service_role;

-- ---------------------------------------------------------------------------
-- Helper 2: per-user paid-coverage aggregate from user_plan_assignments.
-- Only commercial subscriptions ('essencial'/'plus', origin='subscription').
--   p_start      = first instant the user held paid coverage
--   ongoing      = still actively covered with no/future end
--   p_extent     = 'infinity' when ongoing, else the furthest ends_at reached
--   current_tier = plan code currently covering the user (NULL if not covered now)
-- ---------------------------------------------------------------------------
create or replace function public.admin_retention_paid_coverage()
returns table (
  user_id uuid,
  p_start timestamptz,
  p_extent timestamptz,
  ongoing boolean,
  current_tier text
)
language sql
stable
security definer
set search_path = public
as $$
  with paid as (
    select upa.user_id,
           upa.starts_at,
           upa.ends_at,
           upa.status,
           p.code as tier
      from public.user_plan_assignments upa
      join public.plans p on p.id = upa.plan_id
     where upa.origin = 'subscription'
       and p.code in ('essencial', 'plus')
  ),
  agg as (
    select paid.user_id,
           min(paid.starts_at) as p_start,
           bool_or(
             paid.status = 'active'
             and (paid.ends_at is null or paid.ends_at > now())
           ) as ongoing,
           max(paid.ends_at) as max_ends
      from paid
     group by paid.user_id
  ),
  cur as (
    -- the paid row covering "now", if any (latest starting one wins)
    select distinct on (paid.user_id) paid.user_id, paid.tier
      from paid
     where paid.starts_at <= now()
       and (paid.ends_at is null or paid.ends_at > now())
     order by paid.user_id, paid.starts_at desc
  )
  select a.user_id,
         a.p_start,
         case when a.ongoing then 'infinity'::timestamptz else a.max_ends end as p_extent,
         a.ongoing,
         cur.tier as current_tier
    from agg a
    left join cur on cur.user_id = a.user_id;
$$;

revoke all on function public.admin_retention_paid_coverage() from public;
revoke all on function public.admin_retention_paid_coverage() from anon;
revoke all on function public.admin_retention_paid_coverage() from authenticated;
grant execute on function public.admin_retention_paid_coverage() to service_role;

-- ---------------------------------------------------------------------------
-- RPC 1: consolidated overview for the selected period [p_started_after,
-- p_started_before). Returns ONE jsonb with every headline block:
--   product_retention (D1/D7/D30/3+), trial_funnel, time_to_conversion,
--   subscriptions (active/new/cancel-requested/churn + by plan),
--   subscription_retention (M1/M2/M3 + by plan), engagement_vs_conversion,
--   streak_vs_conversion.
-- Period semantics: acquisition/lifecycle blocks (D-N, trial funnel, streak,
-- engagement, new payers, churn, cancellations) are scoped to the period;
-- "active now" and the matured M1/M2/M3 headline are point-in-time / lifecycle
-- and intentionally period-independent (documented per field).
-- ---------------------------------------------------------------------------
create or replace function public.admin_get_retention_overview_v1(
  p_started_after  timestamptz,
  p_started_before timestamptz
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with tz as (select 'America/Sao_Paulo'::text as zone),
  p as (select p_started_after as a0, coalesce(p_started_before, now()) as a1),
  nowd as (select (now() at time zone (select zone from tz))::date as today_sp),
  -- distinct completed-activity days
  ad as (select distinct user_id, day from public.admin_retention_activity_days() where day is not null),
  -- paid coverage per user
  cov as (select * from public.admin_retention_paid_coverage()),
  -- billing facts
  bf as (
    select user_id, first_paid_at,
           (first_paid_at at time zone (select zone from tz))::date as first_paid_sp
      from public.user_billing_facts where first_paid_at is not null
  ),
  -- trial start per user (app trial granted at signup)
  tr as (
    select user_id, min(starts_at) as trial_start,
           (min(starts_at) at time zone (select zone from tz))::date as trial_start_sp
      from public.user_plan_assignments where origin = 'trial' group by user_id
  ),
  -- all users with signup day + age
  u as (
    select au.id as user_id,
           au.created_at,
           (au.created_at at time zone (select zone from tz))::date as signup_sp,
           ((select today_sp from nowd) - (au.created_at at time zone (select zone from tz))::date) as age_days
      from auth.users au
  ),
  -- signup cohort = accounts created in the period
  su as (select u.* from u, p where u.created_at >= p.a0 and u.created_at < p.a1),
  -- first-week distinct active days per user
  fw as (
    select u.user_id, count(distinct ad.day) as days_first_week
      from u left join ad on ad.user_id = u.user_id
             and ad.day between u.signup_sp and u.signup_sp + 6
     group by u.user_id
  ),
  -- first paid tier (tier of earliest commercial subscription row) per paid user
  fpt as (
    select distinct on (upa.user_id) upa.user_id, pl.code as tier
      from public.user_plan_assignments upa join public.plans pl on pl.id = upa.plan_id
     where upa.origin = 'subscription' and pl.code in ('essencial','plus')
     order by upa.user_id, upa.starts_at asc
  ),
  -- transfers in the period (to exclude from churn)
  transfers as (
    select distinct app_user_id::uuid as user_id
      from public.revenuecat_webhook_events
     where event_type = 'TRANSFER' and received_at >= (select a0 from p) and received_at < (select a1 from p)
       and app_user_id ~ '^[0-9a-f-]{36}$'
  ),
  -- trial cohort = trial started in period
  tc as (
    select tr.user_id, tr.trial_start_sp,
           u.signup_sp,
           coalesce(fw.days_first_week, 0) as days_first_week,
           (bf.first_paid_at is not null) as converted,
           exists (select 1 from ad where ad.user_id = tr.user_id) as any_activity
      from tr
      join u on u.user_id = tr.user_id
      left join fw on fw.user_id = tr.user_id
      left join bf on bf.user_id = tr.user_id, p
     where tr.trial_start >= p.a0 and tr.trial_start < p.a1
  ),
  -- new payers in period
  np as (
    select bf.user_id, bf.first_paid_sp,
           (bf.first_paid_sp - coalesce(tr.trial_start_sp, (select signup_sp from u u2 where u2.user_id = bf.user_id))) as days_to_pay,
           fpt.tier
      from bf
      left join tr on tr.user_id = bf.user_id
      left join fpt on fpt.user_id = bf.user_id, p
     where bf.first_paid_at >= p.a0 and bf.first_paid_at < p.a1
  ),
  -- initial streak (longest consecutive-day run in first 14 days) per trial-cohort user
  fw_days as (
    select tc.user_id, ad.day
      from tc join ad on ad.user_id = tc.user_id and ad.day between tc.signup_sp and tc.signup_sp + 13
  ),
  islands as (
    select user_id, (day - (row_number() over (partition by user_id order by day))::int) as grp
      from fw_days
  ),
  runs as (select user_id, grp, count(*) as len from islands group by user_id, grp),
  user_streak as (select user_id, max(len) as streak from runs group by user_id)
  select jsonb_build_object(
    'period', jsonb_build_object('started_after', (select a0 from p), 'started_before', (select a1 from p)),
    'generated_at', now(),

    -- A. Product retention (signup cohort in period, matured windows only)
    'product_retention', jsonb_build_object(
      'd1', (select jsonb_build_object(
               'denominator', count(*) filter (where age_days >= 1),
               'retained', count(*) filter (where age_days >= 1 and exists (select 1 from ad where ad.user_id = su.user_id and ad.day = su.signup_sp + 1)))
             from su),
      'd7', (select jsonb_build_object(
               'denominator', count(*) filter (where age_days >= 7),
               'retained', count(*) filter (where age_days >= 7 and exists (select 1 from ad where ad.user_id = su.user_id and ad.day = su.signup_sp + 7)))
             from su),
      'd30', (select jsonb_build_object(
               'denominator', count(*) filter (where age_days >= 30),
               'retained', count(*) filter (where age_days >= 30 and exists (select 1 from ad where ad.user_id = su.user_id and ad.day = su.signup_sp + 30)))
             from su),
      'three_plus_first_week', (select jsonb_build_object(
               'denominator', count(*) filter (where su.age_days >= 7),
               'retained', count(*) filter (where su.age_days >= 7 and coalesce(fw.days_first_week,0) >= 3))
             from su left join fw on fw.user_id = su.user_id)
    ),

    -- B. Trial -> paid funnel (trial cohort in period)
    'trial_funnel', jsonb_build_object(
      'trials_started', (select count(*) from tc),
      'with_activity', (select count(*) filter (where any_activity) from tc),
      'three_plus_days', (select count(*) filter (where days_first_week >= 3) from tc),
      'converted', (select count(*) filter (where converted) from tc)
    ),

    -- Time to first payment (new payers in period)
    'time_to_conversion', (select jsonb_build_object(
        'payers', count(*),
        'median_days', percentile_cont(0.5) within group (order by days_to_pay),
        'same_day', count(*) filter (where days_to_pay <= 0),
        'within_3d', count(*) filter (where days_to_pay <= 3),
        'within_7d', count(*) filter (where days_to_pay <= 7),
        'after_7d', count(*) filter (where days_to_pay > 7)
      ) from np),

    -- C. Subscriptions
    'subscriptions', jsonb_build_object(
      'active_now', (select count(*) from cov where p_start <= now() and p_extent >= now()),
      'active_by_plan', (select jsonb_build_object(
          'essencial', count(*) filter (where current_tier = 'essencial' and p_start <= now() and p_extent >= now()),
          'plus', count(*) filter (where current_tier = 'plus' and p_start <= now() and p_extent >= now())
        ) from cov),
      'new_payers', (select count(*) from np),
      'new_payers_by_plan', (select jsonb_build_object(
          'essencial', count(*) filter (where tier = 'essencial'),
          'plus', count(*) filter (where tier = 'plus')
        ) from np),
      'cancellations_requested', (
        select count(distinct app_user_id) from public.revenuecat_webhook_events, p
         where event_type = 'CANCELLATION' and received_at >= p.a0 and received_at < p.a1),
      'churn', (select jsonb_build_object(
          'base', count(*) filter (where c.p_start <= (select a0 from p) and c.p_extent >= (select a0 from p)),
          'churned', count(*) filter (
              where c.p_start <= (select a0 from p) and c.p_extent >= (select a0 from p)
                and not c.ongoing and c.p_extent < (select a1 from p)
                and c.user_id not in (select user_id from transfers)))
        from cov c),
      'churn_by_plan', (select jsonb_build_object(
          'essencial', count(*) filter (where c.current_tier is not distinct from 'essencial' and c.p_start <= (select a0 from p) and c.p_extent >= (select a0 from p) and not c.ongoing and c.p_extent < (select a1 from p) and c.user_id not in (select user_id from transfers)),
          'plus', count(*) filter (where c.current_tier is not distinct from 'plus' and c.p_start <= (select a0 from p) and c.p_extent >= (select a0 from p) and not c.ongoing and c.p_extent < (select a1 from p) and c.user_id not in (select user_id from transfers))
        ) from cov c)
    ),

    -- D. Subscription retention M1/M2/M3 (lifecycle, matured cohorts only)
    'subscription_retention', jsonb_build_object(
      'm1', (select jsonb_build_object(
          'denominator', count(*) filter (where bf.first_paid_at <= now() - interval '30 days'),
          'retained', count(*) filter (where bf.first_paid_at <= now() - interval '30 days'
              and exists (select 1 from cov c where c.user_id = bf.user_id and c.p_extent >= bf.first_paid_at + interval '30 days')))
        from bf),
      'm2', (select jsonb_build_object(
          'denominator', count(*) filter (where bf.first_paid_at <= now() - interval '60 days'),
          'retained', count(*) filter (where bf.first_paid_at <= now() - interval '60 days'
              and exists (select 1 from cov c where c.user_id = bf.user_id and c.p_extent >= bf.first_paid_at + interval '60 days')))
        from bf),
      'm3', (select jsonb_build_object(
          'denominator', count(*) filter (where bf.first_paid_at <= now() - interval '90 days'),
          'retained', count(*) filter (where bf.first_paid_at <= now() - interval '90 days'
              and exists (select 1 from cov c where c.user_id = bf.user_id and c.p_extent >= bf.first_paid_at + interval '90 days')))
        from bf),
      'by_plan', (select jsonb_object_agg(tier, obj) from (
          select fpt.tier,
                 jsonb_build_object(
                   'm1_denominator', count(*) filter (where bf.first_paid_at <= now() - interval '30 days'),
                   'm1_retained', count(*) filter (where bf.first_paid_at <= now() - interval '30 days' and exists (select 1 from cov c where c.user_id = bf.user_id and c.p_extent >= bf.first_paid_at + interval '30 days')),
                   'm2_denominator', count(*) filter (where bf.first_paid_at <= now() - interval '60 days'),
                   'm2_retained', count(*) filter (where bf.first_paid_at <= now() - interval '60 days' and exists (select 1 from cov c where c.user_id = bf.user_id and c.p_extent >= bf.first_paid_at + interval '60 days')),
                   'm3_denominator', count(*) filter (where bf.first_paid_at <= now() - interval '90 days'),
                   'm3_retained', count(*) filter (where bf.first_paid_at <= now() - interval '90 days' and exists (select 1 from cov c where c.user_id = bf.user_id and c.p_extent >= bf.first_paid_at + interval '90 days'))
                 ) as obj
            from bf join fpt on fpt.user_id = bf.user_id
           where fpt.tier in ('essencial','plus')
           group by fpt.tier
        ) s)
    ),

    -- E. Engagement (first-week active days) vs conversion (trial cohort)
    'engagement_vs_conversion', (
      select coalesce(jsonb_agg(jsonb_build_object('bucket', bucket, 'users', users, 'converted', converted) order by ord), '[]'::jsonb)
      from (
        select b.bucket, b.ord,
               count(tc.user_id) as users,
               count(tc.user_id) filter (where tc.converted) as converted
        from (values ('0',0),('1',1),('2',2),('3-4',3),('5-7',4)) as b(bucket, ord)
        left join tc on (
             (b.bucket = '0'   and tc.days_first_week = 0)
          or (b.bucket = '1'   and tc.days_first_week = 1)
          or (b.bucket = '2'   and tc.days_first_week = 2)
          or (b.bucket = '3-4' and tc.days_first_week between 3 and 4)
          or (b.bucket = '5-7' and tc.days_first_week between 5 and 7))
        group by b.bucket, b.ord
      ) g
    ),

    -- F. Initial streak vs conversion (trial cohort)
    'streak_vs_conversion', (
      select coalesce(jsonb_agg(jsonb_build_object('bucket', bucket, 'users', users, 'converted', converted) order by ord), '[]'::jsonb)
      from (
        select b.bucket, b.ord,
               count(tc.user_id) as users,
               count(tc.user_id) filter (where tc.converted) as converted
        from (values ('0',0),('1',1),('2',2),('3',3),('4-6',4),('7+',5)) as b(bucket, ord)
        left join (
          select tc.user_id, tc.converted, coalesce(us.streak, 0) as streak
            from tc left join user_streak us on us.user_id = tc.user_id
        ) tc on (
             (b.bucket = '0'   and tc.streak = 0)
          or (b.bucket = '1'   and tc.streak = 1)
          or (b.bucket = '2'   and tc.streak = 2)
          or (b.bucket = '3'   and tc.streak = 3)
          or (b.bucket = '4-6' and tc.streak between 4 and 6)
          or (b.bucket = '7+'  and tc.streak >= 7))
        group by b.bucket, b.ord
      ) g
    )
  );
$$;

revoke all on function public.admin_get_retention_overview_v1(timestamptz, timestamptz) from public;
revoke all on function public.admin_get_retention_overview_v1(timestamptz, timestamptz) from anon;
revoke all on function public.admin_get_retention_overview_v1(timestamptz, timestamptz) from authenticated;
grant execute on function public.admin_get_retention_overview_v1(timestamptz, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- RPC 2: weekly product-retention cohorts by signup week (Mon-Sun, SP).
-- Each cohort reports D1/D7/D30 as {retained, users} ONLY when the whole cohort
-- has matured for that horizon; immature horizons return null -> UI shows "—".
-- p_weeks bounds how many recent weeks are returned.
-- ---------------------------------------------------------------------------
create or replace function public.admin_get_retention_cohorts_v1(p_weeks integer default 12)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with tz as (select 'America/Sao_Paulo'::text as zone),
  nowd as (select (now() at time zone (select zone from tz))::date as today_sp),
  ad as (select distinct user_id, day from public.admin_retention_activity_days() where day is not null),
  u as (
    select au.id as user_id, (au.created_at at time zone (select zone from tz))::date as signup_sp
      from auth.users au
  ),
  cohort as (
    select user_id, signup_sp, (date_trunc('week', signup_sp::timestamp))::date as wk from u
  ),
  per_week as (
    select c.wk,
           count(*) as users,
           count(*) filter (where exists (select 1 from ad where ad.user_id = c.user_id and ad.day = c.signup_sp + 1)) as d1_ret,
           count(*) filter (where exists (select 1 from ad where ad.user_id = c.user_id and ad.day = c.signup_sp + 7)) as d7_ret,
           count(*) filter (where exists (select 1 from ad where ad.user_id = c.user_id and ad.day = c.signup_sp + 30)) as d30_ret
      from cohort c
     group by c.wk
  )
  select coalesce(jsonb_agg(crow order by wk desc), '[]'::jsonb) from (
    select jsonb_build_object(
             'week_start', pw.wk,
             'week_end', pw.wk + 6,
             'users', pw.users,
             'd1',  case when (select today_sp from nowd) >= pw.wk + 6 + 1  then jsonb_build_object('retained', pw.d1_ret,  'users', pw.users) else null end,
             'd7',  case when (select today_sp from nowd) >= pw.wk + 6 + 7  then jsonb_build_object('retained', pw.d7_ret,  'users', pw.users) else null end,
             'd30', case when (select today_sp from nowd) >= pw.wk + 6 + 30 then jsonb_build_object('retained', pw.d30_ret, 'users', pw.users) else null end
           ) as crow,
           pw.wk as wk
      from per_week pw
     where pw.wk >= (select today_sp from nowd) - (p_weeks * 7)
  ) s;
$$;

revoke all on function public.admin_get_retention_cohorts_v1(integer) from public;
revoke all on function public.admin_get_retention_cohorts_v1(integer) from anon;
revoke all on function public.admin_get_retention_cohorts_v1(integer) from authenticated;
grant execute on function public.admin_get_retention_cohorts_v1(integer) to service_role;

-- ---------------------------------------------------------------------------
-- RPC 3: monthly subscription-retention cohorts by FIRST PAYMENT month.
-- Cohort = users whose first_paid_at falls in a given SP month. M1/M2/M3 use the
-- persisted paid-coverage extent (covered at first_paid_at + 30/60/90 days).
-- Immature cohorts return null for that horizon -> UI shows "—".
-- ---------------------------------------------------------------------------
create or replace function public.admin_get_subscription_cohorts_v1(p_months integer default 6)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with tz as (select 'America/Sao_Paulo'::text as zone),
  cov as (select * from public.admin_retention_paid_coverage()),
  bf as (
    select user_id, first_paid_at,
           (date_trunc('month', (first_paid_at at time zone (select zone from tz))::date::timestamp))::date as mo
      from public.user_billing_facts where first_paid_at is not null
  ),
  per_month as (
    select bf.mo,
           count(*) as payers,
           count(*) filter (where exists (select 1 from cov c where c.user_id = bf.user_id and c.p_extent >= bf.first_paid_at + interval '30 days')) as m1_ret,
           count(*) filter (where exists (select 1 from cov c where c.user_id = bf.user_id and c.p_extent >= bf.first_paid_at + interval '60 days')) as m2_ret,
           count(*) filter (where exists (select 1 from cov c where c.user_id = bf.user_id and c.p_extent >= bf.first_paid_at + interval '90 days')) as m3_ret
      from bf group by bf.mo
  )
  select coalesce(jsonb_agg(crow order by mo desc), '[]'::jsonb) from (
    select jsonb_build_object(
             'month', pm.mo,
             'payers', pm.payers,
             'm1', case when now() >= (pm.mo + interval '1 month') + interval '30 days' then jsonb_build_object('retained', pm.m1_ret, 'payers', pm.payers) else null end,
             'm2', case when now() >= (pm.mo + interval '1 month') + interval '60 days' then jsonb_build_object('retained', pm.m2_ret, 'payers', pm.payers) else null end,
             'm3', case when now() >= (pm.mo + interval '1 month') + interval '90 days' then jsonb_build_object('retained', pm.m3_ret, 'payers', pm.payers) else null end
           ) as crow,
           pm.mo as mo
      from per_month pm
     where pm.mo >= (date_trunc('month', now() at time zone (select zone from tz)) - (p_months || ' months')::interval)::date
  ) s;
$$;

revoke all on function public.admin_get_subscription_cohorts_v1(integer) from public;
revoke all on function public.admin_get_subscription_cohorts_v1(integer) from anon;
revoke all on function public.admin_get_subscription_cohorts_v1(integer) from authenticated;
grant execute on function public.admin_get_subscription_cohorts_v1(integer) to service_role;
