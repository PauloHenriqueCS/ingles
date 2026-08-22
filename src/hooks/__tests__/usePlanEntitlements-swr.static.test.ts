/**
 * Static wiring guards for usePlanEntitlements' stale-while-revalidate behavior.
 * The node test env has no DOM/React renderer, so these lock the invariants that
 * matter at the source level.
 *
 * Two bugs these guard against, both already shipped-and-reverted once:
 *  1. Blanking the Home on refetch: HomePage renders
 *     `resolved = isLoading ? null : entitlements`, so if a refetch flips
 *     `isLoading` true, every card blanks to a grey loading state (no "X restante"
 *     badge). The hook must enter the loading state ONLY on the first load
 *     (guarded by hasLoadedRef); later revalidations keep the previous snapshot.
 *  2. Wiping data on a failed refresh: the catch must NOT clear `data`, so a
 *     transient network/auth blip never blanks the Home.
 *
 * Plus: it must actually revalidate on foreground (web + native), which is what
 * updates a stale counter (e.g. "1 restante" → "Limite de hoje") without a reload.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '..', 'usePlanEntitlements.ts'), 'utf8');

/** Body of the catch block that handles a failed fetch (used to assert it never clears data). */
function catchBody(): string {
  const i = src.indexOf('.catch(');
  expect(i).toBeGreaterThan(-1);
  return src.slice(i, i + 500);
}

describe('usePlanEntitlements — stale-while-revalidate (no blanking)', () => {
  it('shows the loading state ONLY on the first load (guarded by a hasLoaded ref)', () => {
    expect(src).toMatch(/hasLoadedRef/);
    // The loading flip is gated behind the first-load guard, never unconditional.
    expect(src).toMatch(/if\s*\(\s*!hasLoadedRef\.current\s*\)\s*setIsLoading\(true\)/);
    // There must be no UNGUARDED `setIsLoading(true)` inside the fetch effect.
    const unguarded = src.match(/(^|[^)]\s*)setIsLoading\(true\)/gm) ?? [];
    // The only occurrence is the guarded one on the same line as the if-guard.
    expect(src.match(/setIsLoading\(true\)/g)?.length).toBe(1);
    void unguarded;
  });

  it('a failed revalidation KEEPS the last snapshot — the catch never clears data', () => {
    const body = catchBody();
    expect(body).not.toMatch(/setData\(\s*null\s*\)/);
  });

  it('revalidates on foreground — web (visibilitychange/focus) AND native (appStateChange)', () => {
    expect(src).toMatch(/addEventListener\(\s*['"]visibilitychange['"]/);
    expect(src).toMatch(/addEventListener\(\s*['"]focus['"]/);
    expect(src).toMatch(/visibilityState\s*===\s*['"]visible['"]/);
    expect(src).toMatch(/@capacitor\/app/);
    expect(src).toMatch(/appStateChange/);
    expect(src).toMatch(/isActive/);
    // Listener cleanup (no leak / duplicate refetch after unmount).
    expect(src).toMatch(/removeEventListener\(\s*['"]visibilitychange['"]/);
    expect(src).toMatch(/handle\.remove\(\)/);
  });

  it('goes through the same authoritative fetcher (single source of truth)', () => {
    expect(src).toMatch(/fetchPlanEntitlements/);
  });
});
