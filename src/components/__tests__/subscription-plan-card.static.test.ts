/**
 * App Store Guideline 3.1.2(c): each auto-renewable subscription card must show
 * name, price, DURATION, and an auto-renewal disclosure. The duration must come
 * from the store's real period (never the old hardcoded "/mês"). Static-wiring
 * assertions per the repo convention (node test env, no jsdom).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const card = readFileSync(join(__dirname, '..', 'SubscriptionPlanCard.tsx'), 'utf8');
const view = readFileSync(join(__dirname, '..', 'SubscriptionView.tsx'), 'utf8');

describe('SubscriptionPlanCard — 3.1.2(c) commercial info', () => {
  it('shows the plan name and store price', () => {
    expect(card).toContain('{plan.name}');
    expect(card).toContain('priceLabel ?? formatPriceBRL(plan.priceCents)');
  });

  it('shows a store-derived duration, not a hardcoded "/mês"', () => {
    // The old hardcoded literal must be gone.
    expect(card).not.toContain(' /mês');
    // Duration comes from the periodLabel prop, with the copy default as fallback.
    expect(card).toContain('periodLabel ?? SUBSCRIPTION_MESSAGES.defaultBillingPeriodLabel');
  });

  it('shows the per-subscription auto-renewal disclosure', () => {
    expect(card).toContain('SUBSCRIPTION_MESSAGES.autoRenewCardNote');
  });
});

describe('SubscriptionView feeds the card real store data', () => {
  it('derives the period label from the store subscriptionPeriod', () => {
    expect(view).toContain('formatBillingPeriodPtBr(realOffering?.subscriptionPeriod)');
    expect(view).toContain('periodLabel={periodLabel}');
  });

  it('keeps the store price as the source of truth', () => {
    expect(view).toContain('priceLabel={realOffering?.priceFormatted}');
  });
});
