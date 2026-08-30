import { describe, it, expect } from 'vitest';
import { tutorialUiStrings } from './tutorialUiStrings';

describe('tutorialUiStrings', () => {
  it('resolves pt-BR and English, falling back to pt-BR for unknown/empty', () => {
    expect(tutorialUiStrings('pt-BR').skip).toBe('Pular tutorial');
    expect(tutorialUiStrings('en').skip).toBe('Skip tutorial');
    expect(tutorialUiStrings('en-US').skip).toBe('Skip tutorial'); // base-language fallback
    expect(tutorialUiStrings(undefined).skip).toBe('Pular tutorial');
    expect(tutorialUiStrings('zz').skip).toBe('Pular tutorial');
  });

  it('keeps the mandatory "Pular tutorial" copy semantic in both languages', () => {
    expect(tutorialUiStrings('pt-BR').skip).toMatch(/pular tutorial/i);
    expect(tutorialUiStrings('en').skip).toMatch(/skip tutorial/i);
  });

  it('formats the progress indicator like "2 de 7" / "2 of 7"', () => {
    expect(tutorialUiStrings('pt-BR').progress(2, 7)).toBe('2 de 7');
    expect(tutorialUiStrings('en').progress(2, 7)).toBe('2 of 7');
  });

  it('provides title + body for every one of the 7 steps in both languages', () => {
    for (const lang of ['pt-BR', 'en']) {
      const t = tutorialUiStrings(lang);
      expect(t.step1.title && t.step1.body && t.step1.cta).toBeTruthy();
      expect(t.step2.title && t.step2.body && t.step2.streakNote).toBeTruthy();
      expect(t.step3.title && t.step3.body).toBeTruthy();
      expect(t.step4.title && t.step4.body).toBeTruthy();
      expect(t.step5.title && t.step5.body).toBeTruthy();
      expect(t.step6.title && t.step6.body).toBeTruthy();
      expect(t.step7.title && t.step7.body && t.step7.cta).toBeTruthy();
    }
  });

  it('names the four practice modalities and the five progress destinations', () => {
    const t = tutorialUiStrings('pt-BR');
    expect([t.step4.writing, t.step4.pronunciation, t.step4.listening, t.step4.conversation].every((m) => m.name && m.desc)).toBe(true);
    expect([t.step6.plan, t.step6.calendar, t.step6.history, t.step6.evolution, t.step6.reminder].every((m) => m.label && m.desc)).toBe(true);
  });
});
