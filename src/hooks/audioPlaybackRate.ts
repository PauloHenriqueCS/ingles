/**
 * Playback-rate application that survives the browser's media-load algorithm.
 *
 * Setting only `playbackRate` is NOT enough. When a media element selects a new
 * resource — e.g. swapping `src` to move from Listening "Parte 1" to "Parte 2"
 * on the SAME element — the browser runs the media element load algorithm and
 * (asynchronously) resets `playbackRate` back to `defaultPlaybackRate`. If we
 * only ever wrote `playbackRate`, that reset silently returns the new audio to
 * 1.0× while the React state (and the speed selector UI) still say 0.75×.
 *
 * The fix is to also set `defaultPlaybackRate`: it is the value the load
 * algorithm restores to, so writing both makes the selected rate stick across
 * `src` swaps and fresh loads.
 *
 * This module is intentionally framework-free and DOM-free (operates on a
 * minimal structural type) so it can be unit-tested in the repo's node test
 * environment without a DOM harness.
 */

export interface RateControllableAudio {
  playbackRate: number;
  defaultPlaybackRate: number;
}

/**
 * Apply `rate` to a media element so it persists across the media-load
 * algorithm. Sets `defaultPlaybackRate` first (the reset target) then
 * `playbackRate` (the immediately-effective value).
 */
export function applyPlaybackRate(audio: RateControllableAudio, rate: number): void {
  audio.defaultPlaybackRate = rate;
  audio.playbackRate = rate;
}
