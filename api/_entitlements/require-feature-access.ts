/**
 * SERVER-ONLY: the definitive access checks. Call these immediately before
 * the costly operation in every route that consumes a plan-limited feature —
 * frontend state is UX only, this is the source of truth.
 */

import { ENTITLEMENT_MESSAGES } from '../../src/domain/entitlements/entitlement-messages';
import type { FeatureLimit } from '../../src/domain/entitlements/entitlement-types';

export type FeatureAccessDenialCode =
  | 'FEATURE_DISABLED'
  | 'DAILY_LIMIT_REACHED'
  | 'MONTHLY_LIMIT_REACHED'
  | 'CHARACTER_LIMIT_EXCEEDED'
  | 'RECORDING_TOO_LONG';

export interface FeatureAccessCheck {
  allowed: boolean;
  code?: FeatureAccessDenialCode;
  message?: string;
}

const ALLOWED: FeatureAccessCheck = { allowed: true };

/** Checks a feature's on/off flag plus its per-period limit (daily or monthly). */
export function requireFeatureAccess(
  featureEnabled: boolean,
  limit: FeatureLimit,
  exhaustedMessage: string,
): FeatureAccessCheck {
  if (!featureEnabled) {
    return { allowed: false, code: 'FEATURE_DISABLED', message: ENTITLEMENT_MESSAGES.featureUnavailable };
  }
  if (!limit.canStart) {
    const code: FeatureAccessDenialCode = limit.period === 'month' ? 'MONTHLY_LIMIT_REACHED' : 'DAILY_LIMIT_REACHED';
    return { allowed: false, code, message: exhaustedMessage };
  }
  return ALLOWED;
}

/** writing_max_characters_per_text — never applied when unlimited. */
export function checkTextLength(text: string, maxCharacters: number, unlimited: boolean): FeatureAccessCheck {
  if (unlimited) return ALLOWED;
  if (text.length <= maxCharacters) return ALLOWED;
  return {
    allowed: false,
    code: 'CHARACTER_LIMIT_EXCEEDED',
    message: ENTITLEMENT_MESSAGES.characterLimitReached(maxCharacters),
  };
}

/** pronunciation/conversation *_max_recording_seconds — never applied when unlimited. */
export function checkRecordingDuration(durationSeconds: number, maxSeconds: number, unlimited: boolean): FeatureAccessCheck {
  if (unlimited) return ALLOWED;
  if (durationSeconds <= maxSeconds) return ALLOWED;
  return {
    allowed: false,
    code: 'RECORDING_TOO_LONG',
    message: ENTITLEMENT_MESSAGES.recordingLimitReached(maxSeconds),
  };
}
