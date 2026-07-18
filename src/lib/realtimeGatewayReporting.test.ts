import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) } },
}));

import {
  toSessionEndReason,
  reportSessionActive,
  reportSessionFailed,
  reportSessionUsage,
  reportSessionEnd,
  checkSessionControl,
} from './realtimeGatewayReporting';

// ── toSessionEndReason — small, validated vocabulary ────────────────────────

describe('toSessionEndReason', () => {
  it('passes through already-known reasons unchanged', () => {
    expect(toSessionEndReason('user_ended')).toBe('user_ended');
    expect(toSessionEndReason('dc_closed')).toBe('dc_closed');
    expect(toSessionEndReason('max_duration_reached')).toBe('max_duration_reached');
    expect(toSessionEndReason('unmounted')).toBe('unmounted');
  });

  it('maps useRealtimeSession internal fail() codes to the backend vocabulary', () => {
    expect(toSessionEndReason('CONNECTION_LOST')).toBe('connection_lost');
    expect(toSessionEndReason('WEBRTC_FAILED')).toBe('webrtc_failed');
    expect(toSessionEndReason('WEBRTC_NETWORK')).toBe('webrtc_network');
    expect(toSessionEndReason('SESSION_ERROR')).toBe('session_error');
  });

  it('falls back to "unknown" for null, undefined, or unrecognized codes', () => {
    expect(toSessionEndReason(null)).toBe('unknown');
    expect(toSessionEndReason(undefined)).toBe('unknown');
    expect(toSessionEndReason('SOME_RANDOM_CODE')).toBe('unknown');
    expect(toSessionEndReason('')).toBe('unknown');
  });

  it('never maps a code that only occurs before a gatewaySessionId exists (mic errors) to anything but unknown', () => {
    // These fail() codes occur before token issuance — reportSessionFailed is
    // never called for them in practice (gatewaySessionIdRef is still null),
    // but the mapping itself must still degrade safely if it ever were.
    expect(toSessionEndReason('MIC_PERMISSION_DENIED')).toBe('unknown');
    expect(toSessionEndReason('MIC_NOT_FOUND')).toBe('unknown');
    expect(toSessionEndReason('MIC_ERROR')).toBe('unknown');
  });
});

// ── Fire-and-forget transport — never throws, always POSTs the right shape ──

describe('reporting calls — fire-and-forget transport', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reportSessionActive POSTs to the flat /api/conversation/session-active route with only gatewaySessionId', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', mockFetch);

    reportSessionActive('session-1');
    await new Promise((r) => setTimeout(r, 0));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    // Exact flat path — NOT the nested /session/active shape that 404'd in
    // production (Vercel never routed the extra path segment to the function).
    expect(url).toBe('/api/conversation/session-active');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body as string)).toEqual({ gatewaySessionId: 'session-1' });
  });

  it('reportSessionFailed POSTs to the flat /api/conversation/session-failed route with gatewaySessionId and a validated reason', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', mockFetch);

    reportSessionFailed('session-2', 'webrtc_failed');
    await new Promise((r) => setTimeout(r, 0));

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/conversation/session-failed');
    expect(JSON.parse(opts.body as string)).toEqual({ gatewaySessionId: 'session-2', reason: 'webrtc_failed' });
  });

  it('reportSessionUsage POSTs to the flat /api/conversation/session-usage route with gatewaySessionId, providerResponseId, and the usage object verbatim', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', mockFetch);

    const usage = { input_token_details: { text_tokens: 10, audio_tokens: 20 } };
    reportSessionUsage('session-3', 'resp_abc123', usage);
    await new Promise((r) => setTimeout(r, 0));

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/conversation/session-usage');
    expect(JSON.parse(opts.body as string)).toEqual({
      gatewaySessionId: 'session-3',
      providerResponseId: 'resp_abc123',
      usage,
    });
  });

  it('reportSessionEnd POSTs to the flat /api/conversation/session-end route with only gatewaySessionId — never a client-computed duration', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', mockFetch);

    reportSessionEnd('session-4');
    await new Promise((r) => setTimeout(r, 0));

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/conversation/session-end');
    const sent = JSON.parse(opts.body as string);
    expect(sent).toEqual({ gatewaySessionId: 'session-4' });
    expect(sent.durationSeconds).toBeUndefined();
  });

  it('a network failure never throws or rejects — telemetry must never affect the conversation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    expect(() => reportSessionActive('session-5')).not.toThrow();
    expect(() => reportSessionFailed('session-5', 'unknown')).not.toThrow();
    expect(() => reportSessionUsage('session-5', 'resp_x', {})).not.toThrow();
    expect(() => reportSessionEnd('session-5')).not.toThrow();

    // Give the swallowed rejections a turn to (not) surface as unhandled.
    await new Promise((r) => setTimeout(r, 0));
  });

  it('never sends the transcript, prompt, or any content field — only technical identifiers/counters', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', mockFetch);

    reportSessionUsage('session-6', 'resp_y', { input_token_details: { text_tokens: 5 } });
    await new Promise((r) => setTimeout(r, 0));

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const sent = opts.body as string;
    // 'input_token_details' is a legitimate field name (mirrors the official
    // Realtime usage object) — check for actual content/secret leakage
    // instead of the substring "token".
    expect(sent).not.toMatch(/transcript|prompt|\bsdp\b|bearer|ephemeral/i);
  });
});

