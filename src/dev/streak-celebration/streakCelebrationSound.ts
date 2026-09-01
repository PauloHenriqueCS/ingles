/**
 * Sound for the streak-celebration PREVIEW.
 *
 * REUSES the existing HTMLAudio infrastructure — no new audio library.
 *   - "discreet"    → the shared `playActivityCompleteSound()` (activity-complete.mp3)
 *   - "achievement" → the shared `playDayCompleteSound()` (day-complete.mp3)
 *   - "premium"     → one extra isolated asset (premium-chime.mp3) played with the
 *                     exact same `new Audio(url)` pattern as celebrationSound.ts.
 *
 * All playback is best-effort and fully swallowed: sound must NEVER break the UI.
 */
import {
  playActivityCompleteSound,
  playDayCompleteSound,
  installCelebrationAudioUnlock,
} from '../../celebration/celebrationSound';
import premiumUrl from './assets/premium-chime.mp3';
import type { StreakSoundOption } from './streakCelebrationTypes';

const PREMIUM_VOLUME = 0.7;
let premiumEl: HTMLAudioElement | null = null;
let unlockInstalled = false;
let unlocked = false;

function getPremium(): HTMLAudioElement | null {
  if (typeof Audio === 'undefined') return null;
  if (!premiumEl) {
    try {
      premiumEl = new Audio(premiumUrl);
      premiumEl.preload = 'auto';
      premiumEl.volume = PREMIUM_VOLUME;
      premiumEl.load();
    } catch {
      return null;
    }
  }
  return premiumEl;
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
    const el = getPremium();
    if (el) {
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
    }
    remove();
  };

  const opts = { passive: true, capture: true } as AddEventListenerOptions;
  const events = ['pointerdown', 'touchend', 'mousedown', 'keydown', 'click'];
  const remove = () => events.forEach((e) => document.removeEventListener(e, unlock, opts));
  events.forEach((e) => document.addEventListener(e, unlock, opts));
}

function playPremium(): void {
  const el = getPremium();
  if (!el) return;
  try {
    el.muted = false;
    el.volume = PREMIUM_VOLUME;
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
      playPremium();
      break;
    case 'none':
    default:
      break;
  }
}
