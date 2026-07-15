import type {
  SentenceRow,
  BookmarkTimingRow,
  WordTimingRow,
  ListeningSentenceTiming,
} from './listening-timing-types';
import { WORD_TIMING_SLACK_MS } from './listening-timing-config';

// ─── Public function ──────────────────────────────────────────────────────────

export function buildListeningSentenceTimings(
  sentences: SentenceRow[],
  bookmarks: BookmarkTimingRow[],
  wordTimings: WordTimingRow[],
  blockOrder: 1 | 2,
): ListeningSentenceTiming[] {
  const sorted = [...sentences].sort((a, b) => a.sentence_order - b.sentence_order);

  // Build lookup: bookmark_name → offset_ms
  const bookmarkMap = new Map<string, number>(
    bookmarks.map(b => [b.bookmark_name, b.offset_ms]),
  );

  const blockEndKey = `block-${blockOrder}-end`;
  const blockEndMs = bookmarkMap.get(blockEndKey) ?? 0;

  const result: ListeningSentenceTiming[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    const startMs = bookmarkMap.get(s.sentence_key) ?? 0;

    // intervalEndMs = next sentence bookmark OR block-end
    const next = sorted[i + 1];
    const intervalEndMs = next
      ? (bookmarkMap.get(next.sentence_key) ?? blockEndMs)
      : blockEndMs;

    // spoken_end_ms = last word event that starts within [startMs, intervalEndMs)
    const sentenceWords = wordTimings.filter(
      w =>
        w.start_ms >= startMs - WORD_TIMING_SLACK_MS &&
        w.start_ms < intervalEndMs + WORD_TIMING_SLACK_MS,
    );

    let spokenEndMs = startMs;
    for (const w of sentenceWords) {
      const wEnd =
        w.end_ms !== null && w.end_ms !== undefined
          ? w.end_ms
          : w.duration_ms !== null && w.duration_ms !== undefined
            ? w.start_ms + w.duration_ms
            : w.start_ms + 300;
      if (wEnd > spokenEndMs && wEnd <= intervalEndMs + WORD_TIMING_SLACK_MS) {
        spokenEndMs = wEnd;
      }
    }

    // Clamp spoken_end to interval
    spokenEndMs = Math.min(spokenEndMs, intervalEndMs);
    spokenEndMs = Math.max(spokenEndMs, startMs);

    // Confidence: 1.0 if bookmark found, lower if missing
    const hasBm = bookmarkMap.has(s.sentence_key);
    const hasNextBm = !next || bookmarkMap.has(next.sentence_key) || bookmarkMap.has(blockEndKey);
    const timingConfidence = hasBm && hasNextBm ? 1.0 : hasBm ? 0.85 : 0.5;

    result.push({
      sentenceKey: s.sentence_key,
      sentenceOrder: s.sentence_order,
      startMs,
      spokenEndMs,
      intervalEndMs,
      timingConfidence,
    });
  }

  return result;
}
