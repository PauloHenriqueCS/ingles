import type { ListeningSubtitleTimingConfig } from './listening-timing-types';

export const ALIGNER_VERSION = 'listening-timing-aligner-v1';
export const TIMING_CONFIG_VERSION = 'timing-config-v1';
export const TIMING_SCHEMA_VERSION = '1.0';

export const BLOCK_START_BOOKMARK_PREFIX = 'block-';
export const BLOCK_START_SUFFIX = '-start';
export const BLOCK_END_SUFFIX = '-end';

export const DEFAULT_TIMING_CONFIG: ListeningSubtitleTimingConfig = {
  preRollMs: 100,
  postRollMs: 150,
  maxGapMs: 300,
  maxOverlapMs: 50,
  minCueDurationMs: 500,
  maxCueDurationMs: 7000,
  alignmentRateThresholdValid: 0.98,
  alignmentRateThresholdReview: 0.95,
  confidenceThresholdValid: 0.90,
  confidenceThresholdReview: 0.75,
};

export const WORD_TIMING_SLACK_MS = 50;
