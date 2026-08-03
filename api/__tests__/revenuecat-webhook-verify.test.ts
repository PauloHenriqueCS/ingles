import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifyWebhookAuthorization,
  verifyWebhookSignature,
  verifyWebhookRequest,
} from '../_billing/revenuecat-webhook-verify';

const AUTH_SECRET = 'test-auth-secret-value';
const HMAC_SECRET = 'test-hmac-signing-secret';

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  originalEnv.REVENUECAT_WEBHOOK_AUTH_SECRET = process.env.REVENUECAT_WEBHOOK_AUTH_SECRET;
  originalEnv.REVENUECAT_WEBHOOK_HMAC_SECRET = process.env.REVENUECAT_WEBHOOK_HMAC_SECRET;
  process.env.REVENUECAT_WEBHOOK_AUTH_SECRET = AUTH_SECRET;
  process.env.REVENUECAT_WEBHOOK_HMAC_SECRET = HMAC_SECRET;
});

afterEach(() => {
  process.env.REVENUECAT_WEBHOOK_AUTH_SECRET = originalEnv.REVENUECAT_WEBHOOK_AUTH_SECRET;
  process.env.REVENUECAT_WEBHOOK_HMAC_SECRET = originalEnv.REVENUECAT_WEBHOOK_HMAC_SECRET;
});

function signBody(body: Buffer, timestampSeconds: number, secret = HMAC_SECRET): string {
  const hex = createHmac('sha256', secret).update(`${timestampSeconds}.`).update(body).digest('hex');
  return `t=${timestampSeconds},v1=${hex}`;
}

describe('verifyWebhookAuthorization', () => {
  it('accepts the exact configured secret', () => {
    expect(verifyWebhookAuthorization(AUTH_SECRET)).toBe(true);
  });

  it('rejects a wrong value', () => {
    expect(verifyWebhookAuthorization('wrong-secret')).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifyWebhookAuthorization(undefined)).toBe(false);
    expect(verifyWebhookAuthorization(null)).toBe(false);
  });

  it('fails closed when the secret itself is unset — never "any value passes"', () => {
    delete process.env.REVENUECAT_WEBHOOK_AUTH_SECRET;
    expect(verifyWebhookAuthorization('literally-anything')).toBe(false);
  });
});

describe('verifyWebhookSignature', () => {
  const body = Buffer.from(JSON.stringify({ event: { type: 'TEST' } }), 'utf8');
  const now = new Date('2026-08-04T12:00:00Z');
  const nowSeconds = Math.floor(now.getTime() / 1000);

  it('accepts a correctly signed body within the tolerance window', () => {
    const header = signBody(body, nowSeconds, HMAC_SECRET);
    const result = verifyWebhookSignature(header, body, now);
    expect(result.ok).toBe(true);
  });

  it('rejects when the body was tampered with after signing', () => {
    const header = signBody(body, nowSeconds, HMAC_SECRET);
    const tamperedBody = Buffer.from(JSON.stringify({ event: { type: 'TAMPERED' } }), 'utf8');
    const result = verifyWebhookSignature(header, tamperedBody, now);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_signature');
  });

  it('rejects a signature computed with the wrong secret', () => {
    const header = signBody(body, nowSeconds, 'someone-elses-secret');
    const result = verifyWebhookSignature(header, body, now);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_signature');
  });

  it('rejects a timestamp far outside the tolerance window (replay protection)', () => {
    const staleSeconds = nowSeconds - 60 * 60; // 1 hour old
    const header = signBody(body, staleSeconds, HMAC_SECRET);
    const result = verifyWebhookSignature(header, body, now);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('signature_timestamp_expired');
  });

  it('rejects a malformed header format', () => {
    const result = verifyWebhookSignature('not-the-right-format', body, now);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_signature_format');
  });

  it('rejects a missing header', () => {
    const result = verifyWebhookSignature(undefined, body, now);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing_signature');
  });

  it('reports hmac_not_configured (never "valid") when the secret is unset', () => {
    delete process.env.REVENUECAT_WEBHOOK_HMAC_SECRET;
    const header = signBody(body, nowSeconds, HMAC_SECRET);
    const result = verifyWebhookSignature(header, body, now);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('hmac_not_configured');
  });
});

describe('verifyWebhookRequest — combined Authorization + HMAC', () => {
  const body = Buffer.from(JSON.stringify({ event: { type: 'TEST' } }), 'utf8');
  const now = new Date('2026-08-04T12:00:00Z');
  const nowSeconds = Math.floor(now.getTime() / 1000);

  it('accepts valid Authorization + valid HMAC, never claims hmacSkipped', () => {
    const signatureHeader = signBody(body, nowSeconds, HMAC_SECRET);
    const result = verifyWebhookRequest({ authorizationHeader: AUTH_SECRET, signatureHeader, rawBody: body, now });
    expect(result.ok).toBe(true);
    expect(result.hmacSkipped).toBe(false);
  });

  it('rejects valid Authorization + invalid HMAC', () => {
    const signatureHeader = signBody(body, nowSeconds, 'wrong-secret');
    const result = verifyWebhookRequest({ authorizationHeader: AUTH_SECRET, signatureHeader, rawBody: body, now });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_signature');
  });

  it('rejects invalid Authorization even with a valid HMAC signature', () => {
    const signatureHeader = signBody(body, nowSeconds, HMAC_SECRET);
    const result = verifyWebhookRequest({ authorizationHeader: 'wrong', signatureHeader, rawBody: body, now });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_authorization');
  });

  it('rejects a missing Authorization header outright', () => {
    const signatureHeader = signBody(body, nowSeconds, HMAC_SECRET);
    const result = verifyWebhookRequest({ authorizationHeader: undefined, signatureHeader, rawBody: body, now });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing_authorization');
  });

  it('accepts on Authorization alone when HMAC is not configured yet, and says so explicitly (hmacSkipped=true) — never pretends HMAC was checked', () => {
    delete process.env.REVENUECAT_WEBHOOK_HMAC_SECRET;
    const result = verifyWebhookRequest({ authorizationHeader: AUTH_SECRET, signatureHeader: undefined, rawBody: body, now });
    expect(result.ok).toBe(true);
    expect(result.hmacSkipped).toBe(true);
  });

  it('never accepts anything when the Authorization secret itself is unconfigured', () => {
    delete process.env.REVENUECAT_WEBHOOK_AUTH_SECRET;
    const signatureHeader = signBody(body, nowSeconds, HMAC_SECRET);
    const result = verifyWebhookRequest({ authorizationHeader: AUTH_SECRET, signatureHeader, rawBody: body, now });
    expect(result.ok).toBe(false);
  });
});
