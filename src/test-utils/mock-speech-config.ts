import { vi } from 'vitest';

/**
 * Shared test helper: a chainable `.from()` mock covering the tables read by
 * resolveUserSpeechConfig (api/_curriculum/language-speech-config):
 *   - user_learning_paths → the user's ACTIVE learning language (blocker 1)
 *   - languages           → the Speech config for that language
 *
 * Defaults to English (locale 'en-US'), so the recognition/TTS locale resolves
 * to 'en-US' as before — but now DATA-DRIVEN from the active path. Pass overrides
 * to prove a second active language resolves a different locale/voice with NO
 * code change.
 */
export interface SpeechConfigMockOptions {
  learningLanguage?: string | null;
  speechLocale?: string;
  defaultTtsVoice?: string;
  sttLanguage?: string;
  allowedTtsVoices?: string[];
  /** When true, the languages row is absent → getLanguageSpeechConfig throws. */
  missingLanguageConfig?: boolean;
}

export function makeSpeechConfigFrom(opts: SpeechConfigMockOptions = {}) {
  const learningLanguage = opts.learningLanguage === undefined ? 'en' : opts.learningLanguage;
  const speechLocale = opts.speechLocale ?? 'en-US';
  const defaultTtsVoice = opts.defaultTtsVoice ?? 'en-US-AvaMultilingualNeural';
  const sttLanguage = opts.sttLanguage ?? 'en';
  const allowedTtsVoices = opts.allowedTtsVoices ?? [defaultTtsVoice];

  return (table: string) => {
    const chain: any = {};
    for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = vi.fn().mockReturnValue(chain);
    if (table === 'user_learning_paths') {
      // The ACTIVE learning path is the authority (blocker 1). null → no path.
      chain.maybeSingle = vi.fn().mockResolvedValue({
        data: learningLanguage === null ? null : { learning_language: learningLanguage, interface_language: 'pt-BR', curriculum_version_id: 'v1', initial_level_code: null },
        error: null,
      });
    } else if (table === 'user_curriculum_preferences') {
      chain.maybeSingle = vi.fn().mockResolvedValue({
        data: learningLanguage === null ? null : { learning_language: learningLanguage },
        error: null,
      });
    } else if (table === 'languages') {
      chain.maybeSingle = vi.fn().mockResolvedValue({
        data: opts.missingLanguageConfig
          ? null
          : { speech_locale: speechLocale, default_tts_voice: defaultTtsVoice, stt_language: sttLanguage, allowed_tts_voices: allowedTtsVoices },
        error: null,
      });
    } else {
      chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    }
    return chain;
  };
}
