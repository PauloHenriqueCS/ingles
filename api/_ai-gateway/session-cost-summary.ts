/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Pure aggregation of a client-driven bridge session's REAL recorded cost
 * (conversation.realtime_usage, pronunciation.assess_text) — the bridges
 * whose physical calls happen entirely in the browser, so there is no
 * invoke() for executeEnforcedPipeline/commit_gateway_reservation_v1 to
 * wrap. Used by reservation-reconciliation.ts to decide whether an upfront
 * budget reservation can be safely committed with a real number, or must
 * stay held (never released) because the real cost isn't fully known yet.
 *
 * No I/O here — the caller fetches events via
 * UsageRepositoryInterface.getSessionUsageEvents and passes them in.
 */

import { sumDecimalStrings } from './decimal';

export interface SessionCostEvent {
  id: string;
  // Decimal string, or null when this event's cost hasn't been calculated
  // yet (cost_status still 'pending' — pricing not yet resolved). NEVER
  // treat null as 0: an unpriced event's real cost is unknown, not free.
  calculatedCostUsd: string | null;
}

export interface SessionCostSummary {
  eventCount: number;
  // True only when EVERY event in the session has a known calculated cost.
  allCosted: boolean;
  // Sum of every event's calculatedCostUsd — only set when allCosted is
  // true. null when eventCount > 0 but at least one event is still
  // unpriced: the real total cannot yet be proven, so it must never be
  // guessed or partially summed as if it were final.
  totalCostUsd: string | null;
  // The most recently completed event — a real, valid ai_usage_events.id
  // for the reservation's usage_event_id pointer. null when eventCount is 0.
  representativeEventId: string | null;
}

export function summarizeSessionCost(events: readonly SessionCostEvent[]): SessionCostSummary {
  if (events.length === 0) {
    return { eventCount: 0, allCosted: true, totalCostUsd: null, representativeEventId: null };
  }

  let allCosted = true;
  const costs: string[] = [];
  for (const e of events) {
    if (e.calculatedCostUsd === null) {
      allCosted = false;
      continue;
    }
    costs.push(e.calculatedCostUsd);
  }

  return {
    eventCount: events.length,
    allCosted,
    totalCostUsd: allCosted ? sumDecimalStrings(costs) : null,
    representativeEventId: events[events.length - 1].id,
  };
}
