import { describe, it, expect } from 'vitest';
import {
  resolveSubscriptionUiState,
  storeOwnershipFromEntitlements,
  type StoreSubscriptionSnapshot,
} from './resolve-subscription-ui-state';
import { REVENUECAT_ENTITLEMENT_IDS } from './revenuecat-catalog';
import type { SubscriptionScreenState } from './subscription-types';

// --- fixtures --------------------------------------------------------------

function backend(overrides: Partial<SubscriptionScreenState> = {}): SubscriptionScreenState {
  return {
    status: 'trialing',
    accessType: 'trial',
    trialEndsAt: null,
    trialDaysRemaining: null,
    currentPlanCode: null,
    currentPlanName: null,
    subscriptionProvider: null,
    subscriptionExpiresAt: null,
    canManageSubscription: false,
    canRestorePurchases: false,
    ...overrides,
  };
}

/** Native store snapshot (Android/iOS), configured & loaded, owning `plan`. */
function store(overrides: Partial<StoreSubscriptionSnapshot> = {}): StoreSubscriptionSnapshot {
  return {
    supported: true,
    loaded: true,
    activeEntitlementIds: [],
    managementUrl: null,
    ...overrides,
  };
}

const OWNS_ESSENTIAL = [REVENUECAT_ENTITLEMENT_IDS.essencial];
const OWNS_PLUS = [REVENUECAT_ENTITLEMENT_IDS.plus];
const OWNS_BOTH = [REVENUECAT_ENTITLEMENT_IDS.essencial, REVENUECAT_ENTITLEMENT_IDS.plus];

// Real DB commercial plan codes are Portuguese (essencial/plus) — see
// subscription-status-service / revenuecat-catalog.
const COMMERCIAL_ESSENTIAL = backend({ status: 'active', accessType: 'commercial', currentPlanCode: 'essencial', currentPlanName: 'Essencial' });
const COMMERCIAL_PLUS = backend({ status: 'active', accessType: 'commercial', currentPlanCode: 'plus', currentPlanName: 'Plus' });

// ---------------------------------------------------------------------------

describe('storeOwnershipFromEntitlements', () => {
  it('maps entitlement id sets to ownership, plus outranking essential', () => {
    expect(storeOwnershipFromEntitlements([])).toBe('none');
    expect(storeOwnershipFromEntitlements(OWNS_ESSENTIAL)).toBe('essential');
    expect(storeOwnershipFromEntitlements(OWNS_PLUS)).toBe('plus');
    expect(storeOwnershipFromEntitlements(OWNS_BOTH)).toBe('both');
  });
});

