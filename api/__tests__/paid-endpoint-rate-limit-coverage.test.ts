/**
 * STRUCTURAL COVERAGE GUARD (audit §18).
 *
 * Every user-reachable API route that can trigger an external paid AI call
 * (OpenAI / Azure Speech / Azure TTS / Realtime) MUST apply a server-side
 * rate limit. This test fails if any listed paid route stops calling
 * applyRateLimit — making it hard to ship a paid endpoint (or a regression)
 * with no rate limit, instead of relying on each developer to remember.
 *
 * When you add a NEW paid route, add it here with the route key(s) it must
 * apply. When you (deliberately) remove a paid provider call from a route,
 * remove it here in the same change — the list is the checklist.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RATE_LIMITS } from '../_rateLimit';

const API_DIR = resolve(__dirname, '..');

function source(relPath: string): string {
  return readFileSync(resolve(API_DIR, relPath), 'utf8');
}

// route file → the route key(s) it must apply (at least one occurrence each).
const PAID_ROUTES: Array<{ file: string; keys: string[] }> = [
  { file: 'generate-theme.ts',                 keys: ['generate-theme'] },
  { file: 'review-text.ts',                    keys: ['review-text'] },
  { file: 'compare-rewrite.ts',                keys: ['compare-rewrite'] },
  { file: 'grammar-explanation.ts',            keys: ['grammar-explanation'] },
  { file: 'writing-rewrite-evaluate.ts',       keys: ['compare-rewrite'] },
  { file: 'tts.ts',                            keys: ['tts'] },
  { file: 'conversation/[...slug].ts',         keys: ['conversation-preview', 'conversation-session'] },
  { file: 'pronunciation/[...slug].ts',        keys: ['pronunciation-start'] },
  { file: 'pronunciation-training/[...slug].ts', keys: ['pronunciation-training-generate-text', 'pronunciation-training-token', 'pronunciation-training-start'] },
  { file: 'listening/[...slug].ts',            keys: ['listening-generate', 'listening-generation-start'] },
];

describe('paid endpoint rate-limit coverage', () => {
  it.each(PAID_ROUTES)('$file applies a rate limit', ({ file, keys }) => {
    const src = source(file);
    expect(src, `${file} must import/call applyRateLimit`).toMatch(/applyRateLimit\s*\(/);
    for (const key of keys) {
      expect(src, `${file} must apply rate-limit key '${key}'`).toContain(`'${key}'`);
    }
  });

  it('every route key referenced by a paid route exists in RATE_LIMITS and fails CLOSED', () => {
    const paidKeys = new Set(PAID_ROUTES.flatMap((r) => r.keys));
    for (const key of paidKeys) {
      expect(RATE_LIMITS[key], `RATE_LIMITS is missing paid key '${key}'`).toBeDefined();
      // A paid route must never silently fail open on a rate-limit-infra outage.
      expect(RATE_LIMITS[key].failClosed, `paid key '${key}' must be failClosed`).toBe(true);
    }
  });

  it('non-cost keys stay fail-open (locking a user out on an infra blip is worse there)', () => {
    for (const key of ['plan-entitlements', 'account-deactivate', 'subscription-sync']) {
      expect(RATE_LIMITS[key]?.failClosed ?? false).toBe(false);
    }
  });
});
