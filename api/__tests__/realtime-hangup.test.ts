/**
 * Tests for api/_realtime-hangup.ts — real OpenAI Realtime call termination
 * plus outcome persistence, shared by session-control's terminate path and
 * the abandoned-session sweep job.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSessionsFrom, sessionsClient } = vi.hoisted(() => {
  const mockSessionsFrom = vi.fn();
  return { mockSessionsFrom, sessionsClient: { from: mockSessionsFrom } };
});

vi.mock('../_ai-gateway/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_ai-gateway/index')>();
  return { ...actual, getSharedServiceClient: () => sessionsClient };
});

import { hangupRealtimeCall, hangupAndPersist } from '../_realtime-hangup';

function makeUpdateChain() {
  const chain: any = {};
  chain.update = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockResolvedValue({ data: null, error: null });
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSessionsFrom.mockReturnValue(makeUpdateChain());
  process.env.OPENAI_API_KEY = 'sk-test-key';
});

describe('hangupRealtimeCall', () => {
  it('returns ok:false, httpStatus:null when OPENAI_API_KEY is unset — never sends a request', async () => {
    delete process.env.OPENAI_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const outcome = await hangupRealtimeCall('call_123');
    expect(outcome).toEqual({ ok: false, httpStatus: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls the real hangup endpoint with the real API key, never an ephemeral token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    await hangupRealtimeCall('call_123');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/realtime/calls/call_123/hangup',
      expect.objectContaining({ method: 'POST', headers: { Authorization: 'Bearer sk-test-key' } }),
    );
  });

  it('a successful hangup returns ok:true with the real HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    expect(await hangupRealtimeCall('call_123')).toEqual({ ok: true, httpStatus: 200 });
  });

  it('an already-ended call (4xx from OpenAI) returns ok:false with the real HTTP status, never throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    expect(await hangupRealtimeCall('call_123')).toEqual({ ok: false, httpStatus: 404 });
  });

  it('a network failure returns ok:false, httpStatus:null, never throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    expect(await hangupRealtimeCall('call_123')).toEqual({ ok: false, httpStatus: null });
  });

  it('URL-encodes the call id (defense against a call_id containing path-breaking characters)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    await hangupRealtimeCall('call/../weird');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/realtime/calls/call%2F..%2Fweird/hangup',
      expect.anything(),
    );
  });
});

describe('hangupAndPersist', () => {
  it('persists hangup_status=ok, hangup_at, and the real http status on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    await hangupAndPersist('gateway-session-1', 'call_123');

    expect(mockSessionsFrom).toHaveBeenCalledWith('ai_provider_sessions');
    const chain = mockSessionsFrom.mock.results[0].value;
    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({
      hangup_status: 'ok', hangup_http_status: 200, hangup_at: expect.any(String),
    }));
    expect(chain.eq).toHaveBeenCalledWith('id', 'gateway-session-1');
  });

  it('persists hangup_status=failed when the hangup itself failed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await hangupAndPersist('gateway-session-1', 'call_123');

    const chain = mockSessionsFrom.mock.results[0].value;
    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ hangup_status: 'failed', hangup_http_status: 404 }));
  });

  it('returns the real outcome to the caller regardless of persistence success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const outcome = await hangupAndPersist('gateway-session-1', 'call_123');
    expect(outcome).toEqual({ ok: true, httpStatus: 200 });
  });

  it('a persistence failure never throws — the hangup outcome is still returned', async () => {
    mockSessionsFrom.mockImplementation(() => { throw new Error('db down'); });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const outcome = await hangupAndPersist('gateway-session-1', 'call_123');
    expect(outcome).toEqual({ ok: true, httpStatus: 200 });
  });
});
