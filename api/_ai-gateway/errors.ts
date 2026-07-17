/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 * Gateway-specific error types and codes.
 */

export type GatewayErrorCode =
  | 'AI_GATEWAY_UNKNOWN_FEATURE'
  | 'AI_GATEWAY_ENFORCEMENT_NOT_READY'
  | 'AI_GATEWAY_POLICY_FETCH_FAILED'
  | 'AI_GATEWAY_TELEMETRY_FAILED';

export class GatewayError extends Error {
  constructor(
    public readonly code: GatewayErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}
