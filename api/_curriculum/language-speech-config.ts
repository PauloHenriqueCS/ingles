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
import { resolveActiveLearningLanguage } from './curriculum-runtime';

export interface LanguageSpeechConfig {
  /** BCP-47 locale for TTS SSML xml:lang AND Azure Speech recognition, e.g. 'en-US'. */
  speechLocale: string;
  /** Default Azure TTS voice, e.g. 'en-US-AvaMultilingualNeural'. */
  defaultTtsVoice: string;
  /** ISO-639-1 language for STT/transcription, e.g. 'en'. */
  sttLanguage: string;
  /**
   * Data-driven allowlist of Azure TTS voices the client may request for THIS
   * learning language (always includes defaultTtsVoice). Empty → only the
   * default voice is allowed. Replaces the old global English-only allowlist.
   */
  allowedTtsVoices: string[];
}

// Defence-in-depth: an Azure neural voice name is a strict token
// (locale + name, e.g. 'en-US-AvaMultilingualNeural'). This shape carries no
// XML metacharacters, so even a maliciously-configured/allowlisted value can
// never break out of the unescaped `<voice name="...">` SSML attribute.
export const SAFE_AZURE_VOICE_RE = /^[A-Za-z]{2,3}-[A-Za-z0-9]+(-[A-Za-z0-9]+)+$/;

export class SpeechConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpeechConfigError';
  }
}

/**
 * Resolves the user's CURRENT learning language from the SAME authority the
 * curriculum uses — the ACTIVE learning path (public.user_learning_paths), never
 * an prefs.updated_at heuristic (blocker 1). Bootstraps a path when the user has
 * none. A read/bootstrap failure PROPAGATES; it is never silently recovered to
 * English. The product bootstrap default only applies inside a genuine first
 * bootstrap (a user with no path), not as error recovery.
 */
export async function resolveUserLearningLanguage(
  client: SupabaseClient,
  userId: string,
): Promise<string> {
  // Delegates to the shared active-path resolver in curriculum-runtime so Speech
  // and ensureUserCurriculum can never diverge on the active language.
  return resolveActiveLearningLanguage(client, userId);
}

/**
 * One-call helper for every Speech flow: resolves the user's ACTIVE learning
 * language and returns its data-driven Speech config. Throws SpeechConfigError
 * (→ explicit operational error, never en-US) when the target language has no
 * Speech config. Callers pass the SERVICE client (server-authoritative bootstrap
 * honours RLS — the write policies are server-role only).
 */
export async function resolveUserSpeechConfig(
  client: SupabaseClient,
  userId: string,
): Promise<LanguageSpeechConfig & { learningLanguage: string }> {
  const learningLanguage = await resolveUserLearningLanguage(client, userId);
  const config = await getLanguageSpeechConfig(client, learningLanguage);
  return { ...config, learningLanguage };
}

export async function getLanguageSpeechConfig(
  client: SupabaseClient,
  learningLanguage: string,
): Promise<LanguageSpeechConfig> {
  const { data } = await client
    .from('languages')
    .select('speech_locale, default_tts_voice, stt_language, allowed_tts_voices')
    .eq('code', learningLanguage)
    .maybeSingle();
  const row = (data ?? null) as
    | {
        speech_locale: string | null; default_tts_voice: string | null;
        stt_language: string | null; allowed_tts_voices: string[] | null;
      }
    | null;
  if (!row || !row.speech_locale || !row.default_tts_voice || !row.stt_language) {
    throw new SpeechConfigError(
      `No speech config for learning_language="${learningLanguage}" (speech_locale/default_tts_voice/stt_language)`,
    );
  }
  const allowed = Array.isArray(row.allowed_tts_voices) ? row.allowed_tts_voices.filter((v) => typeof v === 'string') : [];
  // The default voice is always allowed even if the allowlist column is empty.
  const allowedTtsVoices = Array.from(new Set([row.default_tts_voice, ...allowed]));
  return {
    speechLocale: row.speech_locale,
    defaultTtsVoice: row.default_tts_voice,
    sttLanguage: row.stt_language,
    allowedTtsVoices,
  };
}
