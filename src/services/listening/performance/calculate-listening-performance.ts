import { LISTENING_PERFORMANCE_CONFIG } from './listening-performance-config';
import type { PerformanceCalculation } from './listening-performance-types';

export function calculateListeningPerformance(
  block1Cycles: number,
  block2Cycles: number,
): PerformanceCalculation {
  const { ATTEMPT_WEIGHTS, MIN_WEIGHT, CALCULATION_VERSION } = LISTENING_PERFORMANCE_CONFIG;
  const q1Weight = ATTEMPT_WEIGHTS[block1Cycles] ?? MIN_WEIGHT;
  const q2Weight = ATTEMPT_WEIGHTS[block2Cycles] ?? MIN_WEIGHT;
  const performanceScore = Math.round(((q1Weight + q2Weight) / 2) * 10000) / 100;
  return { q1AttemptCycle: block1Cycles, q2AttemptCycle: block2Cycles, q1Weight, q2Weight, performanceScore, calculationVersion: CALCULATION_VERSION };
}
