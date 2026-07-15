import { createHash } from 'node:crypto';
import { ALIGNER_VERSION, TIMING_CONFIG_VERSION } from './listening-timing-config';
import type { ListeningSentenceTiming, ListeningCueTiming } from './listening-timing-types';

export function computeListeningTimingHash(
  audioAssetId: string,
  ssmlHash: string,
  audioHash: string,
  sentenceTimings: ListeningSentenceTiming[],
  cueTimings: ListeningCueTiming[],
): string {
  const payload = JSON.stringify({
    audioAssetId,
    ssmlHash,
    audioHash,
    alignerVersion: ALIGNER_VERSION,
    timingConfigVersion: TIMING_CONFIG_VERSION,
    sentences: sentenceTimings.map(s => ({
      k: s.sentenceKey,
      s: s.startMs,
      e: s.spokenEndMs,
      i: s.intervalEndMs,
    })),
    cues: cueTimings.map(c => ({
      k: c.cueKey,
      s: c.startMs,
      e: c.endMs,
      src: c.timingSource,
    })),
  });

  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}
