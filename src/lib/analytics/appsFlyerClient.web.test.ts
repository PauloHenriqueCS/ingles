import { describe, it, expect, vi, beforeEach } from 'vitest';

// Simulates the real web build: Capacitor.getPlatform() is 'web' and
// isNativePlatform() is false, exactly like a browser tab with no native shell
// — see runtimeEnvironment.ts's module-level isIOSApp/isAndroidApp.
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'web',
    isNativePlatform: () => false,
    isPluginAvailable: () => false,
  },
}));

const mockInitSDK = vi.fn();
const mockSetCustomerUserId = vi.fn();
const mockLogEvent = vi.fn();
const mockGetUID = vi.fn();

vi.mock('appsflyer-capacitor-plugin', () => ({
  AppsFlyer: {
    initSDK: mockInitSDK,
    setCustomerUserId: mockSetCustomerUserId,
    logEvent: mockLogEvent,
    getAppsFlyerUID: mockGetUID,
  },
}));

import {
  isAppsFlyerSupported,
  isAppsFlyerInitialized,
  initializeAppsFlyer,
  setAppsFlyerCustomerUserId,
  logAppsFlyerEvent,
  getAppsFlyerUidSafe,
  __resetAppsFlyerClientForTests,
} from './appsFlyerClient';

beforeEach(() => {
  vi.clearAllMocks();
  __resetAppsFlyerClientForTests();
  vi.stubEnv('VITE_APPSFLYER_DEV_KEY', 'test-dev-key');
});

describe('appsFlyerClient on the web build', () => {
  it('isAppsFlyerSupported() is false', () => {
    expect(isAppsFlyerSupported()).toBe(false);
  });

  it('initializeAppsFlyer() never imports/starts the SDK and reports not-ready', async () => {
    await expect(initializeAppsFlyer()).resolves.toBe(false);
    expect(mockInitSDK).not.toHaveBeenCalled();
    expect(isAppsFlyerInitialized()).toBe(false);
  });

  it('setAppsFlyerCustomerUserId never touches the SDK', async () => {
    await setAppsFlyerCustomerUserId('aaaaaaaa-0000-0000-0000-000000000001');
    expect(mockInitSDK).not.toHaveBeenCalled();
    expect(mockSetCustomerUserId).not.toHaveBeenCalled();
  });

  it('logAppsFlyerEvent is an inert no-op on web (resolves false, never logs)', async () => {
    await expect(logAppsFlyerEvent('paywall_viewed', { source: 'x' })).resolves.toBe(false);
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it('getAppsFlyerUidSafe returns null on web without touching the SDK', async () => {
    await expect(getAppsFlyerUidSafe()).resolves.toBeNull();
    expect(mockGetUID).not.toHaveBeenCalled();
  });
});
