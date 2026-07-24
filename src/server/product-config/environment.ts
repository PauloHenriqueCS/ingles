import type { ConfigEnvironment } from './types';

// Vercel's own VERCEL_ENV is 'production' | 'preview' | 'development'; the
// config catalog's environments are 'development' | 'staging' | 'production'.
// Preview deployments (PRs) map to 'staging' — closer semantically than
// 'development', which is reserved for actual local dev (VERCEL_ENV unset).
export function resolveConfigEnvironment(): ConfigEnvironment {
  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv === 'production') return 'production';
  if (vercelEnv === 'preview') return 'staging';
  return 'development';
}
