/**
 * Static wiring guards for the Home "stale counter" fix. The node test env has
 * no DOM, so these lock the reconcile-on-visibility wiring at the source level.
 *
 * Bug they guard against: the Home card "Praticar listening" (and Escrita /
 * Pronúncia / Revisar meus erros) kept showing a pre-consumption count — e.g.
 * "1 restante" — after the daily limit was already reached, because the entitlements
 * / summary snapshot was fetched once per mount and never reconciled when the
 * app/tab regained focus (a mobile WebView Home survives a background→foreground
 * round-trip after the user practises elsewhere). The single source of truth is
 * the server-resolved snapshot; these hooks must re-read it on visibility so the
 * Home badge always matches the SAME eligibility the activity gate enforces.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const planHook = readFileSync(join(__dirname, '..', 'usePlanEntitlements.ts'), 'utf8');
const reviewHook = readFileSync(join(__dirname, '..', 'useErrorReviewSummary.ts'), 'utf8');

function assertReconcilesOnVisibility(src: string, label: string) {
  it(`${label} reconciles with the server when the app/tab regains visibility`, () => {
    // Listens to BOTH signals (WebView resume + desktop tab refocus).
    expect(src).toMatch(/addEventListener\(\s*['"]visibilitychange['"]/);
    expect(src).toMatch(/addEventListener\(\s*['"]focus['"]/);
    // Only acts on the transition INTO the foreground — never storms while hidden.
    expect(src).toMatch(/visibilityState\s*===\s*['"]visible['"]/);
    // The visible transition drives a refetch (bumps the fetch effect's token).
    expect(src).toMatch(/setRefetchToken\(\(t\)\s*=>\s*t\s*\+\s*1\)/);
    // Cleans the listeners up (no leak / duplicate refetch after unmount).
    expect(src).toMatch(/removeEventListener\(\s*['"]visibilitychange['"]/);
    expect(src).toMatch(/removeEventListener\(\s*['"]focus['"]/);
  });
}

describe('Home counters — single source of truth stays fresh on focus', () => {
  assertReconcilesOnVisibility(planHook, 'usePlanEntitlements (listening/writing/pronunciation cards)');
  assertReconcilesOnVisibility(reviewHook, 'useErrorReviewSummary (Revisar meus erros card)');

  it('usePlanEntitlements re-reads the SAME authoritative endpoint (no second source of truth)', () => {
    // The refetch path must go through the same fetcher the gate-eligibility
    // snapshot comes from — never a separate client-side count.
    expect(planHook).toMatch(/fetchPlanEntitlements/);
  });
});
