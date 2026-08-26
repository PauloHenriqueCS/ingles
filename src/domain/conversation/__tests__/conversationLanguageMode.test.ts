/**
 * Level-based RECOMMENDATION for the conversation language chooser. This is a
 * soft UI hint only (which option is badged) — it never blocks a choice; any
 * level can pick either mode. A1/A2 → bilingual recommended; B1+ → English.
 */
import { describe, it, expect } from 'vitest';
import {
  recommendConversationLanguageMode,
  isConversationLanguageMode,
  CONVERSATION_LANGUAGE_MODES,
  DEFAULT_CONVERSATION_LANGUAGE_MODE,
} from '../conversationLanguageMode';

describe('recommendConversationLanguageMode', () => {
  it('recommends bilingual for beginner levels A1 and A2', () => {
    expect(recommendConversationLanguageMode('A1')).toBe('bilingual_pt_en');
    expect(recommendConversationLanguageMode('A2')).toBe('bilingual_pt_en');
  });

  it('recommends English-only for B1, B2, C1, C2', () => {
    expect(recommendConversationLanguageMode('B1')).toBe('english_only');
    expect(recommendConversationLanguageMode('B2')).toBe('english_only');
    expect(recommendConversationLanguageMode('C1')).toBe('english_only');
    expect(recommendConversationLanguageMode('C2')).toBe('english_only');
  });

  it('is case-insensitive and tolerant of whitespace', () => {
    expect(recommendConversationLanguageMode(' a1 ')).toBe('bilingual_pt_en');
    expect(recommendConversationLanguageMode('b2')).toBe('english_only');
  });

  it('falls back to English-only for an unknown/absent level (conservative default)', () => {
    expect(recommendConversationLanguageMode(null)).toBe('english_only');
    expect(recommendConversationLanguageMode(undefined)).toBe('english_only');
    expect(recommendConversationLanguageMode('')).toBe('english_only');
    expect(recommendConversationLanguageMode('Z9')).toBe('english_only');
  });
});

describe('conversation language mode enum', () => {
  it('exposes exactly the two modes and the historical default', () => {
    expect(CONVERSATION_LANGUAGE_MODES).toEqual(['english_only', 'bilingual_pt_en']);
    expect(DEFAULT_CONVERSATION_LANGUAGE_MODE).toBe('english_only');
  });

  it('type guard accepts only the two known modes', () => {
    expect(isConversationLanguageMode('english_only')).toBe(true);
    expect(isConversationLanguageMode('bilingual_pt_en')).toBe(true);
    expect(isConversationLanguageMode('pt')).toBe(false);
    expect(isConversationLanguageMode(null)).toBe(false);
  });
});
