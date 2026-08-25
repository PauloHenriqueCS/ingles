import { describe, it, expect, vi, beforeEach } from 'vitest';

// Simulates a real iOS native build with the AppsFlyer plugin registered.
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'ios',
    isNativePlatform: () => true,
    isPluginAvailable: (name: string) => name === 'AppsFlyerPlugin',
  },
}));

const mockInitSDK = vi.fn();
const mockSetCustomerUserId = vi.fn();

vi.mock('appsflyer-capacitor-plugin', () => ({
  AppsFlyer: {
    initSDK: mockInitSDK,
    setCustomerUserId: mockSetCustomerUserId,
  },
}));

import {
  isAppsFlyerSupported,
  initializeAppsFlyer,
  setAppsFlyerCustomerUserId,
  __resetAppsFlyerClientForTests,
} from './appsFlyerClient';

const USER_A = 'aaaaaaaa-0000-0000-0000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  __resetAppsFlyerClientForTests();
  vi.stubEnv('VITE_APPSFLYER_DEV_KEY', 'test-dev-key');
  vi.stubEnv('VITE_APPSFLYER_APP_ID', '');
  mockInitSDK.mockResolvedValue({ res: 'ok' });
  mockSetCustomerUserId.mockResolvedValue(undefined);
});

describe('appsFlyerClient on iOS', () => {
  it('isAppsFlyerSupported() is true', () => {
    expect(isAppsFlyerSupported()).toBe(true);
  });

  it('initializes with the Apple App ID (numeric, no "id" prefix) and no ATT wait', async () => {
    await initializeAppsFlyer();
    const arg = mockInitSDK.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.appID).toBe('6794127995'); // the App Store id, sans "id" prefix
    expect(arg).not.toHaveProperty('waitForATTUserAuthorization'); // AppsFlyer works without IDFA
  });

  it('sets the raw Supabase UUID as the Customer User ID', async () => {
    await setAppsFlyerCustomerUserId(USER_A);
    expect(mockSetCustomerUserId).toHaveBeenCalledWith({ cuid: USER_A });
  });
});
