import { describe, it, expect } from 'vitest';
import { isNativeStoreSectionVisible, shouldShowManageSubscriptionButton } from './native-subscription-actions';

describe('shouldShowManageSubscriptionButton', () => {
  it('shows the button when there is a real, non-empty managementURL on a commercial-eligible native session', () => {
    expect(shouldShowManageSubscriptionButton('commercial', true, 'https://apps.apple.com/account/subscriptions')).toBe(true);
  });

  it('hides the button when managementUrl is null (no fallback link exists)', () => {
    expect(shouldShowManageSubscriptionButton('commercial', true, null)).toBe(false);
  });

  it('hides the button when managementUrl is undefined', () => {
    expect(shouldShowManageSubscriptionButton('commercial', true, undefined)).toBe(false);
  });

  it('hides the button when managementUrl is an empty string', () => {
    expect(shouldShowManageSubscriptionButton('commercial', true, '')).toBe(false);
  });

  it('hides the button for the internal (hand-assigned) plan, even with a real managementUrl', () => {
    expect(shouldShowManageSubscriptionButton('internal', true, 'https://apps.apple.com/account/subscriptions')).toBe(false);
  });

  it('hides the button during trial, even with a real managementUrl', () => {
    expect(shouldShowManageSubscriptionButton('trial', true, 'https://apps.apple.com/account/subscriptions')).toBe(false);
  });

  it('hides the button on the web build (nativeSupported=false), even with a real managementUrl', () => {
    expect(shouldShowManageSubscriptionButton('commercial', false, 'https://apps.apple.com/account/subscriptions')).toBe(false);
  });

  it('shows the button for accessType "none" (choosing a first plan) when a managementUrl is somehow present', () => {
    expect(shouldShowManageSubscriptionButton('none', true, 'https://apps.apple.com/account/subscriptions')).toBe(true);
  });
});

describe('isNativeStoreSectionVisible (gates both manage and restore)', () => {
  it('visible for a real commercial assignment on native', () => {
    expect(isNativeStoreSectionVisible('commercial', true)).toBe(true);
  });

  it('visible with no assignment yet (choosing a first plan) on native', () => {
    expect(isNativeStoreSectionVisible('none', true)).toBe(true);
  });

  it('never visible for the internal plan', () => {
    expect(isNativeStoreSectionVisible('internal', true)).toBe(false);
  });

  it('never visible during trial', () => {
    expect(isNativeStoreSectionVisible('trial', true)).toBe(false);
  });

  it('never visible on web (nativeSupported=false), regardless of accessType', () => {
    expect(isNativeStoreSectionVisible('commercial', false)).toBe(false);
    expect(isNativeStoreSectionVisible('none', false)).toBe(false);
  });
});
