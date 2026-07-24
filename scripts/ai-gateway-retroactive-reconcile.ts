#!/usr/bin/env tsx
/**
 * CLI: Retroactive batch reconciliation for AI Gateway usage events whose
 * cost couldn't be calculated when they were first recorded, typically
 * because a provider_pricing rate hadn't been registered yet at that time.
 *
 * Default target set (no arguments): every ai_usage_events row with
 * cost_status='pending'. Events already in 'calculated'/'reconciled'/
 * 'not_applicable'/'unavailable' are NEVER touched by the default run — this
 * script only closes catalog gaps for events still waiting on a price, it
 * never second-guesses an event already reconciled. To recalculate a
 * specific already-reconciled event on purpose, name it explicitly with
 * --event (see scripts/ai-gateway-reconcile-event.ts for the single-event
 * form used for that case).
 *
 * Never calls OpenAI/Azure/any external provider — it only reads
 * provider_pricing (via the same PricingRepositoryInterface every real
 * request uses) and the already-recorded ai_usage_events/
 * ai_usage_event_metrics rows. Pricing math is never reimplemented here:
 * every classification and every write goes through the existing
 * calculateEventCost (pure, read-only classification) / reconcileEventCost
 * (the real, tested, idempotent persistence path) from
 * api/_ai-gateway/cost-calculator.ts.
 *
 * Modes:
 *   (no flags)   Dry-run. Classifies every candidate as reconciliable (a
 *                price now covers every billable metric, given the event's
 *                own started_at) or still-uncovered (at least one billable
 *                metric still has no matching provider_pricing row for that
 *                timestamp), and reports counts + ids. Writes nothing to
 *                ai_usage_events/ai_usage_event_metrics.
 *   --apply      Same classification, then actually persists via
 *                reconcileEventCost for every event classified reconciliable
 *                in this same run. Still never touches still-uncovered
 *                events (nothing to write — no price found).
 *
 * Options:
 *   --event <id1,id2,...>  Restrict to these specific event ids instead of
 *                          the default cost_status='pending' query. Only way
 *                          to include a non-'pending' event — the explicit
 *                          request the class docstring above requires.
 *   --limit <n>            Cap how many candidate events are considered
 *                          (default: no cap). Applies only to the default
 *                          'pending' query, not to --event.
 *
 * Every run (dry-run or apply) writes one summary row to admin_audit_log via
 * recordRetroactiveReconciliationAudit — see
 * api/_ai-gateway/retroactive-reconciliation-audit.ts. An audit-log failure
 * never aborts or fails the run itself.
 *
 * Idempotent: re-running with the same inputs after an --apply is a safe
 * no-op for every event that run already priced (its cost_status is no
 * longer 'pending', so it drops out of the default candidate set on the
 * next run); reconcileEventCost itself is also independently idempotent
 * (recalculating the same stored metrics against the same price rows always
 * overwrites with the same deterministic values).
 *
 * Usage:
 *   npx tsx scripts/ai-gateway-retroactive-reconcile.ts                 # dry-run, all pending
 *   npx tsx scripts/ai-gateway-retroactive-reconcile.ts --apply
 *   npx tsx scripts/ai-gateway-retroactive-reconcile.ts --limit 50
 *   npx tsx scripts/ai-gateway-retroactive-reconcile.ts --event <id>,<id> --apply
 */

import 'dotenv/config';
import { randomUUID } from 'crypto';
import {
  getProductionDeps,
  getSharedServiceClient,
  calculateEventCost,
  reconcileEventCost,
} from '../api/_ai-gateway/index';
import { recordRetroactiveReconciliationAudit } from '../api/_ai-gateway/retroactive-reconciliation-audit';

interface CliArgs {
  apply: boolean;
  limit: number | null;
  eventIds: string[] | null;
}

