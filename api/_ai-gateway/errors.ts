/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 * Gateway-specific error types and codes.
 */

export type GatewayErrorCode =
  | 'AI_GATEWAY_UNKNOWN_FEATURE'
  | 'AI_GATEWAY_ENFORCEMENT_NOT_READY'
  | 'AI_GATEWAY_POLICY_FETCH_FAILED'
  | 'AI_GATEWAY_TELEMETRY_FAILED'
  // ── Etapa 11 — enforcement error codes ────────────────────────────────────
  // Stable, typed codes for the enforcement pipeline. Only ever thrown in
  // 'enforce' mode (no feature is enforce-active at the end of this stage) —
  // legacy/observe never throw these; they only ever record a decision.
  | 'FEATURE_DISABLED'
  | 'USER_BLOCKED'
  | 'PLAN_NOT_ALLOWED'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'BUDGET_EXCEEDED'
  | 'DUPLICATE_IN_PROGRESS'
  | 'CIRCUIT_OPEN'
  | 'RESERVATION_FAILED'
  | 'POLICY_UNAVAILABLE'
  | 'ENFORCEMENT_NOT_READY';

// HTTP status mapping for the Etapa 11 codes — used by callers translating a
// GatewayError into an API response. Never exposes stack traces, provider
// payloads, internal budgets, or other users' data — only this fixed set of
// safe fields (code, message, retryAfter, resetAt, featureKey, rounded
// limit/usage) belongs in a client-facing body built from this.
export const GATEWAY_ERROR_HTTP_STATUS: Record<GatewayErrorCode, number> = {
  AI_GATEWAY_UNKNOWN_FEATURE:      500,
  AI_GATEWAY_ENFORCEMENT_NOT_READY: 503,
  AI_GATEWAY_POLICY_FETCH_FAILED:  503,
  AI_GATEWAY_TELEMETRY_FAILED:     500,
  FEATURE_DISABLED:                403,
  USER_BLOCKED:                    403,
  PLAN_NOT_ALLOWED:                403,
  RATE_LIMITED:                    429,
  QUOTA_EXCEEDED:                  429,
  BUDGET_EXCEEDED:                 429,
  DUPLICATE_IN_PROGRESS:           409,
  CIRCUIT_OPEN:                    503,
  RESERVATION_FAILED:              503,
  POLICY_UNAVAILABLE:              503,
  ENFORCEMENT_NOT_READY:           503,
};

export class GatewayError extends Error {
  constructor(
    public readonly code: GatewayErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'GatewayError';
  }

  get httpStatus(): number {
    return GATEWAY_ERROR_HTTP_STATUS[this.code];
  }
}
