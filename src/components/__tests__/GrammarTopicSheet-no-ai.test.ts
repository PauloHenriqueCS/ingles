import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Item 11 guarantee: opening a grammar topic explanation must NEVER trigger an
 * AI call or any network request. This static assertion fails if the sheet ever
 * starts importing fetch/apiUrl or the grammar-explanation endpoint. Content
 * must come only from the offline catalog + persisted mistakes.
 */
const source = readFileSync(
  fileURLToPath(new URL('../GrammarTopicSheet.tsx', import.meta.url)),
  'utf8',
);

describe('GrammarTopicSheet — no AI / no network on open', () => {
  it('does not call fetch', () => {
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });
  it('does not reference the grammar-explanation endpoint or apiUrl', () => {
    expect(source).not.toMatch(/grammar-explanation/);
    expect(source).not.toMatch(/apiUrl/);
  });
  it('sources explanations from the offline curriculum catalog', () => {
    expect(source).toMatch(/resolveLegacyGrammarTopic/);
  });
  it('reuses persisted recurring mistakes for the contextual "why" line', () => {
    expect(source).toMatch(/findMistakeForTopic/);
  });
});
