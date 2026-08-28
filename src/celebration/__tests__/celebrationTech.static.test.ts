/**
 * Static assertions that the POLISH layer uses the mandated technologies —
 * Framer Motion (choreography), Lottie (main animation), preloaded audio ASSETS
 * (not runtime Web Audio synthesis), and a first-gesture audio unlock — and that
 * the asset files actually load.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'fs';
import { resolve } from 'path';
import activityLottie from '../assets/lottie/activity-complete.json';
import dayLottie from '../assets/lottie/day-complete.json';

const src = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8');
const overlay = src('CelebrationOverlay.tsx');
const provider = src('CelebrationProvider.tsx');
const sound = src('celebrationSound.ts');

describe('Framer Motion is used for the choreography', () => {
  it('overlay imports and uses framer-motion (motion + reduced-motion + spring)', () => {
    expect(overlay).toMatch(/from 'framer-motion'/);
    expect(overlay).toMatch(/\bmotion\./);
    expect(overlay).toMatch(/useReducedMotion/);
    expect(overlay).toMatch(/type:\s*'spring'/);
  });
  it('provider drives enter/exit with AnimatePresence; overlay declares exit variants', () => {
    expect(provider).toMatch(/AnimatePresence/);
    expect(overlay).toMatch(/\bexit=\{/); // exit variant on the motion elements
  });
});

describe('Lottie is used for the main animation', () => {
  it('overlay imports lottie-react and renders both Lottie assets', () => {
    expect(overlay).toMatch(/from 'lottie-react'/);
    expect(overlay).toMatch(/<Lottie\b/);
    expect(overlay).toMatch(/activity-complete\.json/);
    expect(overlay).toMatch(/day-complete\.json/);
  });
  it('both Lottie assets are valid Bodymovin JSON with layers', () => {
    for (const j of [activityLottie, dayLottie] as Array<{ layers?: unknown[]; op?: number; fr?: number }>) {
      expect(Array.isArray(j.layers)).toBe(true);
      expect((j.layers as unknown[]).length).toBeGreaterThan(3);
      expect(j.fr).toBeGreaterThan(0);
      expect(j.op).toBeGreaterThan(0);
    }
  });
});

describe('Sound uses preloaded real audio assets (not Web Audio synthesis)', () => {
  it('imports the mp3 assets and plays them via HTMLAudioElement with preload', () => {
    expect(sound).toMatch(/assets\/sounds\/activity-complete\.mp3/);
    expect(sound).toMatch(/assets\/sounds\/day-complete\.mp3/);
    expect(sound).toMatch(/new Audio\(/);
    expect(sound).toMatch(/preload = 'auto'/);
    expect(sound).toMatch(/\.load\(\)/);
  });
  it('does NOT synthesize audio at runtime (no oscillator/AudioContext)', () => {
    expect(sound).not.toMatch(/AudioContext/);
    expect(sound).not.toMatch(/createOscillator/);
  });
  it('installs a first-gesture unlock, wired from the provider', () => {
    expect(sound).toMatch(/installCelebrationAudioUnlock/);
    expect(sound).toMatch(/addEventListener/);
    expect(provider).toMatch(/installCelebrationAudioUnlock\(\)/);
  });
  it('the mp3 asset files exist on disk and are non-trivial', () => {
    for (const f of ['activity-complete.mp3', 'day-complete.mp3']) {
      const p = resolve(__dirname, '..', 'assets', 'sounds', f);
      expect(existsSync(p)).toBe(true);
      expect(statSync(p).size).toBeGreaterThan(2000);
    }
  });
});
