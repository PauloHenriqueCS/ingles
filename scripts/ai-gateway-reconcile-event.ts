#!/usr/bin/env tsx
/**
 * CLI: Recalculate the cost of a single AI usage event by id.
 *
 * Server-only, idempotent — safe to re-run. Never accepts a price from the
 * caller; every price is re-read from provider_pricing at call time. Use
 * this for events that stayed cost_status='pending' because no price was
 * registered yet, or after a transient telemetry failure.
 *
 * Usage:
 *   npx tsx scripts/ai-gateway-reconcile-event.ts <event-id>
 */

import 'dotenv/config';
import { getProductionDeps, reconcileEventCost } from '../api/_ai-gateway/index';

const eventId = process.argv[2];

if (!eventId) {
  console.error('Usage: npx tsx scripts/ai-gateway-reconcile-event.ts <event-id>');
  process.exit(1);
}

if (!process.env.VITE_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  process.exit(1);
}

async function main() {
  const deps = getProductionDeps();
  const outcome = await reconcileEventCost(eventId, {
    usageRepository: deps.usageRepository,
    pricingRepository: deps.pricingRepository,
    logger: deps.logger,
  });

  console.log(`Event ${eventId}: ${outcome}`);
  if (outcome === 'not_found') process.exitCode = 1;
}

main().catch((err) => {
  console.error('Reconciliation failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
