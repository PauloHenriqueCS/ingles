/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Operational alerts for external-provider failures (OpenAI / Azure Speech / …).
 *
 * Pipeline:
 *   provider fails
 *     → gateway failEvent() persists the sanitized failure in ai_usage_events
 *     → dispatchProviderIncident() (fire-and-forget) classifies + calls the
 *       atomic RPC record_provider_incident
 *     → the RPC decides open / increment / suppress in ONE DB transaction
 *       (dedup across all Vercel instances via the partial unique index)
 *     → only the instance that WON the "open" transition e-mails via Resend.
 *
 * Recovery is handled out-of-band by runRecoverySweep(), invoked by the
 * /api/internal/listening/alerts-recovery-sweep cron route — never on the hot
 * success path.
 *
 * HARD RULES (see the task brief and api/_ai-gateway/sanitize.ts):
 *   - This module NEVER calls OpenAI/Azure, NEVER goes through the AI Gateway,
 *     and NEVER writes an ai_usage_event — so an alert can never feed back into
 *     the failure pipeline it watches (no loop).
 *   - The e-mail carries ONLY already-sanitized, structured technical fields.
 *     No prompt, user text, generated content, audio, SSML, token, key,
 *     Authorization header, or raw provider body ever reaches it. The raw error
 *     object is never passed to the template.
 *   - Every entry point is wrapped so a failure here (including Resend down)
 *     can never throw into — or delay — the original user request.
 */

import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSharedServiceClient, SupabaseUsageRepository } from './usage-repository';
import type { AiFeatureKey } from './feature-catalog';
import { getResendApiKey, getAlertRecipientEmail, getAlertFromEmail, getAlertEnvironmentOverride } from '../_env';
import { isProductionDeployment } from '../_billing/revenuecat-environment';

export type ProviderErrorClass = 'auth' | 'rate_limit' | 'server' | 'connectivity';

export type AlertLogger = (event: string, data?: Record<string, unknown>) => void;

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const RESEND_TIMEOUT_MS = 5_000;

// ── Classification ────────────────────────────────────────────────────────────
// Mirrors _ai_alert_status_matches_class() in the migration so the live
// classification and the DB window-count can never disagree. Returns null for
// anything that is NOT an operational outage (400/404/2xx, unknown) so ordinary
// client errors never raise an alert.

const CONNECTIVITY_HINT =
  /timeout|timed out|abort|econnreset|econnrefused|enotfound|network|connection|fetch failed|socket|apiconnection|azure_speech_timeout|azure_speech_unavailable|azure_tts_timeout|azure_tts_network|azure_network/i;

export function classifyProviderError(input: {
  httpStatus?: number | null;
  code?: string | null;
  category?: string | null;
}): ProviderErrorClass | null {
  const s = input.httpStatus;
  if (s === 401 || s === 403) return 'auth';
  if (s === 429) return 'rate_limit';
  if (typeof s === 'number' && s >= 500 && s <= 599) return 'server';
  if (s === undefined || s === null) {
    const hay = `${input.code ?? ''} ${input.category ?? ''}`;
    if (CONNECTIVITY_HINT.test(hay)) return 'connectivity';
  }
  return null;
}

// ── Provider + environment labelling ──────────────────────────────────────────

/** Stable dedup label for a raw ai_usage_events.provider value. */
export function providerLabel(providerRaw: string): string {
  return providerRaw.trim().toLowerCase() === 'azure' ? 'azure_speech' : providerRaw.trim().toLowerCase();
}

/** Human-facing provider name for the e-mail. */
export function providerDisplayName(providerRaw: string): string {
  const p = providerRaw.trim().toLowerCase();
  if (p === 'azure') return 'Azure Speech';
  if (p === 'openai') return 'OpenAI';
  return providerRaw;
}

export interface AlertEnvironment {
  /** Value stored in ai_alerts.environment (constrained to the existing enum). */
  dbValue: 'production' | 'staging';
  /** Label shown in the e-mail subject. */
  label: 'PRODUCTION' | 'HOMOLOG';
}

