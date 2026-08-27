/**
 * The mission card must show a SINGLE vocabulary section. The old redundant
 * "Palavras para usar" (theme.useTheseWords) heading was removed; only
 * "Vocabulário útil para esta missão" (theme.suggestedVocabulary) remains. The
 * useTheseWords FIELD stays in the data model (mission snapshot / conversation
 * context) — only its duplicate on-screen section is gone.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const card = readFileSync(join(__dirname, '..', 'DailyThemeCard.tsx'), 'utf8');

describe('DailyThemeCard — single vocabulary section (no duplication)', () => {
  it('keeps the "Vocabulário útil para esta missão" section (suggestedVocabulary), filtered to non-empty items', () => {
    expect(card).toMatch(/Vocabulário útil para esta missão/);
    // The list is filtered through visibleVocabulary so a blank/empty AI list
    // never renders the heading over nothing (empty-vocabulary bug fix).
    expect(card).toMatch(/visibleVocabulary\(theme\.suggestedVocabulary\)\.map/);
  });

  it('no longer renders the redundant "Palavras para usar" section', () => {
    expect(card).not.toMatch(/Palavras para usar/);
    // The useTheseWords list must not be rendered as its own chip section.
    expect(card).not.toMatch(/theme\.useTheseWords\.map/);
  });

  it('there is exactly ONE vocabulary <Section> title in the mission card', () => {
    const titles = card.match(/<Section title="[^"]*[Vv]ocabulário[^"]*"/g) ?? [];
    expect(titles.length).toBe(1);
  });
});
