import { describe, it, expect } from 'vitest';
import type { PublicSubtitleCue } from '../services/listening/execution/listening-execution-types';

// Inline the binary search so we can test it in isolation
function findActiveCue(
  cues: PublicSubtitleCue[],
  timeMs: number,
): PublicSubtitleCue | null {
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cue = cues[mid];
    if (cue.endMs <= timeMs) {
      lo = mid + 1;
    } else if (cue.startMs > timeMs) {
      hi = mid - 1;
    } else {
      return cue;
    }
  }
  return null;
}

function makeCue(cueOrder: number, startMs: number, endMs: number): PublicSubtitleCue {
  return { cueKey: `cue-${cueOrder}`, cueOrder, startMs, endMs, text: `Cue ${cueOrder}` };
}

const CUES: PublicSubtitleCue[] = [
  makeCue(1, 0, 2000),
  makeCue(2, 2500, 5000),
  makeCue(3, 5000, 8000),
  makeCue(4, 9000, 12000),
];

describe('useListeningSubtitles — binary search', () => {
  it('returns first cue at start', () => {
    expect(findActiveCue(CUES, 0)?.cueOrder).toBe(1);
  });

  it('returns first cue mid-range', () => {
    expect(findActiveCue(CUES, 1000)?.cueOrder).toBe(1);
  });

  it('returns null in gap between cues', () => {
    expect(findActiveCue(CUES, 2100)).toBeNull();
  });

  it('returns second cue at its start', () => {
    expect(findActiveCue(CUES, 2500)?.cueOrder).toBe(2);
  });

  it('returns third cue at boundary start (adjacent to cue 2 end)', () => {
    expect(findActiveCue(CUES, 5000)?.cueOrder).toBe(3);
  });

  it('returns null before any cue starts (if first cue starts after 0)', () => {
    const cues = [makeCue(1, 1000, 2000)];
    expect(findActiveCue(cues, 500)).toBeNull();
  });

  it('returns null after all cues end', () => {
    expect(findActiveCue(CUES, 13000)).toBeNull();
  });

  it('returns null for empty cue list', () => {
    expect(findActiveCue([], 1000)).toBeNull();
  });

  it('handles single cue correctly', () => {
    const cues = [makeCue(1, 1000, 3000)];
    expect(findActiveCue(cues, 500)).toBeNull();
    expect(findActiveCue(cues, 1000)?.cueOrder).toBe(1);
    expect(findActiveCue(cues, 2000)?.cueOrder).toBe(1);
    expect(findActiveCue(cues, 3000)).toBeNull();
  });

  it('returns null at exact endMs (endMs is exclusive)', () => {
    expect(findActiveCue(CUES, 2000)).toBeNull();
  });
});
