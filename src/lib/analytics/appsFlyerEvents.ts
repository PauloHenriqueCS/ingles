import { supabase } from '../supabase';
import { isIOSApp, isAndroidApp } from '../runtimeEnvironment';
import {
  isAppsFlyerSupported,
  logAppsFlyerEvent,
  setAppsFlyerCustomerUserId,
  getCapturedConversionData,
  setAppsFlyerConversionSubscriber,
  getAppsFlyerUidSafe,
} from './appsFlyerClient';

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
    if (error) return false; // FAIL-CLOSED: never send if we can't confirm eligibility
    // Only a definitive answer is cached. A definitive `false` (ever paid) sticks
    // forever; a transient error above is not cached, so it is retried next time.
    marketingAllowedCache = data === true;
    return marketingAllowedCache;
  } catch {
    return false; // FAIL-CLOSED: prefer losing a marketing event to sending post-payment
  }
}

/**
 * Mark a claimed event delivered — called ONLY after logAppsFlyerEvent returned
 * true. Until this runs the slot stays 'pending' and a future completion can
 * retry it, so a native logEvent failure never permanently consumes the one-shot.
 * Fail-safe (a mark-sent failure just leaves the slot retryable).
 */
async function markEventSent(eventKey: 'registration' | 'first_activity' | 'learning_day'): Promise<void> {
  try {
    await supabase.rpc('mark_appsflyer_event_sent', { p_event_key: eventKey });
  } catch {
    // leave it 'pending' — a later claim will retry
  }
}

function storeName(): 'app_store' | 'play_store' | undefined {
  if (isIOSApp) return 'app_store';
  if (isAndroidApp) return 'play_store';
  return undefined;
}

function platformName(): 'ios' | 'android' | 'web' {
  if (isIOSApp) return 'ios';
  if (isAndroidApp) return 'android';
  return 'web';
}

// ── Acquisition attribution (item 2) ────────────────────────────────────────
// Links the AppsFlyer install attribution (media_source/campaign/adset/ad/
// af_status/...) to the authenticated Supabase UUID and persists it server-side
// (record_acquisition_attribution). The attribution and the identity can become
// ready in either order, so we (a) persist on identity resolution using whatever
// conversion data has already arrived, and (b) subscribe so a later-arriving
// payload is persisted too. Never fabricates values — absent fields stay null,
// and organic installs (af_status='Organic') are recorded as organic.
let attributionUserId: string | null = null;
let attributionSubscriberWired = false;

async function recordAcquisitionAttribution(): Promise<void> {
  if (!isAppsFlyerSupported()) return;
  if (!attributionUserId) return;
  try {
    const conversion = getCapturedConversionData();
    const afId = await getAppsFlyerUidSafe();
    // Nothing meaningful to persist yet — wait for the conversion callback.
    if (!conversion && !afId) return;
    await supabase.rpc('record_acquisition_attribution', {
      p_af_id: afId,
      p_platform: platformName(),
      p_conversion: conversion ?? null,
    });
  } catch {
    // never throw from analytics
  }
}

function ensureAttributionSubscriber(): void {
  if (attributionSubscriberWired) return;
  attributionSubscriberWired = true;
  setAppsFlyerConversionSubscriber(() => {
    void recordAcquisitionAttribution();
  });
}

// ── Internal paywall/checkout funnel telemetry (item 3) ─────────────────────
// Recorded in our OWN DB for EVERY event (independent of the AppsFlyer ever-paid
// gate), so the paywall_viewed → checkout_started → trial/subscription → purchase
// funnel is measurable without AppsFlyer. All platforms (native + web). No
// sensitive payment data — only the surface/plan/store/platform. Fail-safe.
async function recordPaywallViewedInternal(source?: string): Promise<void> {
  try {
    await supabase.rpc('record_paywall_viewed', {
      p_source: source ?? null,
      p_platform: platformName(),
    });
  } catch {
    // never throw from analytics
  }
}

async function recordCheckoutStartedInternal(plan: 'essential' | 'plus'): Promise<void> {
  try {
    await supabase.rpc('record_checkout_started', {
      p_plan: plan,
      p_store: storeName() ?? null,
      p_platform: platformName(),
    });
  } catch {
    // never throw from analytics
  }
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
    // The slot is 'pending'; only mark it delivered once the native log succeeds,
    // otherwise it stays retryable (never lost to a logEvent failure).
    if (await logAppsFlyerEvent(EVENT_REGISTRATION)) {
      await markEventSent('registration');
    }
  } catch {
    // never throw from analytics
  }
}

/**
 * Identity → registration, in the RIGHT ORDER. The AppsFlyer Customer User ID
 * (Supabase UUID) is set AND confirmed (setAppsFlyerCustomerUserId resolves after
 * the native setCustomerUserId, which also initializes the SDK) BEFORE
 * af_complete_registration fires — so the registration event can never be sent
 * before the CUID exists on this install. Also resets the ever-paid gate cache so
 * a different signed-in user is re-evaluated. Fail-safe throughout; sign-out
 * (userId null) sets no CUID and fires no registration.
 */
export async function syncAppsFlyerIdentityAndRegistration(userId: string | null): Promise<void> {
  if (!isAppsFlyerSupported()) return;
  resetAppsFlyerMarketingCache();
  attributionUserId = userId; // whom to attribute; sign-out (null) parks it, no-op
  ensureAttributionSubscriber(); // catch attribution that arrives after this sync
  await setAppsFlyerCustomerUserId(userId); // never rejects; resolves after the CUID is set
  if (userId) {
    await trackRegistrationCompleted();
    void recordAcquisitionAttribution(); // persist whatever attribution already arrived
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

    // Each authorized slot is 'pending'; flip it 'sent' only after its native log
    // succeeds, so a logEvent failure leaves it retryable on the next completion.
    if (row.first_activity === true) {
      if (await logAppsFlyerEvent(EVENT_FIRST_ACTIVITY, { activity_type: activityType })) {
        await markEventSent('first_activity');
      }
    }
    if (row.learning_day === true) {
      const value: Record<string, unknown> = { activity_type: activityType };
      if (row.days_since_registration != null) {
        value.days_since_registration = row.days_since_registration;
      }
      if (await logAppsFlyerEvent(EVENT_LEARNING_DAY, value)) {
        await markEventSent('learning_day');
      }
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
  // Internal funnel telemetry first — recorded on every platform and even after
  // the first payment (unlike the AppsFlyer send below), so the paywall funnel
  // is fully measurable in our own DB.
  void recordPaywallViewedInternal(source);
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
  // Internal funnel telemetry first — see trackPaywallViewed.
  void recordCheckoutStartedInternal(plan);
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
