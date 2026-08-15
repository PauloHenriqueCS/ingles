import { describe, it, expect, vi, beforeEach } from 'vitest';

// Simulates a native Android Capacitor shell with the OneSignal bridge present.
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'android',
    isNativePlatform: () => true,
    isPluginAvailable: (name: string) => name === 'OneSignalCapacitor',
  },
}));

const mockInitialize = vi.fn().mockResolvedValue(undefined);
const mockLogin = vi.fn().mockResolvedValue(undefined);
const mockLogout = vi.fn().mockResolvedValue(undefined);
const mockSetLogLevel = vi.fn();
const mockAddEventListener = vi.fn();
const mockRequestPermission = vi.fn().mockResolvedValue(true);
const mockHasPermission = vi.fn().mockResolvedValue(false);
const mockCanRequestPermission = vi.fn().mockResolvedValue(true);

vi.mock('@onesignal/capacitor-plugin', () => ({
  default: {
    initialize: (appId: string) => mockInitialize(appId),
    login: (id: string) => mockLogin(id),
    logout: () => mockLogout(),
    Debug: { setLogLevel: (l: number) => mockSetLogLevel(l) },
    Notifications: {
      addEventListener: (e: string, cb: unknown) => mockAddEventListener(e, cb),
      requestPermission: (f?: boolean) => mockRequestPermission(f),
      hasPermission: () => mockHasPermission(),
      canRequestPermission: () => mockCanRequestPermission(),
    },
  },
  LogLevel: { Verbose: 6 },
}));

import {
  isOneSignalSupported,
  isOneSignalInitialized,
  initializeOneSignal,
  syncOneSignalIdentity,
  promptPushPermission,
  getPushPermissionState,
  setNotificationClickHandler,
  __resetOneSignalClientForTests,
} from './onesignalClient';

const APP_ID = 'f95f5d2b-0e8f-411c-8f15-0c976545ee0c';
const USER_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_B = 'bbbbbbbb-0000-0000-0000-000000000002';

beforeEach(() => {
  vi.clearAllMocks();
  mockInitialize.mockResolvedValue(undefined);
  mockLogin.mockResolvedValue(undefined);
  mockLogout.mockResolvedValue(undefined);
  __resetOneSignalClientForTests();
});

describe('onesignalClient on native', () => {
  it('is supported when the native bridge is present', () => {
    expect(isOneSignalSupported()).toBe(true);
  });

  it('initializes exactly once with the OneSignal App ID, even across many calls', async () => {
    await Promise.all([initializeOneSignal(), initializeOneSignal()]);
    await initializeOneSignal();
    expect(mockInitialize).toHaveBeenCalledTimes(1);
    expect(mockInitialize).toHaveBeenCalledWith(APP_ID);
    expect(isOneSignalInitialized()).toBe(true);
  });

  it('registers the notification click listener exactly once', async () => {
    await initializeOneSignal();
    await initializeOneSignal();
    const clickRegistrations = mockAddEventListener.mock.calls.filter(([e]) => e === 'click');
    expect(clickRegistrations).toHaveLength(1);
  });

  it('logs in with the exact Supabase UUID once a user is known', async () => {
    await syncOneSignalIdentity(USER_A);
    expect(mockInitialize).toHaveBeenCalledTimes(1);
    expect(mockLogin).toHaveBeenCalledTimes(1);
    expect(mockLogin).toHaveBeenCalledWith(USER_A);
  });

  it('does NOT request notification permission automatically during init/identity', async () => {
    await initializeOneSignal();
    await syncOneSignalIdentity(USER_A);
    expect(mockRequestPermission).not.toHaveBeenCalled();
  });

  it('is a no-op login when the same user id is synced repeatedly', async () => {
    await syncOneSignalIdentity(USER_A);
    await syncOneSignalIdentity(USER_A);
    expect(mockLogin).toHaveBeenCalledTimes(1);
  });

  it('logs out when the session ends', async () => {
    await syncOneSignalIdentity(USER_A);
    await syncOneSignalIdentity(null);
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });

  it('switches accounts by logging in the new UUID (no stale binding, no logout in between)', async () => {
    await syncOneSignalIdentity(USER_A);
    await syncOneSignalIdentity(USER_B);
    expect(mockLogin).toHaveBeenNthCalledWith(1, USER_A);
    expect(mockLogin).toHaveBeenNthCalledWith(2, USER_B);
    expect(mockLogout).not.toHaveBeenCalled();
  });

  it('with no session, initializes but never logs in or out anonymously', async () => {
    await syncOneSignalIdentity(null);
    expect(mockInitialize).toHaveBeenCalledTimes(1);
    expect(mockLogin).not.toHaveBeenCalled();
    expect(mockLogout).not.toHaveBeenCalled();
  });

  it('a failing SDK initialize does not crash bootstrap and stays retryable', async () => {
    mockInitialize.mockRejectedValueOnce(new Error('boom'));
    await expect(initializeOneSignal()).resolves.toBe(false);
    expect(isOneSignalInitialized()).toBe(false);
    // identity sync also survives a failed init without throwing or logging in
    await expect(syncOneSignalIdentity(USER_A)).resolves.toBeUndefined();
    // the retry (init now succeeds) goes through and logs in
    await syncOneSignalIdentity(USER_A);
    expect(mockLogin).toHaveBeenCalledWith(USER_A);
  });

  it('a failing login is swallowed (bootstrap never throws)', async () => {
    mockLogin.mockRejectedValueOnce(new Error('login failed'));
    await expect(syncOneSignalIdentity(USER_A)).resolves.toBeUndefined();
  });

  it('promptPushPermission requests permission only when explicitly called', async () => {
    const granted = await promptPushPermission(true);
    expect(granted).toBe(true);
    expect(mockRequestPermission).toHaveBeenCalledTimes(1);
    expect(mockRequestPermission).toHaveBeenCalledWith(true);
  });

  it('getPushPermissionState reads live permission state after init', async () => {
    await initializeOneSignal();
    mockHasPermission.mockResolvedValueOnce(true);
    mockCanRequestPermission.mockResolvedValueOnce(false);
    await expect(getPushPermissionState()).resolves.toEqual({
      supported: true,
      hasPermission: true,
      canRequest: false,
    });
  });

  it('forwards a sanitized payload to the app click handler (no raw URL auto-open)', async () => {
    const handler = vi.fn();
    setNotificationClickHandler(handler);
    await initializeOneSignal();
    const clickCb = mockAddEventListener.mock.calls.find(([e]) => e === 'click')?.[1] as (
      e: unknown,
    ) => void;
    clickCb({
      result: { actionId: 'open', url: 'https://app.orodim.com.br/x' },
      notification: { additionalData: { screen: 'review' } },
    });
    expect(handler).toHaveBeenCalledWith({
      actionId: 'open',
      url: 'https://app.orodim.com.br/x',
      additionalData: { screen: 'review' },
    });
  });
});
