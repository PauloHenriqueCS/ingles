/**
 * Generalized conversation language mode on the frontend: level-based
 * RECOMMENDATION (soft UI hint, never blocks) and legacy normalization for
 * pre-generalization persisted values. A1/A2 → bilingual recommended; B1+ →
 * target-only.
 */
import { describe, it, expect } from 'vitest';
import {
  recommendConversationLanguageMode,
  normalizeConversationLanguageMode,
  isConversationLanguageMode,
  CONVERSATION_LANGUAGE_MODES,
  DEFAULT_CONVERSATION_LANGUAGE_MODE,
} from '../conversationLanguageMode';

describe('recommendConversationLanguageMode', () => {
  it('recommends bilingual_support for beginner levels A1 and A2', () => {
    expect(recommendConversationLanguageMode('A1')).toBe('bilingual_support');
    expect(recommendConversationLanguageMode('A2')).toBe('bilingual_support');
  });

  it('recommends target_only for B1, B2, C1, C2', () => {
    expect(recommendConversationLanguageMode('B1')).toBe('target_only');
    expect(recommendConversationLanguageMode('B2')).toBe('target_only');
    expect(recommendConversationLanguageMode('C1')).toBe('target_only');
    expect(recommendConversationLanguageMode('C2')).toBe('target_only');
  });

  it('is case-insensitive and tolerant of whitespace', () => {
    expect(recommendConversationLanguageMode(' a1 ')).toBe('bilingual_support');
    expect(recommendConversationLanguageMode('b2')).toBe('target_only');
  });

  it('falls back to target_only for an unknown/absent level (conservative default)', () => {
    expect(recommendConversationLanguageMode(null)).toBe('target_only');
    expect(recommendConversationLanguageMode(undefined)).toBe('target_only');
    expect(recommendConversationLanguageMode('')).toBe('target_only');
    expect(recommendConversationLanguageMode('Z9')).toBe('target_only');
  });
});

describe('normalizeConversationLanguageMode — legacy compatibility', () => {
  it('maps legacy values to the generalized ones', () => {
    expect(normalizeConversationLanguageMode('english_only')).toBe('target_only');
    expect(normalizeConversationLanguageMode('bilingual_pt_en')).toBe('bilingual_support');
  });

  it('passes generalized values through and rejects unknown', () => {
    expect(normalizeConversationLanguageMode('target_only')).toBe('target_only');
    expect(normalizeConversationLanguageMode('bilingual_support')).toBe('bilingual_support');
    expect(normalizeConversationLanguageMode('pt')).toBeNull();
    expect(normalizeConversationLanguageMode(null)).toBeNull();
  });
});

describe('conversation language mode enum', () => {
  it('exposes exactly the two generalized modes and the historical default', () => {
    expect(CONVERSATION_LANGUAGE_MODES).toEqual(['target_only', 'bilingual_support']);
    expect(DEFAULT_CONVERSATION_LANGUAGE_MODE).toBe('target_only');
  });

  it('type guard accepts only the generalized modes (not legacy)', () => {
    expect(isConversationLanguageMode('target_only')).toBe(true);
    expect(isConversationLanguageMode('bilingual_support')).toBe(true);
    expect(isConversationLanguageMode('english_only')).toBe(false);
    expect(isConversationLanguageMode('bilingual_pt_en')).toBe(false);
    expect(isConversationLanguageMode(null)).toBe(false);
  });
});
