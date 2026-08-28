/**
 * POST /api/debug/log  (rewritten into api/grammar-explanation.ts via
 * vercel.json + __lemonRoute=debug-log to stay within the Vercel Hobby
 * 12-function cap).
 *
 * Client-reported timing ingestion. The device posts here when a request was
 * slow / stalled / errored — the "spinner forever" symptom the server can't see
 * on its own. Every write is gated by the dashboard log level (recordClientLog
 * drops everything when logging is off), so this endpoint is a cheap no-op in
 * normal operation. Accepts a single event or a small batch.
 */
import { requireAuth } from '../_auth';
import { methodGuard, readRawBody, jsonError, PAYLOAD_LIMITS } from '../_helpers';
import { recordClientLog, type ClientLogInput } from '../_debug-log';

const MAX_EVENTS = 20;
const MAX_STR = 200;

function clean(v: unknown, max = MAX_STR): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function toEvent(raw: unknown): ClientLogInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const endpoint = clean(o.endpoint);
  const stage = clean(o.stage);
  if (!endpoint || !stage) return null;
  // `detail` is accepted but hard-capped and never trusted to be small enough to
  // matter — a shallow JSON stringify guard keeps it bounded.
  let detail: Record<string, unknown> | undefined;
  if (o.detail && typeof o.detail === 'object') {
    try {
      const s = JSON.stringify(o.detail);
      if (s.length <= 1000) detail = o.detail as Record<string, unknown>;
    } catch { /* ignore unserializable detail */ }
  }
  return {
    endpoint,
    stage,
    correlationId: clean(o.correlationId, 80),
    durationMs: num(o.durationMs),
    status: num(o.status),
    errorCode: clean(o.errorCode, 60) ?? null,
    bytes: num(o.bytes),
    detail,
  };
}

export async function handleDebugLogRoute(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['POST'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;

  let parsed: unknown;
  try {
    const raw = await readRawBody(req, PAYLOAD_LIMITS.GRAMMAR);
    parsed = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {};
  } catch {
    return jsonError(res, 400, 'INVALID_REQUEST', 'Corpo inválido.');
  }

  const list = Array.isArray(parsed) ? parsed : [parsed];
  const events = list.slice(0, MAX_EVENTS).map(toEvent).filter((e): e is ClientLogInput => e !== null);

  // Fire the writes; recordClientLog is a no-op when logging is off. We await so
  // the function isn't frozen before the (rare, opt-in) insert lands.
  await Promise.all(events.map((e) => recordClientLog(e, auth.userId)));

  res.statusCode = 204;
  res.end();
}
