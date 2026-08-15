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

// Minimal in-memory fixture DB: languages + user_learning_paths (the active
// learning language authority — blocker 1).
function makeClient(fixture: {
  languages: Record<string, { speech_locale: string; default_tts_voice: string; stt_language: string; allowed_tts_voices?: string[] } | null>;
  paths?: Record<string, { learning_language: string }>;
}) {
  return {
    from(table: string) {
      const chain: any = {
        _code: null as string | null,
        _userId: null as string | null,
        select() { return chain; },
        eq(col: string, val: string) {
          if (col === 'code') chain._code = val;
          if (col === 'user_id') chain._userId = val;
          return chain;
        },
        order() { return chain; },
        limit() { return chain; },
        async maybeSingle() {
          if (table === 'languages') {
            return { data: fixture.languages[chain._code as string] ?? null, error: null };
          }
          if (table === 'user_learning_paths') {
            const p = fixture.paths?.[chain._userId as string] ?? null;
            return { data: p ? { ...p, interface_language: 'pt-BR', curriculum_version_id: 'v1', initial_level_code: null } : null, error: null };
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

describe('resolveUserLearningLanguage — ACTIVE learning path is the authority (blocker 1)', () => {
  it('uses the ACTIVE path learning_language (not prefs.updated_at)', async () => {
    const client = makeClient({ languages: { es: ES }, paths: { u1: { learning_language: 'es' } } });
    expect(await resolveUserLearningLanguage(client, 'u1')).toBe('es');
  });

  it('an active English path resolves English even if a Spanish path is not active', async () => {
    const client = makeClient({ languages: { en: EN }, paths: { u1: { learning_language: 'en' } } });
    expect(await resolveUserLearningLanguage(client, 'u1')).toBe('en');
  });

  it('a path READ failure fails loudly — never silently recovers to English (blocker 1)', async () => {
    const errClient: any = {
      from: () => ({
        select() { return this; }, eq() { return this; }, order() { return this; }, limit() { return this; },
        async maybeSingle() { return { data: null, error: { message: 'db down' } }; },
      }),
    };
    await expect(resolveUserLearningLanguage(errClient, 'u1')).rejects.toBeTruthy();
  });
});

describe('resolveUserSpeechConfig — end to end (active path)', () => {
  it('a Spanish ACTIVE path resolves es config, not English', async () => {
    const client = makeClient({ languages: { en: EN, es: ES }, paths: { u1: { learning_language: 'es' } } });
    const cfg = await resolveUserSpeechConfig(client, 'u1');
    expect(cfg.learningLanguage).toBe('es');
    expect(cfg.speechLocale).toBe('es-ES');
  });

  it('a Spanish ACTIVE path whose es config is missing fails loudly (never en-US)', async () => {
    const client = makeClient({ languages: { en: EN, es: null }, paths: { u1: { learning_language: 'es' } } });
    await expect(resolveUserSpeechConfig(client, 'u1')).rejects.toBeInstanceOf(SpeechConfigError);
  });
});
