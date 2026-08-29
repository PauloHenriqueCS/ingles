-- ============================================================================
-- Admin retention v2 — REAL paid-coverage intervals (fixes the "glued periods"
-- limitation) + subscription time-series for the dashboard charts.
-- ----------------------------------------------------------------------------
-- Round 1 (migration 20260829180000) modeled paid coverage as a single extent
-- per user: p_extent = ongoing ? +inf : max(ends_at), starting at min(starts_at).
-- That treats a user who subscribed Jan, LAPSED all of Feb, and resubscribed
-- Mar as continuously covered Jan–Mar — wrong for churn / M1-M3 / cohorts.
--
-- This migration replaces that with the union of REAL coverage intervals
-- (gaps-and-islands over user_plan_assignments), so:
--   * upgrades/downgrades with no gap  -> one continuous interval (not churn)
--   * renewals (adjacent/overlapping)  -> one continuous interval
--   * a genuine lapse then resubscribe -> TWO intervals (a real gap between)
--   * transfers                        -> still excluded from churn (event-based)
-- A small GRACE (2 days) bridges only billing-boundary jitter, never a real lapse.
--
-- covered_at(user, T) := EXISTS a coverage interval [seg_start, seg_end] with
--   seg_start <= T <= seg_end. Everything downstream (active-now, churn,
--   M1/M2/M3, cohorts, the new time-series) is expressed through this, so the
--   gap is handled once, at the source.
--
-- Also adds admin_get_subscription_timeseries_v1 (new payers / cancellations
-- requested / effective churn / active-at-end per bucket) — the one series the
-- round-1 RPCs did not provide, needed for the "subscription trend" chart. All
-- functions stay SECURITY DEFINER + REVOKE public/anon/authenticated + GRANT
-- service_role (same boundary as the other admin_*_v1 RPCs).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Helper: merged REAL coverage intervals per user (one row per interval).
-- Islands = maximal runs of overlapping/adjacent commercial-subscription rows;
-- a new island starts only when a row begins more than GRACE after the furthest
-- coverage reached so far (a real lapse). seg_end = 'infinity' when open-ended.
-- ---------------------------------------------------------------------------
create or replace function public.admin_retention_paid_intervals()
returns table (user_id uuid, seg_start timestamptz, seg_end timestamptz, ongoing boolean, tier text)
language sql
stable
security definer
set search_path = public
as $$
  with paid as (
    select upa.user_id,
           upa.starts_at,
           coalesce(upa.ends_at, 'infinity'::timestamptz) as ends_at,
           (upa.status = 'active' and (upa.ends_at is null or upa.ends_at > now())) as row_ongoing,
           p.code as tier
      from public.user_plan_assignments upa
      join public.plans p on p.id = upa.plan_id
     where upa.origin = 'subscription'
       and p.code in ('essencial', 'plus')
  ),
  ordered as (
    select paid.*,
           max(ends_at) over (
             partition by user_id order by starts_at, ends_at
             rows between unbounded preceding and 1 preceding
           ) as prev_max_end
      from paid
  ),
  marked as (
    -- GRACE = 2 days: bridges renewal/plan-change boundary jitter only; a lapse
    -- of days/weeks (the bug scenario) exceeds it and opens a new island.
    select ordered.*,
           case when prev_max_end is null
                     or starts_at > prev_max_end + interval '2 days'
                then 1 else 0 end as new_island
      from ordered
  ),
  grp as (
    select marked.*,
           sum(new_island) over (
             partition by user_id order by starts_at, ends_at
             rows between unbounded preceding and current row
           ) as island
      from marked
  )
  select user_id,
         min(starts_at) as seg_start,
         max(ends_at) as seg_end,
         bool_or(row_ongoing) as ongoing,
         (array_agg(tier order by starts_at desc))[1] as tier  -- most recent tier in the run
    from grp
   group by user_id, island;
$$;

revoke all on function public.admin_retention_paid_intervals() from public;
revoke all on function public.admin_retention_paid_intervals() from anon;
revoke all on function public.admin_retention_paid_intervals() from authenticated;
grant execute on function public.admin_retention_paid_intervals() to service_role;