describe('resolveSubscriptionUiState — 18 required subscription scenarios', () => {
  // 1. backend trial + RevenueCat none
  it('[1] trial + store owns nothing → subscribe both, state trial, no reconcile', () => {
    const r = resolveSubscriptionUiState(backend(), store({ activeEntitlementIds: [] }));
    expect(r.subscriptionState).toBe('trial');
    expect(r.storeOwnership).toBe('none');
    expect(r.essentialCardAction).toBe('subscribe');
    expect(r.plusCardAction).toBe('subscribe');
    expect(r.needsReconciliation).toBe(false);
    expect(r.availableActions).toEqual(['subscribe_essential', 'subscribe_plus']);
  });

  // 2. backend trial + RevenueCat essential active  (THE reported bug)
  it('[2] trial + store owns Essencial → Essencial is "current" (never "subscribe"), Plus is upgrade, needs sync', () => {
    const r = resolveSubscriptionUiState(backend(), store({ activeEntitlementIds: OWNS_ESSENTIAL }));
    expect(r.storeOwnership).toBe('essential');
    expect(r.essentialCardAction).toBe('current'); // <- the fix: not 'subscribe'
    expect(r.plusCardAction).toBe('upgrade');
    expect(r.needsReconciliation).toBe(true);
    expect(r.availableActions).toContain('sync');
    expect(r.availableActions).not.toContain('subscribe_essential');
  });

  // 3. backend trial + RevenueCat plus active
  it('[3] trial + store owns Plus → Plus "current", Essencial "downgrade", needs sync', () => {
    const r = resolveSubscriptionUiState(backend(), store({ activeEntitlementIds: OWNS_PLUS }));
    expect(r.storeOwnership).toBe('plus');
    expect(r.plusCardAction).toBe('current');
    expect(r.essentialCardAction).toBe('downgrade');
    expect(r.needsReconciliation).toBe(true);
  });

  // 4. backend essential + RevenueCat essential
  it('[4] Essencial coherent (backend + store agree) → Essencial "current", Plus "upgrade", NO sync', () => {
    const r = resolveSubscriptionUiState(COMMERCIAL_ESSENTIAL, store({ activeEntitlementIds: OWNS_ESSENTIAL }));
    expect(r.accessPlan).toBe('essential');
    expect(r.subscriptionState).toBe('active');
    expect(r.essentialCardAction).toBe('current');
    expect(r.plusCardAction).toBe('upgrade');
    expect(r.needsReconciliation).toBe(false);
    expect(r.availableActions).toEqual(['upgrade_to_plus']);
  });

  // 5. backend plus + RevenueCat plus
  it('[5] Plus coherent → Plus "current", Essencial "downgrade", NO sync', () => {
    const r = resolveSubscriptionUiState(COMMERCIAL_PLUS, store({ activeEntitlementIds: OWNS_PLUS }));
    expect(r.accessPlan).toBe('plus');
    expect(r.subscriptionState).toBe('active');
    expect(r.plusCardAction).toBe('current');
    expect(r.essentialCardAction).toBe('downgrade');
    expect(r.needsReconciliation).toBe(false);
  });

  // 6. backend stale (trial) + store active → auto-sync → commercial
  it('[6] stale trial + store Essencial: flags reconciliation; while reconciling shows neutral state with cards disabled', () => {
    const diverged = resolveSubscriptionUiState(backend(), store({ activeEntitlementIds: OWNS_ESSENTIAL }));
    expect(diverged.needsReconciliation).toBe(true);

    // Component sets reconciling=true while the one-shot /sync is in flight.
    const during = resolveSubscriptionUiState(backend(), store({ activeEntitlementIds: OWNS_ESSENTIAL }), true);
    expect(during.subscriptionState).toBe('reconciling');
    expect(during.cardsDisabled).toBe(true);
    expect(during.availableActions).toEqual(['none']);

    // After /sync the backend now agrees → coherent commercial, no more sync.
    const after = resolveSubscriptionUiState(COMMERCIAL_ESSENTIAL, store({ activeEntitlementIds: OWNS_ESSENTIAL }));
    expect(after.subscriptionState).toBe('active');
    expect(after.needsReconciliation).toBe(false);
    expect(after.essentialCardAction).toBe('current');
  });

  // 7. active but cancelled, still valid
  it('[7] cancelled-but-still-valid → subscriptionState "cancelled_active", plan still "current"', () => {
    const b = backend({ status: 'canceled', accessType: 'commercial', currentPlanCode: 'plus', currentPlanName: 'Plus', subscriptionExpiresAt: '2999-01-01T00:00:00Z' });
    const r = resolveSubscriptionUiState(b, store({ activeEntitlementIds: OWNS_PLUS }));
    expect(r.subscriptionState).toBe('cancelled_active');
    expect(r.plusCardAction).toBe('current');
    expect(r.essentialCardAction).toBe('downgrade');
    expect(r.needsReconciliation).toBe(false);
  });

  // 8. expired
  it('[8] expired backend + store owns nothing → subscribe both, state expired, no sync', () => {
    const b = backend({ status: 'expired', accessType: 'none' });
    const r = resolveSubscriptionUiState(b, store({ activeEntitlementIds: [] }));
    expect(r.subscriptionState).toBe('expired');
    expect(r.essentialCardAction).toBe('subscribe');
    expect(r.plusCardAction).toBe('subscribe');
    expect(r.needsReconciliation).toBe(false);
  });

  // 9. pending DOWNGRADE (the reported bug): backend authoritative — Plus stays
  //    current, Essencial is the scheduled "next" plan; NEVER "cancelada",
  //    never re-offered as "Mudar para Essencial".
  it('[9] pending_downgrade: Plus "current", Essencial "next" (locked), effective date exposed, downgrade never re-offered', () => {
    const b = backend({
      status: 'active',
      subscriptionState: 'pending_downgrade',
      accessType: 'commercial',
      currentPlanCode: 'plus',
      currentPlanName: 'Plus',
      pendingPlanCode: 'essencial',
      pendingPlanName: 'Essencial',
      effectiveChangeAt: '2999-01-15T00:00:00Z',
    });
    const r = resolveSubscriptionUiState(b, store({ activeEntitlementIds: OWNS_PLUS }));
    expect(r.subscriptionState).toBe('pending_downgrade');
    expect(r.currentPlan).toBe('plus');
    expect(r.pendingPlan).toBe('essential');
    expect(r.effectiveChangeAt).toBe('2999-01-15T00:00:00Z');
    expect(r.plusCardAction).toBe('current');
    expect(r.essentialCardAction).toBe('next'); // <- not 'downgrade', not 'subscribe'
    expect(r.availableActions).not.toContain('downgrade_to_essential');
    expect(r.availableActions).not.toContain('subscribe_essential');
  });

  // 10. pending UPGRADE (rare — upgrades are immediate, so short-lived)
  it('[10] pending_upgrade: Essencial "current", Plus "next" (locked)', () => {
    const b = backend({
      status: 'active',
      subscriptionState: 'pending_upgrade',
      accessType: 'commercial',
      currentPlanCode: 'essencial',
      currentPlanName: 'Essencial',
      pendingPlanCode: 'plus',
      pendingPlanName: 'Plus',
      effectiveChangeAt: '2999-01-15T00:00:00Z',
    });
    const r = resolveSubscriptionUiState(b, store({ activeEntitlementIds: OWNS_ESSENTIAL }));
    expect(r.subscriptionState).toBe('pending_upgrade');
    expect(r.essentialCardAction).toBe('current');
    expect(r.plusCardAction).toBe('next');
  });

  // 10b. not_renewing (honest fallback: won't renew, no known pending plan)
  it('[10b] not_renewing: Plus stays "current", never claims a cancellation, other plan still switchable', () => {
    const b = backend({
      status: 'active',
      subscriptionState: 'not_renewing',
      accessType: 'commercial',
      currentPlanCode: 'plus',
      currentPlanName: 'Plus',
      subscriptionExpiresAt: '2999-01-10T00:00:00Z',
    });
    const r = resolveSubscriptionUiState(b, store({ activeEntitlementIds: OWNS_PLUS }));
    expect(r.subscriptionState).toBe('not_renewing');
    expect(r.pendingPlan).toBeNull();
    expect(r.plusCardAction).toBe('current');
    expect(r.essentialCardAction).toBe('downgrade');
  });

  // 11. product already owned → never re-subscribe
  it('[11] a store-owned plan is never a "subscribe" action, regardless of a stale backend', () => {
    // Even the most stale backend (trial) cannot produce subscribe for an owned plan.
    const ownEssential = resolveSubscriptionUiState(backend(), store({ activeEntitlementIds: OWNS_ESSENTIAL }));
    expect(ownEssential.essentialCardAction).not.toBe('subscribe');
    const ownPlus = resolveSubscriptionUiState(backend(), store({ activeEntitlementIds: OWNS_PLUS }));
    expect(ownPlus.plusCardAction).not.toBe('subscribe');
  });

  // 12. web without SDK
  it('[12] web (SDK unsupported) → store axis unknown, backend-only, no reconcile, subscribe offered', () => {
    const r = resolveSubscriptionUiState(backend(), store({ supported: false, loaded: true, activeEntitlementIds: [] }));
    expect(r.storeOwnership).toBe('none');
    expect(r.needsReconciliation).toBe(false);
    expect(r.essentialCardAction).toBe('subscribe');
    expect(r.plusCardAction).toBe('subscribe');
  });

  // 13. Android (SDK supported) — same selector, ownership honoured
  it('[13] Android supported build honours store ownership', () => {
    const r = resolveSubscriptionUiState(backend(), store({ supported: true, loaded: true, activeEntitlementIds: OWNS_PLUS }));
    expect(r.storeOwnership).toBe('plus');
    expect(r.plusCardAction).toBe('current');
  });

  // 14. iOS — platform-agnostic: identical resolution to Android for same inputs
  it('[14] iOS resolves identically to Android for the same store snapshot (platform-agnostic)', () => {
    const snap = store({ activeEntitlementIds: OWNS_ESSENTIAL });
    expect(resolveSubscriptionUiState(backend(), snap)).toEqual(resolveSubscriptionUiState(backend(), snap));
  });

  // 15. internal plan
  it('[15] internal plan → accessPlan "internal", state "internal", no store actions, never reconciles', () => {
    const b = backend({ status: 'active', accessType: 'internal', currentPlanCode: '24317180', currentPlanName: 'Ilimitado' });
    // Even if the store somehow reported an entitlement, internal never syncs.
    const r = resolveSubscriptionUiState(b, store({ activeEntitlementIds: OWNS_PLUS }));
    expect(r.accessPlan).toBe('internal');
    expect(r.subscriptionState).toBe('internal');
    expect(r.needsReconciliation).toBe(false);
    expect(r.availableActions).toEqual(['none']);
  });

  // 16. RevenueCat failure (customer info never loaded)
  it('[16] RevenueCat read failed (loaded=false) → store unknown, backend-only, no reconcile, no crash', () => {
    const r = resolveSubscriptionUiState(backend(), store({ supported: true, loaded: false, activeEntitlementIds: [] }));
    expect(r.storeOwnership).toBe('none');
    expect(r.needsReconciliation).toBe(false);
    expect(r.subscriptionState).toBe('trial');
    expect(r.essentialCardAction).toBe('subscribe');
  });

  // 17. /sync failed → no loop; UI stays coherent via the union (still safe)
  it('[17] if /sync did not reconcile the backend, the union still makes the owned plan "current" (never a broken subscribe)', () => {
    // Backend still trial (sync failed to update it) but store owns Essencial.
    const r = resolveSubscriptionUiState(backend(), store({ activeEntitlementIds: OWNS_ESSENTIAL }));
    // needsReconciliation is still true (the component's ref guard prevents a
    // re-fire — see SubscriptionView), but the screen is NOT broken meanwhile:
    expect(r.essentialCardAction).toBe('current');
    expect(r.availableActions).not.toContain('subscribe_essential');
  });

  // 18. re-entry does not duplicate — selector is pure/idempotent
  it('[18] selector is pure: same inputs always yield deeply-equal output (safe to recompute on every render)', () => {
    const a = resolveSubscriptionUiState(COMMERCIAL_PLUS, store({ activeEntitlementIds: OWNS_PLUS }));
    const b = resolveSubscriptionUiState(COMMERCIAL_PLUS, store({ activeEntitlementIds: OWNS_PLUS }));
    expect(a).toEqual(b);
  });
});

