import { describe, it, expect, vi, beforeEach } from 'vitest';

// Simulates a real Android native build with the AppsFlyer plugin registered —
// see runtimeEnvironment.ts's module-level isAndroidApp/isPluginAvailable.
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'android',
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
  isAppsFlyerInitialized,
  initializeAppsFlyer,
  setAppsFlyerCustomerUserId,
  __resetAppsFlyerClientForTests,
} from './appsFlyerClient';

const USER_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_B = 'bbbbbbbb-0000-0000-0000-000000000002';

beforeEach(() => {
  vi.clearAllMocks();
  __resetAppsFlyerClientForTests();
  vi.stubEnv('VITE_APPSFLYER_DEV_KEY', 'test-dev-key');
  vi.stubEnv('VITE_APPSFLYER_APP_ID', ''); // exercise the fallback app id
  vi.stubEnv('VITE_APPSFLYER_DEBUG', '');
  mockInitSDK.mockResolvedValue({ res: 'ok' });
  mockSetCustomerUserId.mockResolvedValue(undefined);
});

describe('appsFlyerClient on Android — support + init', () => {
  it('isAppsFlyerSupported() is true', () => {
    expect(isAppsFlyerSupported()).toBe(true);
  });

  it('initializes the SDK once, with the dev key, the fallback appID, debug off, and no ATT wait', async () => {
    await expect(initializeAppsFlyer()).resolves.toBe(true);
    expect(mockInitSDK).toHaveBeenCalledTimes(1);
    const arg = mockInitSDK.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.devKey).toBe('test-dev-key');
    expect(arg.appID).toBe('6794127995'); // FALLBACK_APP_ID (iOS id; ignored on Android)
    // With no VITE_APPSFLYER_DEBUG opt-in, isDebug tracks import.meta.env.DEV —
    // which Vite inlines to false in a production build (`vite build`). Under
    // vitest this value is DEV=true; asserting the mirror pins the exact
    // contract that guarantees debug is OFF in production without needing to
    // fake a production build inside a dev-mode test runner.
    expect(arg.isDebug).toBe(Boolean(import.meta.env.DEV));
    expect(arg).not.toHaveProperty('manualStart'); // auto-start: install before login
    expect(arg).not.toHaveProperty('waitForATTUserAuthorization'); // ATT not implemented
    expect(isAppsFlyerInitialized()).toBe(true);
  });

  it('does not initialize twice (idempotent bootstrap)', async () => {
    await initializeAppsFlyer();
    await initializeAppsFlyer();
    expect(mockInitSDK).toHaveBeenCalledTimes(1);
  });

  it('collapses concurrent init calls (StrictMode double-mount) into one initSDK', async () => {
    let resolveInit!: () => void;
    mockInitSDK.mockReturnValue(new Promise((resolve) => { resolveInit = () => resolve({ res: 'ok' }); }));
    const a = initializeAppsFlyer();
    const b = initializeAppsFlyer();
    resolveInit();
    await Promise.all([a, b]);
    expect(mockInitSDK).toHaveBeenCalledTimes(1);
  });

  it('opts into debug logs only when VITE_APPSFLYER_DEBUG=true (homolog), even in a prod build', async () => {
    vi.stubEnv('VITE_APPSFLYER_DEBUG', 'true');
    await initializeAppsFlyer();
    expect((mockInitSDK.mock.calls[0][0] as Record<string, unknown>).isDebug).toBe(true);
  });


  it('uses VITE_APPSFLYER_APP_ID when set, over the fallback', async () => {
    vi.stubEnv('VITE_APPSFLYER_APP_ID', '9999999999');
    await initializeAppsFlyer();
    expect((mockInitSDK.mock.calls[0][0] as Record<string, unknown>).appID).toBe('9999999999');
  });

  it('stays fail-safe with no dev key — never initializes, never crashes, never logs the key', async () => {
    vi.stubEnv('VITE_APPSFLYER_DEV_KEY', '');
    await expect(initializeAppsFlyer()).resolves.toBe(false);
    expect(mockInitSDK).not.toHaveBeenCalled();
    expect(isAppsFlyerInitialized()).toBe(false);
  });

  it('a failing initSDK resolves false (bootstrap never throws) and stays retryable', async () => {
    mockInitSDK.mockRejectedValueOnce(new Error('boom'));
    await expect(initializeAppsFlyer()).resolves.toBe(false);
    expect(isAppsFlyerInitialized()).toBe(false);
    // Retry succeeds now that the error is gone.
    mockInitSDK.mockResolvedValue({ res: 'ok' });
    await expect(initializeAppsFlyer()).resolves.toBe(true);
    expect(mockInitSDK).toHaveBeenCalledTimes(2);
  });
});

