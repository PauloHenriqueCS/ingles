import type { ListeningSignedUrlConfig } from './listening-publication-types';

// Matches AUDIO_STORAGE_BUCKET in ../audio/listening-audio-config.ts — the
// synthesis pipeline writes audio into this exact bucket, so publication
// (which copies staging → published within it) must reference the same one.
export const LISTENING_BUCKET = 'listening-audio';

export const SIGNED_URL_CONFIG: ListeningSignedUrlConfig = {
  expiresInSeconds: 3600,
  refreshBeforeExpirationSeconds: 300,
};

export const PUBLICATION_RETRY_MAX = 2;

export const PUBLICATION_RETRY_BACKOFF_MS = [500, 1500];

export const VALID_EPISODE_DURATION_RANGE = {
  minSeconds: 60,
  maxSeconds: 1800,
};

export const REQUIRED_BLOCKS_PER_EPISODE = 2;

export function buildStagingPath(
  cefrLevel: string,
  episodeId: string,
  contentVersion: number,
  ssmlHash: string,
  blockOrder: number,
): string {
  return `staging/${cefrLevel}/${episodeId}/v${contentVersion}/${ssmlHash}/block-${String(blockOrder).padStart(2, '0')}.mp3`;
}

export function buildPublishedPath(
  cefrLevel: string,
  episodeId: string,
  contentVersion: number,
  audioHash: string,
  blockOrder: number,
): string {
  return `published/${cefrLevel}/${episodeId}/v${contentVersion}/${audioHash}/block-${String(blockOrder).padStart(2, '0')}.mp3`;
}
