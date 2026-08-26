import { describe, it, expect } from 'vitest';
import { buildReminderCopy } from '../practiceReminderCopy';

describe('buildReminderCopy — central localized notification copy', () => {
  it('pt-BR', () => {
    expect(buildReminderCopy('pt-BR')).toEqual({
      title: 'Hora de praticar',
      body: 'Que tal continuar seu inglês hoje?',
      channelName: 'Lembrete de prática',
    });
  });

  it('en', () => {
    expect(buildReminderCopy('en')).toEqual({
      title: 'Time to practice',
      body: 'How about continuing your English practice today?',
      channelName: 'Practice reminder',
    });
  });

  it('resolves an en-US style code to English (split on -)', () => {
    expect(buildReminderCopy('en-US').title).toBe('Time to practice');
  });

  it('falls back to pt-BR only when the language is absent/invalid', () => {
    for (const bad of [null, undefined, '', '   ', 'xx']) {
      expect(buildReminderCopy(bad as string | null | undefined).title).toBe('Hora de praticar');
    }
  });
});
