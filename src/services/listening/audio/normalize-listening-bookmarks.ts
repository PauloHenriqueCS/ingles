import type { RawListeningBookmarkEvent, ListeningBookmarkTiming } from './listening-audio-types';

/**
 * Converts Azure Speech ticks (100-nanosecond units) to milliseconds.
 * Throws on negative or NaN inputs.
 */
export function azureTicksToMilliseconds(ticks: number | string): number {
  const n = typeof ticks === 'string' ? Number(ticks) : ticks;
  if (Number.isNaN(n)) throw new Error(`Invalid ticks value: ${ticks}`);
  if (n < 0) throw new Error(`Negative ticks value: ${ticks}`);
  // 1 tick = 100 ns = 0.0001 ms → divide by 10,000, floor to integer ms
  return Math.floor(n / 10_000);
}

/**
 * Normalizes raw bookmark events captured during synthesis into sorted timings.
 * Preserves all events; deduplication / validation is a separate concern.
 */
export function normalizeBookmarkTimings(
  audioAssetId: string,
  rawEvents: RawListeningBookmarkEvent[],
): ListeningBookmarkTiming[] {
  return rawEvents
    .map(e => ({
      audioAssetId,
      bookmarkName: e.bookmarkName,
      eventOrder: e.receivedOrder,
      offsetMs: azureTicksToMilliseconds(e.audioOffsetTicks),
      rawOffsetTicks: e.audioOffsetTicks,
    }))
    .sort((a, b) => a.offsetMs - b.offsetMs);
}
