import { describe, it, expect } from 'vitest';
import {
  REVENUECAT_SUBSCRIPTION_PRODUCT_IDS,
  REVENUECAT_MINUTE_PACKAGE_PRODUCT_IDS,
  REVENUECAT_SUBSCRIPTION_PACKAGE_IDS,
  REVENUECAT_MINUTE_PACKAGE_IDS,
  REVENUECAT_ENTITLEMENT_IDS,
  planCodeForActiveEntitlements,
  isMinutePackageProductId,
} from './revenuecat-catalog';

describe('REVENUECAT_SUBSCRIPTION_PRODUCT_IDS', () => {
  it('matches the real Apple product ids already saved in plans.apple_product_id', () => {
    expect(REVENUECAT_SUBSCRIPTION_PRODUCT_IDS.essencial).toBe('orodim.subscription.essential.monthly');
    expect(REVENUECAT_SUBSCRIPTION_PRODUCT_IDS.plus).toBe('orodim.subscription.plus.monthly');
  });

  it('never uses the old app name in a product id', () => {
    for (const id of Object.values(REVENUECAT_SUBSCRIPTION_PRODUCT_IDS)) {
      expect(id.toLowerCase()).not.toContain('lemon');
    }
  });
});

describe('REVENUECAT_MINUTE_PACKAGE_PRODUCT_IDS', () => {
  it('matches the real Apple product ids already saved in conversation_minute_packages.apple_product_id', () => {
    expect(REVENUECAT_MINUTE_PACKAGE_PRODUCT_IDS['pacote-300-min']).toBe('orodim.conversation.minutes.300');
    expect(REVENUECAT_MINUTE_PACKAGE_PRODUCT_IDS['pacote-600-min']).toBe('orodim.conversation.minutes.600');
    expect(REVENUECAT_MINUTE_PACKAGE_PRODUCT_IDS['pacote-900-min']).toBe('orodim.conversation.minutes.900');
  });
});

describe('REVENUECAT_SUBSCRIPTION_PACKAGE_IDS', () => {
  it('matches the package identifiers configured in the RevenueCat default offering', () => {
    expect(REVENUECAT_SUBSCRIPTION_PACKAGE_IDS.essencial).toBe('essential_monthly');
    expect(REVENUECAT_SUBSCRIPTION_PACKAGE_IDS.plus).toBe('plus_monthly');
  });

  it('never carries an Android base-plan suffix — package ids are store-agnostic', () => {
    for (const id of Object.values(REVENUECAT_SUBSCRIPTION_PACKAGE_IDS)) {
      expect(id).not.toContain(':');
    }
  });
});

describe('REVENUECAT_MINUTE_PACKAGE_IDS', () => {
  it('matches the consumable minute-pack package identifiers in the default offering', () => {
    expect(REVENUECAT_MINUTE_PACKAGE_IDS['pacote-300-min']).toBe('minutes_300');
    expect(REVENUECAT_MINUTE_PACKAGE_IDS['pacote-600-min']).toBe('minutes_600');
    expect(REVENUECAT_MINUTE_PACKAGE_IDS['pacote-900-min']).toBe('minutes_900');
  });
});

describe('isMinutePackageProductId', () => {
  it('recognizes all three real consumable product ids', () => {
    expect(isMinutePackageProductId('orodim.conversation.minutes.300')).toBe(true);
    expect(isMinutePackageProductId('orodim.conversation.minutes.600')).toBe(true);
    expect(isMinutePackageProductId('orodim.conversation.minutes.900')).toBe(true);
  });

  it('rejects a subscription product id or an unknown id', () => {
    expect(isMinutePackageProductId('orodim.subscription.essential.monthly')).toBe(false);
    expect(isMinutePackageProductId('something.else')).toBe(false);
  });
});

describe('planCodeForActiveEntitlements', () => {
  it('resolves plus when the plus entitlement is active', () => {
    expect(planCodeForActiveEntitlements([REVENUECAT_ENTITLEMENT_IDS.plus])).toBe('plus');
  });

  it('resolves essencial when only the essential entitlement is active', () => {
    expect(planCodeForActiveEntitlements([REVENUECAT_ENTITLEMENT_IDS.essencial])).toBe('essencial');
  });

  it('plus always wins when both entitlements are somehow active', () => {
    expect(planCodeForActiveEntitlements([REVENUECAT_ENTITLEMENT_IDS.essencial, REVENUECAT_ENTITLEMENT_IDS.plus])).toBe('plus');
  });

  it('returns null with no active entitlements', () => {
    expect(planCodeForActiveEntitlements([])).toBeNull();
  });

  it('returns null for an unrelated entitlement id', () => {
    expect(planCodeForActiveEntitlements(['some_other_entitlement'])).toBeNull();
  });
});