export function resolveAlertEnvironment(): AlertEnvironment {
  // Explicit ALERT_ENVIRONMENT wins — it is the ONLY reliable way to tell the
  // homologation project (which also runs with VERCEL_ENV='production', because
  // it deploys via `vercel deploy --prod`) apart from the real production
  // project. 'production'/'prod' → PRODUCTION; any other explicit value →
  // HOMOLOG. Falls back to the VERCEL_ENV mapping only when unset.
  const override = getAlertEnvironmentOverride();
  if (override) {
    return override === 'production' || override === 'prod'
      ? { dbValue: 'production', label: 'PRODUCTION' }
      : { dbValue: 'staging', label: 'HOMOLOG' };
  }
  return isProductionDeployment()
    ? { dbValue: 'production', label: 'PRODUCTION' }
    : { dbValue: 'staging', label: 'HOMOLOG' };
}

// ── Sanitized incident signal (the ONLY shape the hot path passes in) ─────────

export interface IncidentSignal {
  /** ai_usage_events.provider — 'openai' | 'azure' | future. */
  providerRaw: string;
  featureKey: string;
  /** Already-sanitized fields (see sanitize.ts). NEVER a raw error object. */
  httpStatus?: number | null;
  errorCode?: string | null;
  errorCategory?: string | null;
  service?: string | null;
  operationPart?: string | null;
  providerRequestId?: string | null;
  correlationId?: string | null;
}

// ── Injectable dependencies (mirrors the gateway's DI pattern) ────────────────

export interface AlertDeps {
  supabase: SupabaseClient;
  /** Sends the e-mail. Returns void; never throws (logs and swallows). */
  sendEmail: (subject: string, text: string) => Promise<void>;
  logger: AlertLogger;
  now: () => Date;
}

const defaultLogger: AlertLogger = (event, data) => {
  // Reuses the safe structured-log shape used across the gateway: technical
  // event + allowlisted fields only, on console.error.
  console.error(JSON.stringify({ alerts: event, ...(data ?? {}), t: Date.now() }));
};

export function getProductionAlertDeps(): AlertDeps {
  const logger = defaultLogger;
  return {
    supabase: getSharedServiceClient(),
    sendEmail: (subject, text) => resendSendEmail(subject, text, logger),
    logger,
    now: () => new Date(),
  };
}

// ── E-mail bodies (pure — unit-tested for the absence of sensitive fields) ────

interface OpenEmailInput {
  env: AlertEnvironment;
  display: string;
  errorClass: ProviderErrorClass;
  signal: IncidentSignal;
  occurrenceCount: number | null;
  severity: string | null;
  occurredAt: string; // ISO
}

export function buildOpenEmail(input: OpenEmailInput): { subject: string; text: string } {
  const { env, display, errorClass, signal, occurrenceCount, severity, occurredAt } = input;
  const subject = `[ORODIM ALERT][${env.label}] ${display} — ${errorClass.toUpperCase()}`;
  const lines: Array<string | null> = [
    `Provider: ${display}`,
    `Environment: ${env.label.toLowerCase()}`,
    `Error class: ${errorClass}`,
    `HTTP status: ${signal.httpStatus ?? 'n/a'}`,
    `Error code: ${signal.errorCode ?? 'n/a'}`,
    `Error category: ${signal.errorCategory ?? 'n/a'}`,
    `Feature: ${signal.featureKey}`,
    signal.service ? `Service: ${signal.service}` : null,
    signal.operationPart ? `Operation part: ${signal.operationPart}` : null,
    `Occurrences (window): ${occurrenceCount ?? 'n/a'}`,
    `Severity: ${severity ?? 'n/a'}`,
    `Opened at: ${occurredAt}`,
    signal.providerRequestId ? `Provider request ID: ${signal.providerRequestId}` : null,
    signal.correlationId ? `Correlation ID: ${signal.correlationId}` : null,
    '',
    'Automated Orodim operational alert. Detection is immediate at the AI Gateway failure sink; recovery is confirmed by the periodic sweep.',
  ];
  return { subject, text: lines.filter((l): l is string => l !== null).join('\n') };
}

