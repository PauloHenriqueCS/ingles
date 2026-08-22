import { getAuthHeader } from './apiAuth';
import { apiUrl } from './apiUrl';
import type { PlanEntitlementsSnapshot } from '../domain/entitlements/entitlement-types';

export async function fetchPlanEntitlements(signal?: AbortSignal): Promise<PlanEntitlementsSnapshot> {
  const authHeader = await getAuthHeader();
  // Cache-busting is REQUIRED, not just defensive: the iOS Capacitor WKWebView
  // does NOT reliably honour `cache: 'no-store'` (nor the endpoint's own
  // `Cache-Control: no-store`) — it serves a previously-cached GET response, so
  // the plan counters ("X restante") stay frozen on their old value no matter
  // how many times we refetch (every refetch just re-reads the cached body).
  // A unique query param per request makes the URL distinct, so the WebView can
  // never satisfy it from cache and is forced to hit the network. The server
  // ignores the extra param. `no-store` + no-cache request headers stay as
  // belt-and-suspenders for well-behaved HTTP layers.
  const bust = `_ts=${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const url = `${apiUrl('/api/pronunciation-training/plan-entitlements')}?${bust}`;
  const res = await fetch(url, {
    headers: { ...authHeader, 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    signal,
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error('Não foi possível carregar as informações do seu plano.');
  }
  return (await res.json()) as PlanEntitlementsSnapshot;
}
