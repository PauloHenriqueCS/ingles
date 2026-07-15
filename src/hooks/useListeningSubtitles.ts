import { useEffect, useRef, useState } from 'react';
import type { PublicSubtitleCue } from '../services/listening/execution/listening-execution-types';

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

export function useListeningSubtitles(
  cues: PublicSubtitleCue[],
  audioRef: React.RefObject<HTMLAudioElement | null>,
  enabled: boolean,
) {
  const [activeCue, setActiveCue] = useState<PublicSubtitleCue | null>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!enabled || cues.length === 0) {
      setActiveCue(null);
      return;
    }

    function tick() {
      const timeMs = (audioRef.current?.currentTime ?? 0) * 1000;
      setActiveCue(findActiveCue(cues, timeMs));
      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafRef.current);
      setActiveCue(null);
    };
  }, [cues, enabled, audioRef]);

  return activeCue;
}
