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
import { sanitizeError } from '../_ai-gateway/sanitize';
import { AzureSpeechError } from '../_azure-speech';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDeps(rpcImpl?: (...args: any[]) => any) {
  const emails: Array<{ subject: string; text: string }> = [];
  const rpc = vi.fn(rpcImpl ?? (async () => ({ data: {}, error: null })));
  const deps: AlertDeps = {
    supabase: { rpc } as any,
    sendEmail: async (subject, text) => { emails.push({ subject, text }); },
    logger: () => {},
    now: () => new Date('2026-08-12T12:00:00.000Z'),
  };
  return { deps, emails, rpc };
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
  it('does NOT classify ordinary client errors / success / unknown', () => {
    expect(classifyProviderError({ httpStatus: 400 })).toBeNull();
    expect(classifyProviderError({ httpStatus: 404 })).toBeNull();
    expect(classifyProviderError({ httpStatus: 200 })).toBeNull();
    expect(classifyProviderError({ httpStatus: null, code: 'SOMETHING_ELSE' })).toBeNull();
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
});

// ── 3. Open path: RPC verdict gates the e-mail ─────────────────────────────────

describe('evaluateProviderIncident', () => {
  it('does nothing for a non-outage class (400)', async () => {
    const { deps, emails, rpc } = makeDeps();
    await evaluateProviderIncident({ ...authSignal, httpStatus: 400, errorCode: null }, deps);
    expect(rpc).not.toHaveBeenCalled();
    expect(emails).toHaveLength(0);
  });

  it('calls the RPC with the correct dedup key and sends one e-mail when opened', async () => {
    const { deps, emails, rpc } = makeDeps(async () => ({
      data: { should_send_email: true, occurrence_count: 1, severity: 'critical', action: 'opened' },
      error: null,
    }));
    await evaluateProviderIncident(authSignal, deps);
    expect(rpc).toHaveBeenCalledWith('record_provider_incident', expect.objectContaining({
      p_environment: 'staging',
      p_provider_raw: 'azure',
      p_provider_label: 'azure_speech',
      p_error_class: 'auth',
      p_dedup_key: 'staging:azure_speech:auth',
    }));
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toBe('[ORODIM ALERT][HOMOLOG] Azure Speech — AUTH');
  });

  it('does NOT send when the RPC suppresses (below threshold / already open / cooldown)', async () => {
    for (const action of ['below_threshold', 'incremented', 'opened_cooldown_suppressed']) {
      const { deps, emails } = makeDeps(async () => ({ data: { should_send_email: false, action }, error: null }));
      await evaluateProviderIncident(authSignal, deps);
      expect(emails).toHaveLength(0);
    }
  });

  it('concurrent detections e-mail only when THIS instance won the open (dedup)', async () => {
    // Instance A wins the atomic insert, instance B collapses to an increment.
    const { deps: depsA, emails: emailsA } = makeDeps(async () => ({ data: { should_send_email: true, occurrence_count: 1, severity: 'critical' }, error: null }));
    const { deps: depsB, emails: emailsB } = makeDeps(async () => ({ data: { should_send_email: false, action: 'raced_increment' }, error: null }));
    await Promise.all([evaluateProviderIncident(authSignal, depsA), evaluateProviderIncident(authSignal, depsB)]);
    expect(emailsA.length + emailsB.length).toBe(1);
  });

  it('is fully isolated: a sendEmail failure never throws', async () => {
    const { rpc } = makeDeps();
    const throwingDeps: AlertDeps = {
      supabase: { rpc: vi.fn(async () => ({ data: { should_send_email: true }, error: null })) } as any,
      sendEmail: async () => { throw new Error('resend exploded'); },
      logger: () => {},
      now: () => new Date(),
    };
    await expect(evaluateProviderIncident(authSignal, throwingDeps)).resolves.toBeUndefined();
    void rpc;
  });

  it('swallows an RPC error without sending or throwing', async () => {
    const { deps, emails } = makeDeps(async () => ({ data: null, error: { message: 'db down' } }));
    await expect(evaluateProviderIncident(authSignal, deps)).resolves.toBeUndefined();
    expect(emails).toHaveLength(0);
  });

  it('labels PRODUCTION and uses a production dedup key when VERCEL_ENV=production', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    const { deps, emails, rpc } = makeDeps(async () => ({ data: { should_send_email: true, occurrence_count: 2, severity: 'critical' }, error: null }));
    await evaluateProviderIncident(authSignal, deps);
    expect(rpc).toHaveBeenCalledWith('record_provider_incident', expect.objectContaining({ p_dedup_key: 'production:azure_speech:auth' }));
    expect(emails[0].subject).toBe('[ORODIM ALERT][PRODUCTION] Azure Speech — AUTH');
  });
});

// ── 4. Recovery sweep ──────────────────────────────────────────────────────────

describe('runRecoverySweep', () => {
  function sweepDeps(openRows: Array<{ id: string }>, rpcResults: any[]) {
    const emails: Array<{ subject: string; text: string }> = [];
    let call = 0;
    const rpc = vi.fn(async () => ({ data: rpcResults[call++], error: null }));
    const supabase = {
      from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: openRows, error: null }) }) }),
      rpc,
    };
    const deps: AlertDeps = {
      supabase: supabase as any,
      sendEmail: async (subject, text) => { emails.push({ subject, text }); },
      logger: () => {},
      now: () => new Date('2026-08-12T13:00:00.000Z'),
    };
    return { deps, emails, rpc };
  }

  it('sends exactly one RECOVERED e-mail per recovered incident and none for orphan closes', async () => {
    const { deps, emails, rpc } = sweepDeps(
      [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }],
      [
        { resolved: true, recovered: true, environment: 'production', provider: 'azure', error_class: 'auth', severity: 'critical', occurrence_count: 42, opened_at: '2026-08-12T12:00:00Z' },
        { resolved: true, recovered: false, reason: 'orphan_closed' },
        { resolved: false, reason: 'still_failing' },
      ],
    );
    const result = await runRecoverySweep(deps);
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ open: 3, recovered: 1, orphanClosed: 1 });
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toBe('[ORODIM RECOVERED][PRODUCTION] Azure Speech');
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

// ── 9. Static migration assertions (SQL-bound decisions) ───────────────────────

const MIGRATION = readFileSync(
  resolve(__dirname, '..', '..', 'supabase', 'migrations', '20260812170000_operational_alerts.sql'),
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
