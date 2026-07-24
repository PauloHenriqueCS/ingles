// SERVER-ONLY: public surface of the product-config module. Import from
// here, not from the individual files, so the small set of safe entry
// points stays obvious.

import { PUBLIC_CONFIG_KEYS, type ConfigEnvironment, type ProductConfigValues, type ResolvedProductConfig } from './types';
import { getDefaultProductConfigService } from './service';

export { resolveConfigEnvironment } from './environment';
export { isWithinConfiguredWindow } from './window';
export { checkProductConfigStatusAuth } from './auth';
export { buildStatusPayload, type ProductConfigStatusPayload } from './status';
export { getDefaultProductConfigService, ProductConfigService } from './service';
export type { ConfigEnvironment, ConfigKey, ProductConfigValues, ResolvedProductConfig } from './types';

export async function getProductConfig(environment: ConfigEnvironment): Promise<ResolvedProductConfig> {
  return getDefaultProductConfigService().getConfig(environment);
}

export type PublicConfigValues = Pick<ProductConfigValues, (typeof PUBLIC_CONFIG_KEYS)[number]>;

export interface PublicConfigPayload {
  environment: ConfigEnvironment;
  values: PublicConfigValues;
  usingFallback: boolean;
}

// Filters a resolved config down to exposure = 'public' keys only —
// audio.azure / audio.openai_voice (server_only) never reach this function's
// caller's response.
export async function getPublicConfigPayload(environment: ConfigEnvironment): Promise<PublicConfigPayload> {
  const resolved = await getProductConfig(environment);
  const values = {} as PublicConfigValues;
  for (const key of PUBLIC_CONFIG_KEYS) {
    (values as Record<string, unknown>)[key] = resolved.values[key];
  }
  return { environment, values, usingFallback: resolved.usingFallback };
}
