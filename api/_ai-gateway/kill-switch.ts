/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Kill-switch evaluation (Etapa 11, Fase 2). Reuses the runtime_status
 * already resolved by GatewayPolicyResolver from ai_runtime_controls — the
 * hierarchical global → provider → feature → user projection that has been
 * live since the Gateway's foundation migration, just never actually
 * enforced by gateway.ts until now.
 *
 * The kill-switch is checked in EVERY mode (legacy, observe, enforce) and
 * takes precedence over gateway_mode, plan, and quota — a manual
 * disabled/circuit_open/maintenance status always blocks, regardless of
 * anything else. Since every seeded control row defaults to
 * runtime_status='enabled', this is inert today: it only ever blocks once
 * an administrator explicitly changes a control's status.
 *
 * A short (5s, same TTL as the policy cache) in-memory staleness bound is
 * inherited for free from GatewayPolicyResolver's own cache — no separate
 * cache is needed here.
 *
 * Precise scope of that 5s bound — do not overstate it:
 *   - It bounds how long a NEW call can keep going through the OLD policy
 *     after an admin changes it — "blocked within up to 5 seconds for new
 *     calls," never "instantly," and never a guarantee tighter than the
 *     cache TTL actually in effect (GatewayPolicyResolver's constructor
 *     accepts a custom ttlMs; getProductionDeps() uses the 5000ms default —
 *     if that default is ever changed, this bound changes with it).
 *   - It says NOTHING about an already-connected OpenAI Realtime session.
 *     Kill-switch blocks NEW webrtc_connect/create_session calls within
 *     that window, but a session already streaming audio keeps running
 *     until it hits its own deadline or the best-effort
 *     session-control-poll-plus-hangup path (see
 *     api/conversation/[...slug].ts's handleSessionControl) closes it —
 *     which depends on a call_id having been captured and on
 *     hangupRealtimeCall actually succeeding, NEITHER of which has been
 *     live-tested against production OpenAI as of this delivery. Do not
 *     describe active-session termination as proven until a real smoke
 *     test with a real call_id confirms it.
 */

import type { RuntimeStatus } from './types';
import type { GatewayErrorCode } from './errors';

export interface KillSwitchDecision {
  blocked: boolean;
  reasonCode?: Extract<GatewayErrorCode, 'FEATURE_DISABLED' | 'CIRCUIT_OPEN'>;
}

/**
 * Pure function: no I/O, trivially testable. `cache_only` blocks too — this
 * Gateway has no response-cache layer to serve from, so "only serve from
 * cache" degrades to "make no new calls," same as disabled.
 */
export function evaluateKillSwitch(runtimeStatus: RuntimeStatus): KillSwitchDecision {
  switch (runtimeStatus) {
    case 'disabled':
    case 'cache_only':
      return { blocked: true, reasonCode: 'FEATURE_DISABLED' };
    case 'circuit_open':
    case 'paused_automatically':
      return { blocked: true, reasonCode: 'CIRCUIT_OPEN' };
    case 'maintenance':
      // Maintenance windows are also a deliberate stop — surfaced as the
      // same client-facing code as a manual disable (FEATURE_DISABLED),
      // since both mean "not available right now, not a client error."
      return { blocked: true, reasonCode: 'FEATURE_DISABLED' };
    case 'enabled':
    default:
      return { blocked: false };
  }
}
