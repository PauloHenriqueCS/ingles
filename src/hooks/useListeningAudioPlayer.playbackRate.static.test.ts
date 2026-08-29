import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Static source assertions proving the playbackRate fix is wired into the REAL
 * element-mutation code paths (not just the pure helper). The repo has no DOM
 * test harness (vitest env 'node'), so — per the established precedent (see
 * RewriteSection-wiring.test.ts) — architectural wiring is proven by asserting
 * on source text.
 *
 * The bug: swapping `src` for Parte 2 re-runs the media-load algorithm which
 * resets playbackRate to defaultPlaybackRate (1.0×); nothing re-applied the
 * selected rate. The fix pins defaultPlaybackRate + playbackRate together
 * (applyPlaybackRate) and re-applies it everywhere the element or its resource
 * changes.
 */

const hookSrc = readFileSync(
  resolve(__dirname, 'useListeningAudioPlayer.ts'),
  'utf8',
);
const viewSrc = readFileSync(
  resolve(__dirname, '..', 'components', 'ListeningView.tsx'),
  'utf8',
);
const helperSrc = readFileSync(
  resolve(__dirname, 'audioPlaybackRate.ts'),
  'utf8',
);

describe('audioPlaybackRate helper pins BOTH rate properties', () => {
  it('sets defaultPlaybackRate (the reset target) and playbackRate', () => {
    expect(helperSrc).toMatch(/audio\.defaultPlaybackRate\s*=\s*rate/);
    expect(helperSrc).toMatch(/audio\.playbackRate\s*=\s*rate/);
  });
});

describe('useListeningAudioPlayer routes every rate write through applyPlaybackRate', () => {
  it('imports the helper', () => {
    expect(hookSrc).toMatch(/import\s*\{\s*applyPlaybackRate\s*\}\s*from\s*'\.\/audioPlaybackRate'/);
  });

  it('keeps the selected rate in a ref so it can be re-applied to new elements', () => {
    expect(hookSrc).toMatch(/rateRef\s*=\s*useRef<number>\(1\)/);
    expect(hookSrc).toMatch(/rateRef\.current\s*=\s*rate/);
  });

  it('re-applies the rate when a NEW element is created in load()', () => {
    // new Audio(...) followed by an applyPlaybackRate(audio, rateRef.current)
    expect(hookSrc).toMatch(/new Audio\(url\)[\s\S]{0,220}applyPlaybackRate\(audio,\s*rateRef\.current\)/);
  });

  it('re-asserts the rate on loadedmetadata (defensive against the async reset)', () => {
    expect(hookSrc).toMatch(/addEventListener\('loadedmetadata'[\s\S]{0,120}applyPlaybackRate\(audio,\s*rateRef\.current\)/);
  });

  it('re-applies the rate after an in-place URL swap (updateUrl)', () => {
    expect(hookSrc).toMatch(/audio\.src\s*=\s*newUrl;[\s\S]{0,160}applyPlaybackRate\(audio,\s*rateRef\.current\)/);
  });

  it('setRate uses the helper (not a bare playbackRate assignment)', () => {
    const setRateBlock = hookSrc.slice(hookSrc.indexOf('const setRate'));
    expect(setRateBlock).toMatch(/applyPlaybackRate\(audioRef\.current,\s*rate\)/);
  });
});

describe('ListeningView re-applies the rate on the Parte 1 → Parte 2 src swap', () => {
  it('handleStoryAdvance sets src then re-applies the selected speed', () => {
    const start = viewSrc.indexOf('function handleStoryAdvance');
    expect(start).toBeGreaterThan(-1);
    const block = viewSrc.slice(start, start + 700);
    expect(block).toMatch(/audio\.src\s*=\s*url1/);
    expect(block).toMatch(/player\.setRate\(speedRef\.current\)/);
    // order: setRate must come AFTER the src assignment
    expect(block.indexOf('player.setRate(speedRef.current)')).toBeGreaterThan(
      block.indexOf('audio.src = url1'),
    );
  });
});