function parseArgs(argv: string[]): CliArgs {
  let apply = false;
  let limit: number | null = null;
  let eventIds: string[] | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--limit') {
      const raw = argv[++i];
      const parsed = raw ? Number.parseInt(raw, 10) : NaN;
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--limit requires a positive integer, got: ${raw}`);
      }
      limit = parsed;
    } else if (arg === '--event') {
      const raw = argv[++i];
      if (!raw) throw new Error('--event requires a comma-separated list of event ids');
      eventIds = raw.split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { apply, limit, eventIds };
}

interface CandidateClassification {
  eventId: string;
  provider: string;
  service: string | null;
  model: string | null;
  startedAt: string;
  reconciliable: boolean;
  totalCostUsd: string | null;
  uncoveredMetricKeys: string[];
}

async function classifyCandidate(
  eventId: string,
  deps: ReturnType<typeof getProductionDeps>,
): Promise<CandidateClassification | null> {
  const event = await deps.usageRepository.getEventForCosting(eventId);
  if (!event) return null;

  const metrics = await deps.usageRepository.getMetricsForEvent(eventId);
  if (metrics.length === 0) {
    return {
      eventId,
      provider: event.provider,
      service: event.service,
      model: event.model,
      startedAt: event.startedAt,
      reconciliable: false,
      totalCostUsd: null,
      uncoveredMetricKeys: [],
    };
  }

  const outcome = await calculateEventCost(event, metrics, deps.pricingRepository, deps.logger);
  const uncoveredMetricKeys = outcome.metricResults
    .filter((m) => m.calculatedCostUsd === null)
    .map((m) => m.metricKey);

  return {
    eventId,
    provider: event.provider,
    service: event.service,
    model: event.model,
    startedAt: event.startedAt,
    reconciliable: outcome.allBillableMetricsPriced,
    totalCostUsd: outcome.totalCostUsd,
    uncoveredMetricKeys,
  };
}

async function main() {
  if (!process.env.VITE_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('ERROR: VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
    process.exit(1);
  }

  const { apply, limit, eventIds } = parseArgs(process.argv.slice(2));
  const runId = randomUUID();
  const deps = getProductionDeps();

  let candidateIds: string[];
  if (eventIds) {
    candidateIds = eventIds;
  } else {
    const supabase = getSharedServiceClient();
    let query = supabase
      .from('ai_usage_events')
      .select('id')
      .eq('cost_status', 'pending')
      .eq('is_billable', true)
      .order('started_at', { ascending: true });
    if (limit) query = query.limit(limit);

    const { data, error } = await query;
    if (error) {
      console.error('Failed to query candidate events:', error.message);
      process.exit(1);
      return;
    }
    candidateIds = (data ?? []).map((r) => (r as { id: string }).id);
  }

  console.log(`[run ${runId}] mode=${apply ? 'apply' : 'dry_run'} candidates=${candidateIds.length}`);

  const reconciliable: CandidateClassification[] = [];
  const stillUncovered: CandidateClassification[] = [];

  for (const id of candidateIds) {
    const classification = await classifyCandidate(id, deps);
    if (!classification) {
      console.log(`  - ${id}: NOT FOUND (skipped)`);
      continue;
    }
    if (classification.reconciliable) {
      reconciliable.push(classification);
    } else {
      stillUncovered.push(classification);
    }
  }

  console.log('\n=== Reconciliable (price now covers every billable metric) ===');
  for (const c of reconciliable) {
    console.log(`  ${c.eventId}  ${c.provider}/${c.service ?? '-'}/${c.model ?? '-'}  started_at=${c.startedAt}  totalCostUsd=${c.totalCostUsd}`);
  }
  if (reconciliable.length === 0) console.log('  (none)');

  console.log('\n=== Still uncovered (no matching price for at least one billable metric) ===');
  for (const c of stillUncovered) {
    console.log(`  ${c.eventId}  ${c.provider}/${c.service ?? '-'}/${c.model ?? '-'}  started_at=${c.startedAt}  missing=[${c.uncoveredMetricKeys.join(', ')}]`);
  }
  if (stillUncovered.length === 0) console.log('  (none)');

  const appliedEventIds: string[] = [];
  const failedEventIds: string[] = [];

  if (apply) {
    console.log('\n=== Applying (writing via reconcileEventCost) ===');
    for (const c of reconciliable) {
      try {
        const result = await reconcileEventCost(c.eventId, {
          usageRepository: deps.usageRepository,
          pricingRepository: deps.pricingRepository,
          logger: deps.logger,
        });
        if (result.outcome === 'calculated') {
          appliedEventIds.push(c.eventId);
          console.log(`  ${c.eventId}: calculated (totalCostUsd=${result.totalCostUsd})`);
        } else {
          failedEventIds.push(c.eventId);
          console.log(`  ${c.eventId}: outcome=${result.outcome} (not applied)`);
        }
      } catch (err) {
        failedEventIds.push(c.eventId);
        console.error(`  ${c.eventId}: FAILED —`, err instanceof Error ? err.message : err);
      }
    }
  }

  console.log(
    `\nSummary: candidates=${candidateIds.length} reconciliable=${reconciliable.length} ` +
    `stillUncovered=${stillUncovered.length} applied=${appliedEventIds.length} failed=${failedEventIds.length}`,
  );
  if (!apply) {
    console.log('Dry-run only — nothing was written. Re-run with --apply to persist.');
  }

  await recordRetroactiveReconciliationAudit({
    runId,
    mode: apply ? 'apply' : 'dry_run',
    candidateEventIds: candidateIds,
    reconciliableEventIds: reconciliable.map((c) => c.eventId),
    stillUncoveredEventIds: stillUncovered.map((c) => c.eventId),
    appliedEventIds,
    failedEventIds,
  });
}

main().catch((err) => {
  console.error('Retroactive reconciliation failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
