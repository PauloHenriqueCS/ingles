/**
 * SERVER-ONLY (Node runtime) crypto helpers. Kept OUT of api/_helpers.ts on
 * purpose: _helpers is transitively imported by the Edge middleware (middleware
 * .ts → src/server/product-config → service.ts imports safeLog from _helpers),
 * and the Edge runtime forbids Node's `crypto` module. This module is imported
 * only by Node serverless routes (never by the middleware graph).
 */

import { createHash, timingSafeEqual } from 'crypto';

/** Constant-time string comparison. Fails closed on empty/missing inputs and
 *  never leaks length via early return: it compares fixed-length SHA-256 digests
 *  so mismatched lengths still take the same time (timingSafeEqual itself throws
 *  on unequal buffer lengths). */
export function safeCompare(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  const ah = createHash('sha256').update(ab).digest();
  const bh = createHash('sha256').update(bb).digest();
  return timingSafeEqual(ah, bh);
}
