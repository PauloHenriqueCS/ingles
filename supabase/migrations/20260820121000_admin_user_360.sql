-- ============================================================================
-- Admin: per-user 360º consolidated aggregation (read-only).
-- ----------------------------------------------------------------------------
-- Returns ONE jsonb payload with the consolidated numbers the admin user-detail
-- screen shows, aggregated server-side (never N+1 in the browser). Only counts
-- and small derived figures are returned here — no raw personal content, no PII
-- beyond what the caller already resolved via admin_list_users_v1. Read-only,
-- SECURITY DEFINER so the service-role admin client reads through it.
--
-- Honesty notes baked into the shape:
--   * "Dias logados" (login-day history) is NOT stored anywhere in public.* —
--     only auth.users.last_sign_in_at (a single value). We therefore expose
--     "active days" (derived from activity events), never a fabricated login
--     count. The UI labels this explicitly.
--   * current_streak/longest_streak are computed by gaps-and-islands over the
--     UNION of real activity dates across every modality (an "active-days"
--     streak), so they are correct by construction. current_streak counts the
--     consecutive run ending today or yesterday (0 if the last active day is
--     older than yesterday).
-- ============================================================================

create or replace function public.admin_get_user_360_v1(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with tz as (select 'America/Sao_Paulo'::text as zone),
  today as (select (now() at time zone (select zone from tz))::date as d),
  -- Union of every day this user did something, one date per modality source.
  activity_dates as (
    select entry_date as day from writing_entries where user_id = p_user_id and entry_date is not null
    union
    select entry_date from english_reviews where user_id = p_user_id and entry_date is not null
    union
    select (created_at at time zone (select zone from tz))::date from english_reviews where user_id = p_user_id
    union
    select practice_date from pronunciation_training_sessions where user_id = p_user_id and practice_date is not null
    union
    select (created_at at time zone (select zone from tz))::date from pronunciation_assessments where user_id = p_user_id
    union
    select activity_date from user_listening_shared_progress where user_id = p_user_id and activity_date is not null
    union
    select activity_date from review_item_attempts where user_id = p_user_id and activity_date is not null
    union
    select session_date from conversation_sessions where user_id = p_user_id and session_date is not null
    union
    select usage_date from usage_daily where user_id = p_user_id and usage_date is not null
  ),
  ad as (select distinct day from activity_dates where day is not null),
  islands as (
    select count(*) as len, min(day) as s, max(day) as e
    from (select day, (day - (row_number() over (order by day))::int) as grp from ad) x
    group by grp
  )
  select jsonb_build_object(
    'activity', jsonb_build_object(
      'active_days_total', (select count(*) from ad),
      'active_days_7d',  (select count(*) from ad where day > (select d from today) - 7),
      'active_days_30d', (select count(*) from ad where day > (select d from today) - 30),
      'first_activity_day', (select min(day) from ad),
      'last_activity_day',  (select max(day) from ad),
      'current_streak', coalesce((
        select len from islands
        where e >= (select d from today) - 1
        order by e desc limit 1), 0),
      'longest_streak', coalesce((select max(len) from islands), 0),
      'login_days_supported', false  -- schema stores no per-day login history
    ),
    'calendar', jsonb_build_object(
      'writing_days', (select count(distinct wday) from (
        select entry_date as wday from writing_entries where user_id=p_user_id and entry_date is not null
        union select entry_date from english_reviews where user_id=p_user_id and entry_date is not null) w),
      'pronunciation_days', (select count(distinct practice_date) from pronunciation_training_sessions where user_id=p_user_id and practice_date is not null),
      'listening_days', (select count(distinct activity_date) from user_listening_shared_progress where user_id=p_user_id and activity_date is not null),
      'conversation_days', (select count(distinct session_date) from conversation_sessions where user_id=p_user_id and session_date is not null),
      'review_days', (select count(distinct activity_date) from review_item_attempts where user_id=p_user_id and activity_date is not null)
    ),
    'placement', (
      select case when a.id is null then jsonb_build_object('has_attempt', false)
        else jsonb_build_object(
          'has_attempt', true,
          'attempts_count', (select count(*) from placement_attempts where user_id=p_user_id),
          'status', a.status,
          'raw_result_level_code', a.raw_result_level_code,
          'effective_level_code', a.effective_level_code,
          'started_at', a.started_at,
          'completed_at', a.completed_at
        ) end
      from (select * from placement_attempts where user_id=p_user_id order by started_at desc nulls last limit 1) a
      right join (select 1) _ on true
    ),
    'curriculum', (
      select jsonb_build_object(
        'current_level_code', p.current_level_code,
        'status', p.status,
        'started_at', p.started_at,
        'subtopics_completed', (select count(*) from user_subtopic_completion where user_id=p_user_id),
        'modality_progress_rows', (select count(*) from user_subtopic_modality_progress where user_id=p_user_id),
        'skill_profiles', coalesce((
          select jsonb_agg(jsonb_build_object('skill', skill, 'cefr_level', cefr_level, 'assessment_status', assessment_status)
                 order by skill)
          from learner_skill_profiles where user_id=p_user_id), '[]'::jsonb)
      )
      from (select * from user_curriculum_progress where user_id=p_user_id order by updated_at desc limit 1) p
      right join (select 1) _ on true
    ),
    'writing', jsonb_build_object(
      'reviews_total', (select count(*) from english_reviews where user_id=p_user_id),
      'reviews_today', (select count(*) from english_reviews where user_id=p_user_id
                        and coalesce(entry_date, (created_at at time zone (select zone from tz))::date) = (select d from today)),
      'reviews_last_at', (select max(created_at) from english_reviews where user_id=p_user_id),
      'reviews_avg_score', (select round(avg(score)::numeric, 1) from english_reviews where user_id=p_user_id and score is not null),
      'entries_total', (select count(*) from writing_entries where user_id=p_user_id),
      'entries_reviewed', (select count(*) from writing_entries where user_id=p_user_id and status='reviewed'),
      'themes_generated', (select count(*) from generated_themes where user_id=p_user_id),
      'rewrite_attempts', (select count(*) from writing_rewrite_attempts where user_id=p_user_id),
      'rewrite_evaluations', (select count(*) from writing_rewrite_evaluations where user_id=p_user_id),
      'learning_memory', (select case when m.id is null then null else jsonb_build_object(
          'current_level', m.current_level, 'total_reviews', m.total_reviews,
          'practiced_days', m.practiced_days, 'current_streak_writing', m.current_streak,
          'last_review_at', m.last_review_at) end
        from (select * from english_learning_memory where user_id=p_user_id order by updated_at desc limit 1) m
        right join (select 1) _ on true)
    ),
    'pronunciation', jsonb_build_object(
      'training_sessions_total', (select count(*) from pronunciation_training_sessions where user_id=p_user_id),
      'training_completed', (select count(*) from pronunciation_training_sessions where user_id=p_user_id and completed_at is not null),
      'training_last_date', (select max(practice_date) from pronunciation_training_sessions where user_id=p_user_id),
      'assessments_total', (select count(*) from pronunciation_assessments where user_id=p_user_id),
      'assessments_avg_score', (select round(avg(pronunciation_score)::numeric,1) from pronunciation_assessments where user_id=p_user_id and pronunciation_score is not null),
      'word_attempts_rows', (select count(*) from pronunciation_word_attempts where user_id=p_user_id),
      'shared_content_used', (select count(*) from user_shared_content_usage where user_id=p_user_id and modality='pronunciation')
    ),
    'listening', jsonb_build_object(
      'shared_started', (select count(*) from user_listening_shared_progress where user_id=p_user_id),
      'shared_completed', (select count(*) from user_listening_shared_progress where user_id=p_user_id and completed=true),
      'shared_last_at', (select max(coalesce(completed_at, updated_at, created_at)) from user_listening_shared_progress where user_id=p_user_id),
      'shared_content_used', (select count(*) from user_shared_content_usage where user_id=p_user_id and modality='listening'),
      'legacy_progress_rows', (select count(*) from user_listening_progress where user_id=p_user_id),
      'legacy_results', (select count(*) from user_listening_results where user_id=p_user_id),
      'legacy_avg_score', (select round(avg(performance_score)::numeric,1) from user_listening_results where user_id=p_user_id and performance_score is not null)
    ),
    'conversation', jsonb_build_object(
      'sessions_total', (select count(*) from conversation_sessions where user_id=p_user_id),
      'seconds_used_total', (select coalesce(sum(duration_sec),0) from conversation_sessions where user_id=p_user_id),
      'last_session_date', (select max(session_date) from conversation_sessions where user_id=p_user_id),
      'credits_total_seconds', (select coalesce(sum(total_seconds),0) from user_conversation_credits where user_id=p_user_id),
      'credits_remaining_seconds', (select coalesce(sum(remaining_seconds),0) from user_conversation_credits where user_id=p_user_id)
    ),
    'reviews', jsonb_build_object(
      'groups_total', (select count(*) from review_groups where user_id=p_user_id),
      'items_total', (select count(*) from review_group_items where user_id=p_user_id),
      'items_pending', (select count(*) from review_group_items where user_id=p_user_id and status='pending'),
      'items_mastered', (select count(*) from review_group_items where user_id=p_user_id and (status='mastered' or mastered_at is not null)),
      'attempts_total', (select count(*) from review_item_attempts where user_id=p_user_id),
      'attempts_passed', (select count(*) from review_item_attempts where user_id=p_user_id and passed=true),
      'last_attempt_date', (select max(activity_date) from review_item_attempts where user_id=p_user_id)
    ),
    'generated_at', now()
  );
$$;

grant execute on function public.admin_get_user_360_v1(uuid) to service_role;
