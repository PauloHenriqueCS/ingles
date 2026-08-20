-- ============================================================================
-- Admin: observabilidade do cache de conteúdo compartilhado (Pronúncia/Escrita)
-- ----------------------------------------------------------------------------
-- The learner app (repo `ingles`) generalized the Listening shared-story cache
-- into a single library table `public.shared_content_items`, discriminated by
-- `modality` ('pronunciation' | 'writing'), with a per-user consumption ledger
-- `public.user_shared_content_usage` (one row per (user_id, shared_item_id),
-- UNIQUE). There is NO reuse/hit counter column anywhere — every "distinct
-- users" / "reuse" figure the admin shows is DERIVED here, server-side, from
-- the ledger. These functions are read-only aggregations, SECURITY DEFINER so
-- the admin service-role client reads through them exactly like the existing
-- admin_*_v1 reporting RPCs. No pedagogical/commercial rule is touched.
--
-- Honest-metric notes baked into the shapes below:
--   * "reuse_events" = total_usages - items_used_count. Each consumption beyond
--     the first per item is a generation the cache avoided. It is a DERIVED
--     proxy, not a stored hit-count; labelled as such in the UI.
--   * audio_* figures are only meaningful for modality='pronunciation'
--     (writing has no audio; its rows stay audio_status='none').
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Overview KPIs for one modality (single row).
-- ----------------------------------------------------------------------------
create or replace function public.admin_shared_content_overview_v1(p_modality text)
returns table (
  total_items              integer,
  ready_count              integer,
  generating_count         integer,
  failed_count             integer,
  audio_ready_count        integer,
  audio_pending_count      integer,
  audio_failed_count       integer,
  audio_none_count         integer,
  ready_without_audio_count integer,
  generated_today          integer,
  distinct_users           integer,
  total_usages             integer,
  items_used_count         integer,
  items_never_used_count   integer,
  reuse_events             integer,
  distinct_levels          integer,
  distinct_subtopics       integer,
  last_created_at          timestamptz,
  by_status                jsonb,
  by_audio_status          jsonb,
  by_level                 jsonb,
  checked_at               timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with items as (
    select * from public.shared_content_items where modality = p_modality
  ),
  usage as (
    select shared_item_id, user_id
    from public.user_shared_content_usage
    where modality = p_modality
  ),
  usage_agg as (
    select
      count(*)::int                          as total_usages,
      count(distinct user_id)::int           as distinct_users,
      count(distinct shared_item_id)::int    as items_used_count
    from usage
  )
  select
    (select count(*) from items)::int,
    (select count(*) from items where status = 'ready')::int,
    (select count(*) from items where status = 'generating')::int,
    (select count(*) from items where status = 'failed')::int,
    (select count(*) from items where audio_status = 'ready')::int,
    (select count(*) from items where audio_status = 'pending')::int,
    (select count(*) from items where audio_status = 'failed')::int,
    (select count(*) from items where audio_status = 'none')::int,
    -- pronunciation content that is "ready" but is still missing the reference
    -- audio it is supposed to carry (a real "sem dependências necessárias" case)
    (select count(*) from items
       where p_modality = 'pronunciation' and status = 'ready' and audio_status <> 'ready')::int,
    (select count(*) from items
       where (created_at at time zone 'America/Sao_Paulo')::date
             = (now() at time zone 'America/Sao_Paulo')::date)::int,
    (select distinct_users from usage_agg),
    (select total_usages from usage_agg),
    (select items_used_count from usage_agg),
    ((select count(*) from items)::int - (select items_used_count from usage_agg)),
    greatest((select total_usages from usage_agg) - (select items_used_count from usage_agg), 0),
    (select count(distinct level_code) from items)::int,
    (select count(distinct subtopic_key) from items)::int,
    (select max(created_at) from items),
    (select coalesce(jsonb_object_agg(status, c), '{}'::jsonb)
       from (select status, count(*) c from items group by status) s),
    (select coalesce(jsonb_object_agg(audio_status, c), '{}'::jsonb)
       from (select audio_status, count(*) c from items group by audio_status) a),
    (select coalesce(jsonb_object_agg(level_code, c), '{}'::jsonb)
       from (select coalesce(nullif(level_code, ''), '(sem nível)') level_code, count(*) c
             from items group by 1) l),
    now();
$$;

-- ----------------------------------------------------------------------------
-- Paginated, filterable, sortable listing of cached items for one modality,
-- with per-item DERIVED usage figures. total_count is embedded on every row
-- (same convention as admin_list_users_v1) so the caller paginates without a
-- second count query.
-- ----------------------------------------------------------------------------
create or replace function public.admin_list_shared_content_v1(
  p_modality     text,
  p_page         integer default 1,
  p_page_size    integer default 25,
  p_status       text default null,
  p_level        text default null,
  p_subtopic     text default null,
  p_audio_status text default null,
  p_never_used   boolean default null,
  p_search       text default null,
  p_order_by     text default 'created_at',
  p_order_dir    text default 'desc'
)
returns table (
  total_count       bigint,
  id                uuid,
  modality          text,
  learning_language text,
  interface_language text,
  curriculum_version_id uuid,
  subtopic_key      text,
  level_code        text,
  exercise_type     text,
  template_key      text,
  prompt_version    integer,
  slot              smallint,
  status            text,
  audio_status      text,
  audio_path        text,
  audio_voice       text,
  audio_locale      text,
  generator_model   text,
  error_message     text,
  created_at        timestamptz,
  updated_at        timestamptz,
  users_count       bigint,
  last_used_at      timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_offset int := greatest(p_page - 1, 0) * greatest(p_page_size, 1);
  v_limit  int := least(greatest(p_page_size, 1), 200);
  v_order_col text;
  v_order_dir text := case when lower(coalesce(p_order_dir, 'desc')) = 'asc' then 'asc' else 'desc' end;
begin
  v_order_col := case lower(coalesce(p_order_by, 'created_at'))
    when 'created_at'  then 'i.created_at'
    when 'updated_at'  then 'i.updated_at'
    when 'users_count' then 'users_count'
    when 'level_code'  then 'i.level_code'
    when 'status'      then 'i.status'
    else 'i.created_at'
  end;

  return query execute format($q$
    with u as (
      select shared_item_id,
             count(distinct user_id) as users_count,
             max(created_at)         as last_used_at
      from public.user_shared_content_usage
      where modality = %L
      group by shared_item_id
    ),
    filtered as (
      select i.*, coalesce(u.users_count, 0) as users_count, u.last_used_at
      from public.shared_content_items i
      left join u on u.shared_item_id = i.id
      where i.modality = %L
        and (%L::text is null or i.status = %L)
        and (%L::text is null or i.level_code = %L)
        and (%L::text is null or i.subtopic_key = %L)
        and (%L::text is null or i.audio_status = %L)
        and (%L::boolean is null
             or (%L::boolean = true  and u.shared_item_id is null)
             or (%L::boolean = false and u.shared_item_id is not null))
        and (%L::text is null
             or i.id::text = %L
             or i.subtopic_key ilike '%%' || %L || '%%'
             or i.level_code  ilike '%%' || %L || '%%'
             or i.template_key ilike '%%' || %L || '%%'
             or i.exercise_type ilike '%%' || %L || '%%')
    )
    select count(*) over()::bigint as total_count,
           id, modality, learning_language, interface_language, curriculum_version_id,
           subtopic_key, level_code, exercise_type, template_key, prompt_version, slot,
           status, audio_status, audio_path, audio_voice, audio_locale, generator_model,
           error_message, created_at, updated_at, users_count, last_used_at
    from filtered
    order by %s %s nulls last, id
    limit %s offset %s
  $q$,
    p_modality, p_modality,
    p_status, p_status,
    p_level, p_level,
    p_subtopic, p_subtopic,
    p_audio_status, p_audio_status,
    p_never_used, p_never_used, p_never_used,
    p_search, p_search, p_search, p_search, p_search, p_search,
    v_order_col, v_order_dir, v_limit, v_offset
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- Full operational detail for a single cached item (for the detail modal),
-- including the content jsonb and derived usage figures. The caller decides
-- how much of `content` to render (cards never dump it).
-- ----------------------------------------------------------------------------
create or replace function public.admin_get_shared_content_detail_v1(p_id uuid)
returns table (
  id                uuid,
  modality          text,
  learning_language text,
  interface_language text,
  curriculum_version_id uuid,
  subtopic_key      text,
  level_code        text,
  exercise_type     text,
  template_key      text,
  prompt_version    integer,
  slot              smallint,
  status            text,
  audio_status      text,
  audio_path        text,
  audio_mime_type   text,
  audio_voice       text,
  audio_locale      text,
  generator_model   text,
  error_message     text,
  lock_expires_at   timestamptz,
  audio_lock_expires_at timestamptz,
  created_at        timestamptz,
  updated_at        timestamptz,
  content           jsonb,
  users_count       bigint,
  first_used_at     timestamptz,
  last_used_at      timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    i.id, i.modality, i.learning_language, i.interface_language, i.curriculum_version_id,
    i.subtopic_key, i.level_code, i.exercise_type, i.template_key, i.prompt_version, i.slot,
    i.status, i.audio_status, i.audio_path, i.audio_mime_type, i.audio_voice, i.audio_locale,
    i.generator_model, i.error_message, i.lock_expires_at, i.audio_lock_expires_at,
    i.created_at, i.updated_at, i.content,
    (select count(distinct u.user_id) from public.user_shared_content_usage u
       where u.shared_item_id = i.id)::bigint,
    (select min(u.created_at) from public.user_shared_content_usage u where u.shared_item_id = i.id),
    (select max(u.created_at) from public.user_shared_content_usage u where u.shared_item_id = i.id)
  from public.shared_content_items i
  where i.id = p_id;
$$;

-- ----------------------------------------------------------------------------
-- Coverage: which (level_code, subtopic_key) cuts already HAVE cached content
-- for a modality, with ready/total and derived distinct-user reach. This is the
-- reliable "quais níveis/recortes já possuem conteúdo" side. The full "quais
-- ainda NÃO possuem" matrix would require the expected curriculum × level grid;
-- it is intentionally NOT fabricated here (see admin summary / UI note).
-- ----------------------------------------------------------------------------
create or replace function public.admin_shared_content_coverage_v1(p_modality text)
returns table (
  level_code   text,
  subtopic_key text,
  total_items  integer,
  ready_items  integer,
  failed_items integer,
  users_count  bigint,
  last_created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with items as (
    select
      id,
      coalesce(nullif(level_code, ''), '(sem nível)')     as level_code,
      coalesce(nullif(subtopic_key, ''), '(sem recorte)') as subtopic_key,
      status,
      created_at
    from public.shared_content_items
    where modality = p_modality
  ),
  usage as (
    select shared_item_id, user_id
    from public.user_shared_content_usage
    where modality = p_modality
  )
  select
    i.level_code,
    i.subtopic_key,
    count(distinct i.id)::int                                    as total_items,
    count(distinct i.id) filter (where i.status = 'ready')::int  as ready_items,
    count(distinct i.id) filter (where i.status = 'failed')::int as failed_items,
    count(distinct u.user_id)::bigint                            as users_count,
    max(i.created_at)                                            as last_created_at
  from items i
  left join usage u on u.shared_item_id = i.id
  group by i.level_code, i.subtopic_key
  order by i.level_code, i.subtopic_key;
$$;

grant execute on function public.admin_shared_content_overview_v1(text) to service_role;
grant execute on function public.admin_list_shared_content_v1(text, integer, integer, text, text, text, text, boolean, text, text, text) to service_role;
grant execute on function public.admin_get_shared_content_detail_v1(uuid) to service_role;
grant execute on function public.admin_shared_content_coverage_v1(text) to service_role;
