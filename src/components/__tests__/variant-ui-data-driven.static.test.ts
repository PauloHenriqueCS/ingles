/**
 * ROOT-2 (residual) — the accent/variant UIs must have NO hardcoded English
 * variant list. Options come exclusively from the data-driven per-language
 * catalog (conversation_language_variants) via GET /api/conversation/variants,
 * so adding a new variant_key never requires editing a component. These static
 * source assertions lock that in — they run in the node test env (no DOM
 * needed) and fail CI if a hardcoded list creeps back.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

describe('AudioSettingsView — no hardcoded accent authority (PROBLEM 1)', () => {
  const view = read('components/AudioSettingsView.tsx');
  const lib = read('lib/audioSettings.ts');

  it('has no hardcoded american/british/australian accent list', () => {
    expect(view).not.toMatch(/american/);
    expect(view).not.toMatch(/british/);
    expect(view).not.toMatch(/australian/);
    expect(view).not.toMatch(/const ACCENTS/);
  });

  it('does not read or write an accent field on audio settings', () => {
    expect(view).not.toMatch(/settings\.accent/);
    expect(view).not.toMatch(/accent:/);
  });

  it('AudioSettings has no accent field (concept lives in AIPreferences/conversation)', () => {
    // A field declaration would be `accent:` — prose in comments may still say
    // the word, so match the declaration shape, not the bare word.
    expect(lib).not.toMatch(/accent\s*:/);
  });
});

describe('TutorPersonalizationSheet — variants come only from the endpoint (PROBLEM 2)', () => {
  const sheet = read('components/TutorPersonalizationSheet.tsx');

  it('fetches accent options from the data-driven endpoint', () => {
    expect(sheet).toMatch(/\/api\/conversation\/variants/);
  });

  it('does not use ACCENT_LABELS as a fallback options source', () => {
    expect(sheet).not.toMatch(/ACCENT_LABELS/);
  });

  it('does not hardcode english accent options as a fallback', () => {
    // No literal english accent keys anywhere in the component.
    expect(sheet).not.toMatch(/'american'/);
    expect(sheet).not.toMatch(/'british'/);
    expect(sheet).not.toMatch(/'neutral'/);
  });

  it('surfaces an error/retry state instead of inventing options on failure', () => {
    expect(sheet).toMatch(/status: 'error'/);
    expect(sheet).toMatch(/Tentar novamente/);
  });
});
