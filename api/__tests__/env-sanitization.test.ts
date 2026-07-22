// Regression test for a production incident: GET /api/pronunciation-training/
// plan-entitlements returned 500 for every request because
// process.env.SUPABASE_SERVICE_ROLE_KEY, as stored in Vercel's production
// environment, carried a leading UTF-8 BOM (U+FEFF). supabase-js sends that
// value verbatim as the `apikey` header, and undici's header encoder rejects
// any header value containing a character above 255 with "Cannot convert
// argument to a ByteString" — every call built from the raw env var threw.
// getCurrentUserPlanEntitlements does not catch that (by design — a plan
// resolution failure must never look like "no plan"), so the exception
// reached the route handler as a hard 500, blocking every plan-gated
// feature for the affected user regardless of their actual plan.
//
// Reproduced directly against production (read-only: minted a session for
// the affected account via the Supabase admin API, called the deployed
// endpoint, logged out immediately) before this fix landed — confirmed the
// exact error message below. See api/_env.ts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readEnv, getSupabaseServiceCredentials, getSupabaseAnonCredentials } from '../_env';

const BOM = String.fromCharCode(0xfeff);

describe('readEnv / getSupabase*Credentials — BOM and whitespace sanitization', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.TEST_VAR;
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.VITE_SUPABASE_ANON_KEY;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('strips a leading BOM, exactly the shape that broke production', () => {
    process.env.TEST_VAR = `${BOM}eyJhbGciOiJIUzI1NiJ9.payload.sig`;
    const value = readEnv('TEST_VAR');
    expect(value.charCodeAt(0)).not.toBe(0xfeff);
    expect(value).toBe('eyJhbGciOiJIUzI1NiJ9.payload.sig');
  });

  it('the sanitized value is valid ByteString header input (what undici rejects)', () => {
    process.env.TEST_VAR = `${BOM}abc123`;
    const value = readEnv('TEST_VAR');
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\xFF]*$/.test(value)).toBe(true);
  });

  it('trims surrounding whitespace (a common paste artifact alongside the BOM)', () => {
    process.env.TEST_VAR = '  eyJhbGciOiJIUzI1NiJ9  \n';
    expect(readEnv('TEST_VAR')).toBe('eyJhbGciOiJIUzI1NiJ9');
  });

  it('leaves a clean value untouched', () => {
    process.env.TEST_VAR = 'eyJhbGciOiJIUzI1NiJ9';
    expect(readEnv('TEST_VAR')).toBe('eyJhbGciOiJIUzI1NiJ9');
  });

  it('returns an empty string for an unset variable, never throws', () => {
    expect(readEnv('DOES_NOT_EXIST')).toBe('');
  });

  it('getSupabaseServiceCredentials sanitizes both url and service-role key', () => {
    process.env.VITE_SUPABASE_URL = `${BOM}https://example.supabase.co`;
    process.env.SUPABASE_SERVICE_ROLE_KEY = `${BOM}service-role-secret `;
    const { url, key } = getSupabaseServiceCredentials();
    expect(url).toBe('https://example.supabase.co');
    expect(key).toBe('service-role-secret');
  });

  it('getSupabaseAnonCredentials sanitizes both url and anon key', () => {
    process.env.VITE_SUPABASE_URL = `${BOM}https://example.supabase.co`;
    process.env.VITE_SUPABASE_ANON_KEY = `${BOM}anon-key `;
    const { url, key } = getSupabaseAnonCredentials();
    expect(url).toBe('https://example.supabase.co');
    expect(key).toBe('anon-key');
  });
});