interface RecoveredPayload {
  environment?: string;
  provider?: string;      // raw provider
  error_class?: string;
  severity?: string;
  occurrence_count?: number;
  opened_at?: string;
  first_occurrence?: string;
  last_occurrence?: string;
}

export function buildRecoveredEmail(payload: RecoveredPayload, resolvedAt: string): { subject: string; text: string } {
  const envLabel = payload.environment === 'production' ? 'PRODUCTION' : 'HOMOLOG';
  const display = providerDisplayName(payload.provider ?? '');
  const subject = `[ORODIM RECOVERED][${envLabel}] ${display}`;
  const lines: Array<string | null> = [
    `Provider: ${display}`,
    `Environment: ${envLabel.toLowerCase()}`,
    payload.error_class ? `Error class: ${payload.error_class}` : null,
    payload.severity ? `Severity: ${payload.severity}` : null,
    `Total occurrences: ${payload.occurrence_count ?? 'n/a'}`,
    payload.opened_at ? `Opened at: ${payload.opened_at}` : null,
    payload.first_occurrence ? `First occurrence: ${payload.first_occurrence}` : null,
    payload.last_occurrence ? `Last failure: ${payload.last_occurrence}` : null,
    `Recovered at: ${resolvedAt}`,
    '',
    `${display} is responding normally again. This incident has been auto-resolved.`,
  ];
  return { subject, text: lines.filter((l): l is string => l !== null).join('\n') };
}

// ── Resend transport (HTTP API, no SDK dependency) ────────────────────────────

/**
 * Sends one alert e-mail. Fails SAFE: a missing key/recipient, a Resend error,
 * a timeout, or a network failure only emits a sanitized log line — never
 * throws. Subject/body are already-safe alert strings; the body is never logged.
 */
export async function resendSendEmail(subject: string, text: string, logger: AlertLogger): Promise<void> {
  const apiKey = getResendApiKey();
  const to = getAlertRecipientEmail();
  const from = getAlertFromEmail();

  if (!apiKey || !to) {
    logger('alerts.email.skipped_not_configured', { hasKey: Boolean(apiKey), hasRecipient: Boolean(to) });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text }),
      signal: controller.signal,
    });
    if (!res.ok) {
      logger('alerts.email.http_error', { status: res.status });
      return;
    }
    logger('alerts.email.sent', { status: res.status });
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    logger(isAbort ? 'alerts.email.timeout' : 'alerts.email.network_error', {});
  } finally {
    clearTimeout(timer);
  }
}

// ── Central e-mail gate ───────────────────────────────────────────────────────
// The ONE place a provider-alert e-mail is actually dispatched (both ALERT and
// RECOVERED go through here). Production sends via Resend; every non-production
// environment (homolog → 'staging') records the incident, dedup/occurrence_count,
// recovery and history EXACTLY the same and only SUPPRESSES the e-mail here — the
// single behavioral difference between environments. The skip log carries only
// the environment label: never a recipient, API key, payload, or any secret.
async function dispatchEmail(deps: AlertDeps, subject: string, text: string): Promise<void> {
  if (resolveAlertEnvironment().dbValue !== 'production') {
    deps.logger('alerts.email.skipped_non_production', { environment: resolveAlertEnvironment().label.toLowerCase() });
    return;
  }
  await deps.sendEmail(subject, text);
}

// ── Open path: classify → atomic RPC → conditional e-mail ─────────────────────

