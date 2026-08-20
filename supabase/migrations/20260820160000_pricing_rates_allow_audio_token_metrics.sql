-- ============================================================================
-- Allow realtime audio-token metric keys in ai_pricing_rates.
-- ----------------------------------------------------------------------------
-- The cost engine (pricing-cost-engine-v2) prices realtime audio as its own
-- tokens (audio_input_tokens / audio_output_tokens / audio_cached_tokens),
-- separate from text tokens. The metric_key CHECK constraint predated those
-- metrics, so admin_upsert_pricing_rate_v1 rejected them (23514). Extend the
-- allowed set to match lib/gateway/pricing-metrics.ts PRICING_METRICS.
-- ============================================================================

alter table public.ai_pricing_rates drop constraint ai_pricing_rates_metric_key_check;

alter table public.ai_pricing_rates add constraint ai_pricing_rates_metric_key_check check (
  metric_key = any (array[
    'tokens_input','tokens_output','tokens_cached','tokens_cached_output',
    'audio_input_tokens','audio_output_tokens','audio_cached_tokens',
    'audio_input_seconds','audio_output_seconds','realtime_seconds',
    'chars_tts_billed','transcription_seconds','pronunciation_assessment_count',
    'images_count','fixed_per_call'
  ])
);
