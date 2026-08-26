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
const PRODUCTION_HOST = 'app.orodim.com.br';

// Logical backup of the pre-remote-first setup (commit cb71da9): fully
// bundled, offline-capable, no server.url. Kept reachable — not deleted —
// via `npm run cap:sync:bundled` (CAPACITOR_MODE=bundled) until remote-first
// is proven out. LemonWebViewClient/LemonWebChromeClient no-op in this mode
// (MainActivity only installs them when bridge.getServerUrl() is non-null).
const isBundledMode = process.env.CAPACITOR_MODE === 'bundled';

const config: CapacitorConfig = {
  appId: 'com.lemon.app',
  appName: 'Orodim',
  // Required by `cap sync`'s packaging step either way. In remote-first mode
  // this is no longer the primary UI — it's just where the local offline-
  // fallback page (errorPath below) lives (public/mobile-fallback.html).
  webDir: 'dist',
  plugins: {
    // @capgo/capacitor-social-login ships all four providers (Google, Apple,
    // Facebook, Twitter) as `implementation` by default. Its post-`cap sync`
    // hook (scripts/configure-dependencies.js) regenerates the native provider
    // wiring from THIS block on every sync, so it is the single source of
    // truth. Orodim uses only Google (Android) and Apple (iOS) — see
    // src/lib/googleAuth.ts and src/lib/appleAuth.ts. Marking Facebook false
    // drops com.facebook.android:facebook-login/facebook-core, which is the
    // sole origin of com.google.android.gms.permission.AD_ID and the
    // ACCESS_ADSERVICES_* permissions (confirmed via manifest-merger blame),
    // and swaps in the plugin's stub FacebookProvider. This keeps the app
    // eligible to declare "No advertising ID" in the Play Console. Google and
    // Apple are left at their defaults (implementation) to preserve login.
    SocialLogin: {
      providers: {
        facebook: false,
      },
    },
    // Practice-reminder local notifications (src/lib/notifications/
    // practiceReminderService.ts). smallIcon reuses the OneSignal status-bar
    // icon already shipped in res/drawable-*/ic_stat_onesignal_default.png so
    // Android shows a proper monochrome glyph instead of a gray square. No
    // sound override — the default notification sound is fine for a reminder.
    LocalNotifications: {
      smallIcon: 'ic_stat_onesignal_default',
      iconColor: '#F5C518',
    },
  },
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
