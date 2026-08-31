/**
 * SERVER-ONLY behavioral-push SWEEP handler. Invoked by pg_cron → pg_net at the
 * consolidated internal dispatcher route
 * (GET /api/internal/listening/behavioral-push-sweep) — NOT a new Vercel
 * function (the project is at 12/12 on Hobby). Authentication (CRON_SECRET) is
 * enforced by the dispatcher before this runs.
 *
 * Flow per candidate: decide type (pure, reuses Home's streak math) → verify
 * entitlement (existing server-authoritative logic) → resolve language + copy →
 * ATOMIC claim (DB unique = last line of defense) → immediate revalidation
 * (race with a 20:00 completion / cooldown) → real send OR dry_run → mark.
 *
 * Batched + paginated (no full-base load, no per-user N+1 for eligibility — the
 * heavy aggregation is one SQL call per batch). Structured, sanitized logs only.
 */

import { methodGuard, safeLog } from '../_helpers';
import { getSharedServiceClient } from '../_ai-gateway/index';
import {
  isBehavioralPushEnabled,
  isBehavioralPushDryRun,
  getBehavioralPushTestUserIds,
  getBehavioralPushEnvironment,
  getOneSignalServerAppId,
  getOneSignalRestApiKey,
} from '../_env';
import { getCurrentUserPlanEntitlements } from '../_entitlements/plan-entitlements-service';
import { canSendCommunication } from '../_account/communication-suppression';
import { BEHAVIORAL_PUSH, decideBehavioralPush } from './behavioralPushDomain';
import { buildBehavioralPushCopy, resolvePushLanguage } from './behavioralPushCopy';
import { sendBehavioralPush } from './oneSignalServer';
import { shouldRealSend, resolveUserInterfaceLanguage, type SendGateConfig } from './behavioralPushConfig';

const LOG = 'internal/listening/behavioral-push-sweep';
/** Max candidate batches processed per invocation — keeps the request short;
 *  pg_cron re-runs within the 20:00 window pick up any remainder. */
const MAX_BATCHES = 5;

interface CandidateRow {
  user_id: string;
  active_weekdays: number[];
  active_dates: string[];
  practiced_today: boolean;
  account_created_date: string;
  last_activity_at: string | null;
}

interface SweepStats {
  candidates: number;
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
  dryRun: number;
}

/** São Paulo local date (YYYY-MM-DD) and hour (0-23). */
function spDateAndHour(now: Date): { date: string; hour: number } {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);
  const hourStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    hour12: false,
    hour: '2-digit',
  }).format(now);
  // 'en-US' 2-digit hour can render midnight as '24' — normalize to 0.
  const hour = Number(hourStr) % 24;
  return { date, hour };
}

export async function handleBehavioralPushSweep(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['GET'])) return;

  const startedAt = Date.now();
  const stats: SweepStats = { candidates: 0, claimed: 0, sent: 0, failed: 0, skipped: 0, dryRun: 0 };

  try {
    const { date: spDate, hour: spHour } = spDateAndHour(new Date());

    // Window gate: only evaluate at ~20:00 America/Sao_Paulo. `force=1` (still
    // CRON_SECRET-authed) bypasses it for controlled homolog testing.
    const forced = req.query?.force === '1' || req.query?.force === 'true';
    if (!forced && (spHour < BEHAVIORAL_PUSH.EVAL_HOUR_SP_START || spHour > BEHAVIORAL_PUSH.EVAL_HOUR_SP_END)) {
      safeLog(LOG, 'outside_window', 200, { spHour });
      return res.status(200).json({ skipped: 'outside_window', spHour, spDate });
    }

    const supabase = getSharedServiceClient();
    const environment = getBehavioralPushEnvironment();
    const gate: SendGateConfig = {
      enabled: isBehavioralPushEnabled(),
      dryRun: isBehavioralPushDryRun(),
      testUserIds: getBehavioralPushTestUserIds(),
      appId: getOneSignalServerAppId(),
      restApiKey: getOneSignalRestApiKey(),
    };

    const limit = BEHAVIORAL_PUSH.SWEEP_BATCH_SIZE;
    let offset = 0;

    // Test allowlist may bypass the ACCOUNT-TYPE exclusions (admin/internal,
    // deactivated, comm-suppressed) so an explicitly-allowlisted account can be
    // tested end-to-end in homologation — NEVER in production (there the list is
    // empty by design; this hard-gates it regardless). Behavioral rules
    // (practiced-today, cooldown, idempotency, weekday, streak/abandon) are
    // never bypassed. See migration 20260831120000.
    const bypassUserIds = environment === 'production' ? [] : Array.from(gate.testUserIds);

    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const { data, error } = await supabase.rpc('behavioral_push_candidates', {
        p_local_date: spDate,
        p_lookback_days: BEHAVIORAL_PUSH.STREAK_LOOKBACK_DAYS,
        p_cooldown_hours: BEHAVIORAL_PUSH.COOLDOWN_HOURS,
        p_limit: limit,
        p_offset: offset,
        p_bypass_user_ids: bypassUserIds,
      });
      if (error) {
        safeLog(LOG, 'candidates_error', 500, { error: error.message });
        break;
      }
      const rows = (data ?? []) as CandidateRow[];
      if (rows.length === 0) break;
      stats.candidates += rows.length;

      for (const row of rows) {
        await processCandidate(supabase, row, spDate, environment, gate, stats);
      }

      if (rows.length < limit) break;
      offset += limit;
    }

    const durationMs = Date.now() - startedAt;
    const dryRunMode = !gate.enabled || gate.dryRun;
    safeLog(LOG, 'sweep_done', 200, { ...stats, durationMs, environment, dryRunMode });
    return res.status(200).json({ success: true, ...stats, durationMs, environment, spDate });
  } catch (err) {
    safeLog(LOG, 'sweep_error', 500, {
      error: err instanceof Error ? err.message : String(err),
      ...stats,
    });
    return res.status(500).json({ success: false, error: 'Behavioral push sweep failed.' });
  }
}