-- ---------------------------------------------------------------------------
-- RPC 1 (rewritten): consolidated overview — subscription/M blocks now use real
-- coverage intervals. Product-retention / trial / engagement / streak blocks are
-- unchanged from 20260829180000.
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
  ad as (select distinct user_id, day from public.admin_retention_activity_days() where day is not null),
  iv as (select * from public.admin_retention_paid_intervals()),
  bf as (
    select user_id, first_paid_at,
           (first_paid_at at time zone (select zone from tz))::date as first_paid_sp
      from public.user_billing_facts where first_paid_at is not null
  ),
  tr as (
    select user_id, min(starts_at) as trial_start,
           (min(starts_at) at time zone (select zone from tz))::date as trial_start_sp
      from public.user_plan_assignments where origin = 'trial' group by user_id
  ),
  u as (
    select au.id as user_id, au.created_at,
           (au.created_at at time zone (select zone from tz))::date as signup_sp,
           ((select today_sp from nowd) - (au.created_at at time zone (select zone from tz))::date) as age_days
      from auth.users au
  ),
  su as (select u.* from u, p where u.created_at >= p.a0 and u.created_at < p.a1),
  fw as (
    select u.user_id, count(distinct ad.day) as days_first_week
      from u left join ad on ad.user_id = u.user_id and ad.day between u.signup_sp and u.signup_sp + 6
     group by u.user_id
  ),
  fpt as (
    select distinct on (upa.user_id) upa.user_id, pl.code as tier
      from public.user_plan_assignments upa join public.plans pl on pl.id = upa.plan_id
     where upa.origin = 'subscription' and pl.code in ('essencial','plus')
     order by upa.user_id, upa.starts_at asc
  ),
  transfers as (
    select distinct app_user_id::uuid as user_id
      from public.revenuecat_webhook_events
     where event_type = 'TRANSFER' and received_at >= (select a0 from p) and received_at < (select a1 from p)
       and app_user_id ~ '^[0-9a-f-]{36}$'
  ),
  tc as (
    select tr.user_id, tr.trial_start_sp, u.signup_sp,
           coalesce(fw.days_first_week,0) as days_first_week,
           (bf.first_paid_at is not null) as converted,
           exists (select 1 from ad where ad.user_id = tr.user_id) as any_activity
      from tr join u on u.user_id = tr.user_id
      left join fw on fw.user_id = tr.user_id
      left join bf on bf.user_id = tr.user_id, p
     where tr.trial_start >= p.a0 and tr.trial_start < p.a1
  ),
  np as (
    select bf.user_id, bf.first_paid_sp,
           (bf.first_paid_sp - coalesce(tr.trial_start_sp, (select signup_sp from u u2 where u2.user_id = bf.user_id))) as days_to_pay,
           fpt.tier
      from bf left join tr on tr.user_id = bf.user_id left join fpt on fpt.user_id = bf.user_id, p
     where bf.first_paid_at >= p.a0 and bf.first_paid_at < p.a1
  ),
  fw_days as (select tc.user_id, ad.day from tc join ad on ad.user_id = tc.user_id and ad.day between tc.signup_sp and tc.signup_sp + 13),
  islands as (select user_id, (day - (row_number() over (partition by user_id order by day))::int) as grp from fw_days),
  runs as (select user_id, grp, count(*) as len from islands group by user_id, grp),
  user_streak as (select user_id, max(len) as streak from runs group by user_id),
  -- coverage snapshots via REAL intervals
  covnow as (select user_id, (array_agg(tier order by seg_end desc))[1] as tier
               from iv where seg_start <= now() and seg_end >= now() group by user_id),
  cov0 as (select user_id, (array_agg(tier order by seg_end desc))[1] as tier
             from iv where seg_start <= (select a0 from p) and seg_end >= (select a0 from p) group by user_id),
  cov1 as (select distinct user_id from iv where seg_start <= (select a1 from p) and seg_end >= (select a1 from p)),
  churned as (
    select c0.user_id, c0.tier from cov0 c0
     where c0.user_id not in (select user_id from cov1)
       and c0.user_id not in (select user_id from transfers)
  )
  select jsonb_build_object(
    'period', jsonb_build_object('started_after', (select a0 from p), 'started_before', (select a1 from p)),
    'generated_at', now(),
    'product_retention', jsonb_build_object(
      'd1', (select jsonb_build_object('denominator', count(*) filter (where age_days >= 1),
               'retained', count(*) filter (where age_days >= 1 and exists (select 1 from ad where ad.user_id = su.user_id and ad.day = su.signup_sp + 1))) from su),
      'd7', (select jsonb_build_object('denominator', count(*) filter (where age_days >= 7),
               'retained', count(*) filter (where age_days >= 7 and exists (select 1 from ad where ad.user_id = su.user_id and ad.day = su.signup_sp + 7))) from su),
      'd30', (select jsonb_build_object('denominator', count(*) filter (where age_days >= 30),
               'retained', count(*) filter (where age_days >= 30 and exists (select 1 from ad where ad.user_id = su.user_id and ad.day = su.signup_sp + 30))) from su),
      'three_plus_first_week', (select jsonb_build_object('denominator', count(*) filter (where su.age_days >= 7),
               'retained', count(*) filter (where su.age_days >= 7 and coalesce(fw.days_first_week,0) >= 3)) from su left join fw on fw.user_id = su.user_id)
    ),
    'trial_funnel', jsonb_build_object(
      'trials_started', (select count(*) from tc),
      'with_activity', (select count(*) filter (where any_activity) from tc),
      'three_plus_days', (select count(*) filter (where days_first_week >= 3) from tc),
      'converted', (select count(*) filter (where converted) from tc)
    ),
    'time_to_conversion', (select jsonb_build_object('payers', count(*),
        'median_days', percentile_cont(0.5) within group (order by days_to_pay),
        'same_day', count(*) filter (where days_to_pay <= 0),
        'within_3d', count(*) filter (where days_to_pay <= 3),
        'within_7d', count(*) filter (where days_to_pay <= 7),
        'after_7d', count(*) filter (where days_to_pay > 7)) from np),
    'subscriptions', jsonb_build_object(
      'active_now', (select count(*) from covnow),
      'active_by_plan', (select jsonb_build_object(
          'essencial', count(*) filter (where tier = 'essencial'),
          'plus', count(*) filter (where tier = 'plus')) from covnow),
      'new_payers', (select count(*) from np),
      'new_payers_by_plan', (select jsonb_build_object(
          'essencial', count(*) filter (where tier = 'essencial'),
          'plus', count(*) filter (where tier = 'plus')) from np),
      'cancellations_requested', (select count(distinct app_user_id) from public.revenuecat_webhook_events, p
          where event_type = 'CANCELLATION' and received_at >= p.a0 and received_at < p.a1),
      'churn', jsonb_build_object('base', (select count(*) from cov0), 'churned', (select count(*) from churned)),
      'churn_by_plan', (select jsonb_build_object(
          'essencial', count(*) filter (where tier = 'essencial'),
          'plus', count(*) filter (where tier = 'plus')) from churned)
    ),
    'subscription_retention', jsonb_build_object(
      'm1', (select jsonb_build_object('denominator', count(*) filter (where bf.first_paid_at <= now() - interval '30 days'),
          'retained', count(*) filter (where bf.first_paid_at <= now() - interval '30 days'
              and exists (select 1 from iv where iv.user_id = bf.user_id and iv.seg_start <= bf.first_paid_at + interval '30 days' and iv.seg_end >= bf.first_paid_at + interval '30 days'))) from bf),
      'm2', (select jsonb_build_object('denominator', count(*) filter (where bf.first_paid_at <= now() - interval '60 days'),
          'retained', count(*) filter (where bf.first_paid_at <= now() - interval '60 days'
              and exists (select 1 from iv where iv.user_id = bf.user_id and iv.seg_start <= bf.first_paid_at + interval '60 days' and iv.seg_end >= bf.first_paid_at + interval '60 days'))) from bf),
      'm3', (select jsonb_build_object('denominator', count(*) filter (where bf.first_paid_at <= now() - interval '90 days'),
          'retained', count(*) filter (where bf.first_paid_at <= now() - interval '90 days'
              and exists (select 1 from iv where iv.user_id = bf.user_id and iv.seg_start <= bf.first_paid_at + interval '90 days' and iv.seg_end >= bf.first_paid_at + interval '90 days'))) from bf),
      'by_plan', (select jsonb_object_agg(tier, obj) from (
          select fpt.tier, jsonb_build_object(
              'm1_denominator', count(*) filter (where bf.first_paid_at <= now() - interval '30 days'),
              'm1_retained', count(*) filter (where bf.first_paid_at <= now() - interval '30 days' and exists (select 1 from iv where iv.user_id=bf.user_id and iv.seg_start<=bf.first_paid_at+interval '30 days' and iv.seg_end>=bf.first_paid_at+interval '30 days')),
              'm2_denominator', count(*) filter (where bf.first_paid_at <= now() - interval '60 days'),
              'm2_retained', count(*) filter (where bf.first_paid_at <= now() - interval '60 days' and exists (select 1 from iv where iv.user_id=bf.user_id and iv.seg_start<=bf.first_paid_at+interval '60 days' and iv.seg_end>=bf.first_paid_at+interval '60 days')),
              'm3_denominator', count(*) filter (where bf.first_paid_at <= now() - interval '90 days'),
              'm3_retained', count(*) filter (where bf.first_paid_at <= now() - interval '90 days' and exists (select 1 from iv where iv.user_id=bf.user_id and iv.seg_start<=bf.first_paid_at+interval '90 days' and iv.seg_end>=bf.first_paid_at+interval '90 days'))
            ) as obj
            from bf join fpt on fpt.user_id = bf.user_id where fpt.tier in ('essencial','plus') group by fpt.tier) s)
    ),
    'engagement_vs_conversion', (select coalesce(jsonb_agg(jsonb_build_object('bucket', bucket, 'users', users, 'converted', converted) order by ord), '[]'::jsonb)
      from (select b.bucket, b.ord, count(tc.user_id) as users, count(tc.user_id) filter (where tc.converted) as converted
        from (values ('0',0),('1',1),('2',2),('3-4',3),('5-7',4)) as b(bucket, ord)
        left join tc on ((b.bucket='0' and tc.days_first_week=0) or (b.bucket='1' and tc.days_first_week=1) or (b.bucket='2' and tc.days_first_week=2) or (b.bucket='3-4' and tc.days_first_week between 3 and 4) or (b.bucket='5-7' and tc.days_first_week between 5 and 7))
        group by b.bucket, b.ord) g),
    'streak_vs_conversion', (select coalesce(jsonb_agg(jsonb_build_object('bucket', bucket, 'users', users, 'converted', converted) order by ord), '[]'::jsonb)
      from (select b.bucket, b.ord, count(tc.user_id) as users, count(tc.user_id) filter (where tc.converted) as converted
        from (values ('0',0),('1',1),('2',2),('3',3),('4-6',4),('7+',5)) as b(bucket, ord)
        left join (select tc.user_id, tc.converted, coalesce(us.streak,0) as streak from tc left join user_streak us on us.user_id = tc.user_id) tc
          on ((b.bucket='0' and tc.streak=0) or (b.bucket='1' and tc.streak=1) or (b.bucket='2' and tc.streak=2) or (b.bucket='3' and tc.streak=3) or (b.bucket='4-6' and tc.streak between 4 and 6) or (b.bucket='7+' and tc.streak>=7))
        group by b.bucket, b.ord) g)
  );
