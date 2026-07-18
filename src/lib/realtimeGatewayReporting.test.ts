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

  it('reportSessionActive POSTs to /api/conversation/session/active with only gatewaySessionId', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', mockFetch);

    reportSessionActive('session-1');
    await new Promise((r) => setTimeout(r, 0));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/conversation/session/active');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body as string)).toEqual({ gatewaySessionId: 'session-1' });
  });

  it('reportSessionFailed POSTs gatewaySessionId and a validated reason', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', mockFetch);

    reportSessionFailed('session-2', 'webrtc_failed');
    await new Promise((r) => setTimeout(r, 0));

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(opts.body as string)).toEqual({ gatewaySessionId: 'session-2', reason: 'webrtc_failed' });
  });

  it('reportSessionUsage POSTs gatewaySessionId, providerResponseId, and the usage object verbatim', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', mockFetch);

    const usage = { input_token_details: { text_tokens: 10, audio_tokens: 20 } };
    reportSessionUsage('session-3', 'resp_abc123', usage);
    await new Promise((r) => setTimeout(r, 0));

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/conversation/session/usage');
    expect(JSON.parse(opts.body as string)).toEqual({
      gatewaySessionId: 'session-3',
      providerResponseId: 'resp_abc123',
      usage,
    });
  });

  it('reportSessionEnd POSTs gatewaySessionId and durationSeconds', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', mockFetch);

    reportSessionEnd('session-4', 123.45);
    await new Promise((r) => setTimeout(r, 0));

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(opts.body as string)).toEqual({ gatewaySessionId: 'session-4', durationSeconds: 123.45 });
  });

  it('a network failure never throws or rejects — telemetry must never affect the conversation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    expect(() => reportSessionActive('session-5')).not.toThrow();
    expect(() => reportSessionFailed('session-5', 'unknown')).not.toThrow();
    expect(() => reportSessionUsage('session-5', 'resp_x', {})).not.toThrow();
    expect(() => reportSessionEnd('session-5', 10)).not.toThrow();

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
