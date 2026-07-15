export const LISTENING_PERFORMANCE_CONFIG = {
  ATTEMPT_WEIGHTS: { 1: 1.0, 2: 0.7, 3: 0.4 } as Readonly<Record<number, number>>,
  MIN_WEIGHT: 0.4,
  CALCULATION_VERSION: 'listening-performance-v1',
} as const;