describe('appsFlyerClient on Android — Customer User ID = Supabase UUID', () => {
  it('sets the raw Supabase UUID as the CUID (no prefix/transform), initializing on demand', async () => {
    await setAppsFlyerCustomerUserId(USER_A);
    expect(mockInitSDK).toHaveBeenCalledTimes(1); // self-initializes if bootstrap hasn't run
    expect(mockSetCustomerUserId).toHaveBeenCalledTimes(1);
    expect(mockSetCustomerUserId).toHaveBeenCalledWith({ cuid: USER_A });
  });

  it('does not re-send the same CUID (session restore re-fires the effect)', async () => {
    await setAppsFlyerCustomerUserId(USER_A);
    await setAppsFlyerCustomerUserId(USER_A);
    expect(mockSetCustomerUserId).toHaveBeenCalledTimes(1);
  });

  it('updates the CUID on an account switch', async () => {
    await setAppsFlyerCustomerUserId(USER_A);
    await setAppsFlyerCustomerUserId(USER_B);
    expect(mockSetCustomerUserId).toHaveBeenCalledTimes(2);
    expect(mockSetCustomerUserId).toHaveBeenLastCalledWith({ cuid: USER_B });
  });

  it('sign-out is a no-op — no clear-CUID API is invented', async () => {
    await setAppsFlyerCustomerUserId(USER_A);
    mockSetCustomerUserId.mockClear();
    await setAppsFlyerCustomerUserId(null);
    expect(mockSetCustomerUserId).not.toHaveBeenCalled();
  });

  it('relogin by the SAME user after sign-out does not re-send the CUID', async () => {
    await setAppsFlyerCustomerUserId(USER_A);
    await setAppsFlyerCustomerUserId(null); // sign out (no-op)
    mockSetCustomerUserId.mockClear();
    await setAppsFlyerCustomerUserId(USER_A); // relogin same user
    expect(mockSetCustomerUserId).not.toHaveBeenCalled();
  });

  it('a DIFFERENT user after sign-out does update the CUID', async () => {
    await setAppsFlyerCustomerUserId(USER_A);
    await setAppsFlyerCustomerUserId(null); // sign out
    await setAppsFlyerCustomerUserId(USER_B); // different user logs in
    expect(mockSetCustomerUserId).toHaveBeenLastCalledWith({ cuid: USER_B });
  });

  it('a null id before auth resolves never touches the SDK (no anonymous CUID)', async () => {
    await setAppsFlyerCustomerUserId(null);
    expect(mockInitSDK).not.toHaveBeenCalled();
    expect(mockSetCustomerUserId).not.toHaveBeenCalled();
  });

  it('never sets a CUID when the dev key is missing (SDK never initializes)', async () => {
    vi.stubEnv('VITE_APPSFLYER_DEV_KEY', '');
    await setAppsFlyerCustomerUserId(USER_A);
    expect(mockSetCustomerUserId).not.toHaveBeenCalled();
  });

  it('serializes overlapping identity calls (fast sign-out-then-sign-in), landing on the last id', async () => {
    const first = setAppsFlyerCustomerUserId(USER_A);
    const second = setAppsFlyerCustomerUserId(USER_B);
    await Promise.all([first, second]);
    expect(mockInitSDK).toHaveBeenCalledTimes(1);
    expect(mockSetCustomerUserId).toHaveBeenLastCalledWith({ cuid: USER_B });
  });

  it('a failing setCustomerUserId never rejects the caller', async () => {
    mockSetCustomerUserId.mockRejectedValueOnce(new Error('boom'));
    await expect(setAppsFlyerCustomerUserId(USER_A)).resolves.toBeUndefined();
  });
});
