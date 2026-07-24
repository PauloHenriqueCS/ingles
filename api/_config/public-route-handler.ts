// GET /api/config/public (rewritten from api/grammar-explanation.ts to stay
// within the Vercel Hobby plan's function cap — see vercel.json). Returns
// only exposure = 'public' config values (banner text, feature flags,
// signup state, timezone). Never includes audio.azure / audio.openai_voice
// (exposure = 'server_only') — getPublicConfigPayload filters those out
// before this handler ever sees the response shape.

import { methodGuard, safeLog } from '../_helpers';
import { getPublicConfigPayload, resolveConfigEnvironment } from '../../src/server/product-config';
import { SAFE_DEFAULTS } from '../../src/server/product-config/defaults';
import { PUBLIC_CONFIG_KEYS } from '../../src/server/product-config/types';

export async function handleConfigPublicRoute(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['GET'])) return;

  try {
    const environment = resolveConfigEnvironment();
    const payload = await getPublicConfigPayload(environment);
    // Short edge/browser cache — the service's own in-memory cache is the
    // primary control; this just avoids re-fetching on every rapid reload.
    res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=60');
    return res.status(200).json(payload);
  } catch (err) {
    // getPublicConfigPayload/getProductConfig never throw in practice — this
    // is a last-resort guard so a bug here can never break the frontend.
    safeLog('config/public', 'unexpected_error', 200, {});
    const values: Record<string, unknown> = {};
    for (const key of PUBLIC_CONFIG_KEYS) values[key] = SAFE_DEFAULTS[key];
    return res.status(200).json({ environment: resolveConfigEnvironment(), values, usingFallback: true });
  }
}
