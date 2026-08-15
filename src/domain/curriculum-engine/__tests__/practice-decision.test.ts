import { describe, it, expect } from 'vitest';
import { decidePractice } from '../practice-decision';
import type { CurricularModality, ModalityPreferences, OrderedSubtopic } from '../progression';

const prefs = (p: Partial<ModalityPreferences>): ModalityPreferences => ({
  writing: false, listening: false, pronunciation: false, conversation: false, ...p,
});

const ordered: OrderedSubtopic[] = [
  { subtopicKey: 'A1.M1.R1', moduleKey: 'A1.M1', levelCode: 'A1' },
  { subtopicKey: 'A1.M1.R2', moduleKey: 'A1.M1', levelCode: 'A1' },
  { subtopicKey: 'A1.M2.R1', moduleKey: 'A1.M2', levelCode: 'A1' },
];

const practiced = (m: Record<string, CurricularModality[]>): Map<string, Set<CurricularModality>> => {
  const map = new Map<string, Set<CurricularModality>>();
  for (const [k, v] of Object.entries(m)) map.set(k, new Set(v));
  return map;
};

describe('decidePractice', () => {
  it('does not advance until all selected modalities are practised', () => {
    const d = decidePractice({
      prefs: prefs({ writing: true, listening: true }),
      orderedSubtopics: ordered,
      practicedBySubtopic: practiced({ 'A1.M1.R1': ['writing'] }),
      previousCompleted: new Set(),
    });
    expect(d.completedNow).toEqual([]);
    expect(d.state.currentSubtopicKey).toBe('A1.M1.R1');
  });

  it('completes and advances when the last selected modality is practised', () => {
    const d = decidePractice({
      prefs: prefs({ writing: true, listening: true }),
      orderedSubtopics: ordered,
      practicedBySubtopic: practiced({ 'A1.M1.R1': ['writing', 'listening'] }),
      previousCompleted: new Set(),
    });
    expect(d.completedNow).toEqual(['A1.M1.R1']);
    expect(d.state.currentSubtopicKey).toBe('A1.M1.R2');
  });

  it('advances several recortes in one pass (multiple/day)', () => {
    const d = decidePractice({
      prefs: prefs({ writing: true }),
      orderedSubtopics: ordered,
      practicedBySubtopic: practiced({ 'A1.M1.R1': ['writing'], 'A1.M1.R2': ['writing'] }),
      previousCompleted: new Set(),
    });
    expect(d.completedNow.sort()).toEqual(['A1.M1.R1', 'A1.M1.R2']);
    expect(d.state.currentSubtopicKey).toBe('A1.M2.R1');
  });

  it('never uncompletes a past recorte when a modality is later added', () => {
    const d = decidePractice({
      prefs: prefs({ writing: true, listening: true }), // listening newly required
      orderedSubtopics: ordered,
      practicedBySubtopic: practiced({ 'A1.M1.R1': ['writing'] }), // only writing recorded
      previousCompleted: new Set(['A1.M1.R1']), // was completed under writing-only
    });
    expect(d.allCompleted.has('A1.M1.R1')).toBe(true);
    expect(d.completedNow).toEqual([]);
  });

  it('curriculum_completed when everything is done', () => {
    const d = decidePractice({
      prefs: prefs({ writing: true }),
      orderedSubtopics: ordered,
      practicedBySubtopic: practiced({ 'A1.M1.R1': ['writing'], 'A1.M1.R2': ['writing'], 'A1.M2.R1': ['writing'] }),
      previousCompleted: new Set(),
    });
    expect(d.state.status).toBe('curriculum_completed');
    expect(d.state.currentSubtopicKey).toBeNull();
  });
});
