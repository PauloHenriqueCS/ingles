import { describe, it, expect } from 'vitest';
import {
  pronunciationMetricStrings,
  PRONUNCIATION_METRIC_ORDER,
  type PronunciationMetricKey,
} from './pronunciationMetricStrings';

const METRICS: PronunciationMetricKey[] = ['accuracy', 'fluency', 'completeness', 'prosody'];

describe('pronunciationMetricStrings', () => {
  it('has a title + non-technical description for all four metrics in pt-BR and en', () => {
    for (const lang of ['pt-BR', 'en']) {
      const s = pronunciationMetricStrings(lang);
      for (const key of METRICS) {
        expect(s[key].title.length).toBeGreaterThan(0);
        expect(s[key].description.length).toBeGreaterThan(20);
      }
    }
  });

  it('gives each metric its OWN distinct description (no copy/paste)', () => {
    const s = pronunciationMetricStrings('pt-BR');
    const descriptions = METRICS.map((k) => s[k].description);
    expect(new Set(descriptions).size).toBe(METRICS.length);
  });

  it('makes clear that a low Completude score is NOT bad pronunciation', () => {
    const pt = pronunciationMetricStrings('pt-BR').completeness.description;
    expect(pt).toMatch(/não significa que você pronunciou mal/i);
    const en = pronunciationMetricStrings('en').completeness.description;
    expect(en).toMatch(/does not mean you pronounced badly/i);
  });

  it('uses the canonical metric names (pt-BR)', () => {
    const s = pronunciationMetricStrings('pt-BR');
    expect(s.accuracy.title).toBe('Precisão');
    expect(s.fluency.title).toBe('Fluência');
    expect(s.completeness.title).toBe('Completude');
    expect(s.prosody.title).toBe('Prosódia');
  });

  it('falls back to pt-BR for unknown/empty language, and resolves language subtags', () => {
    expect(pronunciationMetricStrings(undefined).accuracy.title).toBe('Precisão');
    expect(pronunciationMetricStrings('xx').accuracy.title).toBe('Precisão');
    expect(pronunciationMetricStrings('en-US').accuracy.title).toBe('Accuracy');
  });

  it('exposes the four metrics in a stable display order', () => {
    expect(PRONUNCIATION_METRIC_ORDER).toEqual(METRICS);
  });
});
