/**
 * SERVER-ONLY: feature flags for the canonical writing rewrite V2 engine.
 * Never import in React components or client-side bundles.
 *
 * When LEARNING_ENGINE_VERSION=v2 (default), this engine is always 'full'.
 * When LEARNING_ENGINE_VERSION=v1 (rollback), falls back to 'off'.
 */

import { isV2Active } from './engineVersion';

export type RewriteV2Mode = 'off' | 'shadow' | 'admin' | 'new_users' | 'full';

export function getRewriteV2Mode(): RewriteV2Mode {
  if (isV2Active()) return 'full';

  // V1 rollback: read individual override (defaults to 'off')
  const raw = process.env.CANONICAL_WRITING_REWRITE_V2;
  if (
    raw === 'shadow' ||
    raw === 'admin' ||
    raw === 'new_users' ||
    raw === 'full'
  ) {
    return raw;
  }
  return 'off';
}

export function isRewriteV2Enabled(): boolean {
  return getRewriteV2Mode() !== 'off';
}

export function isRewriteV2Shadow(): boolean {
  return getRewriteV2Mode() === 'shadow';
}

export function isRewriteV2FullyActive(): boolean {
  const mode = getRewriteV2Mode();
  return mode === 'full' || mode === 'admin' || mode === 'new_users';
}
