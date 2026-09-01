/**
 * SERVER-ONLY OneSignal REST send layer. This is the ONLY place the backend
 * talks to OneSignal's API. The client SDK (src/lib/push/onesignalClient.ts)
 * is a separate, unrelated integration — do not import this from client code.
 *
 * Guarantees:
 *   - Targets ONE user, always, via include_aliases.external_id (= the Supabase
 *     UUID the client set with OneSignal.login). NEVER a segment / "All" /
 *     broadcast — targeting an explicit External ID sourced from THIS
 *     environment's own Supabase DB is what keeps a homologation sweep from
 *     ever reaching production devices (prod & homolog are separate Supabase
 *     projects → disjoint UUID spaces; there is a single shared OneSignal app).
 *   - Fails CLOSED: missing appId / restApiKey / externalId → no request.
 *   - Bounded by an AbortController timeout.
 *   - Returns a normalized, sanitized result. The REST API key is never logged,
 *     never echoed, never included in the returned object.
 *
 * Endpoint & payload verified against OneSignal's current REST reference
 * (POST https://api.onesignal.com/notifications, Authorization: Key <key>,
 * include_aliases + target_channel, idempotency_key body field).
 */

import { randomUUID } from 'node:crypto';

const ONESIGNAL_ENDPOINT = 'https://api.onesignal.com/notifications';
const DEFAULT_TIMEOUT_MS = 10_000;

export interface SendBehavioralPushParams {
  appId: string;
  restApiKey: string;
  /** Supabase UUID = OneSignal External ID. */
  externalId: string;
  title: string;
  body: string;
  /** Small, non-sensitive identifiers only (e.g. behavioral_push_event_id,
   *  push_type). Never email/plan/private data. */
  data?: Record<string, unknown>;
  /** RFC-9562 UUID for provider-side dedup. Generated if omitted. */
  idempotencyKey?: string;
  timeoutMs?: number;
}

export interface SendBehavioralPushResult {
  ok: boolean;
  /** OneSignal notification id on success, else null. */
  notificationId: string | null;
  /** Sanitized short failure code (never the raw provider body). */
  failureCode: string | null;
}

function sanitizeHttpFailure(status: number): string {
  if (status >= 500) return `http_5xx_${status}`;
  if (status >= 400) return `http_4xx_${status}`;
  return `http_${status}`;
}

/**
 * Send a single behavioral push to one user by External ID. Best-effort and
 * self-contained: it throws nothing, returning a normalized result the caller
 * persists as sent/failed. A `false` ok never counts as sent.
 */
export async function sendBehavioralPush(
  params: SendBehavioralPushParams,
): Promise<SendBehavioralPushResult> {
  const { appId, restApiKey, externalId, title, body, data } = params;

  // Fail closed — never send without explicit config or an explicit target.
  if (!appId || !restApiKey || !externalId) {
    return { ok: false, notificationId: null, failureCode: 'config_missing' };
  }

  const payload: Record<string, unknown> = {
    app_id: appId,
    target_channel: 'push',
    // Explicit single-user targeting. This object must NEVER be replaced by
    // included_segments / any broadcast selector.
    include_aliases: { external_id: [externalId] },
    headings: { en: title },
    contents: { en: body },
    idempotency_key: params.idempotencyKey ?? randomUUID(),
  };
  if (data && Object.keys(data).length > 0) payload.data = data;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const resp = await fetch(ONESIGNAL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Key ${restApiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    let json: unknown = null;
    try {
      json = await resp.json();
    } catch {
      json = null;
    }

    if (!resp.ok) {
      return { ok: false, notificationId: null, failureCode: sanitizeHttpFailure(resp.status) };
    }

    const record = (json ?? {}) as Record<string, unknown>;
    const notificationId = typeof record.id === 'string' && record.id.length > 0 ? record.id : null;

    // OneSignal can return HTTP 200 with no id and errors like "All included
    // players are not subscribed" when the External ID has no subscribed
    // device. That is NOT a successful send.
    if (!notificationId) {
      return { ok: false, notificationId: null, failureCode: 'no_recipients' };
    }

    return { ok: true, notificationId, failureCode: null };
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    return {
      ok: false,
      notificationId: null,
      failureCode: name === 'AbortError' ? 'timeout' : 'network_error',
    };
  } finally {
    clearTimeout(timer);
  }
}
