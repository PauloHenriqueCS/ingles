export type RewriteV2Mode = 'off' | 'shadow' | 'admin' | 'new_users' | 'full';

export function getRewriteV2Mode(): RewriteV2Mode {
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
