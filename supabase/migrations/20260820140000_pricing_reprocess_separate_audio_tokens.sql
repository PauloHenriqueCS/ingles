-- ============================================================================
-- Pricing engine fix: expose realtime AUDIO tokens separately (+ pronunciation
-- audio_seconds) to the cost reprocessor.
-- ----------------------------------------------------------------------------
-- The previous admin_fetch_events_for_reprocessing_v1 COLLAPSED audio tokens
-- into the text-token buckets:
--   tokens_input  = input_text_tokens  + input_audio_tokens
--   tokens_output = output_text_tokens + output_audio_tokens
--   tokens_cached = cached_input_tokens + cached_input_audio_tokens
-- Since realtime audio tokens are ~15× the price of text tokens, one blended
-- per-token rate can never price a realtime call correctly — so realtime stayed
-- "sem preço". It also dropped `audio_seconds` entirely (pronunciation).
--
-- This version keeps text and audio tokens in SEPARATE columns and passes
-- audio_seconds through as `transcription_seconds`, so the cost engine
-- (pricing-cost-engine-v2) can price each with its own rate. Chat.completions
-- are unaffected (they carry no audio tokens, so tokens_input stays identical).
-- Return-type change → DROP + CREATE.
-- ============================================================================

drop function if exists public.admin_fetch_events_for_reprocessing_v1(text,text,text,text,timestamptz,timestamptz,boolean,timestamptz,uuid,integer);

create function public.admin_fetch_events_for_reprocessing_v1(
  p_environment text, p_provider text default null, p_model text default null, p_feature_key text default null,
  p_started_after timestamptz default null, p_started_before timestamptz default null, p_only_unpriced boolean default true,
  p_cursor_started_at timestamptz default null, p_cursor_id uuid default null, p_limit integer default 200
)
returns table(
  id uuid, provider text, model text, operation text, feature_key text, region text, started_at timestamptz, environment text,
  tokens_input integer, tokens_output integer, tokens_cached integer,
  tokens_input_audio integer, tokens_output_audio integer, tokens_cached_audio integer,
  chars_tts_billed integer, audio_input_seconds numeric, audio_output_seconds numeric, realtime_seconds numeric,
  transcription_seconds numeric, images_count integer,
  cost_total_usd numeric, currency text, cost_status text
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_limit integer;
begin
  v_limit := least(greatest(p_limit, 1), 500);
  return query
  with events as (
    select e.*
    from public.ai_usage_events e
    left join lateral (
      select v.status from public.ai_cost_valuations v where v.event_id = e.id order by v.created_at desc limit 1
    ) latest on true
    where (p_provider is null or e.provider = p_provider)
      and (p_model is null or e.model = p_model)
      and (p_feature_key is null or e.feature_key = p_feature_key)
      and (p_started_after is null or e.started_at >= p_started_after)
      and (p_started_before is null or e.started_at <= p_started_before)
      and (p_cursor_started_at is null or e.started_at > p_cursor_started_at
           or (e.started_at = p_cursor_started_at and e.id > p_cursor_id))
      and (not p_only_unpriced or latest.status is distinct from 'calculated')
  ),
  metrics as (
    select m.usage_event_id,
      sum(m.quantity) filter (where m.metric_key = 'input_text_tokens')         as tokens_input,
      sum(m.quantity) filter (where m.metric_key = 'output_text_tokens')        as tokens_output,
      sum(m.quantity) filter (where m.metric_key = 'cached_input_tokens')       as tokens_cached,
      sum(m.quantity) filter (where m.metric_key = 'input_audio_tokens')        as tokens_input_audio,
      sum(m.quantity) filter (where m.metric_key = 'output_audio_tokens')       as tokens_output_audio,
      sum(m.quantity) filter (where m.metric_key = 'cached_input_audio_tokens') as tokens_cached_audio,
      sum(m.quantity) filter (where m.metric_key = 'tts_characters')            as chars_tts_billed,
      sum(m.quantity) filter (where m.metric_key = 'session_seconds')           as realtime_seconds,
      sum(m.quantity) filter (where m.metric_key = 'audio_seconds')             as transcription_seconds
    from public.ai_usage_event_metrics m
    join events e on e.id = m.usage_event_id
    group by m.usage_event_id
  )
  select
    e.id, e.provider, e.model, e.operation_part as operation, e.feature_key, null::text as region, e.started_at,
    p_environment as environment,
    coalesce(mt.tokens_input, 0)::integer,
    coalesce(mt.tokens_output, 0)::integer,
    coalesce(mt.tokens_cached, 0)::integer,
    coalesce(mt.tokens_input_audio, 0)::integer,
    coalesce(mt.tokens_output_audio, 0)::integer,
    coalesce(mt.tokens_cached_audio, 0)::integer,
    coalesce(mt.chars_tts_billed, 0)::integer,
    0::numeric as audio_input_seconds,
    0::numeric as audio_output_seconds,
    coalesce(mt.realtime_seconds, 0) as realtime_seconds,
    coalesce(mt.transcription_seconds, 0) as transcription_seconds,
    0::integer as images_count,
    coalesce(e.reconciled_cost_usd, e.calculated_cost_usd) as cost_total_usd,
    case when coalesce(e.reconciled_cost_usd, e.calculated_cost_usd) is not null then 'USD' else null end as currency,
    e.cost_status
  from events e
  left join metrics mt on mt.usage_event_id = e.id
  order by e.started_at asc, e.id asc
  limit v_limit;
end;
$function$;

grant execute on function public.admin_fetch_events_for_reprocessing_v1(text,text,text,text,timestamptz,timestamptz,boolean,timestamptz,uuid,integer) to service_role;
