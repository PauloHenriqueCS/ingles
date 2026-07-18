/**
 * SERVER-ONLY: the 21 capability_definitions keys registered by
 * supabase/migrations/20260718210000_..., named so callers never hardcode
 * the raw strings. Keep in sync with that migration if keys ever change.
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
  conversationMaxRecordingSeconds: 'conversation.max_recording_seconds',
  conversationMaxRecordingSecondsUnlimited: 'conversation.max_recording_seconds.unlimited',
  conversationExtraPurchaseEnabled: 'conversation.extra_purchase_enabled',
} as const;

export const ALL_CAPABILITY_KEYS: string[] = Object.values(CAPABILITY_KEYS);