export async function evaluateProviderIncident(signal: IncidentSignal, deps: AlertDeps): Promise<void> {
  try {
    const errorClass = classifyProviderError({
      httpStatus: signal.httpStatus,
      code: signal.errorCode,
      category: signal.errorCategory,
    });
    if (!errorClass) return; // not an operational outage class → no alert

    const env = resolveAlertEnvironment();
    const label = providerLabel(signal.providerRaw);
    const display = providerDisplayName(signal.providerRaw);
    const dedupKey = `${env.dbValue}:${label}:${errorClass}`;
    const occurredAt = deps.now().toISOString();

    // detail: SANITIZED, structured technical fields ONLY.
    const detail = {
      provider: label,
      provider_display: display,
      error_class: errorClass,
      http_status: signal.httpStatus ?? null,
      error_code: signal.errorCode ?? null,
      error_category: signal.errorCategory ?? null,
      feature_key: signal.featureKey,
      service: signal.service ?? null,
      operation_part: signal.operationPart ?? null,
      provider_request_id: signal.providerRequestId ?? null,
      correlation_id: signal.correlationId ?? null,
    };

    const { data, error } = await deps.supabase.rpc('record_provider_incident', {
      p_environment: env.dbValue,
      p_provider_raw: signal.providerRaw,
      p_provider_label: label,
      p_error_class: errorClass,
      p_dedup_key: dedupKey,
      p_title: `${display} — ${errorClass.toUpperCase()}`,
      p_detail: detail,
    });

    if (error) {
      deps.logger('alerts.record.failed', { message: error.message });
      return;
    }

    const verdict = (data ?? {}) as {
      should_send_email?: boolean;
      occurrence_count?: number;
      severity?: string;
      action?: string;
    };

    if (!verdict.should_send_email) return;

    const { subject, text } = buildOpenEmail({
      env,
      display,
      errorClass,
      signal,
      occurrenceCount: verdict.occurrence_count ?? null,
      severity: verdict.severity ?? null,
      occurredAt,
    });
    await dispatchEmail(deps, subject, text);
  } catch (err) {
    // Absolute isolation: nothing here may propagate to the caller.
    try {
      deps.logger('alerts.evaluate.failed', { message: err instanceof Error ? err.message : String(err) });
    } catch { /* logging must never throw upward either */ }
  }
}

// ── Recovery sweep (called by the cron route only) ────────────────────────────

export async function runRecoverySweep(
  deps: AlertDeps,
): Promise<{ open: number; recovered: number; orphanClosed: number }> {
  let openCount = 0;
  let recovered = 0;
  let orphanClosed = 0;
  try {
    const { data: openAlerts, error } = await deps.supabase
      .from('ai_alerts')
      .select('id')
      .eq('status', 'open');

    if (error) {
      deps.logger('alerts.sweep.query_failed', { message: error.message });
      return { open: 0, recovered: 0, orphanClosed: 0 };
    }

    const rows = (openAlerts ?? []) as Array<{ id: string }>;
    openCount = rows.length;

    for (const row of rows) {
      const { data, error: rpcErr } = await deps.supabase.rpc('resolve_provider_incident_if_recovered', {
        p_alert_id: row.id,
      });
      if (rpcErr) {
        deps.logger('alerts.sweep.rpc_failed', { message: rpcErr.message });
        continue;
      }
      const v = (data ?? {}) as RecoveredPayload & { resolved?: boolean; recovered?: boolean };
      if (v.resolved && v.recovered) {
        recovered++;
        const { subject, text } = buildRecoveredEmail(v, deps.now().toISOString());
        await dispatchEmail(deps, subject, text); // gated to production; best-effort, never throws
      } else if (v.resolved && !v.recovered) {
        orphanClosed++;
      }
    }

    deps.logger('alerts.sweep.done', { open: openCount, recovered, orphanClosed });
  } catch (err) {
    deps.logger('alerts.sweep.failed', { message: err instanceof Error ? err.message : String(err) });
  }
  return { open: openCount, recovered, orphanClosed };
}

// ── Fire-and-forget entry point for the gateway failure sink ──────────────────

/**
 * Schedules incident evaluation WITHOUT blocking the caller. Uses Vercel's
 * waitUntil so the Fluid Compute instance stays alive until the alert settles,
 * adding no latency to the (already-failing) user response. Outside a Vercel
 * request scope (e.g. local/tests) it falls back to a self-contained,
 * always-caught background promise. Safe to call unconditionally: it builds its
 * own dependencies and never throws.
 */
