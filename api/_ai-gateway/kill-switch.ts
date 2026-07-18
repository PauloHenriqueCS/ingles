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
 * cache is needed here, which keeps "reflected within 5 seconds" true by
 * construction rather than by a second, independently-tuned cache.
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
