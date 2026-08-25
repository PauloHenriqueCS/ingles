/**
 * App Store Guideline 3.1.2(c): the paywall must present, BEFORE any purchase,
 * a functional Privacy Policy link (every platform) and Apple's Standard EULA
 * (iOS/iPadOS only), plus an auto-renewal disclosure. jsdom is not configured
 * in this repo (vite.config.ts environment: 'node'), so components are verified
 * via static-wiring assertions per the repo convention (see
 * subscription-gate-popup.static.test.ts). The platform-gating LOGIC itself is
 * covered behaviorally by the pure prop `showAppleEula`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const legal = readFileSync(join(__dirname, '..', 'SubscriptionLegalLinks.tsx'), 'utf8');
const view = readFileSync(join(__dirname, '..', 'SubscriptionView.tsx'), 'utf8');

describe('SubscriptionLegalLinks — 3.1.2(c) compliance wiring', () => {
  it('uses the canonical URL constants, never inline URLs', () => {
    expect(legal).toContain("from '../domain/subscription/legal-links'");
    expect(legal).toContain('PRIVACY_POLICY_URL');
    expect(legal).toContain('APPLE_EULA_URL');
    // The literal URLs live only in legal-links.ts, not the component.
    expect(legal).not.toContain('apple.com/legal');
    expect(legal).not.toContain('orodim.com.br/privacy');
  });

  it('renders the auto-renewal disclosure', () => {
    expect(legal).toContain('SUBSCRIPTION_MESSAGES.autoRenewDisclosure');
  });

  it('always renders the Privacy Policy link (all platforms)', () => {
    expect(legal).toContain('data-testid="legal-link-privacy"');
    expect(legal).toContain('SUBSCRIPTION_MESSAGES.privacyPolicyLinkLabel');
    expect(legal).toContain('href={PRIVACY_POLICY_URL}');
  });

  it('renders the Apple EULA link ONLY when showAppleEula is true (iOS/iPadOS)', () => {
    expect(legal).toMatch(/\{showAppleEula\s*&&/);
    // The EULA anchor must sit inside the showAppleEula guard.
    const guardIndex = legal.indexOf('{showAppleEula');
    const eulaIndex = legal.indexOf('legal-link-eula');
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(eulaIndex).toBeGreaterThan(guardIndex);
    expect(legal).toContain('href={APPLE_EULA_URL}');
  });

  it('opens links via the shared Capacitor helper (functional inside the native app)', () => {
    expect(legal).toContain("from '../lib/openExternalUrl'");
    expect(legal).toContain('openExternalUrl');
  });

  it('links are real anchors with a functional href', () => {
    expect(legal).toMatch(/<a\b/);
    expect(legal).toContain('href={PRIVACY_POLICY_URL}');
  });
});

describe('SubscriptionView wires the legal section with platform-correct gating', () => {
  it('renders SubscriptionLegalLinks passing isIOSApp (iPadOS reports as ios)', () => {
    expect(view).toContain("import SubscriptionLegalLinks from './SubscriptionLegalLinks'");
    expect(view).toContain("import { isIOSApp } from '../lib/runtimeEnvironment'");
    expect(view).toContain('<SubscriptionLegalLinks showAppleEula={isIOSApp} />');
  });
});
