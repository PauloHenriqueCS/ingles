import type { CEFRLevel } from '../../domain/curriculum/cefr';

export const LISTENING_LEVEL_GROUPS = ['A1_A2', 'B1_B2', 'C1_C2'] as const;
export type ListeningLevelGroup = typeof LISTENING_LEVEL_GROUPS[number];

export const LEVEL_GROUP_MEMBERS: Record<ListeningLevelGroup, readonly [CEFRLevel, CEFRLevel]> = {
  A1_A2: ['A1', 'A2'],
  B1_B2: ['B1', 'B2'],
  C1_C2: ['C1', 'C2'],
};

export function isListeningLevelGroup(value: string): value is ListeningLevelGroup {
  return (LISTENING_LEVEL_GROUPS as readonly string[]).includes(value);
}

export function levelGroupForCefr(level: CEFRLevel): ListeningLevelGroup {
  for (const group of LISTENING_LEVEL_GROUPS) {
    if ((LEVEL_GROUP_MEMBERS[group] as readonly CEFRLevel[]).includes(level)) return group;
  }
  throw new Error(`No level group configured for CEFR level: ${level}`);
}

export function otherLevelInGroup(group: ListeningLevelGroup, level: CEFRLevel): CEFRLevel {
  const [a, b] = LEVEL_GROUP_MEMBERS[group];
  if (level === a) return b;
  if (level === b) return a;
  throw new Error(`CEFR level ${level} is not a member of level group ${group}`);
}
