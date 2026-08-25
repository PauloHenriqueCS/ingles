import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Controls the native/web branch without touching Capacitor internals. Live
// binding: openExternalUrl reads `isNativeApp` at call time, so the getter
// re-evaluates per call and a single file can exercise both platforms.
let nativeFlag = false;
vi.mock('./runtimeEnvironment', () => ({
  get isNativeApp() {
    return nativeFlag;
  },
}));

const browserOpen = vi.fn();
vi.mock('@capacitor/browser', () => ({
  Browser: { open: browserOpen, close: vi.fn() },
}));

const windowOpen = vi.fn();

import { openExternalUrl } from './openExternalUrl';

const URL = 'https://www.orodim.com.br/privacy';

describe('openExternalUrl', () => {
  beforeEach(() => {
    browserOpen.mockReset();
    windowOpen.mockReset();
    vi.stubGlobal('window', { open: windowOpen });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('on native uses the Capacitor in-app Browser (never window.open)', async () => {
    nativeFlag = true;
    await openExternalUrl(URL);
    expect(browserOpen).toHaveBeenCalledWith({ url: URL });
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it('on web opens a new tab with noopener/noreferrer (never the Capacitor Browser)', async () => {
    nativeFlag = false;
    await openExternalUrl(URL);
    expect(windowOpen).toHaveBeenCalledWith(URL, '_blank', 'noopener,noreferrer');
    expect(browserOpen).not.toHaveBeenCalled();
  });

  it('never throws even if the opener fails (a legal link must not crash the paywall)', async () => {
    nativeFlag = true;
    browserOpen.mockRejectedValueOnce(new Error('boom'));
    await expect(openExternalUrl(URL)).resolves.toBeUndefined();
  });
});
