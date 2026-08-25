/**
 * Canonical legal URLs surfaced inside the subscription flow (App Store
 * Guideline 3.1.2(c)). Single source of truth — never inline these URLs in a
 * component or duplicate them.
 *
 *  - PRIVACY_POLICY_URL: shown on EVERY platform (iOS, iPadOS, Android, web).
 *  - APPLE_EULA_URL: Apple's Standard EULA (Licensed Application End User
 *    License Agreement). Shown ONLY on iOS/iPadOS — never on Android or web.
 *    Do NOT replace it with an Orodim-specific terms URL: Apple requires this
 *    exact Standard EULA link when the app does not ship its own custom EULA.
 */
export const PRIVACY_POLICY_URL = 'https://www.orodim.com.br/privacy';
export const APPLE_EULA_URL = 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/';
