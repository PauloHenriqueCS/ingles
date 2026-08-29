/**
 * Static assertions for two writing-flow UX changes:
 *  - a non-practice day auto-opens the activity (no "Dia de revisão" interstitial
 *    on the happy path; the card only remains as an error fallback);
 *  - the mission-loading text cycles progressive messages (like Listening) instead
 *    of a single fixed line.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const dayViewSrc = readFileSync(resolve(__dirname, '..', 'DayView.tsx'), 'utf8');
const themeCardSrc = readFileSync(resolve(__dirname, '..', 'DailyThemeCard.tsx'), 'utf8');

describe('DayView — non-practice day opens the activity directly', () => {
  it('auto-activates the day instead of parking on the interstitial', () => {
    // an effect fires handleActivateDay when the day would be inactive
    expect(dayViewSrc).toMatch(/if \(showInactiveMessage && autoActivatedForRef\.current !== date\)/);
    expect(dayViewSrc).toMatch(/void handleActivateDay\(\)/);
    // a loader is shown while it opens…
    expect(dayViewSrc).toMatch(/Abrindo atividade/);
    // …and the old card is only a fallback when activation errors
    expect(dayViewSrc).toMatch(/activateError \?[\s\S]*<InactiveDayCard/);
  });
});

describe('DailyThemeCard — progressive mission-loading messages', () => {
  it('cycles forward through progress messages while generating (not a fixed line)', () => {
    for (const msg of ['Carregando missão', 'Montando a explicação', 'Criando os exercícios']) {
      expect(themeCardSrc).toContain(msg);
    }
    expect(themeCardSrc).toMatch(/setInterval\(/);
    // advances and holds on the last step (no infinite loop-back)
    expect(themeCardSrc).toMatch(/Math\.min\(i \+ 1, MISSION_PROGRESS\.length - 1\)/);
    // the loading line renders the current progress message when generating
    expect(themeCardSrc).toMatch(/isLoading \? MISSION_PROGRESS\[missionProgressIdx\]/);
  });
});
