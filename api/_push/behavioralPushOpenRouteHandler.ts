/**
 * SERVER-ONLY client-facing route: record that a behavioral push was OPENED.
 * Rewritten onto grammar-explanation.ts via ?__lemonRoute=behavioral-push-open
 * (see vercel.json) purely to stay within the 12-function Vercel cap — unrelated
 * to grammar explanations.
 *
 * Security: the caller's identity comes from requireAuth (Supabase session),
 * NEVER from a user_id in the body. The verified userId is passed to the RPC,
 * which confirms the event belongs to that user before stamping opened_at (a
 * server timestamp). First open wins; repeats are idempotent no-ops. An event
 * that isn't the caller's → 403; a missing event → 404 (both sanitized).
 */

import { requireAuth } from '../_auth';
import { getSharedServiceClient } from '../_ai-gateway/index';
import { methodGuard, readRawBody, PAYLOAD_LIMITS, jsonError, safeLog } from '../_helpers';

const LOG = 'behavioral-push-open';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleBehavioralPushOpenRoute(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['POST'])) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;

  let eventId: unknown;
  try {
    const raw = await readRawBody(req, PAYLOAD_LIMITS.PREVIEW);
    const parsed = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {};
    eventId = (parsed as Record<string, unknown> | null)?.behavioral_push_event_id;
  } catch {
    return jsonError(res, 400, 'INVALID_REQUEST', 'Corpo da requisição inválido.');
  }

  if (typeof eventId !== 'string' || !UUID_RE.test(eventId)) {
    return jsonError(res, 400, 'INVALID_REQUEST', 'behavioral_push_event_id inválido.');
  }

  const supabase = getSharedServiceClient();
  try {
    const { data, error } = await supabase.rpc('behavioral_push_record_open', {
      p_event_id: eventId,
      p_user_id: userId,
    });
    if (error) {
      safeLog(LOG, 'rpc_error', 500, { error: error.message });
      return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível registrar a abertura.');
    }
    const outcome = String(data);
    if (outcome === 'ok') return res.status(200).json({ ok: true });
    if (outcome === 'not_found') return res.status(404).json({ ok: false });
    // 'forbidden' — do not reveal whether the event exists.
    return res.status(403).json({ ok: false });
  } catch (err) {
    safeLog(LOG, 'exception', 500, { error: err instanceof Error ? err.message : String(err) });
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível registrar a abertura.');
  }
}
