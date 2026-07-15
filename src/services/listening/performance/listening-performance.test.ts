import { describe, it, expect } from 'vitest';
import { calculateListeningPerformance } from './calculate-listening-performance';
import { LISTENING_PERFORMANCE_CONFIG } from './listening-performance-config';

describe('calculateListeningPerformance', () => {
  it('(1, 1) → score = 100', () => {
    const result = calculateListeningPerformance(1, 1);
    expect(result.performanceScore).toBe(100);
    expect(result.q1Weight).toBe(1.0);
    expect(result.q2Weight).toBe(1.0);
    expect(result.q1AttemptCycle).toBe(1);
    expect(result.q2AttemptCycle).toBe(1);
  });

  it('(2, 2) → score = 70', () => {
    const result = calculateListeningPerformance(2, 2);
    expect(result.performanceScore).toBe(70);
    expect(result.q1Weight).toBe(0.7);
    expect(result.q2Weight).toBe(0.7);
  });

  it('(3, 3) → score = 40', () => {
    const result = calculateListeningPerformance(3, 3);
    expect(result.performanceScore).toBe(40);
    expect(result.q1Weight).toBe(0.4);
    expect(result.q2Weight).toBe(0.4);
  });

  it('(1, 2) → score = 85 ((1.0 + 0.7) / 2 * 100)', () => {
    const result = calculateListeningPerformance(1, 2);
    expect(result.performanceScore).toBe(85);
    expect(result.q1Weight).toBe(1.0);
    expect(result.q2Weight).toBe(0.7);
  });

  it('(2, 3) → score = 55 ((0.7 + 0.4) / 2 * 100)', () => {
    const result = calculateListeningPerformance(2, 3);
    expect(result.performanceScore).toBe(55);
    expect(result.q1Weight).toBe(0.7);
    expect(result.q2Weight).toBe(0.4);
  });

  it('(99, 99) → score = 40 (clamped to MIN_WEIGHT)', () => {
    const result = calculateListeningPerformance(99, 99);
    expect(result.performanceScore).toBe(40);
    expect(result.q1Weight).toBe(LISTENING_PERFORMANCE_CONFIG.MIN_WEIGHT);
    expect(result.q2Weight).toBe(LISTENING_PERFORMANCE_CONFIG.MIN_WEIGHT);
  });

  it('version string = "listening-performance-v1"', () => {
    const result = calculateListeningPerformance(1, 1);
    expect(result.calculationVersion).toBe('listening-performance-v1');
  });
});