async function processCandidate(
  supabase: any,
  row: CandidateRow,
  spDate: string,
  environment: string,
  gate: SendGateConfig,
  stats: SweepStats,
): Promise<void> {
  // 1. Decide push type (pure — reuses computeWeekdayStreak).
  const decision = decideBehavioralPush({
    userId: row.user_id,
    activeWeekdays: row.active_weekdays ?? [],
    activeDates: row.active_dates ?? [],
    practicedToday: row.practiced_today,
    accountCreatedDate: row.account_created_date,
    localDate: spDate,
  });
  if (!decision.pushType) return;

  // 2. Entitlement — must have >= 1 accessible practice modality right now.
  //    Fail closed: if we can't verify, don't send.
  let canPractice = false;
  try {
    const ent = await getCurrentUserPlanEntitlements(row.user_id);
    canPractice =
      ent.writing.enabled || ent.listening.enabled || ent.pronunciation.enabled || ent.conversation.enabled;
  } catch {
    return;
  }
  if (!canPractice) return;

  // 3. Language + deterministic copy (built before claim to persist the variant).
  const language = resolvePushLanguage(await resolveUserInterfaceLanguage(supabase, row.user_id));
  const copy = buildBehavioralPushCopy({
    pushType: decision.pushType,
    language,
    streak: decision.streak,
  });

  // 4. Atomic claim (ON CONFLICT (user_id, local_date) DO NOTHING).
  let claimId: string | null = null;
  try {
    const { data, error } = await supabase.rpc('behavioral_push_claim', {
      p_user_id: row.user_id,
      p_local_date: spDate,
      p_push_type: decision.pushType,
      p_environment: environment,
      p_interface_language: language,
      p_copy_variant: copy.variant,
      p_streak: decision.streak,
      p_missed_days: decision.missedStudyDays,
      p_last_activity_at: row.last_activity_at,
    });
    if (error) {
      safeLog(LOG, 'claim_error', 500, { error: error.message });
      return;
    }
    claimId = (data as string | null) ?? null;
  } catch (err) {
    safeLog(LOG, 'claim_exception', 500, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!claimId) return; // lost the race / already decided today
  stats.claimed++;

  // 5. Immediate revalidation (race with a 20:00 completion + cooldown).
  try {
    const { data: stillEligible } = await supabase.rpc('behavioral_push_revalidate', {
      p_user_id: row.user_id,
      p_local_date: spDate,
      p_cooldown_hours: BEHAVIORAL_PUSH.COOLDOWN_HOURS,
    });
    if (stillEligible !== true) {
      await mark(supabase, claimId, 'skipped', { failureCode: 'revalidation_failed' });
      stats.skipped++;
      return;
    }
  } catch {
    await mark(supabase, claimId, 'skipped', { failureCode: 'revalidation_error' });
    stats.skipped++;
    return;
  }

  // 6. Real send vs dry-run.
  if (!shouldRealSend(row.user_id, gate)) {
    await mark(supabase, claimId, 'dry_run', {});
    stats.dryRun++;
    return;
  }

  // 7. Suppression gate immediately before the actual send (fails closed).
  const allowed = await canSendCommunication({ userId: row.user_id, channel: 'push', scope: 'marketing' });
  if (!allowed) {
    await mark(supabase, claimId, 'skipped', { failureCode: 'communication_blocked' });
    stats.skipped++;
    return;
  }

  // 8. Send. Only a genuine provider success counts as 'sent'.
  const result = await sendBehavioralPush({
    appId: gate.appId,
    restApiKey: gate.restApiKey,
    externalId: row.user_id,
    title: copy.title,
    body: copy.body,
    data: { behavioral_push_event_id: claimId, push_type: decision.pushType },
  });

  if (result.ok) {
    await mark(supabase, claimId, 'sent', {
      notificationId: result.notificationId,
      attributionHours: BEHAVIORAL_PUSH.ATTRIBUTION_WINDOW_HOURS,
    });
    stats.sent++;
  } else {
    await mark(supabase, claimId, 'failed', { failureCode: result.failureCode });
    stats.failed++;
  }
}

async function mark(
  supabase: any,
  id: string,
  status: 'sent' | 'failed' | 'skipped' | 'dry_run',
  opts: { notificationId?: string | null; failureCode?: string | null; attributionHours?: number },
): Promise<void> {
  try {
    await supabase.rpc('behavioral_push_mark', {
      p_id: id,
      p_status: status,
      p_onesignal_notification_id: opts.notificationId ?? null,
      p_failure_code: opts.failureCode ?? null,
      p_attribution_hours: opts.attributionHours ?? null,
    });
  } catch (err) {
    safeLog(LOG, 'mark_error', 500, { status, error: err instanceof Error ? err.message : String(err) });
  }
}
