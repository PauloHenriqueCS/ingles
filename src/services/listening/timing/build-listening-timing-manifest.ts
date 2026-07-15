import { TIMING_SCHEMA_VERSION, ALIGNER_VERSION, TIMING_CONFIG_VERSION } from './listening-timing-config';
import type {
  ListeningSentenceTiming,
  ListeningCueTiming,
  ListeningTimingManifest,
} from './listening-timing-types';

export function buildListeningTimingManifest(
  episodeId: string,
  blockId: string,
  audioAssetId: string,
  audioDurationMs: number,
  ssmlHash: string,
  audioHash: string,
  sentenceTimings: ListeningSentenceTiming[],
  cueTimings: ListeningCueTiming[],
): ListeningTimingManifest {
  return {
    schemaVersion: TIMING_SCHEMA_VERSION,
    episodeId,
    blockId,
    audioAssetId,
    audioDurationMs,
    ssmlHash,
    audioHash,
    alignerVersion: ALIGNER_VERSION,
    timingConfigVersion: TIMING_CONFIG_VERSION,
    sentences: sentenceTimings.map(s => ({
      sentenceKey: s.sentenceKey,
      startMs: s.startMs,
      spokenEndMs: s.spokenEndMs,
      intervalEndMs: s.intervalEndMs,
    })),
    cues: cueTimings.map(c => ({
      cueKey: c.cueKey,
      startMs: c.startMs,
      endMs: c.endMs,
      confidence: c.confidence,
      timingSource: c.timingSource,
    })),
  };
}