// ── Failure observability — a non-2xx response must never vanish silently ──
// fetch() only rejects on a network error; it resolves normally for 401,
// 404, 500, etc. Before this fix, post() never checked response.ok, so a
// rejected bridge call (auth failure, route mismatch, server error) left
// zero trace anywhere — this is what let session-active fail invisibly in
// production while the conversation itself kept working normally (the
// actual root cause turned out to be a 404: the nested /session/active
// shape was never routed by Vercel to this function at all — fixed by
// moving to flat, single-segment routes).

describe('bridge call failures are observable, sanitized, and never break the conversation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('a 401 response logs a sanitized technical error — never throws', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    expect(() => reportSessionActive('session-7')).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));

    expect(consoleSpy).toHaveBeenCalledWith(
      '[realtimeGatewayReporting] bridge call failed',
      expect.objectContaining({ endpoint: '/api/conversation/session-active', status: 401, errorCode: 'HTTP_401', hasGatewaySessionId: true }),
    );
  });

  it('a 404 response is logged with its real status — proves route-mismatch would be visible', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    reportSessionUsage('session-8', 'resp_z', { input_token_details: { text_tokens: 1 } });
    await new Promise((r) => setTimeout(r, 0));

    expect(consoleSpy).toHaveBeenCalledWith(
      '[realtimeGatewayReporting] bridge call failed',
      expect.objectContaining({ endpoint: '/api/conversation/session-usage', status: 404, errorCode: 'HTTP_404' }),
    );
  });

  it('a 500 response is logged distinctly from a network error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    reportSessionEnd('session-9');
    await new Promise((r) => setTimeout(r, 0));

    expect(consoleSpy).toHaveBeenCalledWith(
      '[realtimeGatewayReporting] bridge call failed',
      expect.objectContaining({ status: 500, errorCode: 'HTTP_500' }),
    );
  });

  it('a network-level failure (fetch rejects) is logged with errorCode NETWORK_ERROR and no HTTP status', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    reportSessionFailed('session-10', 'webrtc_failed');
    await new Promise((r) => setTimeout(r, 0));

    expect(consoleSpy).toHaveBeenCalledWith(
      '[realtimeGatewayReporting] bridge call failed',
      expect.objectContaining({ endpoint: '/api/conversation/session-failed', status: null, errorCode: 'NETWORK_ERROR' }),
    );
  });

  it('a successful (200) call never logs anything', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    reportSessionActive('session-11');
    await new Promise((r) => setTimeout(r, 0));

    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('the failure log never contains the token, transcript, audio, or SDP — only sanitized technical fields', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    reportSessionUsage('session-12', 'resp_secret', { input_token_details: { text_tokens: 3 } });
    await new Promise((r) => setTimeout(r, 0));

    const loggedPayload = JSON.stringify(consoleSpy.mock.calls[0]);
    expect(loggedPayload).not.toMatch(/transcript|prompt|\bsdp\b|bearer|ephemeral/i);
    // Only the boolean presence of gatewaySessionId is logged, never the
    // gatewaySessionId, providerResponseId, or usage values themselves.
    expect(loggedPayload).not.toContain('session-12');
    expect(loggedPayload).not.toContain('resp_secret');
  });
});

