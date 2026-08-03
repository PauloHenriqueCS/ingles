/**
 * Handler for POST /api/billing/revenuecat/webhook — reached via a
 * vercel.json rewrite into api/grammar-explanation.ts (see the
 * __lemonRoute branch there and api/_helpers.ts's readRawBody), purely to
 * stay within the Vercel Hobby plan's 12-serverless-function cap. Grammar-
 * explanation's own logic/URL are unaffected.
 *
 * Flow: verify (Authorization + HMAC) -> record the event idempotently by
 * revenuecat_event_id -> dispatch by event-type category -> always ACK 200
 * once durably recorded, even on a processing failure (see the doc comment
 * above the retry-handling block below for why).
 *
 * Never logs the full payload, a secret, or a token — only route/event
 * metadata (safeLog's own allowlisted-fields contract).
 */

import { createHash } from 'node:crypto';
import { readRawBody, jsonError, methodGuard, safeLog } from '../_helpers';
import { verifyWebhookRequest } from './revenuecat-webhook-verify';
import { getSharedServiceClient } from '../_ai-gateway/usage-repository';
import {
  syncSubscriptionFromEvent,
  SUBSCRIPTION_LIFECYCLE_EVENT_TYPES,
  type RevenueCatLifecycleEvent,
} from './revenuecat-subscription-sync-service';
import { creditMinutePackagePurchase } from './revenuecat-minute-credit-service';

const MAX_WEBHOOK_BODY_BYTES = 65_536; // 64KB — generous for a RevenueCat event payload

