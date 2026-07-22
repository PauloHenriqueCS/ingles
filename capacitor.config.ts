import type { CapacitorConfig } from '@capacitor/cli';

// Remote-first: the WebView loads the production site directly, so a web
// deploy reaches the installed app without a new APK/AAB. This alone is not
// a security boundary — see android/app/src/main/java/com/lemon/app/
// LemonWebViewClient.java and LemonWebChromeClient.java, which are the
// actual enforcement (exact-origin navigation, exact-origin mic grants).
// allowNavigation is kept in sync with that same host for the pieces of
// Capacitor's own internals that consult it (e.g. the bridge's injected-
// script origin allowlist) — it is defense-in-depth, not the boundary
// itself, since it only compares host, never scheme (an http:// request to
// the same host passes it — confirmed by reading Bridge.java).
const PRODUCTION_HOST = 'my.lemonenglish.app';

// Logical backup of the pre-remote-first setup (commit cb71da9): fully
// bundled, offline-capable, no server.url. Kept reachable — not deleted —
// via `npm run cap:sync:bundled` (CAPACITOR_MODE=bundled) until remote-first
// is proven out. LemonWebViewClient/LemonWebChromeClient no-op in this mode
// (MainActivity only installs them when bridge.getServerUrl() is non-null).
const isBundledMode = process.env.CAPACITOR_MODE === 'bundled';

const config: CapacitorConfig = {
  appId: 'com.lemon.app',
  appName: 'Lemon',
  // Required by `cap sync`'s packaging step either way. In remote-first mode
  // this is no longer the primary UI — it's just where the local offline-
  // fallback page (errorPath below) lives (public/mobile-fallback.html).
  webDir: 'dist',
  ...(isBundledMode
    ? {}
    : {
        server: {
          url: `https://${PRODUCTION_HOST}`,
          cleartext: false,
          allowNavigation: [PRODUCTION_HOST],
          // Served locally (bundled in the APK, no network needed) whenever
          // the WebView fails to load the production URL.
          errorPath: 'mobile-fallback.html',
        },
      }),
};

export default config;
