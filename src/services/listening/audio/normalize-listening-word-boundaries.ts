import type { RawListeningWordBoundaryEvent, ListeningWordTiming } from './listening-audio-types';
import { azureTicksToMilliseconds } from './normalize-listening-bookmarks';

/**
 * Deduplicates word boundary events.
 * Two events are duplicates when they share the same text, audioOffset, AND textOffset.
 * Words repeated at different positions in the text are preserved.
 */
export function deduplicateListeningWordEvents(
  events: RawListeningWordBoundaryEvent[],
): RawListeningWordBoundaryEvent[] {
  const seen = new Set<string>();
  return events.filter(e => {
    const key = `${e.text}|${e.audioOffsetTicks}|${e.textOffset ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Normalizes raw word boundary events into structured timings (1-indexed word_order).
 */
export function normalizeWordBoundaryTimings(
  audioAssetId: string,
  rawEvents: RawListeningWordBoundaryEvent[],
): ListeningWordTiming[] {
  const deduped = deduplicateListeningWordEvents(rawEvents);
  return deduped.map((e, idx) => {
    const startMs = azureTicksToMilliseconds(e.audioOffsetTicks);
    const durationMs =
      e.durationTicks != null ? azureTicksToMilliseconds(e.durationTicks) : null;
    const endMs = durationMs != null ? startMs + durationMs : null;
    return {
      audioAssetId,
      wordOrder: idx + 1,
      text: e.text,
      startMs,
      durationMs,
      endMs,
      textOffset: e.textOffset,
      wordLength: e.wordLength,
      boundaryType: e.boundaryType,
      rawOffsetTicks: e.audioOffsetTicks,
      rawDurationTicks: e.durationTicks,
    };
  });
}