describe('resolveSubscriptionUiState — divergence direction & manage affordance', () => {
  it('store owning LESS than the backend never triggers a sync (never revokes access)', () => {
    // Backend says Plus (access truth) but the store read shows nothing yet.
    const r = resolveSubscriptionUiState(COMMERCIAL_PLUS, store({ activeEntitlementIds: [] }));
    expect(r.needsReconciliation).toBe(false);
    expect(r.plusCardAction).toBe('current'); // backend still the authority
  });

  it('a real store management URL surfaces a "manage" action', () => {
    const r = resolveSubscriptionUiState(COMMERCIAL_PLUS, store({ activeEntitlementIds: OWNS_PLUS, managementUrl: 'https://play.google.com/store/account/subscriptions' }));
    expect(r.availableActions).toContain('manage');
  });

  it('store owning a DIFFERENT commercial plan than the backend still reconciles', () => {
    // Backend Essencial, store Plus — an upgrade completed at the store first.
    const r = resolveSubscriptionUiState(COMMERCIAL_ESSENTIAL, store({ activeEntitlementIds: OWNS_PLUS }));
    expect(r.needsReconciliation).toBe(true);
    // Union treats Plus as owned → Plus current, Essencial downgrade.
    expect(r.plusCardAction).toBe('current');
  });
});
