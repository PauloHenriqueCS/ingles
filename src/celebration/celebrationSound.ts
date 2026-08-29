/**
 * Celebration sound effects — REAL, preloaded audio assets (Kenney CC0, MP3),
 * played via HTMLAudioElement. No runtime Web Audio synthesis.
 *
 *   - activity-complete.mp3  (~0.34s, Kenney "Interface Sounds", CC0)
 *   - day-complete.mp3       (~0.99s, Kenney "Music Jingles" steel-drum, CC0)
 *   see assets/sounds/CREDITS.md for source + license.
 *
 * Robustness:
 *   - Preloaded: the two <audio> elements are created once with preload='auto'
 *     and load() is called up front, so there is no perceptible delay at play.
 *   - Autoplay policy: browsers block audio until a user gesture. We install a
 *     ONE-TIME global unlock on the first pointer/touch/key/click anywhere in the
 *     app that primes both elements (play→pause while muted). After that, a
 *     programmatic play() at completion time is allowed. A celebration itself
 *     also follows a user action, but the global unlock guarantees the very first
 *     one plays too.
 *   - Fail-safe: any failure (no Audio, blocked play, decode error) is swallowed.
 *     Sound must NEVER break the activity completion.
 *   - Volume controlled; a module-level mute flag backs a future settings toggle.
 */
import activityUrl from './assets/sounds/activity-complete.mp3';
import dayUrl from './assets/sounds/day-complete.mp3';

type Kind = 'activity' | 'day';

const VOLUME: Record<Kind, number> = { activity: 0.7, day: 0.8 };
const URLS: Record<Kind, string> = { activity: activityUrl, day: dayUrl };

let muted = false;
let unlockInstalled = false;
let unlocked = false;
const elements: Partial<Record<Kind, HTMLAudioElement>> = {};

export function setCelebrationSoundMuted(value: boolean): void {
  muted = value;
}
export function isCelebrationSoundMuted(): boolean {
  return muted;
}

function get(kind: Kind): HTMLAudioElement | null {
  if (typeof Audio === 'undefined') return null;
  let el = elements[kind];
  if (!el) {
    try {
      el = new Audio(URLS[kind]);
      el.preload = 'auto';
      el.volume = VOLUME[kind];
      el.load();
      elements[kind] = el;
    } catch {
      return null;
    }
  }
  return el ?? null;
}

/**
 * Install a one-time global audio unlock on the first user gesture. Idempotent;
 * safe to call on every app start. No-op off the DOM (tests/SSR).
 */
export function installCelebrationAudioUnlock(): void {
  if (unlockInstalled || typeof window === 'undefined' || typeof document === 'undefined') return;
  unlockInstalled = true;

  const unlock = () => {
    if (unlocked) return;
    unlocked = true;
    (['activity', 'day'] as Kind[]).forEach((kind) => {
      const el = get(kind);
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
        } else {
          el.pause();
          el.currentTime = 0;
          el.muted = false;
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

function play(kind: Kind): void {
  if (muted) return;
  const el = get(kind);
  if (!el) return;
  try {
    el.muted = false;
    el.volume = VOLUME[kind];
    el.currentTime = 0;
    const p = el.play();
    if (p && typeof p.then === 'function') p.catch(() => {});
  } catch {
    /* never let audio break the flow */
  }
}

export function playActivityCompleteSound(): void {
  play('activity');
}
export function playDayCompleteSound(): void {
  play('day');
}
