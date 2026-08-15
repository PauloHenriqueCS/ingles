# OneSignal Push Notifications — Orodim (Android + iOS)

Client/native push infrastructure via `@onesignal/capacitor-plugin` (v1.1.7,
compatible with the project's Capacitor 8.4.2). This document covers the JS
architecture, what was configured natively, and the **manual steps that still
require macOS/Xcode or the OneSignal/Apple/Google dashboards**.

- **OneSignal App ID:** `f95f5d2b-0e8f-411c-8f15-0c976545ee0c` (public, not a secret)
- **Android applicationId:** `com.orodim.app` (namespace `com.lemon.app`)
- **iOS Bundle ID:** `app.lemonenglish.lemon` (Release) / `com.lemon.app` (Debug)
- **iOS App Group:** `group.app.lemonenglish.lemon.onesignal`

No secrets live in this repo: the Firebase Service Account, APNs `.p8`, and the
OneSignal REST API key are configured **only** in the OneSignal dashboard.

---

## 1. JS architecture (remote-first)

The Android/iOS WebView loads `https://app.orodim.com.br` live (see
`capacitor.config.ts`), so — exactly like RevenueCat and social login — the
OneSignal JS SDK ships inside the deployed web bundle and calls the **native**
OneSignal bridge. On the plain web (a browser) the SDK is never imported.

| File | Role |
| --- | --- |
| `src/lib/push/onesignalClient.ts` | Single entry point to the SDK. Native-only, idempotent `initialize`, `syncOneSignalIdentity`, permission helpers, click listener, test reset. |
| `src/hooks/useOneSignalIdentitySync.ts` | Bridges the Supabase session → OneSignal (bootstrap init once + `login`/`logout` on session change). |
| `src/App.tsx` | Mounts `useOneSignalIdentitySync(user?.id)` next to `useRevenueCatIdentitySync`. |

Guarantees enforced by the client:

- **No web init** — `isOneSignalSupported()` = `(isIOSApp || isAndroidApp) && isPluginAvailable('OneSignalCapacitor')`.
- **Single init** — `initialized` flag + in-flight promise (StrictMode-safe).
- **Identity = Supabase UUID** — `OneSignal.login(session.user.id)`; never email/RevenueCat id/token/device id.
- **Login / logout / account switch** — serialized via `identityChain`; switching users just `login`s the new UUID (OneSignal migrates the device subscription).
- **No auto-prompt** — `initialize()` never shows the OS prompt. `promptPushPermission()` is the only prompt path and must be wired to a deliberate UX moment (see §5).
- **Fail-safe** — every SDK error is swallowed with a warn; bootstrap never crashes.
- **Single click listener** — registered once inside `initialize()`; forwards a sanitized payload to an app-registered handler. It never opens arbitrary remote URLs (see §6).

---

## 2. Android — what's configured (in-repo)

- Notification small icon: `android/app/src/main/res/drawable-*/ic_stat_onesignal_default.png`, generated from the existing monochrome brand asset (`ic_launcher_monochrome`, RGBA/alpha — the correct format; Android tints the alpha mask). OneSignal auto-uses a drawable named `ic_stat_onesignal_default`.
- Location module **disabled permanently and reproducibly** via a committed Gradle transitive exclude in `android/app/build.gradle` (`exclude group: 'com.onesignal', module: 'location'`). This keeps `ACCESS_*_LOCATION` out of the merged manifest on **every** build **without** depending on the `ONESIGNAL_DISABLE_LOCATION` env var being exported (verified: the release-state `assembleDebug` manifest has no location permission). The plugin's official `ONESIGNAL_DISABLE_LOCATION=true` flag is additionally wired into the `cap:sync` npm scripts as defense-in-depth and to cover the iOS SPM resolve (ETAPA 9).
- `POST_NOTIFICATIONS` (Android 13+) is contributed by the OneSignal SDK's own manifest via manifest-merge — no manual `AndroidManifest.xml` edit needed. The SDK also requests it at the right time when you call `promptPushPermission()`.
- `google-services.json` is **not** required (OneSignal manages FCM via the dashboard Service Account). The existing conditional `google-services` block in `app/build.gradle` stays a harmless no-op.

> When building the APK/AAB locally, export the location flag in the same shell
> (Gradle re-reads it each configuration, and an IDE launched from Finder does
> not inherit your shell env):
>
> ```bash
> ONESIGNAL_DISABLE_LOCATION=true npx cap sync android
> cd android && ONESIGNAL_DISABLE_LOCATION=true ./gradlew assembleDebug
> ```

---

## 3. iOS — what's configured (in-repo)

- `ios/App/App/App.entitlements` (Debug) — `aps-environment = development` + App Group.
- `ios/App/App/AppRelease.entitlements` (Release) — `aps-environment = production` + App Group.
- `project.pbxproj` — `CODE_SIGN_ENTITLEMENTS` wired for both app configs (Debug → `App.entitlements`, Release → `AppRelease.entitlements`).
- `ios/App/App/Info.plist` — `UIBackgroundModes = [remote-notification]`.
- NSE scaffold in `ios/App/OneSignalNotificationServiceExtension/`: `NotificationService.swift`, `Info.plist`, `OneSignalNotificationServiceExtension.entitlements` (App Group).

> `capacitor.config.ts` was intentionally **not** given an `ios` block. The old
> `handleApplicationNotifications` key does **not** exist in
> `@onesignal/capacitor-plugin` 1.1.x — the plugin manages notifications via
> native swizzling automatically. Adding it would be dead config.

### 3a. Manual Xcode steps (macOS required — NOT done on Windows)

The project uses **Swift Package Manager** (`ios/App/CapApp-SPM/Package.swift`),
not CocoaPods. Do NOT convert it.

1. `ONESIGNAL_DISABLE_LOCATION=true npx cap sync ios` — adds the OneSignal plugin
   to the SPM graph (`CapApp-SPM/Package.swift`). **Run this on macOS.** This
   integration was developed on Windows, where the Capacitor CLI writes
   backslash paths into `Package.swift` that break SPM on macOS; that file was
   therefore intentionally left at its committed state and MUST be regenerated by
   `cap sync ios` on the Mac build machine. Launch Xcode from that same terminal
   so SPM inherits the env var.
2. Open `ios/App/App.xcworkspace` (or `.xcodeproj`) in Xcode.
3. **App target → Signing & Capabilities** — confirm:
   - **Push Notifications** capability is present (driven by the entitlements files above).
   - **App Groups** contains `group.app.lemonenglish.lemon.onesignal`.
   - **Background Modes → Remote notifications** is checked (from Info.plist).
   - Team `64DAPP778J`, Automatic signing (unchanged).
4. **Add the Notification Service Extension target** (the one thing that must be
   done in Xcode — a new target can't be safely hand-written into `project.pbxproj`):
   - File → New → Target → **Notification Service Extension**. Name it
     `OneSignalNotificationServiceExtension`. Set its **Deployment Target to 15.0**
     (≥ 14 required by the plugin). When Xcode says "Activate scheme?", click Cancel.
   - **Delete the auto-generated `NotificationService.swift` and `Info.plist`**
     and instead add the ones already in
     `ios/App/OneSignalNotificationServiceExtension/` (Add Files, uncheck "copy").
   - NSE bundle id: `app.lemonenglish.lemon.OneSignalNotificationServiceExtension`.
   - NSE **Signing & Capabilities → App Groups** → add the SAME group
     `group.app.lemonenglish.lemon.onesignal` (its entitlements file is provided).
5. **Link `OneSignalExtension` to the NSE target** (SPM): select the NSE target →
   General → *Frameworks and Libraries* → **+** → choose the `OneSignalExtension`
   library product from the `OneSignal-XCFramework` package. (The main app target
   already gets OneSignal transitively through the Capacitor plugin.)
6. Build the app target, then the NSE target.

### 3b. Apple Developer portal prerequisites

- App ID `app.lemonenglish.lemon` must have **Push Notifications** and **App Groups**
  (`group.app.lemonenglish.lemon.onesignal`) enabled. Automatic signing will
  regenerate the provisioning profiles once the entitlements request them.
- ⚠️ **Bundle-id split:** Debug builds use `com.lemon.app`, Release uses
  `app.lemonenglish.lemon`. OneSignal's iOS app is configured for
  `app.lemonenglish.lemon`. For push testing use a build whose bundle id matches
  the OneSignal/APNs configuration (i.e. a Release-configured build, or add
  `com.lemon.app` to APNs too). This split is pre-existing and was left unchanged.

---

## 4. Identity flow

`useOneSignalIdentitySync(user?.id)` in `App.tsx`:

- **App start with existing session** — `useAuth` restores the session → effect runs → `OneSignal.login(user.id)`.
- **Login** — `onAuthStateChange` fires → `login(user.id)`.
- **Logout** — session becomes null → `OneSignal.logout()`.
- **Account switch** — new UUID → `login(newId)` (migrates the subscription off the old user).

---

## 5. Requesting permission (wire this when product decides)

Permission is deliberately decoupled. When you add a soft-ask / onboarding step /
settings toggle, call:

```ts
import { promptPushPermission, getPushPermissionState } from '@/lib/push/onesignalClient';

const state = await getPushPermissionState(); // { supported, hasPermission, canRequest }
if (state.canRequest) {
  const granted = await promptPushPermission(/* fallbackToSettings */ true);
}
```

`fallbackToSettings: true` routes an already-denied user to the system settings.
Do NOT call this at cold start.

---

## 6. Click handling / deep links

`onesignalClient.ts` registers ONE `click` listener at init and forwards a
sanitized `PushClickPayload { actionId, url, additionalData }` to an app handler:

```ts
import { setNotificationClickHandler } from '@/lib/push/onesignalClient';

setNotificationClickHandler((payload) => {
  // Route using the app's OWN navigation. Validate before acting — never open
  // payload.url blindly. No business routes are invented here yet (TBD).
});
```

The payload URL is never auto-opened. Define the payload/deep-link contract when
push campaigns are designed (out of scope for this infrastructure task).

---

## 7. Testing from the dashboard

No REST API key or send backend is needed. Once a device shows as **Subscribed**
in OneSignal → Audience → Subscriptions (with `External ID` = the Supabase UUID),
mark it a Test Subscription and send from the dashboard. See the manual test
scripts in the PR description.
