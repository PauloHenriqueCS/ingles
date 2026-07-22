/**
 * Static config assertions on vercel.json's routing/caching rules.
 *
 * There is no live Vercel server in the unit test suite, so this simulates
 * the stale-chunk-after-deploy scenario the same way this repo already
 * tests config wiring it can't exercise at runtime (see
 * src/lib/lemonNativeAndroid.wiring.test.ts): read the config as data and
 * test its regex/rule behavior directly. Manual confirmation against the
 * real https://my.lemonenglish.app is documented in the task report, not
 * repeated here.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const VERCEL_CONFIG_PATH = resolve(__dirname, '..', '..', 'vercel.json');

interface VercelRewrite { source: string; destination: string }
interface VercelHeaderRule { source: string; headers: { key: string; value: string }[] }
interface VercelConfig { rewrites: VercelRewrite[]; headers: VercelHeaderRule[] }

const config = JSON.parse(readFileSync(VERCEL_CONFIG_PATH, 'utf8')) as VercelConfig;

function findRewrite(source: string): VercelRewrite | undefined {
  return config.rewrites.find((r) => r.source === source);
}

describe('vercel.json — SPA catch-all rewrite', () => {
  const catchAll = config.rewrites[config.rewrites.length - 1];
  const catchAllRegex = new RegExp(`^${catchAll.source}$`);

  it('is the last rewrite (lowest priority) and points at /index.html', () => {
    expect(catchAll.destination).toBe('/index.html');
  });

  it('still matches real SPA routes, so client-side routing keeps working', () => {
    expect(catchAllRegex.test('/')).toBe(true);
    expect(catchAllRegex.test('/pronunciation')).toBe(true);
    expect(catchAllRegex.test('/some/deep/react/route')).toBe(true);
  });

  it('does not match /api/* — those are handled by functions/other rewrites, never the SPA shell', () => {
    expect(catchAllRegex.test('/api/conversation/session')).toBe(false);
    expect(catchAllRegex.test('/api/listening/today')).toBe(false);
  });

  it('does not match /assets/* — a missing hashed chunk must 404, never fall back to index.html (root cause of the "Failed to fetch dynamically imported module" bug)', () => {
    expect(catchAllRegex.test('/assets/index-abc123.js')).toBe(false);
    expect(catchAllRegex.test('/assets/microsoft.cognitiveservices.speech.sdk-xyz789.js')).toBe(false);
  });
});

describe('vercel.json — /assets/* caching', () => {
  it('has a dedicated header rule for /assets/(.*) with long, immutable Cache-Control', () => {
    const rule = config.headers.find((h) => h.source === '/assets/(.*)');
    expect(rule).toBeDefined();

    const cacheControl = rule?.headers.find((h) => h.key === 'Cache-Control');
    expect(cacheControl?.value).toMatch(/immutable/);
    expect(cacheControl?.value).toMatch(/max-age=31536000/);
  });

  it('leaves the existing site-wide security headers rule untouched', () => {
    const rule = config.headers.find((h) => h.source === '/(.*)');
    expect(rule).toBeDefined();

    const keys = rule?.headers.map((h) => h.key) ?? [];
    expect(keys).toContain('Permissions-Policy');
    expect(keys).toContain('X-Frame-Options');
    expect(keys).toContain('Content-Security-Policy');
  });
});

describe('vercel.json — API rewrites are untouched by the /assets/ exclusion', () => {
  it('still rewrites /api/listening/* and /api/internal/listening/* to their [...slug] handlers', () => {
    expect(findRewrite('/api/listening/(.*)')?.destination).toBe('/api/listening/[...slug]?slug=$1');
    expect(findRewrite('/api/internal/listening/(.*)')?.destination).toBe('/api/internal/listening/[...slug]?slug=$1');
  });

  it('still rewrites the account-deactivate route', () => {
    expect(findRewrite('/api/account/deactivate')?.destination).toBe('/api/grammar-explanation?__lemonRoute=account-deactivate');
  });
});
