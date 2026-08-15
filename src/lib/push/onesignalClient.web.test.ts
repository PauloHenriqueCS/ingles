import { describe, it, expect, vi, beforeEach } from 'vitest';

// Simulates the real web build: a browser tab with no native shell, exactly
// like runtimeEnvironment.ts sees it (getPlatform 'web', isNativePlatform
// false). Push must be completely inert here — the SDK is never even imported.
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'web',
    isNativePlatform: () => false,
    isPluginAvailable: () => false,
  },
}));

const mockInitialize = vi.fn();
const mockLogin = vi.fn();
const mockLogout = vi.fn();
const mockRequestPermission = vi.fn();
const mockAddEventListener = vi.fn();

vi.mock('@onesignal/capacitor-plugin', () => ({
  default: {
    initialize: mockInitialize,
    login: mockLogin,
    logout: mockLogout,
    Debug: { setLogLevel: vi.fn() },
    Notifications: {
      addEventListener: mockAddEventListener,
      requestPermission: mockRequestPermission,
      hasPermission: vi.fn(),
      canRequestPermission: vi.fn(),
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
  __resetOneSignalClientForTests,
} from './onesignalClient';

beforeEach(() => {
  vi.clearAllMocks();
  __resetOneSignalClientForTests();
});

describe('onesignalClient on the web build', () => {
  it('isOneSignalSupported() is false', () => {
    expect(isOneSignalSupported()).toBe(false);
  });

  it('initializeOneSignal never imports or initializes the SDK', async () => {
    await expect(initializeOneSignal()).resolves.toBe(false);
    expect(mockInitialize).not.toHaveBeenCalled();
    expect(isOneSignalInitialized()).toBe(false);
  });

  it('syncOneSignalIdentity never touches the SDK', async () => {
    await syncOneSignalIdentity('aaaaaaaa-0000-0000-0000-000000000001');
    expect(mockInitialize).not.toHaveBeenCalled();
    expect(mockLogin).not.toHaveBeenCalled();
  });

  it('promptPushPermission resolves false without prompting', async () => {
    await expect(promptPushPermission()).resolves.toBe(false);
    expect(mockRequestPermission).not.toHaveBeenCalled();
  });

  it('getPushPermissionState reports unsupported', async () => {
    await expect(getPushPermissionState()).resolves.toEqual({
      supported: false,
      hasPermission: false,
      canRequest: false,
    });
  });

  it('never registers notification listeners', async () => {
    await initializeOneSignal();
    expect(mockAddEventListener).not.toHaveBeenCalled();
  });
});
