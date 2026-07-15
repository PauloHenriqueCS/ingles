import type { RawListeningBookmarkEvent, ListeningBookmarkValidationResult } from './listening-audio-types';

/**
 * Validates the set of received bookmark events against the expected list.
 * Expected order: block-N-start, sentenceKeys..., block-N-end.
 */
export function validateListeningBookmarkEvents(
  events: RawListeningBookmarkEvent[],
  expectedBookmarks: string[],
): ListeningBookmarkValidationResult {
  const expectedSet = new Set(expectedBookmarks);
  const actualNames = events.map(e => e.bookmarkName);

  // Missing
  const actualSet = new Set(actualNames);
  const missing = expectedBookmarks.filter(name => !actualSet.has(name));

  // Duplicated
  const seen = new Set<string>();
  const duplicated: string[] = [];
  for (const name of actualNames) {
    if (seen.has(name)) {
      if (!duplicated.includes(name)) duplicated.push(name);
    } else {
      seen.add(name);
    }
  }

  // Unexpected
  const unexpected = [...new Set(actualNames.filter(n => !expectedSet.has(n)))];

  // Out of order (using first-occurrence positions of expected marks)
  const firstPos = new Map<string, number>();
  actualNames.forEach((name, i) => {
    if (expectedSet.has(name) && !firstPos.has(name)) firstPos.set(name, i);
  });
  const outOfOrder: string[] = [];
  let prevPos = -1;
  for (const expected of expectedBookmarks) {
    const pos = firstPos.get(expected);
    if (pos !== undefined) {
      if (pos < prevPos) outOfOrder.push(expected);
      else prevPos = pos;
    }
  }

  // Offsets decreasing (among expected marks, sorted by receivedOrder)
  const expectedEvents = events
    .filter(e => expectedSet.has(e.bookmarkName))
    .sort((a, b) => a.receivedOrder - b.receivedOrder);
  const offsetsDecreasing: string[] = [];
  let prevOffset = -1;
  for (const e of expectedEvents) {
    if (e.audioOffsetTicks < prevOffset) offsetsDecreasing.push(e.bookmarkName);
    else prevOffset = e.audioOffsetTicks;
  }

  const valid =
    missing.length === 0 &&
    duplicated.length === 0 &&
    unexpected.length === 0 &&
    outOfOrder.length === 0 &&
    offsetsDecreasing.length === 0;

  return { valid, missing, duplicated, unexpected, outOfOrder, offsetsDecreasing };
}
