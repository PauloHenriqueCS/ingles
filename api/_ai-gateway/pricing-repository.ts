/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Read-only access to provider_pricing. The gateway always reads prices from
 * this table; it never calls out to a provider's pricing page at runtime.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSharedServiceClient } from './usage-repository';

export interface PriceLookupParams {
  provider: string;
  service: string | null;
  model: string | null;
  metricKey: string;
  currency: string;
  at: Date;
}

export interface PriceLookupResult {
  id: string;
  // Decimal strings — never `number` — to preserve exact precision from
  // Postgres NUMERIC all the way through the cost calculation.
  pricePerUnit: string;
  unitSize: string;
  currency: string;
}

export interface PricingRepositoryInterface {
  findActivePrice(params: PriceLookupParams): Promise<PriceLookupResult | null>;
}

export class SupabasePricingRepository implements PricingRepositoryInterface {
  private readonly supabase: SupabaseClient;

  constructor(supabase?: SupabaseClient) {
    this.supabase = supabase ?? getSharedServiceClient();
  }

  async findActivePrice(params: PriceLookupParams): Promise<PriceLookupResult | null> {
    const { provider, service, model, metricKey, currency, at } = params;
    const atIso = at.toISOString();

    let query = this.supabase
      .from('provider_pricing')
      // ::text casts avoid a lossy NUMERIC → JS number round-trip on the way out.
      .select('id, price_per_unit::text, unit_size::text, currency')
      .eq('provider', provider)
      .eq('metric_key', metricKey)
      .eq('currency', currency)
      .eq('is_active', true)
      .lte('valid_from', atIso) // valid_from is inclusive
      .or(`valid_until.is.null,valid_until.gt.${atIso}`) // valid_until is exclusive
      .order('valid_from', { ascending: false })
      .limit(1);

    query = service != null ? query.eq('service', service) : query.is('service', null);
    query = model != null ? query.eq('model', model) : query.is('model', null);

    const { data, error } = await query.maybeSingle();
    if (error || !data) return null;

    const row = data as { id: string; price_per_unit: string; unit_size: string; currency: string };
    return {
      id:           row.id,
      pricePerUnit: row.price_per_unit,
      unitSize:     row.unit_size,
      currency:     row.currency,
    };
  }
}
