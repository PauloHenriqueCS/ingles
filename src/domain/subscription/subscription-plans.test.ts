import { describe, it, expect } from 'vitest';
import { COMMERCIAL_PLANS, COMMERCIAL_PLAN_ORDER, RECOMMENDED_PLAN_CODE, TRIAL_DAILY_LIMITS, TRIAL_DURATION_DAYS } from './subscription-plans';

describe('COMMERCIAL_PLANS.essential', () => {
  const essential = COMMERCIAL_PLANS.essential;

  it('prices at R$ 34,90 (3490 cents)', () => {
    expect(essential.priceCents).toBe(3490);
  });

  it('grants 1 writing / 1 pronunciation / 1 listening per day', () => {
    expect(essential.writingPerDay).toBe(1);
    expect(essential.pronunciationPerDay).toBe(1);
    expect(essential.listeningPerDay).toBe(1);
  });

  it('grants 30 conversation minutes per month, and allows extra minute packages', () => {
    expect(essential.conversationMinutesMonthly).toBe(30);
    expect(essential.allowsExtraMinutePackages).toBe(true);
  });
});

describe('COMMERCIAL_PLANS.plus', () => {
  const plus = COMMERCIAL_PLANS.plus;

  it('prices at R$ 59,90 (5990 cents)', () => {
    expect(plus.priceCents).toBe(5990);
  });

  it('grants 3 writings / 3 pronunciations / 3 listenings per day', () => {
    expect(plus.writingPerDay).toBe(3);
    expect(plus.pronunciationPerDay).toBe(3);
    expect(plus.listeningPerDay).toBe(3);
  });

  it('does NOT invent a conversation minutes figure — stays null until product defines it', () => {
    expect(plus.conversationMinutesMonthly).toBeNull();
  });

  it('does not (yet) advertise extra minute packages', () => {
    expect(plus.allowsExtraMinutePackages).toBe(false);
  });
});

describe('plan catalog shape', () => {
  it('recommends Essencial by default', () => {
    expect(RECOMMENDED_PLAN_CODE).toBe('essential');
  });

  it('lists both plans in display order', () => {
    expect(COMMERCIAL_PLAN_ORDER).toEqual(['essential', 'plus']);
  });

  it('never describes any plan field as unlimited', () => {
    const dump = JSON.stringify(COMMERCIAL_PLANS).toLowerCase();
    expect(dump).not.toContain('ilimitado');
    expect(dump).not.toContain('unlimited');
  });
});

describe('trial limits', () => {
  it('matches the 7-day trial spec: 1/1/1 daily activities, 15 total conversation minutes', () => {
    expect(TRIAL_DAILY_LIMITS).toEqual({
      writingPerDay: 1,
      pronunciationPerDay: 1,
      listeningPerDay: 1,
      conversationMinutesTotal: 15,
    });
    expect(TRIAL_DURATION_DAYS).toBe(7);
  });

  it('has no notion of extra minute packages — that is a commercial-plan-only concept', () => {
    expect(TRIAL_DAILY_LIMITS).not.toHaveProperty('allowsExtraMinutePackages');
  });
});