// ── checkSessionControl — Etapa 11, Fase 9 mid-session control poll ────────
// Unlike the fire-and-forget reporters above, this one has a real answer the
// caller needs, but it must still fail open (terminate: false) on any
// network/HTTP/parse failure — a poll failure must never cut off an
// otherwise-healthy conversation.

describe('checkSessionControl', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs to the flat /api/conversation/session-control route with only gatewaySessionId', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ terminate: false, deadlineAt: '2026-01-01T00:00:00.000Z' }) });
    vi.stubGlobal('fetch', mockFetch);

    const result = await checkSessionControl('session-20');

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/conversation/session-control');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body as string)).toEqual({ gatewaySessionId: 'session-20' });
    expect(result).toEqual({ terminate: false, reason: undefined });
  });

  it('returns terminate:true with the server-reported reason', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ terminate: true, reason: 'kill_switch' }) }));
    const result = await checkSessionControl('session-21');
    expect(result).toEqual({ terminate: true, reason: 'kill_switch' });
  });

  it('fails open (terminate:false) on a non-2xx response', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const result = await checkSessionControl('session-22');
    expect(result).toEqual({ terminate: false });
    expect(consoleSpy).toHaveBeenCalledWith(
      '[realtimeGatewayReporting] bridge call failed',
      expect.objectContaining({ endpoint: '/api/conversation/session-control', status: 500, errorCode: 'HTTP_500' }),
    );
  });

  it('fails open (terminate:false) on a network failure — never throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(checkSessionControl('session-23')).resolves.toEqual({ terminate: false });
  });

  it('fails open (terminate:false) when the response body is malformed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new Error('bad json'); } }));
    await expect(checkSessionControl('session-24')).resolves.toEqual({ terminate: false });
  });

  it('ignores a non-boolean terminate field — treated as false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ terminate: 'yes' }) }));
    const result = await checkSessionControl('session-25');
    expect(result.terminate).toBe(false);
  });
});

// ── No stale nested-path references anywhere in executable code ────────────
// The old /session/active, /session/usage, /session/end, /session/failed
// shapes 404'd in production. Grep-proves none of them remain reachable
// from this module — not just that the four functions above happen to POST
// the right URL right now.

describe('no old nested bridge URLs remain in this module', () => {
  it('the compiled source contains none of the four old /session/<verb> path strings', async () => {
    const src = await import('./realtimeGatewayReporting?raw');
    const code = (src as unknown as { default: string }).default;
    // Full URL strings (what an actual fetch() call would use) — not the
    // bare "/session/active" substring, which legitimately still appears in
    // an explanatory code comment about why it was replaced.
    for (const stale of [
      '/api/conversation/session/active', '/api/conversation/session/usage',
      '/api/conversation/session/end', '/api/conversation/session/failed',
    ]) {
      expect(code).not.toContain(stale);
    }
    for (const flat of ['/api/conversation/session-active', '/api/conversation/session-usage', '/api/conversation/session-end', '/api/conversation/session-failed', '/api/conversation/session-control']) {
      expect(code).toContain(flat);
    }
  });
});
