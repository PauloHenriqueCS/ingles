import { describe, it, expect, vi, beforeEach } from 'vitest';

// Android native build with the AppsFlyer plugin registered.
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'android',
    isNativePlatform: () => true,
    isPluginAvailable: (name: string) => name === 'AppsFlyerPlugin',
  },
}));

const mockInitSDK = vi.fn();
const mockLogEvent = vi.fn();
const mockGetUID = vi.fn();

vi.mock('appsflyer-capacitor-plugin', () => ({
  AppsFlyer: {
    initSDK: mockInitSDK,
    setCustomerUserId: vi.fn(),
    logEvent: mockLogEvent,
    getAppsFlyerUID: mockGetUID,
  },
}));

import {
  logAppsFlyerEvent,
  getAppsFlyerUidSafe,
  __resetAppsFlyerClientForTests,
} from './appsFlyerClient';

beforeEach(() => {
  vi.clearAllMocks();
  __resetAppsFlyerClientForTests();
  vi.stubEnv('VITE_APPSFLYER_DEV_KEY', 'test-dev-key');
  vi.stubEnv('VITE_APPSFLYER_APP_ID', '');
  vi.stubEnv('VITE_APPSFLYER_DEBUG', '');
  mockInitSDK.mockResolvedValue({ res: 'ok' });
  mockLogEvent.mockResolvedValue({ res: 'ok' });
  mockGetUID.mockResolvedValue({ uid: '1787622320045-5959941633477793940' });
});

describe('logAppsFlyerEvent (Phase 2, native)', () => {
  it('initializes then logs the event with name + value', async () => {
    await expect(logAppsFlyerEvent('first_activity_completed', { activity_type: 'writing' })).resolves.toBe(true);
    expect(mockInitSDK).toHaveBeenCalledTimes(1); // ensured init before logging
    expect(mockLogEvent).toHaveBeenCalledWith({
      eventName: 'first_activity_completed',
      eventValue: { activity_type: 'writing' },
    });
  });

  it('defaults eventValue to an empty object when omitted', async () => {
    await logAppsFlyerEvent('af_complete_registration');
    expect(mockLogEvent).toHaveBeenCalledWith({ eventName: 'af_complete_registration', eventValue: {} });
  });

  it('is fail-safe: a native logEvent rejection never throws (resolves false)', async () => {
    mockLogEvent.mockRejectedValueOnce(new Error('bridge down'));
    await expect(logAppsFlyerEvent('paywall_viewed')).resolves.toBe(false);
  });

  it('does not log when the dev key is missing (SDK never initializes)', async () => {
    vi.stubEnv('VITE_APPSFLYER_DEV_KEY', '');
    await expect(logAppsFlyerEvent('paywall_viewed')).resolves.toBe(false);
    expect(mockLogEvent).not.toHaveBeenCalled();
  });
});

describe('getAppsFlyerUidSafe (for RevenueCat $appsflyerId — 17)', () => {
  it('returns the AppsFlyer SDK UID (distinct from the Supabase CUID)', async () => {
    await expect(getAppsFlyerUidSafe()).resolves.toBe('1787622320045-5959941633477793940');
    expect(mockGetUID).toHaveBeenCalledTimes(1);
  });

  it('returns null (never throws) when the bridge errors', async () => {
    mockGetUID.mockRejectedValueOnce(new Error('no uid'));
    await expect(getAppsFlyerUidSafe()).resolves.toBeNull();
  });

  it('returns null for an empty uid', async () => {
    mockGetUID.mockResolvedValueOnce({ uid: '' });
    await expect(getAppsFlyerUidSafe()).resolves.toBeNull();
  });
});
