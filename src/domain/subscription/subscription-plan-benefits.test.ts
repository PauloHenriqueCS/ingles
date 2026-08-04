import { describe, it, expect } from 'vitest';
import { buildPlanBenefitLines } from './subscription-plan-benefits';
import { COMMERCIAL_PLANS } from './subscription-plans';
import { SUBSCRIPTION_MESSAGES } from './subscription-copy';

describe('buildPlanBenefitLines — essential', () => {
  it('includes the defined monthly conversation minutes line', () => {
    const lines = buildPlanBenefitLines(COMMERCIAL_PLANS.essential, false);
    expect(lines).toContain('30 minutos de conversação por mês');
    expect(lines).toHaveLength(4);
  });
});

describe('buildPlanBenefitLines — plus', () => {
  it('includes the defined monthly conversation minutes line', () => {
    const lines = buildPlanBenefitLines(COMMERCIAL_PLANS.plus, false);
    expect(lines).toContain('70 minutos de conversação por mês');
    expect(lines).toHaveLength(4);
  });

  it('never shows the dev-only "a definir" placeholder now that the figure is defined', () => {
    const prod = buildPlanBenefitLines(COMMERCIAL_PLANS.plus, false);
    const dev = buildPlanBenefitLines(COMMERCIAL_PLANS.plus, true);
    expect(prod).not.toContain(SUBSCRIPTION_MESSAGES.conversationMinutesTbdDev);
    expect(dev).not.toContain(SUBSCRIPTION_MESSAGES.conversationMinutesTbdDev);
    expect(dev).toHaveLength(4); // dev flag makes no difference once the real number is set
  });
});

describe('buildPlanBenefitLines — no plan ever claims unlimited', () => {
  it.each(['essential', 'plus'] as const)('%s has no "ilimitado" wording, dev or prod', (code) => {
    const plan = COMMERCIAL_PLANS[code];
    const prod = buildPlanBenefitLines(plan, false).join(' ').toLowerCase();
    const dev = buildPlanBenefitLines(plan, true).join(' ').toLowerCase();
    expect(prod).not.toContain('ilimitado');
    expect(dev).not.toContain('ilimitado');
  });
});
