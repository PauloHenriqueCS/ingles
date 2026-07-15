import type { ListeningJobType } from './listening-job-types';

// ── Lock timeouts per job type (ms) ──────────────────────────────────────────
// Azure synthesis is capped at 240s to stay within Vercel's 300s function timeout.
// Local worker usage is not constrained by this.

export const LOCK_TIMEOUT_MS: Record<ListeningJobType, number> = {
  ENSURE_LISTENING_INVENTORY:       300_000,  // 5 min
  GENERATE_LISTENING_STORY:         600_000,  // 10 min
  GENERATE_LISTENING_QUESTIONS:     600_000,  // 10 min
  PREPARE_LISTENING_SUBTITLES:      600_000,  // 10 min
  GENERATE_LISTENING_SSML:          300_000,  // 5 min
  SYNTHESIZE_LISTENING_BLOCK_AUDIO: 240_000,  // 4 min (Vercel limit buffer)
  SYNCHRONIZE_LISTENING_BLOCK:      600_000,  // 10 min
  VALIDATE_LISTENING_EPISODE:       600_000,  // 10 min
  PUBLISH_LISTENING_EPISODE:        600_000,  // 10 min
  REPAIR_LISTENING_EPISODE:         600_000,  // 10 min
  AUDIT_LISTENING_INVENTORY:        300_000,  // 5 min
  AUDIT_LISTENING_STORAGE:        1_800_000,  // 30 min
  CLEANUP_LISTENING_STAGING:        900_000,  // 15 min
  CALCULATE_LISTENING_PERFORMANCE:   60_000,  // 1 min
};

// ── Max attempts per job type ─────────────────────────────────────────────────

export const MAX_ATTEMPTS: Record<ListeningJobType, number> = {
  ENSURE_LISTENING_INVENTORY:       2,
  GENERATE_LISTENING_STORY:         3,
  GENERATE_LISTENING_QUESTIONS:     3,
  PREPARE_LISTENING_SUBTITLES:      3,
  GENERATE_LISTENING_SSML:          2,
  SYNTHESIZE_LISTENING_BLOCK_AUDIO: 3,
  SYNCHRONIZE_LISTENING_BLOCK:      2,
  VALIDATE_LISTENING_EPISODE:       3,
  PUBLISH_LISTENING_EPISODE:        3,
  REPAIR_LISTENING_EPISODE:         2,
  AUDIT_LISTENING_INVENTORY:        2,
  AUDIT_LISTENING_STORAGE:          2,
  CLEANUP_LISTENING_STAGING:        2,
  CALCULATE_LISTENING_PERFORMANCE:  3,
};

// ── Priorities ────────────────────────────────────────────────────────────────

export const JOB_PRIORITY = {
  URGENT: 100,
  HIGH:    50,
  NORMAL:  10,
  LOW:      1,
} as const;

export const DEFAULT_PRIORITY: Record<ListeningJobType, number> = {
  ENSURE_LISTENING_INVENTORY:       JOB_PRIORITY.LOW,
  GENERATE_LISTENING_STORY:         JOB_PRIORITY.NORMAL,
  GENERATE_LISTENING_QUESTIONS:     JOB_PRIORITY.NORMAL,
  PREPARE_LISTENING_SUBTITLES:      JOB_PRIORITY.NORMAL,
  GENERATE_LISTENING_SSML:          JOB_PRIORITY.NORMAL,
  SYNTHESIZE_LISTENING_BLOCK_AUDIO: JOB_PRIORITY.HIGH,
  SYNCHRONIZE_LISTENING_BLOCK:      JOB_PRIORITY.HIGH,
  VALIDATE_LISTENING_EPISODE:       JOB_PRIORITY.HIGH,
  PUBLISH_LISTENING_EPISODE:        JOB_PRIORITY.HIGH,
  REPAIR_LISTENING_EPISODE:         JOB_PRIORITY.URGENT,
  AUDIT_LISTENING_INVENTORY:        JOB_PRIORITY.LOW,
  AUDIT_LISTENING_STORAGE:              JOB_PRIORITY.LOW,
  CLEANUP_LISTENING_STAGING:            JOB_PRIORITY.LOW,
  CALCULATE_LISTENING_PERFORMANCE:      JOB_PRIORITY.NORMAL,
};

// ── Retry backoff ─────────────────────────────────────────────────────────────
// Delays in ms, indexed by (attempt - 1). Jitter of ±10% is applied at runtime.

const BACKOFF_DELAYS_MS = [60_000, 300_000, 1_800_000]; // 1m, 5m, 30m

export function getRetryDelayMs(attempt: number): number {
  const base = BACKOFF_DELAYS_MS[Math.min(attempt - 1, BACKOFF_DELAYS_MS.length - 1)] ?? 1_800_000;
  const jitter = base * 0.1 * (Math.random() * 2 - 1);
  return Math.round(base + jitter);
}

// ── Concurrency ───────────────────────────────────────────────────────────────

export type ListeningJobConcurrencyConfig = {
  maxConcurrentText:    number;
  maxConcurrentAzure:   number;
  maxConcurrentSync:    number;
  maxConcurrentPublish: number;
};

export const JOB_CONCURRENCY: ListeningJobConcurrencyConfig = {
  maxConcurrentText:    2,
  maxConcurrentAzure:   1,
  maxConcurrentSync:    2,
  maxConcurrentPublish: 1,
};

// Text-generation job types (governed by maxConcurrentText)
export const TEXT_JOB_TYPES: ListeningJobType[] = [
  'GENERATE_LISTENING_STORY',
  'GENERATE_LISTENING_QUESTIONS',
  'PREPARE_LISTENING_SUBTITLES',
  'GENERATE_LISTENING_SSML',
];

// Azure synthesis job types (governed by maxConcurrentAzure)
export const AZURE_JOB_TYPES: ListeningJobType[] = [
  'SYNTHESIZE_LISTENING_BLOCK_AUDIO',
];

// Synchronization job types (governed by maxConcurrentSync)
export const SYNC_JOB_TYPES: ListeningJobType[] = [
  'SYNCHRONIZE_LISTENING_BLOCK',
];

// Publication job types (governed by maxConcurrentPublish)
export const PUBLISH_JOB_TYPES: ListeningJobType[] = [
  'VALIDATE_LISTENING_EPISODE',
  'PUBLISH_LISTENING_EPISODE',
];

// ── Inventory ─────────────────────────────────────────────────────────────────

export const INVENTORY_CONFIG = {
  MINIMUM_PER_LEVEL:        3,
  DESIRED_PER_LEVEL:        7,
  MAXIMUM_PER_LEVEL:        14,
  ACTIVE_USER_WINDOW_DAYS:  30,
  MAX_NEW_PIPELINES_PER_DAY: 10,
  MAX_AZURE_SYNTHS_PER_HOUR:  6,
} as const;

// ── Heartbeat ─────────────────────────────────────────────────────────────────

export const HEARTBEAT_INTERVAL_MS = 60_000; // 1 minute

// ── Retention ─────────────────────────────────────────────────────────────────

export const RETENTION_DAYS = {
  COMPLETED:   90,
  CANCELLED:   90,
  FAILED:     180,
  DEAD_LETTER: Infinity, // never auto-delete
} as const;
