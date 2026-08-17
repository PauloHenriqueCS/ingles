/**
 * The plan/entitlements snapshot must never be served from a stale HTTP cache —
 * a plan change (e.g. an admin granting an unlimited plan) has to take effect on
 * the next fetch. Both the endpoint and the client fetch must opt out of caching.
 * (Regression guard: the endpoint was previously the ONLY handler in its file
 * missing `Cache-Control: no-store`, which let the app keep an older commercial
 * snapshot even though the server resolved the new plan correctly.)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const handlerSrc = readFileSync(resolve(__dirname, '..', 'pronunciation-training', '[...slug].ts'), 'utf8');
const fetcherSrc = readFileSync(resolve(__dirname, '..', '..', 'src', 'lib', 'planEntitlementsFetcher.ts'), 'utf8');

describe('plan-entitlements freshness (no stale cache)', () => {
  it('the handlePlanEntitlements endpoint sets Cache-Control: no-store', () => {
    const handler = handlerSrc.slice(
      handlerSrc.indexOf('async function handlePlanEntitlements'),
      handlerSrc.indexOf('async function handlePlanEntitlements') + 900,
    );
    expect(handler).toMatch(/res\.setHeader\('Cache-Control', 'no-store'\)/);
    // The no-store must be set BEFORE the snapshot is returned.
    expect(handler.indexOf("'no-store'")).toBeLessThan(handler.indexOf('return res.json(snapshot)'));
  });

  it('the client fetch uses cache: no-store so the WebView never serves a stale plan', () => {
    expect(fetcherSrc).toMatch(/cache:\s*'no-store'/);
    expect(fetcherSrc).toContain('/api/pronunciation-training/plan-entitlements');
  });
});
