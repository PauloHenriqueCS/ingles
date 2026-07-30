/**
 * SERVER-ONLY: the capability_definitions keys registered by
 * supabase/migrations/20260718210000_... (plus the trial_total pair
 * reconciled by 20260728000000_conversation_trial_total_capability_definitions),
 * named so callers never hardcode the raw strings. Keep in sync with those
 * migrations if keys ever change.
 */
export const CAPABILITY_KEYS = {
  writingEnabled: 'writing.enabled',
  writingThemeGenerationsPerDay: 'writing.theme_generations_per_day',
  writingThemeGenerationsPerDayUnlimited: 'writing.theme_generations_per_day.unlimited',
  writingMaxCharactersPerText: 'writing.max_characters_per_text',
  writingMaxCharactersPerTextUnlimited: 'writing.max_characters_per_text.unlimited',
  writingReviewsPerDay: 'writing.reviews_per_day',
  writingReviewsPerDayUnlimited: 'writing.reviews_per_day.unlimited',

  listeningEnabled: 'listening.enabled',
  listeningStoriesPerDay: 'listening.stories_per_day',
  listeningStoriesPerDayUnlimited: 'listening.stories_per_day.unlimited',

  pronunciationEnabled: 'pronunciation.enabled',
  pronunciationEvaluationsPerDay: 'pronunciation.evaluations_per_day',
  pronunciationEvaluationsPerDayUnlimited: 'pronunciation.evaluations_per_day.unlimited',
  pronunciationMaxRecordingSeconds: 'pronunciation.max_recording_seconds',
  pronunciationMaxRecordingSecondsUnlimited: 'pronunciation.max_recording_seconds.unlimited',

  conversationEnabled: 'conversation.enabled',
  conversationIncludedSecondsPerMonth: 'conversation.realtime.seconds.monthly',
  conversationIncludedSecondsPerMonthUnlimited: 'conversation.realtime.seconds.monthly.unlimited',
  // Etapa 2A — the internal 'trial' plan's lifetime total (consumed across
  // the whole assignment, never reset monthly). Resolved INSTEAD OF the
  // monthly pair above, exclusively when plan.code === 'trial' — see
  // plan-entitlements-service.ts. Never used as a fallback for any other
  // plan, and the monthly pair is never used as a fallback for trial.
  conversationTrialTotalSeconds: 'conversation.realtime.seconds.trial_total',
  conversationTrialTotalSecondsUnlimited: 'conversation.realtime.seconds.trial_total.unlimited',
  conversationMaxRecordingSeconds: 'conversation.max_recording_seconds',
  conversationMaxRecordingSecondsUnlimited: 'conversation.max_recording_seconds.unlimited',
  conversationExtraPurchaseEnabled: 'conversation.extra_purchase_enabled',
} as const;

export const ALL_CAPABILITY_KEYS: string[] = Object.values(CAPABILITY_KEYS);
