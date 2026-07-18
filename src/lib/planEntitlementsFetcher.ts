import { getAuthHeader } from './apiAuth';
import type { PlanEntitlementsSnapshot } from '../domain/entitlements/entitlement-types';

export async function fetchPlanEntitlements(signal?: AbortSignal): Promise<PlanEntitlementsSnapshot> {
  const authHeader = await getAuthHeader();
  const res = await fetch('/api/pronunciation-training/plan-entitlements', { headers: authHeader, signal });
  if (!res.ok) {
    throw new Error('Não foi possível carregar as informações do seu plano.');
  }
  return (await res.json()) as PlanEntitlementsSnapshot;
}
