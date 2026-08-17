import { getAuthHeader } from './apiAuth';
import { apiUrl } from './apiUrl';
import type { PlanEntitlementsSnapshot } from '../domain/entitlements/entitlement-types';

export async function fetchPlanEntitlements(signal?: AbortSignal): Promise<PlanEntitlementsSnapshot> {
  const authHeader = await getAuthHeader();
  // `cache: 'no-store'` so the WebView/HTTP layer never serves a stale plan
  // snapshot — a plan change (e.g. an admin granting an unlimited plan) must be
  // reflected on the next fetch, not held behind a cached older response. Pairs
  // with the endpoint's own `Cache-Control: no-store`.
  const res = await fetch(apiUrl('/api/pronunciation-training/plan-entitlements'), {
    headers: authHeader,
    signal,
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error('Não foi possível carregar as informações do seu plano.');
  }
  return (await res.json()) as PlanEntitlementsSnapshot;
}
