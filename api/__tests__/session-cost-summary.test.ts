import { describe, it, expect } from 'vitest';
import { summarizeSessionCost } from '../_ai-gateway/session-cost-summary';

describe('summarizeSessionCost', () => {
  it('no events -> eventCount 0, allCosted true, totalCostUsd null, no representative event', () => {
    expect(summarizeSessionCost([])).toEqual({ eventCount: 0, allCosted: true, totalCostUsd: null, representativeEventId: null });
  });

  it('sums the real cost of every fully-costed event', () => {
    const summary = summarizeSessionCost([
      { id: 'e1', calculatedCostUsd: '0.10' },
      { id: 'e2', calculatedCostUsd: '0.25' },
      { id: 'e3', calculatedCostUsd: '0.15' },
    ]);
    expect(summary.allCosted).toBe(true);
    expect(summary.totalCostUsd).toBe('0.5');
    expect(summary.eventCount).toBe(3);
    expect(summary.representativeEventId).toBe('e3'); // last event, in input order
  });

  it('a single unpriced event makes the whole summary unresolved — never partially summed', () => {
    const summary = summarizeSessionCost([
      { id: 'e1', calculatedCostUsd: '0.10' },
      { id: 'e2', calculatedCostUsd: null },
    ]);
    expect(summary.allCosted).toBe(false);
    expect(summary.totalCostUsd).toBeNull();
    expect(summary.eventCount).toBe(2);
  });

  it('a single event with $0 cost is still allCosted (0 is a known value, not "unknown")', () => {
    const summary = summarizeSessionCost([{ id: 'e1', calculatedCostUsd: '0' }]);
    expect(summary).toEqual({ eventCount: 1, allCosted: true, totalCostUsd: '0', representativeEventId: 'e1' });
  });
});
