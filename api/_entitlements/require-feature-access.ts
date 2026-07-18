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
  | 'RECORDING_TOO_LONG'
  | 'CONFIGURATION_ERROR';

export interface FeatureAccessCheck {
  allowed: boolean;
  code?: FeatureAccessDenialCode;
  message?: string;
}

const ALLOWED: FeatureAccessCheck = { allowed: true };

/**
 * Checks ONLY for the config_error state, independent of enabled/canStart —
 * call this FIRST in every route, before any enabled/limit business-rule
 * check, so a missing capability on a partially-configured plan never falls
 * through and gets reported as "not included in your plan" or a normal
 * exhausted-limit message. Never calls the AI provider when this returns
 * non-null.
 */
export function checkFeatureConfigError(limit: FeatureLimit): FeatureAccessCheck | null {
  if (limit.state === 'config_error') {
    return { allowed: false, code: 'CONFIGURATION_ERROR', message: ENTITLEMENT_MESSAGES.configurationError };
  }
  return null;
}

/** Checks a feature's on/off flag plus its per-period limit (daily or monthly). */
export function requireFeatureAccess(
  featureEnabled: boolean,
  limit: FeatureLimit,
  exhaustedMessage: string,
): FeatureAccessCheck {
  // A missing capability on an otherwise-configured plan version is a
  // config bug, not a "not included in this plan" business rule — never
  // call the AI provider, never leak internals, always the safe message.
  if (limit.state === 'config_error') {
    return { allowed: false, code: 'CONFIGURATION_ERROR', message: ENTITLEMENT_MESSAGES.configurationError };
  }
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
