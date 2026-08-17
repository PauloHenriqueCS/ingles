/**
 * Interface-language localization of the new UI chrome (Foco atual, Conversa
 * guiada / livre). A non-pt-BR interface must NOT inject Portuguese, and the
 * new keys must exist in every language table.
 */
import { describe, it, expect } from 'vitest';
import { curriculumUiStrings } from './curriculumUiStrings';

describe('curriculumUiStrings — new focus / conversation chrome', () => {
  it('resolves Portuguese chrome for pt-BR', () => {
    const t = curriculumUiStrings('pt-BR');
    expect(t.focusEyebrow).toBe('Foco atual');
    expect(t.conversationGuidedTitle).toBe('Conversa guiada');
    expect(t.conversationFreeTitle).toBe('Conversa livre');
    expect(t.conversationFocusLabel('Cumprimentar e apresentar-se')).toBe('Foco: Cumprimentar e apresentar-se');
  });

  it('resolves ENGLISH chrome for en and never injects Portuguese', () => {
    const t = curriculumUiStrings('en');
    expect(t.focusEyebrow).toBe('Current focus');
    expect(t.conversationGuidedTitle).toBe('Guided conversation');
    expect(t.conversationFreeTitle).toBe('Free conversation');
    // No Portuguese leaks into the English chrome.
    expect(t.focusEyebrow).not.toBe('Foco atual');
    expect(t.conversationGuidedDesc).not.toMatch(/plano de ensino/);
    expect(t.conversationFocusLabel('Greetings')).toBe('Focus: Greetings');
  });

  it('falls back to pt-BR only for an unknown interface language (documented default)', () => {
    const t = curriculumUiStrings('xx-YY');
    expect(t.focusEyebrow).toBe('Foco atual');
  });

  it('matches the base language when a region is unknown (e.g. en-GB → en)', () => {
    const t = curriculumUiStrings('en-GB');
    expect(t.focusEyebrow).toBe('Current focus');
  });

  it('exposes every new key in both language tables', () => {
    for (const lang of ['pt-BR', 'en']) {
      const t = curriculumUiStrings(lang);
      expect(typeof t.focusEyebrow).toBe('string');
      expect(typeof t.focusInitializing).toBe('string');
      expect(typeof t.focusCompleted).toBe('string');
      expect(typeof t.focusUnavailable).toBe('string');
      expect(typeof t.conversationGuidedTitle).toBe('string');
      expect(typeof t.conversationFreeTitle).toBe('string');
      expect(typeof t.conversationGuidedDesc).toBe('string');
      expect(typeof t.conversationFreeDesc).toBe('string');
      expect(typeof t.conversationRecommended).toBe('string');
      expect(t.conversationFocusLabel('X')).toContain('X');
    }
  });
});
