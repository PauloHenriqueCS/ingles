export type RewriteStatus =
  | 'draft'
  | 'submitted'
  | 'evaluation_pending'
  | 'evaluated'
  | 'evaluation_failed'
  | 'superseded'
  | 'cancelled';

export const ALL_REWRITE_STATUSES: readonly RewriteStatus[] = [
  'draft',
  'submitted',
  'evaluation_pending',
  'evaluated',
  'evaluation_failed',
  'superseded',
  'cancelled',
] as const;

export const SUBMITTED_IMMUTABLE_FIELDS: ReadonlySet<string> = new Set([
  'rewrite_text',
  'original_submission_id',
  'review_id',
  'mission_id',
  'user_id',
  'rewrite_sequence',
  'submitted_at',
  'support_usage_snapshot',
]);

// Valid transitions map
const VALID_TRANSITIONS: ReadonlyMap<RewriteStatus, ReadonlySet<RewriteStatus>> = new Map([
  ['draft',              new Set<RewriteStatus>(['submitted', 'superseded', 'cancelled'])],
  ['submitted',          new Set<RewriteStatus>(['evaluation_pending', 'superseded', 'cancelled'])],
  ['evaluation_pending', new Set<RewriteStatus>(['evaluated', 'evaluation_failed'])],
  ['evaluated',          new Set<RewriteStatus>(['superseded'])],
  ['evaluation_failed',  new Set<RewriteStatus>(['evaluation_pending', 'cancelled'])],
  ['superseded',         new Set<RewriteStatus>()],
  ['cancelled',          new Set<RewriteStatus>()],
]);

// Explicitly forbidden transitions
const FORBIDDEN_TRANSITIONS: ReadonlySet<string> = new Set([
  'draft->evaluated',
  'evaluated->draft',
  'superseded->evaluated',
  'cancelled->submitted',
]);

export function canTransitionRewriteStatus(
  from: RewriteStatus,
  to: RewriteStatus,
): { allowed: boolean; reason?: string } {
  const forbiddenKey = `${from}->${to}`;
  if (FORBIDDEN_TRANSITIONS.has(forbiddenKey)) {
    return {
      allowed: false,
      reason: `Transition from '${from}' to '${to}' is explicitly forbidden`,
    };
  }

  const validTargets = VALID_TRANSITIONS.get(from);
  if (!validTargets) {
    return { allowed: false, reason: `Unknown source status: ${from}` };
  }

  if (!validTargets.has(to)) {
    return {
      allowed: false,
      reason: `Transition from '${from}' to '${to}' is not allowed`,
    };
  }

  return { allowed: true };
}

/** Returns true for terminal statuses (superseded | cancelled). */
export function isRewriteTerminal(status: RewriteStatus): boolean {
  return status === 'superseded' || status === 'cancelled';
}

/** Returns true for anything except 'draft' — content is immutable once submitted. */
export function isRewriteImmutable(status: RewriteStatus): boolean {
  return status !== 'draft';
}
