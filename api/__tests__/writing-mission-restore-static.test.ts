/**
 * Source-level guards for the "restore today's assigned mission on re-entry"
 * fix (problem 9). The daily mission is persisted per-user in generated_themes;
 * the client must be able to rehydrate it on re-entry WITHOUT generating a new
 * one, WITHOUT an AI call, and WITHOUT consuming a generation. Following this
 * repo's convention of proving server/client wiring with static assertions.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const genThemeSrc = readFileSync(join(__dirname, '..', 'generate-theme.ts'), 'utf8');
const dailyCardSrc = readFileSync(join(__dirname, '..', '..', 'src', 'components', 'DailyThemeCard.tsx'), 'utf8');

// Isolate the retrieve-only branch: from its marker to the start of the normal path.
const retrieveBranch = genThemeSrc.slice(
  genThemeSrc.indexOf('const retrieveOnly ='),
  genThemeSrc.indexOf('const { mode: _clientMode'),
);

describe('generate-theme retrieve-only mode (restore mission)', () => {
  it('exists and is triggered by mode:"retrieve" / retrieveOnly', () => {
    expect(genThemeSrc).toContain("req.body?.mode === 'retrieve'");
    expect(retrieveBranch.length).toBeGreaterThan(0);
    expect(retrieveBranch).toContain("mode: 'retrieve'");
  });

  it('returns the most recent still-active mission for the SAME day window the counter uses', () => {
    expect(retrieveBranch).toContain("utcDayRange");
    expect(retrieveBranch).toMatch(/\.from\('generated_themes'\)/);
    expect(retrieveBranch).toMatch(/\.eq\('status', 'generated'\)/);
    expect(retrieveBranch).toMatch(/order\('created_at', \{ ascending: false \}\)/);
  });

  it('makes NO AI call and inserts NOTHING (never consumes a generation)', () => {
    expect(retrieveBranch).not.toContain('executeAiGatewayCall');
    expect(retrieveBranch).not.toContain('.insert(');
    // it must return BEFORE blockedByGenerationLimit / the generation counter path
    expect(genThemeSrc.indexOf('const retrieveOnly =')).toBeLessThan(genThemeSrc.indexOf('const { mode: _clientMode'));
  });

  it('is not blocked by an exhausted generation limit (restore works even at the daily cap)', () => {
    // The retrieve branch does not reference the generation-limit gate at all.
    expect(retrieveBranch).not.toContain('blockedByGenerationLimit');
  });
});

describe('DailyThemeCard restores the mission on entry (no new generation)', () => {
  it('calls the retrieve endpoint on mount with mode:"retrieve"', () => {
    expect(dailyCardSrc).toContain("JSON.stringify({ mode: 'retrieve' })");
    // a mount-only effect drives the restore
    expect(dailyCardSrc).toMatch(/useEffect\([\s\S]*mode: 'retrieve'[\s\S]*\}, \[\]\)/);
  });

  it('re-entry does not auto-generate: the only generate() POST is the explicit user action', () => {
    // buildGenerateThemeRequestBody is the NEW-generation body; the restore path
    // must not use it (it sends the plain retrieve body instead).
    const restoreEffect = dailyCardSrc.slice(
      dailyCardSrc.indexOf("body: JSON.stringify({ mode: 'retrieve' })") - 400,
      dailyCardSrc.indexOf("body: JSON.stringify({ mode: 'retrieve' })") + 200,
    );
    expect(restoreEffect).not.toContain('buildGenerateThemeRequestBody');
  });
});
