import { isNativeApp } from './runtimeEnvironment';

/**
 * Opens an external URL from anywhere in the app, choosing the right mechanism
 * for the runtime. There was no shared helper before — the app used
 * `Browser.open` (appleAuth.ts) and `window.open` (SubscriptionView) ad hoc.
 * This centralizes the pattern so legal links (Privacy Policy / Apple EULA) in
 * the paywall open reliably INSIDE the native app instead of failing silently.
 *
 *  - Native (iOS/Android): @capacitor/browser, which opens an in-app browser
 *    (SFSafariViewController / Chrome Custom Tab). A plain `window.open` in the
 *    Capacitor WebView can be swallowed, so we must use the plugin.
 *  - Web: a normal new tab with noopener/noreferrer.
 *
 * Best-effort: a failure to open a legal link must never crash the paywall.
 */
export async function openExternalUrl(url: string): Promise<void> {
  try {
    if (isNativeApp) {
      const { Browser } = await import('@capacitor/browser');
      await Browser.open({ url });
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  } catch (err) {
    console.warn('[openExternalUrl] failed to open', url, err instanceof Error ? err.message : err);
  }
}
