// Context families (broad groupings)
export type ContextFamily =
  | 'work'
  | 'travel'
  | 'social'
  | 'food'
  | 'health'
  | 'education'
  | 'home'
  | 'technology'
  | 'entertainment'
  | 'environment'
  | 'personal'
  | 'news'
  | 'culture'
  | 'unknown';

const PREFIX_TO_FAMILY: Record<string, ContextFamily> = {
  'work':          'work',
  'travel':        'travel',
  'social':        'social',
  'food':          'food',
  'health':        'health',
  'edu':           'education',
  'education':     'education',
  'home':          'home',
  'tech':          'technology',
  'technology':    'technology',
  'entertainment': 'entertainment',
  'env':           'environment',
  'environment':   'environment',
  'personal':      'personal',
  'news':          'news',
  'culture':       'culture',
};

// Extract context family from a context key or mission context
export function extractContextFamily(contextKeyOrString: string): ContextFamily {
  if (!contextKeyOrString) return 'unknown';

  // Context keys are formatted as "family:topicId:hint" or "family.subfmaily..."
  // Try colon separator first (canonical format), then dot separator
  const separators = [':', '.'];
  for (const sep of separators) {
    const idx = contextKeyOrString.indexOf(sep);
    if (idx !== -1) {
      const prefix = contextKeyOrString.slice(0, idx).toLowerCase();
      if (prefix in PREFIX_TO_FAMILY) {
        return PREFIX_TO_FAMILY[prefix];
      }
    }
  }

  // Try the whole string as a family
  const lower = contextKeyOrString.toLowerCase();
  if (lower in PREFIX_TO_FAMILY) {
    return PREFIX_TO_FAMILY[lower];
  }

  return 'unknown';
}

// Build a context key from mission/submission metadata
export function buildContextKey(params: {
  contextFamily: ContextFamily;
  missionId?: string;
  topicId: string;
  subfamilyHint?: string;
}): string {
  const { contextFamily, missionId, topicId, subfamilyHint } = params;
  const suffix = subfamilyHint ?? (missionId ? missionId.slice(0, 8) : 'gen');
  return `${contextFamily}:${topicId}:${suffix}`;
}

// Check if two context keys are from distinct families
export function areDistinctContexts(keyA: string, keyB: string): boolean {
  const familyA = extractContextFamily(keyA);
  const familyB = extractContextFamily(keyB);
  return familyA !== familyB;
}

// Count distinct context families from a list of context keys
export function countDistinctContextFamilies(contextKeys: string[]): number {
  const families = new Set<ContextFamily>();
  for (const key of contextKeys) {
    families.add(extractContextFamily(key));
  }
  return families.size;
}
