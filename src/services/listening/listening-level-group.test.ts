import { describe, it, expect } from 'vitest';
import {
  LISTENING_LEVEL_GROUPS,
  LEVEL_GROUP_MEMBERS,
  isListeningLevelGroup,
  levelGroupForCefr,
  otherLevelInGroup,
} from './listening-level-group';
import type { CEFRLevel } from '../../domain/curriculum/cefr';

describe('listening level groups', () => {
  it('defines exactly three groups', () => {
    expect(LISTENING_LEVEL_GROUPS).toEqual(['A1_A2', 'B1_B2', 'C1_C2']);
  });

  it('maps every CEFR level to exactly one group, and every group has exactly two members', () => {
    const seen = new Set<CEFRLevel>();
    for (const group of LISTENING_LEVEL_GROUPS) {
      const members = LEVEL_GROUP_MEMBERS[group];
      expect(members).toHaveLength(2);
      for (const level of members) {
        expect(seen.has(level)).toBe(false);
        seen.add(level);
      }
    }
    expect(seen).toEqual(new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']));
  });

  it.each([
    ['A1', 'A1_A2'], ['A2', 'A1_A2'],
    ['B1', 'B1_B2'], ['B2', 'B1_B2'],
    ['C1', 'C1_C2'], ['C2', 'C1_C2'],
  ] as const)('levelGroupForCefr(%s) === %s', (level, expected) => {
    expect(levelGroupForCefr(level)).toBe(expected);
  });

  it('otherLevelInGroup returns the alternate level within a group', () => {
    expect(otherLevelInGroup('A1_A2', 'A1')).toBe('A2');
    expect(otherLevelInGroup('A1_A2', 'A2')).toBe('A1');
    expect(otherLevelInGroup('B1_B2', 'B1')).toBe('B2');
    expect(otherLevelInGroup('C1_C2', 'C2')).toBe('C1');
  });

  it('otherLevelInGroup throws for a level outside the given group', () => {
    expect(() => otherLevelInGroup('A1_A2', 'B1')).toThrow();
  });

  it('isListeningLevelGroup narrows valid group strings and rejects everything else', () => {
    expect(isListeningLevelGroup('A1_A2')).toBe(true);
    expect(isListeningLevelGroup('B1_B2')).toBe(true);
    expect(isListeningLevelGroup('A1')).toBe(false);
    expect(isListeningLevelGroup('')).toBe(false);
    expect(isListeningLevelGroup('a1_a2')).toBe(false);
  });
});
