import { describe, it, expect } from 'vitest';
import { buildBehavioralPushCopy, resolvePushLanguage } from './behavioralPushCopy';

describe('resolvePushLanguage', () => {
  it('maps pt / pt-BR to pt and everything else to en', () => {
    expect(resolvePushLanguage('pt-BR')).toBe('pt');
    expect(resolvePushLanguage('pt')).toBe('pt');
    expect(resolvePushLanguage('en-US')).toBe('en');
    expect(resolvePushLanguage('en')).toBe('en');
    expect(resolvePushLanguage('')).toBe('en');
    expect(resolvePushLanguage(null)).toBe('en');
    expect(resolvePushLanguage(undefined)).toBe('en');
  });
});

describe('buildBehavioralPushCopy — streak_risk', () => {
  it('pt: plural days', () => {
    const c = buildBehavioralPushCopy({ pushType: 'streak_risk', language: 'pt', streak: 8 });
    expect(c.title).toContain('em risco');
    expect(c.body).toContain('8 dias');
    expect(c.variant).toBe('streak_risk.pt.v1');
  });

  it('pt: singular day (1 dia, not 1 dias)', () => {
    const c = buildBehavioralPushCopy({ pushType: 'streak_risk', language: 'pt', streak: 1 });
    expect(c.body).toContain('1 dia.');
    expect(c.body).not.toContain('1 dias');
  });

  it('en: N-day streak', () => {
    const c = buildBehavioralPushCopy({ pushType: 'streak_risk', language: 'en', streak: 8 });
    expect(c.title).toContain('at risk');
    expect(c.body).toContain('8-day streak');
    expect(c.variant).toBe('streak_risk.en.v1');
  });

  it('clamps a non-positive streak to at least 1', () => {
    const c = buildBehavioralPushCopy({ pushType: 'streak_risk', language: 'en', streak: 0 });
    expect(c.body).toContain('1-day streak');
  });
});

describe('buildBehavioralPushCopy — abandonment (no guilt/threat/counts)', () => {
  it('pt', () => {
    const c = buildBehavioralPushCopy({ pushType: 'abandonment', language: 'pt', streak: 0 });
    expect(c.title).toBe('Que tal retomar hoje?');
    expect(c.variant).toBe('abandonment.pt.v1');
  });

  it('en', () => {
    const c = buildBehavioralPushCopy({ pushType: 'abandonment', language: 'en', streak: 0 });
    expect(c.title).toBe('Ready to practice again?');
    expect(c.variant).toBe('abandonment.en.v1');
  });

  it('never mentions a count of missing activities or blame words', () => {
    for (const language of ['pt', 'en'] as const) {
      const c = buildBehavioralPushCopy({ pushType: 'abandonment', language, streak: 0 });
      const text = `${c.title} ${c.body}`.toLowerCase();
      for (const bad of ['atrasad', 'falh', 'behind', 'failed', 'atividades para']) {
        expect(text).not.toContain(bad);
      }
    }
  });
});
