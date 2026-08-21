/**
 * The proactive access-ended gate must be a dismissible popup that offers a
 * plan once the trial ran out or a subscription lapsed. Its "no access"
 * decision must come from the canonical resolver's 'expired' state (backend
 * access truth), never a re-derived rule. Static-wiring assertions per this
 * repo's convention.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const popup = readFileSync(join(__dirname, '..', 'SubscriptionGatePopup.tsx'), 'utf8');
const app = readFileSync(join(__dirname, '..', '..', 'App.tsx'), 'utf8');

describe('SubscriptionGatePopup', () => {
  it('is a dialog popup with the plans CTA', () => {
    expect(popup).toMatch(/role="dialog"/);
    expect(popup).toContain('data-testid="subscription-gate-popup-cta"');
    expect(popup).toContain('ENTITLEMENT_MESSAGES.viewPlansCta');
  });

  it('derives "no access" from the canonical resolver\'s expired state', () => {
    expect(popup).toContain('resolveSubscriptionUiState');
    expect(popup).toContain('useSubscriptionStatus');
    expect(popup).toMatch(/uiState === 'expired'/);
  });

  it('is dismissible and shown at most once per session', () => {
    expect(popup).toContain('setDismissed(true)');
    expect(popup).toContain('ENTITLEMENT_MESSAGES.accessEndedPopupDismiss');
    expect(popup).toMatch(/!dismissed/);
  });

  it('routes to the subscription screen and is suppressed there', () => {
    expect(popup).toContain('onNavigateToSubscription');
    expect(app).toMatch(/onNavigateToSubscription=\{\(\) => setView\('subscription'\)\}/);
    expect(app).toMatch(/suppressed=\{view === 'subscription'\}/);
  });
});
