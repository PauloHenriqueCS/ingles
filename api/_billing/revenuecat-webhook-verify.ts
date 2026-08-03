/**
 * SERVER-ONLY: RevenueCat webhook authentication — Authorization header
 * (mandatory, always) and X-RevenueCat-Webhook-Signature HMAC-SHA256
 * (mandatory once a signing secret is configured; see the module doc
 * comment on verifyWebhookRequest for what happens before that).
 *
 * Signature format: `t=<unix_seconds>,v1=<hex hmac-sha256>`, computed over
 * `"<timestamp>."` followed by the raw request body bytes — never a
 * re-serialized JSON.stringify(JSON.parse(body)), which can differ
 * byte-for-byte from what was actually signed (key order, whitespace).
 */

import { timingSafeEqual, createHmac } from 'node:crypto';
import { getRevenueCatWebhookAuthSecret, getRevenueCatWebhookHmacSecret } from '../_env';

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

/** Always compares full buffer lengths first via a length check that itself
 *  leaks length (unavoidable — timingSafeEqual requires equal-length inputs)
 *  but never short-circuits the byte comparison itself. */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA); // keep the branch's timing profile similar
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Fails closed: an unset secret or missing header is never treated as "any
 *  value passes" — see getRevenueCatWebhookAuthSecret's own doc comment. */
export function verifyWebhookAuthorization(authorizationHeader: string | undefined | null): boolean {
  const expected = getRevenueCatWebhookAuthSecret();
  if (!expected || !authorizationHeader) return false;
  return constantTimeEqual(authorizationHeader, expected);
}

export type SignatureCheckReason =
  | 'hmac_not_configured'
  | 'missing_signature'
  | 'invalid_signature_format'
  | 'signature_timestamp_expired'
  | 'invalid_signature';

export interface SignatureCheckResult {
  ok: boolean;
  reason?: SignatureCheckReason;
}

const SIGNATURE_HEADER_RE = /^t=(\d+),v1=([0-9a-fA-F]+)$/;

export function verifyWebhookSignature(
  signatureHeader: string | undefined | null,
  rawBody: Buffer,
  now: Date = new Date(),
): SignatureCheckResult {
  const secret = getRevenueCatWebhookHmacSecret();
  if (!secret) return { ok: false, reason: 'hmac_not_configured' };
  if (!signatureHeader) return { ok: false, reason: 'missing_signature' };

  const match = SIGNATURE_HEADER_RE.exec(signatureHeader.trim());
  if (!match) return { ok: false, reason: 'invalid_signature_format' };
  const [, timestampStr, signatureHex] = match;

  const nowSeconds = Math.floor(now.getTime() / 1000);
  const timestampSeconds = parseInt(timestampStr, 10);
  const ageSeconds = Math.abs(nowSeconds - timestampSeconds);
  if (!Number.isFinite(ageSeconds) || ageSeconds > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'signature_timestamp_expired' };
  }

  const expectedHex = createHmac('sha256', secret)
    .update(`${timestampStr}.`)
    .update(rawBody)
    .digest('hex');

  if (!constantTimeEqual(signatureHex.toLowerCase(), expectedHex.toLowerCase())) {
    return { ok: false, reason: 'invalid_signature' };
  }
  return { ok: true };
}

export interface WebhookRequestVerification {
  ok: boolean;
  reason?: 'missing_authorization' | 'invalid_authorization' | SignatureCheckReason;
  /** True when the HMAC secret isn't configured yet — the request was still
   *  accepted on Authorization alone (never silently claimed as
   *  HMAC-verified). Surfaced so the route handler can log it explicitly —
   *  "nunca finja que HMAC foi validado". */
  hmacSkipped: boolean;
}

/**
 * The single check the webhook route handler calls. Authorization is
 * always mandatory. HMAC becomes mandatory the moment
 * REVENUECAT_WEBHOOK_HMAC_SECRET is set (by whoever configures the
 * RevenueCat dashboard's signing secret — see this task's manual
 * checklist) — until then, hmacSkipped is true and only Authorization
 * gates the request. This is a real, documented limitation, not a silent
 * downgrade: every acceptance is logged with hmacSkipped so it's visible
 * which requests were let through without signature verification.
 */
export function verifyWebhookRequest(params: {
  authorizationHeader: string | undefined | null;
  signatureHeader: string | undefined | null;
  rawBody: Buffer;
  now?: Date;
}): WebhookRequestVerification {
  if (!getRevenueCatWebhookAuthSecret()) {
    return { ok: false, reason: 'invalid_authorization', hmacSkipped: false };
  }
  if (!params.authorizationHeader) {
    return { ok: false, reason: 'missing_authorization', hmacSkipped: false };
  }
  if (!verifyWebhookAuthorization(params.authorizationHeader)) {
    return { ok: false, reason: 'invalid_authorization', hmacSkipped: false };
  }

  const signatureResult = verifyWebhookSignature(params.signatureHeader, params.rawBody, params.now);
  if (signatureResult.reason === 'hmac_not_configured') {
    return { ok: true, hmacSkipped: true };
  }
  if (!signatureResult.ok) {
    return { ok: false, reason: signatureResult.reason, hmacSkipped: false };
  }
  return { ok: true, hmacSkipped: false };
}
