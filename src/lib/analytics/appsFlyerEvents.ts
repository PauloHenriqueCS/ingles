import { supabase } from '../supabase';
import { isIOSApp, isAndroidApp } from '../runtimeEnvironment';
import { isAppsFlyerSupported, logAppsFlyerEvent } from './appsFlyerClient';

/**
 * AppsFlyer Phase 2 — the marketing/acquisition funnel, orchestrated on top of
 * the native wrapper (appsFlyerClient.ts). This module owns the DECISION of
 * whether an event may fire; appsFlyerClient owns the native bridge. Every
 * function here is:
 *   - native-only (a no-op on web / when the SDK is unsupported),
 *   - fail-safe (an analytics failure NEVER throws to the caller — it must never
 *     block an activity, a registration, or a purchase),
 *   - PII-free (only the activity type / plan / store go out; identity is the
 *     Supabase UUID already set as the AppsFlyer Customer User ID),
 *   - server-authoritative for idempotency and the "stop after first payment"
 *     rule (the one-shot / one-per-day claims and the ever-paid gate live in
 *     Postgres — see migration 20260825120000_appsflyer_marketing_events.sql —
 *     so they survive reload, logout/login, device switch and reinstall).
 *
 * Revenue/purchase events are deliberately NOT sent from here — those flow
 * server-side through the RevenueCat→AppsFlyer integration to avoid double
 * counting (see revenueCatClient.ts for the $appsflyerId wiring that enables it).
 */

export type AppsFlyerActivityType =
  | 'writing'
  | 'pronunciation'
  | 'listening'
  | 'review'
  | 'conversation';

// Canonical AppsFlyer event names (the only authorized Phase 2 events).
const EVENT_REGISTRATION = 'af_complete_registration';
const EVENT_FIRST_ACTIVITY = 'first_activity_completed';
const EVENT_LEARNING_DAY = 'learning_day_completed';
const EVENT_PAYWALL_VIEWED = 'paywall_viewed';
const EVENT_INITIATED_CHECKOUT = 'af_initiated_checkout';

/**
 * Session cache of the ever-paid gate for the non-claim behavioural events
 * (paywall_viewed / af_initiated_checkout). "Ever paid" only ever flips
 * false→true, so a cached `false` (blocked) is sticky and safe. Reset on an
 * identity change so a different signed-in user is re-evaluated.
 */
let marketingAllowedCache: boolean | null = null;

/** Call when the signed-in user changes (see useAppsFlyerIdentitySync). */
export function resetAppsFlyerMarketingCache(): void {
  marketingAllowedCache = null;
}

async function marketingAllowed(): Promise<boolean> {
  // Once we know this user has paid, stay blocked without another round-trip.
  if (marketingAllowedCache === false) return false;
  try {
    const { data, error } = await supabase.rpc('appsflyer_marketing_allowed');
    if (error) {
      // Fail-open for the funnel events: a transient gate failure should not
      // silently drop acquisition data. The one-shot activity claims enforce
      // ever-paid independently server-side, so this only affects paywall/checkout.
      return marketingAllowedCache ?? true;
    }
    marketingAllowedCache = data === true;
    return marketingAllowedCache;
  } catch {
    return marketingAllowedCache ?? true;
  }
}

function storeName(): 'app_store' | 'play_store' | undefined {
  if (isIOSApp) return 'app_store';
  if (isAndroidApp) return 'play_store';
  return undefined;
}

/**
 * af_complete_registration — fired exactly once for a genuinely new account.
 * The server RPC decides (never on login/restore, never on a second device,
 * never retroactively for a pre-existing user); we only log what it authorizes.
 * Safe to call on every identity resolution — it self-suppresses after the first.
 */
export async function trackRegistrationCompleted(): Promise<void> {
  if (!isAppsFlyerSupported()) return;
  try {
    const { data, error } = await supabase.rpc('claim_appsflyer_registration');
    if (error || data !== true) return;
    await logAppsFlyerEvent(EVENT_REGISTRATION);
  } catch {
    // never throw from analytics
  }
}

/**
 * Called after a GENUINE activity completion (writing/pronunciation/listening/
 * review/conversation). One server round-trip decides both one-shot events:
 *   - first_activity_completed — once in the user's lifetime (and never for a
 *     user who already had completions before the feature shipped),
 *   - learning_day_completed   — at most once per America/Sao_Paulo day.
 * Both are suppressed once the user has ever paid. We only fire what the RPC
 * authorizes.
 */
export async function trackActivityCompleted(activityType: AppsFlyerActivityType): Promise<void> {
  if (!isAppsFlyerSupported()) return;
  try {
    const { data, error } = await supabase.rpc('claim_appsflyer_activity_events', {
      p_activity_type: activityType,
    });
    if (error || !data) return;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return;

    if (row.first_activity === true) {
      await logAppsFlyerEvent(EVENT_FIRST_ACTIVITY, { activity_type: activityType });
    }
    if (row.learning_day === true) {
      const value: Record<string, unknown> = { activity_type: activityType };
      if (row.days_since_registration != null) {
        value.days_since_registration = row.days_since_registration;
      }
      await logAppsFlyerEvent(EVENT_LEARNING_DAY, value);
    }
  } catch {
    // never throw from analytics
  }
}

/**
 * paywall_viewed — the subscription paywall (plan cards offered for purchase)
 * became visible. Not one-shot (it's useful to know a user returned), but
 * suppressed after the first payment and de-duped per genuine view by the
 * caller (a ref guard in SubscriptionView, since the component unmounts on
 * navigation away). `source` (optional) = which surface/limit routed here.
 */
export async function trackPaywallViewed(source?: string): Promise<void> {
  if (!isAppsFlyerSupported()) return;
  try {
    if (!(await marketingAllowed())) return;
    await logAppsFlyerEvent(EVENT_PAYWALL_VIEWED, source ? { source } : {});
  } catch {
    // never throw from analytics
  }
}

/**
 * af_initiated_checkout — the real store purchase flow is starting (fired right
 * before Purchases.purchasePackage, after its guards). Subscriptions only.
 * Suppressed after the first payment. No price is sent (the store owns pricing;
 * revenue flows via RevenueCat→AppsFlyer).
 */
export async function trackCheckoutStarted(plan: 'essential' | 'plus'): Promise<void> {
  if (!isAppsFlyerSupported()) return;
  try {
    if (!(await marketingAllowed())) return;
    const value: Record<string, unknown> = { plan };
    const store = storeName();
    if (store) value.store = store;
    await logAppsFlyerEvent(EVENT_INITIATED_CHECKOUT, value);
  } catch {
    // never throw from analytics
  }
}