interface RawEventEnvelope {
  api_version?: string;
  event?: Record<string, unknown>;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function strArray(v: unknown): string[] | null {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
}

type ProcessingStatus = 'received' | 'processed' | 'ignored' | 'failed';

/** Terminal statuses mean this exact event id was already fully handled —
 *  a redelivery is a pure duplicate. 'received'/'failed' are NOT terminal:
 *  a redelivery of an event whose previous attempt threw must actually be
 *  retried, never silently swallowed as "already handled". */
const TERMINAL_STATUSES = new Set<ProcessingStatus>(['processed', 'ignored']);

export async function handleRevenueCatWebhookRoute(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['POST'])) return;

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req, MAX_WEBHOOK_BODY_BYTES);
  } catch {
    return jsonError(res, 413, 'PAYLOAD_TOO_LARGE', 'Corpo da requisição excede o limite.');
  }

  const verification = verifyWebhookRequest({
    authorizationHeader: req.headers?.['authorization'],
    signatureHeader: req.headers?.['x-revenuecat-webhook-signature'],
    rawBody,
  });
  if (!verification.ok) {
    safeLog('billing/revenuecat-webhook', 'verification_failed', 401, { reason: verification.reason ?? 'unknown' });
    return jsonError(res, 401, 'UNAUTHORIZED', 'Assinatura ou autorização inválida.');
  }
  if (verification.hmacSkipped) {
    // Never pretended to be HMAC-verified — see revenuecat-webhook-verify.ts.
    safeLog('billing/revenuecat-webhook', 'hmac_not_configured', 200);
  }

  let envelope: RawEventEnvelope;
  try {
    envelope = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return jsonError(res, 400, 'INVALID_REQUEST', 'Corpo da requisição inválido.');
  }
  const rawEvent = envelope.event;
  if (!rawEvent || typeof rawEvent !== 'object') {
    return jsonError(res, 400, 'INVALID_REQUEST', 'Evento ausente no corpo da requisição.');
  }

  const eventId = str(rawEvent.id);
  const eventType = str(rawEvent.type);
  const environment = str(rawEvent.environment) ?? 'PRODUCTION';
  const appUserId = str(rawEvent.app_user_id);
  if (!eventId || !eventType) {
    return jsonError(res, 400, 'INVALID_REQUEST', 'Evento sem id ou type.');
  }

  const supabase = getSharedServiceClient();
  const payloadHash = createHash('sha256').update(rawBody).digest('hex');

  // ── Idempotent record-then-process ──────────────────────────────────────
  // A redelivery of an event already in a TERMINAL status is a pure
  // duplicate — ack immediately, never reprocess. A redelivery of an event
  // still 'received' or 'failed' (previous attempt crashed before finishing)
  // is retried for real: the downstream sync/credit services are themselves
  // idempotent (idempotency_key / unique external_reference), so reprocessing
  // is always safe, never a double-effect.
  const { data: existing, error: selectError } = await supabase
    .from('revenuecat_webhook_events')
    .select('id, processing_status')
    .eq('revenuecat_event_id', eventId)
    .maybeSingle();
  if (selectError) {
    safeLog('billing/revenuecat-webhook', 'event_lookup_failed', 500);
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível verificar o evento.');
  }

  const existingRow = existing as { id: string; processing_status: ProcessingStatus } | null;
  if (existingRow && TERMINAL_STATUSES.has(existingRow.processing_status)) {
    safeLog('billing/revenuecat-webhook', 'duplicate_event', 200, { eventType });
    return res.status(200).json({ received: true, duplicate: true });
  }

  if (!existingRow) {
    const { error: insertError } = await supabase.from('revenuecat_webhook_events').insert({
      revenuecat_event_id: eventId,
      event_type: eventType,
      environment,
      app_user_id: appUserId,
      product_id: str(rawEvent.product_id),
      transaction_id: str(rawEvent.transaction_id),
      original_transaction_id: str(rawEvent.original_transaction_id),
      payload_hash: payloadHash,
      processing_status: 'received',
    });
    if (insertError && (insertError as { code?: string }).code !== '23505') {
      safeLog('billing/revenuecat-webhook', 'event_log_insert_failed', 500);
      return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível registrar o evento.');
    }
    // A 23505 here means a concurrent delivery of the same event id won the
    // race to insert — this request still safely proceeds to (re)process,
    // since every downstream effect is independently idempotent.
  }

  let processingStatus: ProcessingStatus = 'ignored';
  let errorMessage: string | null = null;

  try {
    if (eventType === 'TEST') {
      processingStatus = 'ignored';
    } else if (eventType === 'NON_RENEWING_PURCHASE') {
      const productId = str(rawEvent.product_id);
      if (!appUserId || !productId) {
        processingStatus = 'ignored';
        errorMessage = 'missing_app_user_id_or_product_id';
      } else {
        const outcome = await creditMinutePackagePurchase(
          { appUserId, environment, productId, transactionId: str(rawEvent.transaction_id) },
          { supabase },
        );
        processingStatus = outcome.ok ? 'processed' : 'ignored';
        if (!outcome.ok) errorMessage = outcome.reason;
      }
    } else if (SUBSCRIPTION_LIFECYCLE_EVENT_TYPES.has(eventType) || eventType === 'BILLING_ISSUE') {
      if (!appUserId) {
        processingStatus = 'ignored';
        errorMessage = 'missing_app_user_id';
      } else {
        const lifecycleEvent: RevenueCatLifecycleEvent = {
          type: eventType,
          appUserId,
          environment,
          productId: str(rawEvent.product_id),
          purchasedAtMs: num(rawEvent.purchased_at_ms),
          expirationAtMs: num(rawEvent.expiration_at_ms),
          originalTransactionId: str(rawEvent.original_transaction_id),
          transferredTo: strArray(rawEvent.transferred_to),
        };
        const outcome = await syncSubscriptionFromEvent(lifecycleEvent, { supabase });
        processingStatus = outcome.ok ? 'processed' : 'ignored';
        if (!outcome.ok) errorMessage = outcome.reason;
      }
    } else {
      // PAYWALL_*, VIRTUAL_CURRENCY_TRANSACTION, EXPERIMENT_ENROLLMENT,
      // PURCHASE_REDEEMED, SUBSCRIBER_ALIAS, PRICE_INCREASE_CONSENT_*,
      // INVOICE_ISSUANCE, SUBSCRIPTION_PAUSED — acknowledged, never acted on.
      processingStatus = 'ignored';
    }
  } catch (err) {
    processingStatus = 'failed';
    errorMessage = err instanceof Error ? err.message : 'unknown_error';
    safeLog('billing/revenuecat-webhook', 'processing_error', 500, { eventType });
  }

  const { error: updateError } = await supabase
    .from('revenuecat_webhook_events')
    .update({ processing_status: processingStatus, processed_at: new Date().toISOString(), error_message: errorMessage })
    .eq('revenuecat_event_id', eventId);
  if (updateError) {
    safeLog('billing/revenuecat-webhook', 'event_status_update_failed', 500, { eventType });
  }

  // Always ACK 200 once the event is durably recorded (even 'failed') —
  // the failure is visible in revenuecat_webhook_events.error_message for
  // investigation/manual reconciliation, never silently swallowed, and
  // never left to trigger a RevenueCat retry storm.
  res.status(200).json({ received: true });
}
