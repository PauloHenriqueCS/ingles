/**
 * Server-authoritative resolution of the GENERALIZED conversation language mode
 * plus the pure composition helper. The mode never encodes a language pair; the
 * pedagogical directive is DATA (prompt_templates → conversation.bilingual_support),
 * not code — so this suite asserts resolution, legacy compatibility, the
 * target/base language-pair resolver, and that composition leaves target_only
 * byte-for-byte unchanged. The directive PROSE is asserted on the migration
 * (supabase/migrations/__tests__/conversation-language-mode-generalize.test.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  resolveConversationLanguageMode,
  normalizeConversationLanguageMode,
  composeConversationInstructions,
  resolveConversationLanguagePair,
  isConversationLanguageMode,
  CONVERSATION_LANGUAGE_MODES,
  DEFAULT_CONVERSATION_LANGUAGE_MODE,
  BILINGUAL_SUPPORT_TEMPLATE_KEY,
} from '../conversation/_language-mode';

describe('resolveConversationLanguageMode — generalized values', () => {
  it('honors the generalized values', () => {
    expect(resolveConversationLanguageMode('target_only')).toBe('target_only');
    expect(resolveConversationLanguageMode('bilingual_support')).toBe('bilingual_support');
  });

  it('accepts LEGACY values (backward compatibility)', () => {
    expect(resolveConversationLanguageMode('english_only')).toBe('target_only');
    expect(resolveConversationLanguageMode('bilingual_pt_en')).toBe('bilingual_support');
  });

  it('falls back to target_only when absent/unknown (older clients / legacy rows)', () => {
    expect(resolveConversationLanguageMode(undefined)).toBe('target_only');
    expect(resolveConversationLanguageMode(null)).toBe('target_only');
    expect(resolveConversationLanguageMode('nonsense')).toBe('target_only');
    expect(resolveConversationLanguageMode(42)).toBe('target_only');
    expect(DEFAULT_CONVERSATION_LANGUAGE_MODE).toBe('target_only');
  });

  it('exposes exactly the two generalized modes', () => {
    expect(CONVERSATION_LANGUAGE_MODES).toEqual(['target_only', 'bilingual_support']);
    expect(BILINGUAL_SUPPORT_TEMPLATE_KEY).toBe('conversation.bilingual_support');
  });
});

describe('normalizeConversationLanguageMode / isConversationLanguageMode', () => {
  it('normalizes legacy → generalized and passes through generalized', () => {
    expect(normalizeConversationLanguageMode('english_only')).toBe('target_only');
    expect(normalizeConversationLanguageMode('bilingual_pt_en')).toBe('bilingual_support');
    expect(normalizeConversationLanguageMode('target_only')).toBe('target_only');
    expect(normalizeConversationLanguageMode('bilingual_support')).toBe('bilingual_support');
  });

  it('returns null for unrecognized values', () => {
    expect(normalizeConversationLanguageMode('pt')).toBeNull();
    expect(normalizeConversationLanguageMode(null)).toBeNull();
  });

  it('type guard accepts ONLY the generalized modes (not legacy)', () => {
    expect(isConversationLanguageMode('target_only')).toBe(true);
    expect(isConversationLanguageMode('bilingual_support')).toBe(true);
    expect(isConversationLanguageMode('english_only')).toBe(false);
    expect(isConversationLanguageMode('bilingual_pt_en')).toBe(false);
  });
});

describe('resolveConversationLanguagePair — target/base decoupled from fixed values', () => {
  it('maps target=learningLanguage, base=interfaceLanguage from the language context', () => {
    expect(resolveConversationLanguagePair({ learningLanguage: 'en', interfaceLanguage: 'pt-BR' }))
      .toEqual({ targetLanguage: 'en', baseLanguage: 'pt-BR' });
  });

  it('works for a different pair with no code change (future-proof)', () => {
    expect(resolveConversationLanguagePair({ learningLanguage: 'es', interfaceLanguage: 'pt-BR' }))
      .toEqual({ targetLanguage: 'es', baseLanguage: 'pt-BR' });
  });
});

describe('composeConversationInstructions — pure, no pedagogy', () => {
  const base = 'You are a tutor. Responda SEMPRE em inglês.';

  it('target_only path: a null/empty fragment leaves the base UNCHANGED', () => {
    expect(composeConversationInstructions(base, null)).toBe(base);
    expect(composeConversationInstructions(base, '   ')).toBe(base);
  });

  it('bilingual_support path: appends the data-driven fragment after the base', () => {
    const fragment = '## Modo bilíngue\nUse português para explicar.';
    const out = composeConversationInstructions(base, fragment);
    expect(out.startsWith(base)).toBe(true);
    expect(out).toContain(fragment);
    expect(out.length).toBeGreaterThan(base.length);
  });
});
