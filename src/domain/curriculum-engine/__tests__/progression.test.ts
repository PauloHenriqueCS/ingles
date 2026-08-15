import { describe, it, expect } from 'vitest';
import {
  isSubtopicComplete,
  pendingModalities,
  selectedModalities,
  computeCurriculumState,
  isModuleComplete,
  isLevelComplete,
  recomputeCompleted,
  type ModalityPreferences,
  type OrderedSubtopic,
} from '../progression';

const prefs = (p: Partial<ModalityPreferences>): ModalityPreferences => ({
  writing: false,
  listening: false,
  pronunciation: false,
  conversation: false,
  ...p,
});

describe('progression — recorte completion (menu = rule)', () => {
  it('Writing + Listening: not complete until BOTH practised', () => {
    const p = prefs({ writing: true, listening: true });
    expect(isSubtopicComplete(p, ['writing'])).toBe(false);
    expect(isSubtopicComplete(p, ['writing', 'listening'])).toBe(true);
  });

  it('single modality selected completes with that one practice (no repeat invented)', () => {
    const p = prefs({ writing: true });
    expect(isSubtopicComplete(p, ['writing'])).toBe(true);
  });

  it('Writing + Listening + Pronunciation requires all three', () => {
    const p = prefs({ writing: true, listening: true, pronunciation: true });
    expect(isSubtopicComplete(p, ['writing', 'listening'])).toBe(false);
    expect(isSubtopicComplete(p, ['writing', 'listening', 'pronunciation'])).toBe(true);
  });

  it('conversation selected => required; not selected => never blocks', () => {
    const withConv = prefs({ writing: true, conversation: true });
    expect(isSubtopicComplete(withConv, ['writing'])).toBe(false);
    expect(isSubtopicComplete(withConv, ['writing', 'conversation'])).toBe(true);

    const noConv = prefs({ writing: true });
    // practising conversation is harmless but writing alone already completes.
    expect(isSubtopicComplete(noConv, ['writing'])).toBe(true);
  });

  it('zero selected modalities cannot complete', () => {
    expect(isSubtopicComplete(prefs({}), ['writing', 'listening'])).toBe(false);
  });

  it('pendingModalities lists selected-but-not-practised', () => {
    const p = prefs({ writing: true, listening: true, pronunciation: true });
    expect(pendingModalities(p, ['writing']).sort()).toEqual(['listening', 'pronunciation']);
  });

  it('selectedModalities respects the preference flags', () => {
    expect(selectedModalities(prefs({ writing: true, conversation: true }))).toEqual(['writing', 'conversation']);
  });
});

describe('progression — cross-day persistence & recompute on preference change', () => {
  it('practising Writing today and Listening later completes the same recorte', () => {
    const p = prefs({ writing: true, listening: true, pronunciation: true });
    const practiced = new Map<string, Set<'writing' | 'listening' | 'pronunciation' | 'conversation'>>([
      ['A1.SELFINTRO.GREET_INTRODUCE', new Set(['writing'])],
    ]);
    // day 1: writing only
    expect(recomputeCompleted(p, practiced).size).toBe(0);
    // day 2: add listening + pronunciation
    practiced.get('A1.SELFINTRO.GREET_INTRODUCE')!.add('listening');
    practiced.get('A1.SELFINTRO.GREET_INTRODUCE')!.add('pronunciation');
    expect(recomputeCompleted(p, practiced).has('A1.SELFINTRO.GREET_INTRODUCE')).toBe(true);
  });

  it('changing preferences never deletes practice; may complete a recorte immediately', () => {
    const practiced = new Map([['S1', new Set<'writing' | 'listening' | 'pronunciation' | 'conversation'>(['writing'])]]);
    // Was requiring writing+listening → incomplete.
    expect(recomputeCompleted(prefs({ writing: true, listening: true }), practiced).has('S1')).toBe(false);
    // User drops listening → now writing alone satisfies → complete, no data lost.
    expect(recomputeCompleted(prefs({ writing: true }), practiced).has('S1')).toBe(true);
  });
});

describe('progression — position, multi-recorte/day, module/level/curriculum completion', () => {
  const ordered: OrderedSubtopic[] = [
    { subtopicKey: 'A1.M1.R1', moduleKey: 'A1.M1', levelCode: 'A1' },
    { subtopicKey: 'A1.M1.R2', moduleKey: 'A1.M1', levelCode: 'A1' },
    { subtopicKey: 'A1.M2.R1', moduleKey: 'A1.M2', levelCode: 'A1' },
    { subtopicKey: 'A2.M1.R1', moduleKey: 'A2.M1', levelCode: 'A2' },
  ];

  it('current subtopic is the first not-completed (multiple can finish same day)', () => {
    const completed = new Set(['A1.M1.R1', 'A1.M1.R2', 'A1.M2.R1']); // 3 in one day is fine
    const state = computeCurriculumState(ordered, completed);
    expect(state.currentSubtopicKey).toBe('A2.M1.R1');
    expect(state.status).toBe('active');
  });

  it('module/level completion', () => {
    const completed = new Set(['A1.M1.R1', 'A1.M1.R2']);
    expect(isModuleComplete(ordered, 'A1.M1', completed)).toBe(true);
    expect(isModuleComplete(ordered, 'A1.M2', completed)).toBe(false);
    expect(isLevelComplete(ordered, 'A1', completed)).toBe(false);
  });

  it('curriculum_completed when all subtopics done (no reset, no C3)', () => {
    const all = new Set(ordered.map((s) => s.subtopicKey));
    const state = computeCurriculumState(ordered, all);
    expect(state.status).toBe('curriculum_completed');
    expect(state.currentSubtopicKey).toBeNull();
  });
});