$$;

revoke all on function public.admin_get_retention_overview_v1(timestamptz, timestamptz) from public;
revoke all on function public.admin_get_retention_overview_v1(timestamptz, timestamptz) from anon;
revoke all on function public.admin_get_retention_overview_v1(timestamptz, timestamptz) from authenticated;
grant execute on function public.admin_get_retention_overview_v1(timestamptz, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- RPC 3 (rewritten): monthly subscription cohorts — M1/M2/M3 now use real
-- coverage intervals (covered_at first_paid + 30/60/90).
-- ---------------------------------------------------------------------------
create or replace function public.admin_get_subscription_cohorts_v1(p_months integer default 6)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with tz as (select 'America/Sao_Paulo'::text as zone),
  iv as (select * from public.admin_retention_paid_intervals()),
  bf as (select user_id, first_paid_at,
           (date_trunc('month', (first_paid_at at time zone (select zone from tz))::date::timestamp))::date as mo
      from public.user_billing_facts where first_paid_at is not null),
  per_month as (
    select bf.mo, count(*) as payers,
       count(*) filter (where exists (select 1 from iv where iv.user_id=bf.user_id and iv.seg_start<=bf.first_paid_at+interval '30 days' and iv.seg_end>=bf.first_paid_at+interval '30 days')) as m1_ret,
       count(*) filter (where exists (select 1 from iv where iv.user_id=bf.user_id and iv.seg_start<=bf.first_paid_at+interval '60 days' and iv.seg_end>=bf.first_paid_at+interval '60 days')) as m2_ret,
       count(*) filter (where exists (select 1 from iv where iv.user_id=bf.user_id and iv.seg_start<=bf.first_paid_at+interval '90 days' and iv.seg_end>=bf.first_paid_at+interval '90 days')) as m3_ret
      from bf group by bf.mo)
  select coalesce(jsonb_agg(crow order by mo desc), '[]'::jsonb) from (
    select jsonb_build_object('month', pm.mo, 'payers', pm.payers,
        'm1', case when now() >= (pm.mo + interval '1 month') + interval '30 days' then jsonb_build_object('retained', pm.m1_ret, 'payers', pm.payers) else null end,
        'm2', case when now() >= (pm.mo + interval '1 month') + interval '60 days' then jsonb_build_object('retained', pm.m2_ret, 'payers', pm.payers) else null end,
        'm3', case when now() >= (pm.mo + interval '1 month') + interval '90 days' then jsonb_build_object('retained', pm.m3_ret, 'payers', pm.payers) else null end
      ) as crow, pm.mo as mo
      from per_month pm
     where pm.mo >= (date_trunc('month', now() at time zone (select zone from tz)) - (p_months || ' months')::interval)::date) s;
$$;

revoke all on function public.admin_get_subscription_cohorts_v1(integer) from public;
revoke all on function public.admin_get_subscription_cohorts_v1(integer) from anon;
revoke all on function public.admin_get_subscription_cohorts_v1(integer) from authenticated;
grant execute on function public.admin_get_subscription_cohorts_v1(integer) to service_role;

-- ---------------------------------------------------------------------------
-- RPC 4 (new): subscription time-series over the selected period. One bucket per
-- day/week/month with new payers, cancellations requested, effective churn
-- (interval-based, transfer-excluded) and active-at-bucket-end. Needed for the
-- "subscription trend" chart — the round-1 RPCs only returned single-period
-- totals, so a trend could not be drawn without this server-side aggregation.
-- ---------------------------------------------------------------------------
create or replace function public.admin_get_subscription_timeseries_v1(
  p_started_after  timestamptz,
  p_started_before timestamptz,
  p_granularity    text default 'week'
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with tz as (select 'America/Sao_Paulo'::text as zone),
  p as (select p_started_after as a0, coalesce(p_started_before, now()) as a1),
  gran as (select case when p_granularity in ('day','week','month') then p_granularity else 'day' end as g),
  step as (select (case (select g from gran) when 'day' then interval '1 day' when 'week' then interval '1 week' else interval '1 month' end) as s),
  iv as (select * from public.admin_retention_paid_intervals()),
  bf as (select user_id, first_paid_at from public.user_billing_facts where first_paid_at is not null),
  -- align first bucket to a natural SP boundary, then step across the period
  starts as (
    select generate_series(
      ((date_trunc((select g from gran), (select a0 from p) at time zone (select zone from tz))) at time zone (select zone from tz)),
      (select a1 from p) - interval '1 microsecond',
      (select s from step)
    ) as bstart
  ),
  buckets as (
    select greatest(bstart, (select a0 from p)) as b0,
           least(bstart + (select s from step), (select a1 from p)) as b1
      from starts
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'bucket_start', b0,
      'new_payers', (select count(*) from bf where bf.first_paid_at >= bk.b0 and bf.first_paid_at < bk.b1),
      'cancellations_requested', (select count(distinct app_user_id) from public.revenuecat_webhook_events
          where event_type='CANCELLATION' and received_at >= bk.b0 and received_at < bk.b1),
      'churn_effective', (
        select count(*) from (
          select user_id from iv where seg_start <= bk.b0 and seg_end >= bk.b0
          except
          select user_id from iv where seg_start <= bk.b1 and seg_end >= bk.b1
        ) lost
        where lost.user_id not in (
          select app_user_id::uuid from public.revenuecat_webhook_events
           where event_type='TRANSFER' and received_at >= bk.b0 and received_at < bk.b1 and app_user_id ~ '^[0-9a-f-]{36}$'
        )),
      'active_end', (select count(distinct user_id) from iv where seg_start <= bk.b1 and seg_end >= bk.b1)
    ) order by b0), '[]'::jsonb)
  from buckets bk;
$$;

revoke all on function public.admin_get_subscription_timeseries_v1(timestamptz, timestamptz, text) from public;
revoke all on function public.admin_get_subscription_timeseries_v1(timestamptz, timestamptz, text) from anon;
revoke all on function public.admin_get_subscription_timeseries_v1(timestamptz, timestamptz, text) from authenticated;
grant execute on function public.admin_get_subscription_timeseries_v1(timestamptz, timestamptz, text) to service_role;

-- Round-1 extent helper is superseded by admin_retention_paid_intervals().
-- Safe to drop: the string-body SQL functions above do not hard-depend on it.
drop function if exists public.admin_retention_paid_coverage();
