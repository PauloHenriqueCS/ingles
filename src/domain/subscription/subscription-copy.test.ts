import { describe, it, expect } from 'vitest';
import { SUBSCRIPTION_MESSAGES, TRIAL_LIMIT_LABELS, PLAN_BENEFIT_LABELS } from './subscription-copy';

describe('button labels', () => {
  it('are all defined and non-empty', () => {
    expect(SUBSCRIPTION_MESSAGES.subscribeEssential).toBe('Assinar Essencial');
    expect(SUBSCRIPTION_MESSAGES.subscribePlus).toBe('Assinar Plus');
    expect(SUBSCRIPTION_MESSAGES.restorePurchases.length).toBeGreaterThan(0);
    expect(SUBSCRIPTION_MESSAGES.manageSubscription.length).toBeGreaterThan(0);
    expect(SUBSCRIPTION_MESSAGES.backToHome.length).toBeGreaterThan(0);
  });
});

describe('placeholder handler copy — must never claim a real outcome', () => {
  it('purchase placeholder names the plan and explicitly denies a charge or plan change', () => {
    const msg = SUBSCRIPTION_MESSAGES.devPurchasePlaceholder('Essencial');
    expect(msg).toContain('Essencial');
    expect(msg).toMatch(/Nenhuma cobrança foi feita/);
    expect(msg).toMatch(/nenhum plano foi alterado/i);
    expect(msg).not.toMatch(/compra (concluída|aprovada)/i);
  });

  it('restore placeholder explicitly denies any change was made', () => {
    expect(SUBSCRIPTION_MESSAGES.devRestorePlaceholder).toMatch(/Nenhuma alteração foi feita/);
    expect(SUBSCRIPTION_MESSAGES.devRestorePlaceholder).not.toMatch(/restaurad[ao] com sucesso/i);
  });

  it('manage-subscription placeholder does not claim the feature works', () => {
    expect(SUBSCRIPTION_MESSAGES.devManageSubscriptionPlaceholder).toMatch(/não está disponível/);
  });
});

describe('no copy anywhere claims an unlimited feature', () => {
  function flattenStrings(obj: Record<string, unknown>): string[] {
    const out: string[] = [];
    for (const value of Object.values(obj)) {
      if (typeof value === 'string') out.push(value);
      if (typeof value === 'function') {
        // Every copy function here takes a single string/number sample arg.
        const fn = value as (arg: string) => unknown;
        out.push(String(fn('amostra')));
      }
    }
    return out;
  }

  it('SUBSCRIPTION_MESSAGES has no "ilimitado" text outside of a plan-agnostic label', () => {
    const strings = flattenStrings(SUBSCRIPTION_MESSAGES);
    for (const s of strings) {
      expect(s.toLowerCase()).not.toContain('ilimitado');
    }
  });

  it('TRIAL_LIMIT_LABELS never says ilimitado', () => {
    const strings = [
      TRIAL_LIMIT_LABELS.writingPerDay(1),
      TRIAL_LIMIT_LABELS.pronunciationPerDay(1),
      TRIAL_LIMIT_LABELS.listeningPerDay(1),
      TRIAL_LIMIT_LABELS.conversationMinutesTotal(15),
    ];
    for (const s of strings) expect(s.toLowerCase()).not.toContain('ilimitado');
  });

  it('PLAN_BENEFIT_LABELS never says ilimitado', () => {
    const strings = [
      PLAN_BENEFIT_LABELS.writingPerDay(3),
      PLAN_BENEFIT_LABELS.pronunciationPerDay(3),
      PLAN_BENEFIT_LABELS.listeningPerDay(3),
      PLAN_BENEFIT_LABELS.conversationMinutesMonthly(30),
    ];
    for (const s of strings) expect(s.toLowerCase()).not.toContain('ilimitado');
  });
});

describe('trial limit wording matches the spec exactly', () => {
  it('1 writing / 1 pronunciation / 1 listening per day, 15 total conversation minutes', () => {
    expect(TRIAL_LIMIT_LABELS.writingPerDay(1)).toBe('1 escrita por dia');
    expect(TRIAL_LIMIT_LABELS.pronunciationPerDay(1)).toBe('1 pronúncia por dia');
    expect(TRIAL_LIMIT_LABELS.listeningPerDay(1)).toBe('1 listening por dia');
    expect(TRIAL_LIMIT_LABELS.conversationMinutesTotal(15)).toBe('15 minutos totais de conversação');
  });
});

describe('plan benefit pluralization', () => {
  it('singularizes 1 activity per day', () => {
    expect(PLAN_BENEFIT_LABELS.writingPerDay(1)).toBe('1 escrita por dia');
    expect(PLAN_BENEFIT_LABELS.pronunciationPerDay(1)).toBe('1 pronúncia por dia');
    expect(PLAN_BENEFIT_LABELS.listeningPerDay(1)).toBe('1 listening por dia');
  });

  it('pluralizes 3 activities per day (Plus)', () => {
    expect(PLAN_BENEFIT_LABELS.writingPerDay(3)).toBe('3 escritas por dia');
    expect(PLAN_BENEFIT_LABELS.pronunciationPerDay(3)).toBe('3 pronúncias por dia');
    expect(PLAN_BENEFIT_LABELS.listeningPerDay(3)).toBe('3 listenings por dia');
  });
});
