import type { CueRow, ListeningSentenceTiming } from './listening-timing-types';

export interface EstimatedCueTiming {
  startMs: number;
  endMs: number;
  confidence: number;
}

/**
 * Proportional estimation of cue timing when word-level events are unavailable.
 * Splits the sentence timing interval among sibling cues by character count.
 */
export function estimateCueTimingsWithinSentence(
  targetCue: CueRow,
  siblingsInSentence: CueRow[],
  sentenceTiming: ListeningSentenceTiming,
): EstimatedCueTiming {
  const sorted = [...siblingsInSentence].sort((a, b) => a.cue_order - b.cue_order);
  const targetIdx = sorted.findIndex(c => c.cue_key === targetCue.cue_key);

  if (sorted.length === 1 || targetIdx === -1) {
    return {
      startMs: sentenceTiming.startMs,
      endMs: sentenceTiming.spokenEndMs,
      confidence: 0.7,
    };
  }

  const totalChars = sorted.reduce((s, c) => s + c.text.length, 0);
  const durationMs = sentenceTiming.spokenEndMs - sentenceTiming.startMs;

  let cumulativeChars = 0;
  for (let i = 0; i < targetIdx; i++) {
    cumulativeChars += sorted[i].text.length;
  }
  const targetChars = sorted[targetIdx].text.length;

  const ratio = totalChars > 0 ? cumulativeChars / totalChars : 0;
  const targetRatio = totalChars > 0 ? targetChars / totalChars : 1 / sorted.length;

  const startMs = sentenceTiming.startMs + Math.round(durationMs * ratio);
  const endMs = startMs + Math.round(durationMs * targetRatio);

  return {
    startMs: Math.max(sentenceTiming.startMs, startMs),
    endMs: Math.min(sentenceTiming.intervalEndMs, endMs),
    confidence: 0.7,
  };
}
