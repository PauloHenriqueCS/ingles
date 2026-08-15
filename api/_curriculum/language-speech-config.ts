/**
 * SERVER-ONLY. Data-driven Speech (TTS/STT) configuration per learning language,
 * read from public.languages (speech_locale / default_tts_voice / stt_language).
 *
 * There is NO hardcoded en-US / voice / STT language in the runtime code: a new
 * learning language configures its own row and works with the same code. Throws
 * an explicit error when a language has no speech config — never a silent English
 * default.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface LanguageSpeechConfig {
  /** BCP-47 locale for TTS SSML xml:lang, e.g. 'en-US'. */
  speechLocale: string;
  /** Default Azure TTS voice, e.g. 'en-US-AvaMultilingualNeural'. */
  defaultTtsVoice: string;
  /** ISO-639-1 language for STT/transcription, e.g. 'en'. */
  sttLanguage: string;
}

export class SpeechConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpeechConfigError';
  }
}

export async function getLanguageSpeechConfig(
  client: SupabaseClient,
  learningLanguage: string,
): Promise<LanguageSpeechConfig> {
  const { data } = await client
    .from('languages')
    .select('speech_locale, default_tts_voice, stt_language')
    .eq('code', learningLanguage)
    .maybeSingle();
  const row = (data ?? null) as
    | { speech_locale: string | null; default_tts_voice: string | null; stt_language: string | null }
    | null;
  if (!row || !row.speech_locale || !row.default_tts_voice || !row.stt_language) {
    throw new SpeechConfigError(
      `No speech config for learning_language="${learningLanguage}" (speech_locale/default_tts_voice/stt_language)`,
    );
  }
  return {
    speechLocale: row.speech_locale,
    defaultTtsVoice: row.default_tts_voice,
    sttLanguage: row.stt_language,
  };
}
