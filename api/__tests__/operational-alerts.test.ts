/**
 * Operational alerts — behavioral (DI) + static migration assertions.
 *
 * The threshold / dedup / cooldown / recovery DECISIONS live in the atomic
 * Postgres RPCs (they must, for cross-instance correctness). Those are asserted
 * statically against the migration source here (the same approach the repo uses
 * for other SQL-bound logic), while the TypeScript layer — classification,
 * dedup-key construction, e-mail gating on the RPC verdict, RECOVERED handling,
 * total isolation, and the absence of sensitive fields — is exercised
 * behaviorally with injected dependencies (no DB, no network).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import {
  classifyProviderError,
  isBillingBlockSignal,
  evaluateProviderIncident,
  runRecoverySweep,
  buildOpenEmail,
  buildRecoveredEmail,
  resendSendEmail,
  providerLabel,
  resolveAlertEnvironment,
  mapPronunciationFailCodeToProviderSignal,
  type AlertDeps,
  type IncidentSignal,
} from '../_ai-gateway/alerts';
import { sanitizeError, extractOpenAiErrorCode } from '../_ai-gateway/sanitize';
import { AzureSpeechError } from '../_azure-speech';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDeps(rpcImpl?: (...args: any[]) => any) {
  const emails: Array<{ subject: string; text: string }> = [];
  const logs: Array<{ event: string; data?: Record<string, unknown> }> = [];
  const rpc = vi.fn(rpcImpl ?? (async () => ({ data: {}, error: null })));
  const deps: AlertDeps = {
    supabase: { rpc } as any,
    sendEmail: async (subject, text) => { emails.push({ subject, text }); },
    logger: (event, data) => { logs.push({ event, data }); },
    now: () => new Date('2026-08-12T12:00:00.000Z'),
  };
  return { deps, emails, rpc, logs };
}

const authSignal: IncidentSignal = {
  providerRaw: 'azure',
  featureKey: 'pronunciation.start_assessment',
  httpStatus: 401,
  errorCode: 'AZURE_SPEECH_AUTH_FAILED',
  errorCategory: 'AzureSpeechError',
  service: 'speech_sts',
  correlationId: 'corr-123',
  providerRequestId: 'req-abc',
};

// ── 1. Classification ──────────────────────────────────────────────────────────

describe('classifyProviderError', () => {
  it('maps 401/403 to auth', () => {
    expect(classifyProviderError({ httpStatus: 401 })).toBe('auth');
    expect(classifyProviderError({ httpStatus: 403 })).toBe('auth');
  });
  it('maps 429 to rate_limit', () => {
    expect(classifyProviderError({ httpStatus: 429 })).toBe('rate_limit');
  });
  it('maps 5xx to server', () => {
    expect(classifyProviderError({ httpStatus: 500 })).toBe('server');
    expect(classifyProviderError({ httpStatus: 503 })).toBe('server');
  });
  it('maps timeout / network (no status) to connectivity', () => {
    expect(classifyProviderError({ httpStatus: null, category: 'AzureTtsTimeoutError' })).toBe('connectivity');
    expect(classifyProviderError({ httpStatus: null, code: 'AZURE_TTS_NETWORK_ERROR_block_1' })).toBe('connectivity');
    expect(classifyProviderError({ httpStatus: undefined, category: 'APIConnectionTimeoutError' })).toBe('connectivity');
    expect(classifyProviderError({ httpStatus: null, code: 'AZURE_SPEECH_ServiceTimeout' })).toBe('connectivity');
    expect(classifyProviderError({ httpStatus: null, code: 'AZURE_SPEECH_ConnectionFailure' })).toBe('connectivity');
  });
  it('maps a billing/credit/quota/subscription block to billing — even without 401/403', () => {
    // OpenAI credit exhaustion arrives as HTTP 429 with a structured code, NOT 401.
    expect(classifyProviderError({ httpStatus: 429, code: 'insufficient_quota' })).toBe('billing');
    expect(classifyProviderError({ httpStatus: 429, code: 'billing_hard_limit_reached' })).toBe('billing');
    // 402 Payment Required is billing on its own.
    expect(classifyProviderError({ httpStatus: 402 })).toBe('billing');
    // A structured billing code wins even when there is no HTTP status at all.
    expect(classifyProviderError({ httpStatus: null, code: 'account_deactivated' })).toBe('billing');
    // access_terminated (often 403) is billing, more specific than plain auth.
    expect(classifyProviderError({ httpStatus: 403, code: 'access_terminated' })).toBe('billing');
  });
  it('keeps a plain 429 (no billing code) as a transient rate_limit', () => {
    expect(classifyProviderError({ httpStatus: 429 })).toBe('rate_limit');
    expect(classifyProviderError({ httpStatus: 429, code: 'rate_limit_exceeded' })).toBe('rate_limit');
  });
  it('NEVER silently drops a genuine provider error: unknown shapes → provider_error', () => {
    // Previously these returned null (silent). They are all genuine provider-origin
    // failures (the classifier is only ever reached from the gateway invoke() catch
    // or the browser provider-fail allowlist), so they must be monitored.
    expect(classifyProviderError({ httpStatus: 402, code: null })).toBe('billing'); // 402 → billing
    expect(classifyProviderError({ httpStatus: 404 })).toBe('provider_error');
    expect(classifyProviderError({ httpStatus: 408 })).toBe('provider_error');
    expect(classifyProviderError({ httpStatus: 409 })).toBe('provider_error');
    expect(classifyProviderError({ httpStatus: 400 })).toBe('provider_error');
    expect(classifyProviderError({ httpStatus: null, code: 'SOMETHING_ELSE' })).toBe('provider_error');
    expect(classifyProviderError({ httpStatus: null, category: 'WeirdSdkError' })).toBe('provider_error');
  });
});

describe('isBillingBlockSignal', () => {
  it('is true for 402 and for curated structured billing codes only', () => {
    expect(isBillingBlockSignal({ httpStatus: 402 })).toBe(true);
    expect(isBillingBlockSignal({ httpStatus: 429, code: 'insufficient_quota' })).toBe(true);
    expect(isBillingBlockSignal({ httpStatus: 429, code: 'INSUFFICIENT_QUOTA' })).toBe(true); // case-insensitive
    expect(isBillingBlockSignal({ httpStatus: 429, code: 'rate_limit_exceeded' })).toBe(false);
    expect(isBillingBlockSignal({ httpStatus: 500 })).toBe(false);
    expect(isBillingBlockSignal({ httpStatus: null, code: null })).toBe(false);
  });
});

// ── 2. Azure error normalization reaches telemetry ─────────────────────────────

describe('sanitizeError preserves normalized Azure status/code', () => {
  it('reads a real .status + .code from AzureSpeechError', () => {
    const info = sanitizeError(new AzureSpeechError('AZURE_SPEECH_AUTH_FAILED', 'rejected', 403));
    expect(info.httpStatus).toBe(403);
    expect(info.code).toBe('AZURE_SPEECH_AUTH_FAILED');
    expect(info.category).toBe('AzureSpeechError');
    expect(classifyProviderError(info)).toBe('auth');
  });
  it('falls back to .azureStatus when .status is absent', () => {
    const info = sanitizeError({ azureStatus: 401, name: 'AzureTtsHttpError', code: 'AZURE_TTS_HTTP_ERROR' } as any);
    expect(info.httpStatus).toBe(401);
    expect(classifyProviderError(info)).toBe('auth');
  });
  it('captures a provider request id but never a secret message', () => {
    const info = sanitizeError({ status: 500, requestId: 'req_openai_123', message: 'bearer sk-secret leak' } as any);
    expect(info.requestId).toBe('req_openai_123');
    expect(info.sanitizedMessage).toBeUndefined(); // secret-looking message dropped
  });
  it('falls back to .openaiStatus (PreviewTtsHttpError) so OpenAI HTTP errors classify', () => {
    const info = sanitizeError({ openaiStatus: 429, name: 'PreviewTtsHttpError' } as any);
    expect(info.httpStatus).toBe(429);
    expect(classifyProviderError(info)).toBe('rate_limit');
  });
  it('falls back to the OpenAI SDK .type when .code is absent (billing detection)', () => {
    const info = sanitizeError({ status: 429, type: 'insufficient_quota' } as any);
    expect(info.code).toBe('insufficient_quota');
    expect(classifyProviderError(info)).toBe('billing');
  });
});

describe('extractOpenAiErrorCode', () => {
  it('pulls a structured code/type from a raw OpenAI error body', () => {
    expect(extractOpenAiErrorCode('{"error":{"code":"insufficient_quota","message":"secret"}}')).toBe('insufficient_quota');
    expect(extractOpenAiErrorCode('{"error":{"type":"invalid_request_error"}}')).toBe('invalid_request_error');
  });
  it('returns undefined for a non-JSON or empty body (never throws)', () => {
    expect(extractOpenAiErrorCode('not json')).toBeUndefined();
    expect(extractOpenAiErrorCode('')).toBeUndefined();
    expect(extractOpenAiErrorCode(null)).toBeUndefined();
  });
  it('a create_session HTTP 429 insufficient_quota body classifies as billing end-to-end', () => {
    // Mirrors CreateSessionHttpError.status + .code getters feeding sanitizeError.
    const rawText = '{"error":{"code":"insufficient_quota","type":"insufficient_quota"}}';
    const info = sanitizeError({ status: 429, code: extractOpenAiErrorCode(rawText), name: 'CreateSessionHttpError' } as any);
    expect(info.httpStatus).toBe(429);
    expect(classifyProviderError(info)).toBe('billing');
  });
});

// ── 3. Open path: RPC verdict gates the e-mail ─────────────────────────────────

describe('evaluateProviderIncident', () => {
  const openedVerdict = async () => ({
    data: { should_send_email: true, occurrence_count: 1, severity: 'critical', action: 'opened' },
    error: null,
  });

  it('an unknown 4xx is no longer silent: it records a monitored provider_error', async () => {
    const { deps, rpc } = makeDeps(async () => ({ data: { should_send_email: false, action: 'below_threshold' }, error: null }));
    await evaluateProviderIncident({ ...authSignal, httpStatus: 404, errorCode: null }, deps);
    expect(rpc).toHaveBeenCalledWith('record_provider_incident', expect.objectContaining({
      p_error_class: 'provider_error',
      p_dedup_key: 'staging:azure_speech:provider_error',
    }));
  });

  it('provider_error below threshold sends NO e-mail; on open sends exactly one; increments never re-e-mail', async () => {
    vi.stubEnv('ALERT_ENVIRONMENT', 'production'); // e-mail path is gated to production
    // below threshold → suppressed
    {
      const { deps, emails } = makeDeps(async () => ({ data: { should_send_email: false, action: 'below_threshold', occurrence_count: 2 }, error: null }));
      await evaluateProviderIncident({ ...authSignal, httpStatus: 404, errorCode: null }, deps);
      expect(emails).toHaveLength(0);
    }
    // threshold reached → one ALERT
    {
      const { deps, emails } = makeDeps(async () => ({ data: { should_send_email: true, action: 'opened', occurrence_count: 3, severity: 'warning' }, error: null }));
      await evaluateProviderIncident({ ...authSignal, httpStatus: 404, errorCode: null }, deps);
      expect(emails).toHaveLength(1);
      expect(emails[0].subject).toBe('[ORODIM ALERT][PRODUCTION] Azure Speech — PROVIDER_ERROR');
    }
    // further occurrences → increment, no new e-mail (anti-spam preserved)
    {
      const { deps, emails } = makeDeps(async () => ({ data: { should_send_email: false, action: 'incremented' }, error: null }));
      await evaluateProviderIncident({ ...authSignal, httpStatus: 404, errorCode: null }, deps);
      expect(emails).toHaveLength(0);
    }
  });

  it('a billing block opens a critical incident with a billing dedup key and one ALERT', async () => {
    vi.stubEnv('ALERT_ENVIRONMENT', 'production'); // e-mail path is gated to production
    const { deps, emails, rpc } = makeDeps(async () => ({
      data: { should_send_email: true, occurrence_count: 1, severity: 'critical', action: 'opened' }, error: null,
    }));
    await evaluateProviderIncident(
      { providerRaw: 'openai', featureKey: 'conversation.create_session', httpStatus: 429, errorCode: 'insufficient_quota', errorCategory: 'CreateSessionHttpError' },
      deps,
    );
    expect(rpc).toHaveBeenCalledWith('record_provider_incident', expect.objectContaining({
      p_provider_raw: 'openai',
      p_error_class: 'billing',
      p_dedup_key: 'production:openai:billing',
    }));
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toBe('[ORODIM ALERT][PRODUCTION] OpenAI — BILLING');
  });

  it('PRODUCTION + open: records incident AND sends exactly 1 Resend e-mail', async () => {
    vi.stubEnv('ALERT_ENVIRONMENT', 'production');
    const { deps, emails, rpc } = makeDeps(openedVerdict);
    await evaluateProviderIncident(authSignal, deps);
    expect(rpc).toHaveBeenCalledWith('record_provider_incident', expect.objectContaining({
      p_environment: 'production',
      p_provider_raw: 'azure',
      p_provider_label: 'azure_speech',
      p_error_class: 'auth',
      p_dedup_key: 'production:azure_speech:auth',
    }));
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toBe('[ORODIM ALERT][PRODUCTION] Azure Speech — AUTH');
  });

  it('HOMOLOG + open: records/processes incident identically but sends 0 e-mails (skipped_non_production)', async () => {
    vi.stubEnv('ALERT_ENVIRONMENT', 'homolog');
    const { deps, emails, rpc, logs } = makeDeps(openedVerdict);
    await evaluateProviderIncident(authSignal, deps);
    // Incident is recorded exactly the same (same RPC call) — only the e-mail differs.
    expect(rpc).toHaveBeenCalledWith('record_provider_incident', expect.objectContaining({
      p_environment: 'staging',
      p_error_class: 'auth',
      p_dedup_key: 'staging:azure_speech:auth',
    }));
    expect(emails).toHaveLength(0);
    expect(logs.some((l) => l.event === 'alerts.email.skipped_non_production')).toBe(true);
    // Skip log must never carry a recipient/key/payload.
    const skip = logs.find((l) => l.event === 'alerts.email.skipped_non_production');
    expect(JSON.stringify(skip)).not.toMatch(/api[_-]?key|bearer|token|@/i);
  });

  it('does NOT send when the RPC suppresses (below threshold / already open / cooldown)', async () => {
    vi.stubEnv('ALERT_ENVIRONMENT', 'production');
    for (const action of ['below_threshold', 'incremented', 'opened_cooldown_suppressed']) {
      const { deps, emails } = makeDeps(async () => ({ data: { should_send_email: false, action }, error: null }));
      await evaluateProviderIncident(authSignal, deps);
      expect(emails).toHaveLength(0);
    }
  });

  it('PRODUCTION concurrent detections e-mail only when THIS instance won the open (dedup)', async () => {
    vi.stubEnv('ALERT_ENVIRONMENT', 'production');
    const { deps: depsA, emails: emailsA } = makeDeps(async () => ({ data: { should_send_email: true, occurrence_count: 1, severity: 'critical' }, error: null }));
    const { deps: depsB, emails: emailsB } = makeDeps(async () => ({ data: { should_send_email: false, action: 'raced_increment' }, error: null }));
    await Promise.all([evaluateProviderIncident(authSignal, depsA), evaluateProviderIncident(authSignal, depsB)]);
    expect(emailsA.length + emailsB.length).toBe(1);
  });

  it('is fully isolated: a sendEmail failure never throws (production)', async () => {
    vi.stubEnv('ALERT_ENVIRONMENT', 'production');
    const throwingDeps: AlertDeps = {
      supabase: { rpc: vi.fn(async () => ({ data: { should_send_email: true }, error: null })) } as any,
      sendEmail: async () => { throw new Error('resend exploded'); },
      logger: () => {},
      now: () => new Date(),
    };
    await expect(evaluateProviderIncident(authSignal, throwingDeps)).resolves.toBeUndefined();
  });

  it('swallows an RPC error without sending or throwing', async () => {
    const { deps, emails } = makeDeps(async () => ({ data: null, error: { message: 'db down' } }));
    await expect(evaluateProviderIncident(authSignal, deps)).resolves.toBeUndefined();
    expect(emails).toHaveLength(0);
  });
});

// ── 4. Recovery sweep ──────────────────────────────────────────────────────────

describe('runRecoverySweep', () => {
  function sweepDeps(openRows: Array<{ id: string }>, rpcResults: any[]) {
    const emails: Array<{ subject: string; text: string }> = [];
    const logs: Array<{ event: string }> = [];
    let call = 0;
    const rpc = vi.fn(async () => ({ data: rpcResults[call++], error: null }));
    const supabase = {
      from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: openRows, error: null }) }) }),
      rpc,
    };
    const deps: AlertDeps = {
      supabase: supabase as any,
      sendEmail: async (subject, text) => { emails.push({ subject, text }); },
      logger: (event) => { logs.push({ event }); },
      now: () => new Date('2026-08-12T13:00:00.000Z'),
    };
    return { deps, emails, rpc, logs };
  }

  const RECOVERED = [
    { resolved: true, recovered: true, environment: 'production', provider: 'azure', error_class: 'auth', severity: 'critical', occurrence_count: 42, opened_at: '2026-08-12T12:00:00Z' },
    { resolved: true, recovered: false, reason: 'orphan_closed' },
    { resolved: false, reason: 'still_failing' },
  ];

  it('PRODUCTION: resolves incidents AND sends exactly one RECOVERED e-mail (none for orphans)', async () => {
    vi.stubEnv('ALERT_ENVIRONMENT', 'production');
    const { deps, emails, rpc } = sweepDeps([{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }], RECOVERED);
    const result = await runRecoverySweep(deps);
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ open: 3, recovered: 1, orphanClosed: 1 });
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toBe('[ORODIM RECOVERED][PRODUCTION] Azure Speech');
  });

  it('HOMOLOG: resolves the incident identically but sends 0 RECOVERED e-mails', async () => {
    vi.stubEnv('ALERT_ENVIRONMENT', 'homolog');
    const { deps, emails, rpc, logs } = sweepDeps([{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }], RECOVERED);
    const result = await runRecoverySweep(deps);
    // Recovery is processed exactly the same (resolve RPC called per open row, same counts)…
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ open: 3, recovered: 1, orphanClosed: 1 });
    // …only the RECOVERED e-mail is suppressed.
    expect(emails).toHaveLength(0);
    expect(logs.some((l) => l.event === 'alerts.email.skipped_non_production')).toBe(true);
  });

  it('returns zeros and sends nothing when the query fails', async () => {
    const supabase = { from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: null, error: { message: 'x' } }) }) }), rpc: vi.fn() };
    const emails: any[] = [];
    const deps: AlertDeps = { supabase: supabase as any, sendEmail: async () => { emails.push(1); }, logger: () => {}, now: () => new Date() };
    const result = await runRecoverySweep(deps);
    expect(result).toEqual({ open: 0, recovered: 0, orphanClosed: 0 });
    expect(emails).toHaveLength(0);
  });
});

// ── 5. Resend transport resilience ─────────────────────────────────────────────

describe('resendSendEmail never throws and fails safe', () => {
  it('skips (no fetch) when not configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(resendSendEmail('s', 't', () => {})).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('survives a network error', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test');
    vi.stubEnv('ALERT_RECIPIENT_EMAIL', 'ops@example.com');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await expect(resendSendEmail('s', 't', () => {})).resolves.toBeUndefined();
  });

  it('survives a timeout (AbortError)', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test');
    vi.stubEnv('ALERT_RECIPIENT_EMAIL', 'ops@example.com');
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }));
    await expect(resendSendEmail('s', 't', () => {})).resolves.toBeUndefined();
  });

  it('survives a non-2xx Resend response', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test');
    vi.stubEnv('ALERT_RECIPIENT_EMAIL', 'ops@example.com');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
    await expect(resendSendEmail('s', 't', () => {})).resolves.toBeUndefined();
  });
});

// ── 6. Security: no sensitive data in the e-mail bodies ────────────────────────

const FORBIDDEN = [/prompt/i, /\btoken\b/i, /authorization/i, /api[_-]?key/i, /secret/i, /\bssml\b/i, /\baudio\b/i, /bearer/i, /password/i, /transcript/i];

describe('e-mail bodies never contain sensitive data', () => {
  it('open e-mail carries only safe structured fields', () => {
    const { subject, text } = buildOpenEmail({
      env: resolveAlertEnvironment(),
      display: 'Azure Speech',
      errorClass: 'auth',
      signal: authSignal,
      occurrenceCount: 3,
      severity: 'critical',
      occurredAt: '2026-08-12T12:00:00.000Z',
    });
    const blob = `${subject}\n${text}`;
    for (const re of FORBIDDEN) expect(blob).not.toMatch(re);
    expect(text).toContain('Provider: Azure Speech');
    expect(text).toContain('HTTP status: 401');
    expect(text).toContain('Provider request ID: req-abc');
  });

  it('recovered e-mail carries only safe structured fields', () => {
    const { subject, text } = buildRecoveredEmail(
      { environment: 'production', provider: 'azure', error_class: 'auth', severity: 'critical', occurrence_count: 5, opened_at: '2026-08-12T12:00:00Z' },
      '2026-08-12T12:30:00Z',
    );
    const blob = `${subject}\n${text}`;
    for (const re of FORBIDDEN) expect(blob).not.toMatch(re);
    expect(subject).toBe('[ORODIM RECOVERED][PRODUCTION] Azure Speech');
  });
});

// ── 7. Browser fail-code mapping ───────────────────────────────────────────────

describe('mapPronunciationFailCodeToProviderSignal', () => {
  it('maps only genuine Azure outages', () => {
    expect(mapPronunciationFailCodeToProviderSignal('AZURE_AUTH_FAILED')).toEqual({ httpStatus: 401, errorCode: 'AZURE_AUTH_FAILED' });
    expect(mapPronunciationFailCodeToProviderSignal('AZURE_TIMEOUT')).toEqual({ httpStatus: null, errorCode: 'AZURE_TIMEOUT' });
    expect(mapPronunciationFailCodeToProviderSignal('AZURE_NETWORK_ERROR')).toEqual({ httpStatus: null, errorCode: 'AZURE_NETWORK_ERROR' });
  });
  it('ignores user / decode / no-match codes', () => {
    for (const code of ['AZURE_CANCELED', 'AZURE_NO_MATCH', 'CLIENT_INTERRUPTED', 'AUDIO_DECODE_FAILED', 'RESULT_INVALID']) {
      expect(mapPronunciationFailCodeToProviderSignal(code)).toBeNull();
    }
  });
  it('classifies the mapped auth signal correctly', () => {
    const s = mapPronunciationFailCodeToProviderSignal('AZURE_AUTH_FAILED')!;
    expect(classifyProviderError({ httpStatus: s.httpStatus })).toBe('auth');
  });
});

// ── 8. providerLabel ───────────────────────────────────────────────────────────

describe('providerLabel', () => {
  it('normalizes azure to azure_speech and leaves others intact', () => {
    expect(providerLabel('azure')).toBe('azure_speech');
    expect(providerLabel('openai')).toBe('openai');
  });
});

// ── 8b. Environment resolution (homolog must never read as production) ─────────

describe('resolveAlertEnvironment', () => {
  it('CRITICAL: ALERT_ENVIRONMENT=homolog wins even when VERCEL_ENV=production', () => {
    vi.stubEnv('VERCEL_ENV', 'production');       // homolog project deploys with --prod
    vi.stubEnv('ALERT_ENVIRONMENT', 'homolog');
    expect(resolveAlertEnvironment()).toEqual({ dbValue: 'staging', label: 'HOMOLOG' });
  });
  it('ALERT_ENVIRONMENT=production maps to PRODUCTION', () => {
    vi.stubEnv('ALERT_ENVIRONMENT', 'production');
    expect(resolveAlertEnvironment()).toEqual({ dbValue: 'production', label: 'PRODUCTION' });
  });
  it('falls back to VERCEL_ENV when the override is unset', () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    expect(resolveAlertEnvironment()).toEqual({ dbValue: 'production', label: 'PRODUCTION' });
  });
  it('defaults to HOMOLOG/staging when neither is production', () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    expect(resolveAlertEnvironment()).toEqual({ dbValue: 'staging', label: 'HOMOLOG' });
  });
});

// ── 9. Static migration assertions (SQL-bound decisions) ───────────────────────

const MIGRATION = readFileSync(
  resolve(__dirname, '..', '..', 'supabase', 'migrations', '20260812230000_operational_alerts.sql'),
  'utf8',
);

describe('operational-alerts migration', () => {
  it('reuses the existing tables (no new alerts table)', () => {
    expect(MIGRATION).not.toMatch(/CREATE TABLE[^;]*\bai_alerts\b/i);
    expect(MIGRATION).toMatch(/ALTER TABLE public\.ai_alerts ADD COLUMN IF NOT EXISTS occurrence_count/);
    expect(MIGRATION).toMatch(/first_occurrence/);
    expect(MIGRATION).toMatch(/last_occurrence/);
    expect(MIGRATION).toMatch(/opened_at/);
  });

  it('opens incidents atomically via the partial unique index + xmax winner', () => {
    expect(MIGRATION).toMatch(/ON CONFLICT \(dedup_key, environment\) WHERE status <> 'resolved'/);
    expect(MIGRATION).toMatch(/\(xmax = 0\)/);
  });

  it('guards the recovery UPDATE by status=open so only one RECOVERED fires', () => {
    expect(MIGRATION).toMatch(/WHERE id = p_alert_id AND status = 'open'/);
    expect(MIGRATION).toMatch(/resolve_reason = 'auto_recovered'/);
    expect(MIGRATION).toMatch(/resolve_reason = 'auto_closed_stale'/);
  });

  it('classifies the window count the same way as the TypeScript layer', () => {
    expect(MIGRATION).toMatch(/'auth'\s+THEN p_http_status IN \(401, 403\)/);
    expect(MIGRATION).toMatch(/'rate_limit'\s+THEN p_http_status = 429/);
    expect(MIGRATION).toMatch(/'server'\s+THEN p_http_status BETWEEN 500 AND 599/);
    expect(MIGRATION).toMatch(/'connectivity'\s+THEN p_http_status IS NULL/);
  });

  it('seeds the four rule classes for production and staging (homolog→staging)', () => {
    for (const cls of ['auth', 'rate_limit', 'server', 'connectivity']) {
      expect(MIGRATION).toContain(`'${cls}'`);
    }
    expect(MIGRATION).toMatch(/'production', 'error_rate', 'auth',\s+300,\s+NULL::numeric, 1,\s+'critical'/);
    expect(MIGRATION).toMatch(/'staging',\s+'error_rate', 'auth'/);
    expect(MIGRATION).not.toMatch(/'homolog'/);
  });

  it('locks the RPCs down to service_role (SECURITY DEFINER, no PUBLIC execute)', () => {
    expect(MIGRATION).toMatch(/SECURITY DEFINER/);
    expect(MIGRATION).toMatch(/REVOKE ALL ON FUNCTION public\.record_provider_incident[^;]*FROM PUBLIC/);
    expect(MIGRATION).toMatch(/GRANT EXECUTE ON FUNCTION public\.record_provider_incident[^;]*TO service_role/);
  });
});

// ── 10. Billing + provider_error coverage migration (the new, additive one) ────

const MIGRATION_V2 = readFileSync(
  resolve(__dirname, '..', '..', 'supabase', 'migrations', '20260813120000_operational_alerts_billing_and_fallback_classes.sql'),
  'utf8',
);

describe('billing + provider_error coverage migration', () => {
  it('is additive: no CREATE TABLE, no editing of applied objects', () => {
    expect(MIGRATION_V2).not.toMatch(/CREATE TABLE/i);
    expect(MIGRATION_V2).not.toMatch(/DROP (FUNCTION|TABLE)/i);
  });

  it('detects a billing block by structured code (mirrors isBillingBlockSignal)', () => {
    expect(MIGRATION_V2).toMatch(/_ai_error_code_is_billing/);
    expect(MIGRATION_V2).toMatch(/'insufficient_quota'/);
    expect(MIGRATION_V2).toMatch(/'billing_hard_limit_reached'/);
  });

  it('makes the window count / recovery CODE-AWARE (4-arg matcher over error_code + error_category)', () => {
    expect(MIGRATION_V2).toMatch(/_ai_alert_status_matches_class\(\s*e\.http_status,\s*p_error_class,\s*e\.error_code,\s*e\.error_category\s*\)/);
    expect(MIGRATION_V2).toMatch(/_ai_alert_status_matches_class\(\s*e\.http_status,\s*v_alert\.error_class,\s*e\.error_code,\s*e\.error_category\s*\)/);
    expect(MIGRATION_V2).toMatch(/CREATE OR REPLACE FUNCTION public\.record_provider_incident/);
    expect(MIGRATION_V2).toMatch(/CREATE OR REPLACE FUNCTION public\.resolve_provider_incident_if_recovered/);
  });

  it('classifies event class with billing winning over auth/rate_limit and provider_error as the fallback', () => {
    expect(MIGRATION_V2).toMatch(/_ai_alert_event_class/);
    expect(MIGRATION_V2).toMatch(/402 OR public\._ai_error_code_is_billing\(p_error_code\) THEN 'billing'/);
    expect(MIGRATION_V2).toMatch(/ELSE 'provider_error'/);
  });

  it('seeds billing (critical, min 1) and provider_error (warning, min 3) for production AND staging', () => {
    expect(MIGRATION_V2).toMatch(/'production', 'error_rate', 'billing',\s+300, NULL::numeric, 1, 'critical'/);
    expect(MIGRATION_V2).toMatch(/'production', 'error_rate', 'provider_error', 300, NULL::numeric, 3, 'warning'/);
    expect(MIGRATION_V2).toMatch(/'staging',\s+'error_rate', 'billing'/);
    expect(MIGRATION_V2).toMatch(/'staging',\s+'error_rate', 'provider_error'/);
    expect(MIGRATION_V2).not.toMatch(/'homolog'/);
  });

  it('has built-in default rules for billing + provider_error so a missing seed cannot silence them', () => {
    expect(MIGRATION_V2).toMatch(/WHEN 'billing'\s+THEN v_window_seconds := 300;\s+v_min_events := 1;\s+v_cooldown_secs := 21600; v_severity := 'critical'/);
    expect(MIGRATION_V2).toMatch(/WHEN 'provider_error' THEN v_window_seconds := 300;\s+v_min_events := 3;\s+v_cooldown_secs := 1800;\s+v_severity := 'warning'/);
  });

  it('locks the new helper functions down to service_role (revokes anon/authenticated)', () => {
    expect(MIGRATION_V2).toMatch(/REVOKE ALL ON FUNCTION public\._ai_alert_event_class\(integer, text, text\)\s+FROM PUBLIC, anon, authenticated/);
    expect(MIGRATION_V2).toMatch(/GRANT EXECUTE ON FUNCTION public\._ai_error_code_is_billing\(text\)\s+TO service_role/);
  });
});