// Vercel's waitUntil, loaded LAZILY at module init via a runtime dynamic import
// so `@vercel/functions` is NOT pulled into the eager (statically-transformed)
// module graph of every gateway caller — that eager import measurably slowed
// unrelated handlers' cold import cost. The package is small and resolves long
// before any real provider failure, so by dispatch time `_waitUntil` is set and
// is called SYNCHRONOUSLY within the request scope (preserving the exact
// behavior of a static import). If it somehow isn't loaded yet, or we're outside
// a Vercel request scope (local/tests), we fall back to a self-contained,
// always-caught background promise (Fluid Compute keeps the instance alive).
let _waitUntil: ((p: Promise<unknown>) => void) | null = null;
void import('@vercel/functions')
  .then((m) => { _waitUntil = m.waitUntil; })
  .catch(() => { _waitUntil = null; });

function scheduleBackground(task: Promise<unknown>): void {
  const safe = task.catch(() => undefined);
  if (_waitUntil) {
    try { _waitUntil(safe); return; } catch { /* not in a request scope — fall through */ }
  }
  void safe;
}

export function dispatchProviderIncident(signal: IncidentSignal, logger: AlertLogger): void {
  try {
    const deps = getProductionAlertDeps();
    scheduleBackground(evaluateProviderIncident(signal, deps));
  } catch (err) {
    try {
      logger('alerts.dispatch.failed', { message: err instanceof Error ? err.message : String(err) });
    } catch { /* never throw upward */ }
  }
}

// ── Browser-side Azure coverage (pronunciation SDK runs in the browser) ───────

/**
 * Maps a browser-reported pronunciation fail code to a provider-outage signal,
 * or null for codes that are NOT provider outages (user stop, no-match, audio
 * decode, generic cancel) and must never raise an alert.
 */
export function mapPronunciationFailCodeToProviderSignal(
  code: string,
): { httpStatus: number | null; errorCode: string } | null {
  switch (code) {
    case 'AZURE_AUTH_FAILED':   return { httpStatus: 401, errorCode: 'AZURE_AUTH_FAILED' };
    case 'AZURE_TIMEOUT':       return { httpStatus: null, errorCode: 'AZURE_TIMEOUT' };
    case 'AZURE_NETWORK_ERROR': return { httpStatus: null, errorCode: 'AZURE_NETWORK_ERROR' };
    default:                    return null;
  }
}

/**
 * Coverage for the browser Azure pronunciation path: the physical call runs in
 * the browser, so the gateway's failEvent never sees it. Called best-effort from
 * the /fail endpoints. Records a failed ai_usage_event (so the incident
 * window-count, which reads ai_usage_events, includes this failure) and then
 * evaluates the incident directly (this path is not wrapped by
 * executeAiGatewayCall). Fully isolated: awaited by the caller but never throws,
 * and it records only sanitized technical fields.
 */
export async function recordAndAlertBrowserProviderFailure(input: {
  featureKey: AiFeatureKey;
  providerRaw: string;
  httpStatus: number | null;
  errorCode: string;
  service?: string;
  userId?: string;
}): Promise<void> {
  const logger = defaultLogger;
  try {
    const usage = new SupabaseUsageRepository();
    try {
      const eventId = await usage.startEvent({
        requestId: randomUUID(),
        correlationId: randomUUID(),
        actorType: 'user',
        featureKey: input.featureKey,
        provider: input.providerRaw,
        service: input.service,
        executionLocation: 'frontend',
        isBillable: false,
        attemptNumber: 1,
        callSequence: 1,
        userId: input.userId,
        startedAt: Date.now(),
      });
      await usage.failEvent(eventId, {
        latencyMs: 0,
        httpStatus: input.httpStatus ?? undefined,
        errorCode: input.errorCode,
        errorCategory: 'browser_reported',
      });
    } catch (e) {
      logger('alerts.browser_record.failed', { message: e instanceof Error ? e.message : String(e) });
    }

    await evaluateProviderIncident(
      {
        providerRaw: input.providerRaw,
        featureKey: input.featureKey,
        httpStatus: input.httpStatus,
        errorCode: input.errorCode,
        errorCategory: 'browser_reported',
        service: input.service ?? null,
      },
      getProductionAlertDeps(),
    );
  } catch (err) {
    try {
      logger('alerts.browser_failure.failed', { message: err instanceof Error ? err.message : String(err) });
    } catch { /* never throw upward */ }
  }
}
