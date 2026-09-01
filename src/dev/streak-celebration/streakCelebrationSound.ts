/**
 * Sound for the streak-celebration PREVIEW.
 *
 * REUSES the existing HTMLAudio infrastructure — no new audio library.
 *   - "discreet"    → the shared `playActivityCompleteSound()` (activity-complete.mp3)
 *   - "achievement" → the shared `playDayCompleteSound()` (day-complete.mp3)
 *   - "premium"/"seal" → extra isolated assets played with the exact same
 *                     `new Audio(url)` pattern as celebrationSound.ts.
 *
 * All playback is best-effort and fully swallowed: sound must NEVER break the UI.
 */
import {
  playActivityCompleteSound,
  playDayCompleteSound,
  installCelebrationAudioUnlock,
} from '../../celebration/celebrationSound';
import premiumUrl from './assets/premium-chime.mp3';
import sealUrl from './assets/seal.mp3';
import type { StreakSoundOption } from './streakCelebrationTypes';

const EXTRA_VOLUME = 0.7;
const EXTRA_URLS: Record<'premium' | 'seal', string> = { premium: premiumUrl, seal: sealUrl };
const extraEls: Partial<Record<'premium' | 'seal', HTMLAudioElement>> = {};
let unlockInstalled = false;
let unlocked = false;

function getExtra(kind: 'premium' | 'seal'): HTMLAudioElement | null {
  if (typeof Audio === 'undefined') return null;
  let el = extraEls[kind];
  if (!el) {
    try {
      el = new Audio(EXTRA_URLS[kind]);
      el.preload = 'auto';
      el.volume = EXTRA_VOLUME;
      el.load();
      extraEls[kind] = el;
    } catch {
      return null;
    }
  }
  return el ?? null;
}

/**
 * Install the audio unlock. Delegates the two shared elements to the project's
 * own `installCelebrationAudioUnlock`, and primes the premium element on the
 * first user gesture with the same muted play→pause trick. Idempotent.
 */
export function installStreakAudioUnlock(): void {
  installCelebrationAudioUnlock();
  if (unlockInstalled || typeof window === 'undefined' || typeof document === 'undefined') return;
  unlockInstalled = true;

  const unlock = () => {
    if (unlocked) return;
    unlocked = true;
    (['premium', 'seal'] as const).forEach((kind) => {
      const el = getExtra(kind);
      if (!el) return;
      try {
        const prevVol = el.volume;
        el.muted = true;
        const p = el.play();
        if (p && typeof p.then === 'function') {
          p.then(() => {
            el.pause();
            el.currentTime = 0;
            el.muted = false;
            el.volume = prevVol;
          }).catch(() => {
            el.muted = false;
            el.volume = prevVol;
          });
        }
      } catch {
        /* ignore */
      }
    });
    remove();
  };

  const opts = { passive: true, capture: true } as AddEventListenerOptions;
  const events = ['pointerdown', 'touchend', 'mousedown', 'keydown', 'click'];
  const remove = () => events.forEach((e) => document.removeEventListener(e, unlock, opts));
  events.forEach((e) => document.addEventListener(e, unlock, opts));
}

function playExtra(kind: 'premium' | 'seal'): void {
  const el = getExtra(kind);
  if (!el) return;
  try {
    el.muted = false;
    el.volume = EXTRA_VOLUME;
    el.currentTime = 0;
    const p = el.play();
    if (p && typeof p.then === 'function') p.catch(() => {});
  } catch {
    /* never let audio break the flow */
  }
}

/** Play the chosen preview sound. Safe to call anytime. */
export function playStreakSound(option: StreakSoundOption): void {
  switch (option) {
    case 'discreet':
      playActivityCompleteSound();
      break;
    case 'achievement':
      playDayCompleteSound();
      break;
    case 'premium':
      playExtra('premium');
      break;
    case 'seal':
      playExtra('seal');
      break;
    case 'none':
    default:
      break;
  }
}
