import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendBehavioralPush } from './oneSignalServer';

const APP_ID = 'app-123';
const REST_KEY = 'super-secret-rest-key';
const EXTERNAL_ID = '11111111-2222-3333-4444-555555555555';

function base() {
  return {
    appId: APP_ID,
    restApiKey: REST_KEY,
    externalId: EXTERNAL_ID,
    title: 'Hi',
    body: 'Practice today',
    data: { behavioral_push_event_id: 'evt-1', push_type: 'streak_risk' as const },
  };
}

function mockFetch(resp: { ok: boolean; status: number; json: () => Promise<unknown> }) {
  const fn = vi.fn().mockResolvedValue(resp);
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sendBehavioralPush — request shape', () => {
  it('POSTs to the OneSignal endpoint targeting ONE external_id, never a broadcast', async () => {
    const fn = mockFetch({ ok: true, status: 200, json: async () => ({ id: 'notif-1' }) });
    const res = await sendBehavioralPush(base());

    expect(res).toEqual({ ok: true, notificationId: 'notif-1', failureCode: null });
    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe('https://api.onesignal.com/notifications');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Key ${REST_KEY}`);

    const payload = JSON.parse(init.body);
    expect(payload.app_id).toBe(APP_ID);
    expect(payload.target_channel).toBe('push');
    expect(payload.include_aliases).toEqual({ external_id: [EXTERNAL_ID] });
    expect(payload.headings).toEqual({ en: 'Hi' });
    expect(payload.contents).toEqual({ en: 'Practice today' });
    expect(payload.data).toEqual({ behavioral_push_event_id: 'evt-1', push_type: 'streak_risk' });
    expect(typeof payload.idempotency_key).toBe('string');
    // NEVER a segment/broadcast selector.
    expect(payload.included_segments).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('All');
  });

  it('never leaks the REST API key in the returned result', async () => {
    mockFetch({ ok: true, status: 200, json: async () => ({ id: 'notif-1' }) });
    const res = await sendBehavioralPush(base());
    expect(JSON.stringify(res)).not.toContain(REST_KEY);
  });
});

describe('sendBehavioralPush — failures never count as sent', () => {
  it('fails closed on missing config WITHOUT calling fetch', async () => {
    const fn = mockFetch({ ok: true, status: 200, json: async () => ({ id: 'x' }) });
    const noKey = await sendBehavioralPush({ ...base(), restApiKey: '' });
    const noApp = await sendBehavioralPush({ ...base(), appId: '' });
    const noTarget = await sendBehavioralPush({ ...base(), externalId: '' });
    for (const r of [noKey, noApp, noTarget]) {
      expect(r.ok).toBe(false);
      expect(r.failureCode).toBe('config_missing');
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it('200 with no recipients (no id) is not a send', async () => {
    mockFetch({ ok: true, status: 200, json: async () => ({ id: null, errors: ['All included players are not subscribed'] }) });
    const res = await sendBehavioralPush(base());
    expect(res).toEqual({ ok: false, notificationId: null, failureCode: 'no_recipients' });
  });

  it('maps 4xx and 5xx to sanitized codes', async () => {
    mockFetch({ ok: false, status: 400, json: async () => ({ errors: ['bad'] }) });
    expect((await sendBehavioralPush(base())).failureCode).toBe('http_4xx_400');

    mockFetch({ ok: false, status: 503, json: async () => ({}) });
    expect((await sendBehavioralPush(base())).failureCode).toBe('http_5xx_503');
  });

  it('treats an unparseable 200 body as no_recipients (never a false send)', async () => {
    mockFetch({ ok: true, status: 200, json: async () => { throw new Error('not json'); } });
    const res = await sendBehavioralPush(base());
    expect(res.ok).toBe(false);
    expect(res.failureCode).toBe('no_recipients');
  });

  it('maps an aborted request to timeout', async () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err));
    const res = await sendBehavioralPush({ ...base(), timeoutMs: 5 });
    expect(res).toEqual({ ok: false, notificationId: null, failureCode: 'timeout' });
  });

  it('maps a network error to network_error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    const res = await sendBehavioralPush(base());
    expect(res.failureCode).toBe('network_error');
  });
});
