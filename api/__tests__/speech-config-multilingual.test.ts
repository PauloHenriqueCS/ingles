/**
 * Proves the Speech (TTS/STT/recognition) config is fully DATA-DRIVEN per
 * learning language — the SAME code resolves English or a second language purely
 * from the public.languages row, with NO branch and NO hardcoded en-US fallback.
 *
 * Blocker 27 (speech) + blocker 24 (second-language genericity): changing the
 * languages row (or the user's learning_language) changes the resolved locale/
 * voice/STT with zero code change; a language with no Speech config fails loudly.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  getLanguageSpeechConfig,
  resolveUserLearningLanguage,
  resolveUserSpeechConfig,
  SpeechConfigError,
} from '../_curriculum/language-speech-config';

// Minimal in-memory fixture DB: languages + user_curriculum_preferences.
function makeClient(fixture: {
  languages: Record<string, { speech_locale: string; default_tts_voice: string; stt_language: string; allowed_tts_voices?: string[] } | null>;
  prefs?: Record<string, { learning_language: string }>;
}) {
  return {
    from(table: string) {
      const chain: any = {
        _eqField: null as string | null,
        _eqVal: null as string | null,
        select() { return chain; },
        eq(col: string, val: string) { chain._eqField = col; chain._eqVal = val; return chain; },
        order() { return chain; },
        limit() { return chain; },
        async maybeSingle() {
          if (table === 'languages') {
            const row = fixture.languages[chain._eqVal as string] ?? null;
            return { data: row, error: null };
          }
          if (table === 'user_curriculum_preferences') {
            const row = fixture.prefs?.[chain._eqVal as string] ?? null;
            return { data: row, error: null };
          }
          return { data: null, error: null };
        },
      };
      return chain;
    },
  } as any;
}

const EN = { speech_locale: 'en-US', default_tts_voice: 'en-US-AvaMultilingualNeural', stt_language: 'en', allowed_tts_voices: ['en-US-AvaMultilingualNeural', 'en-US-JennyNeural'] };
// A SECOND language (Spanish) — a test fixture only, NOT a production Spanish V1.
const ES = { speech_locale: 'es-ES', default_tts_voice: 'es-ES-ElviraNeural', stt_language: 'es', allowed_tts_voices: ['es-ES-ElviraNeural'] };

describe('getLanguageSpeechConfig — data-driven per language', () => {
  it('English row → en-US locale/voice/stt', async () => {
    const cfg = await getLanguageSpeechConfig(makeClient({ languages: { en: EN } }), 'en');
    expect(cfg.speechLocale).toBe('en-US');
    expect(cfg.defaultTtsVoice).toBe('en-US-AvaMultilingualNeural');
    expect(cfg.sttLanguage).toBe('en');
    expect(cfg.allowedTtsVoices).toContain('en-US-JennyNeural');
  });

  it('Spanish fixture row → es-ES locale/voice/stt with the SAME code (no branch)', async () => {
    const cfg = await getLanguageSpeechConfig(makeClient({ languages: { es: ES } }), 'es');
    expect(cfg.speechLocale).toBe('es-ES');
    expect(cfg.defaultTtsVoice).toBe('es-ES-ElviraNeural');
    expect(cfg.sttLanguage).toBe('es');
  });

  it('the default voice is always in the allowlist even when the column is empty', async () => {
    const cfg = await getLanguageSpeechConfig(
      makeClient({ languages: { es: { ...ES, allowed_tts_voices: [] } } }), 'es',
    );
    expect(cfg.allowedTtsVoices).toEqual(['es-ES-ElviraNeural']);
  });

  it('a language with NO speech config throws — never a silent en-US fallback', async () => {
    await expect(getLanguageSpeechConfig(makeClient({ languages: { es: null } }), 'es'))
      .rejects.toBeInstanceOf(SpeechConfigError);
  });
});

describe('resolveUserLearningLanguage — pinned preference, product bootstrap default', () => {
  it('uses the persisted learning_language', async () => {
    const client = makeClient({ languages: { es: ES }, prefs: { u1: { learning_language: 'es' } } });
    expect(await resolveUserLearningLanguage(client, 'u1')).toBe('es');
  });

  it('falls back to the product bootstrap default only when the user never chose one', async () => {
    const client = makeClient({ languages: { en: EN } });
    expect(await resolveUserLearningLanguage(client, 'new-user')).toBe('en');
  });
});

describe('resolveUserSpeechConfig — end to end', () => {
  it('a configured Spanish learner resolves es config, not English', async () => {
    const client = makeClient({ languages: { en: EN, es: ES }, prefs: { u1: { learning_language: 'es' } } });
    const cfg = await resolveUserSpeechConfig(client, 'u1');
    expect(cfg.learningLanguage).toBe('es');
    expect(cfg.speechLocale).toBe('es-ES');
  });

  it('a configured Spanish learner whose es config is missing fails loudly (never en-US)', async () => {
    const client = makeClient({ languages: { en: EN, es: null }, prefs: { u1: { learning_language: 'es' } } });
    await expect(resolveUserSpeechConfig(client, 'u1')).rejects.toBeInstanceOf(SpeechConfigError);
  });
});
