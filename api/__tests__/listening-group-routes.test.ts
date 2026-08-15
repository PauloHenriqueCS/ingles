import { describe, it, expect } from 'vitest';
import handler from '../listening/[...slug]';

// ─────────────────────────────────────────────────────────────────────────────
// Data-driven cutover: the legacy group/on-demand listening GENERATION routes
// composed their pedagogy from hardcoded English prompt/word-count catalogs
// (build-listening-story-prompt / build-listening-question-prompt), NOT the
// data-driven curriculum. A level-indexed shared inventory can't be recorte-
// specific, so it is fundamentally incompatible with per-recorte curriculum
// content. These routes are therefore RETIRED (HTTP 410): the sole authority for
// a listening practice is the data-driven curriculum Story path
// (POST /api/listening/generate → shared-story → listening.two_part_generate,
// composed for the user's CURRENT recorte, which records curricular practice).
// This suite locks in that retirement so no hardcoded-pedagogy generation route
// can silently come back to life at runtime.
// ─────────────────────────────────────────────────────────────────────────────

function makeReq(slug: string, method = 'POST') {
  return { method, headers: { authorization: 'Bearer test' }, query: { slug }, url: `/api/listening/${slug}`, body: {} };
}
function makeRes() {
  let _status = 200;
  let _body: unknown;
  const res = {
    status(s: number) { _status = s; return res; },
    json(b: unknown) { _body = b; return res; },
    setHeader() {},
    _status: () => _status,
    _body: () => _body,
  };
  return res;
}

const RETIRED_ROUTES = [
  'group/process-next',
  'group/retry',
  'on-demand/start',
  'on-demand/status',
  'on-demand/process-next',
  'on-demand/retry',
];

describe('retired legacy listening generation routes (data-driven cutover)', () => {
  for (const slug of RETIRED_ROUTES) {
    it(`${slug} returns 410 LISTENING_ROUTE_RETIRED without invoking any hardcoded generator`, async () => {
      const res = makeRes();
      await handler(makeReq(slug), res);
      expect(res._status()).toBe(410);
      expect((res._body() as { code?: string }).code).toBe('LISTENING_ROUTE_RETIRED');
    });
  }
});
