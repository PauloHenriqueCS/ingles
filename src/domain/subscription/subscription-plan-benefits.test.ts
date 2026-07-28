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

describe('buildPlanBenefitLines — plus (undefined conversation minutes)', () => {
  it('omits any conversation-minutes line in production mode (includeDevOnlyNote=false)', () => {
    const lines = buildPlanBenefitLines(COMMERCIAL_PLANS.plus, false);
    expect(lines).toHaveLength(3);
    expect(lines.join(' ')).not.toMatch(/minutos de conversação/);
  });

  it('shows the dev-only "a definir" placeholder only when includeDevOnlyNote=true', () => {
    const lines = buildPlanBenefitLines(COMMERCIAL_PLANS.plus, true);
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe(SUBSCRIPTION_MESSAGES.conversationMinutesTbdDev);
  });

  it('never invents a number for Plus conversation minutes in either mode', () => {
    const prod = buildPlanBenefitLines(COMMERCIAL_PLANS.plus, false).join(' ');
    const dev = buildPlanBenefitLines(COMMERCIAL_PLANS.plus, true).join(' ');
    expect(prod).not.toMatch(/\d+ minutos de conversação/);
    expect(dev).not.toMatch(/\d+ minutos de conversação/);
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
