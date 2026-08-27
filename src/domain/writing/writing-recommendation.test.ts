import { describe, it, expect } from 'vitest';
import { recommendImprovement } from './writing-recommendation';

describe('recommendImprovement — adaptive Concluir vs Melhorar', () => {
  it('Caso A: no main mistakes ⇒ do NOT recommend improving', () => {
    const r = recommendImprovement(0);
    expect(r.recommend).toBe(false);
    expect(r.pointsToImprove).toBe(0);
  });

  it('Caso B: one or more main mistakes ⇒ recommend improving', () => {
    expect(recommendImprovement(1)).toEqual({ recommend: true, pointsToImprove: 1 });
    expect(recommendImprovement(3)).toEqual({ recommend: true, pointsToImprove: 3 });
  });

  it('is defensive against bad inputs', () => {
    expect(recommendImprovement(-2)).toEqual({ recommend: false, pointsToImprove: 0 });
    expect(recommendImprovement(Number.NaN)).toEqual({ recommend: false, pointsToImprove: 0 });
    expect(recommendImprovement(2.9)).toEqual({ recommend: true, pointsToImprove: 2 });
  });
});
