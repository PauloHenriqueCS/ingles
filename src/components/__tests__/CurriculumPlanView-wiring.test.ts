/**
 * Static source assertions on the "Plano de ensino" components
 * (CurriculumPlanView.tsx + CurriculumLevelDetail.tsx).
 *
 * This repo has no DOM/component test harness (vitest environment is 'node',
 * no @testing-library/react — see RewriteSection-wiring.test.ts), so UI wiring
 * is proven with static source-text assertions. The data logic these screens
 * render is covered separately in curriculum-tree-derivation.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const planSrc = readFileSync(resolve(__dirname, '..', 'CurriculumPlanView.tsx'), 'utf8');
const detailSrc = readFileSync(resolve(__dirname, '..', 'CurriculumLevelDetail.tsx'), 'utf8');

describe('CurriculumPlanView.tsx — data-driven levels list', () => {
  it('loads the plan from the data-driven endpoint (getCurriculumTree), not a hardcoded array', () => {
    expect(planSrc).toMatch(/import \{[\s\S]*getCurriculumTree[\s\S]*\} from '\.\.\/lib\/curriculumApi'/);
    expect(planSrc).toMatch(/getCurriculumTree\(\)/);
  });

  it('renders ALL levels by mapping over the endpoint tree (no hardcoded A1..C2 list)', () => {
    expect(planSrc).toMatch(/tree\.levels\.map\(/);
    // No hardcoded CEFR ladder literal in the component.
    expect(planSrc).not.toMatch(/\[\s*'A1'\s*,\s*'A2'\s*,\s*'B1'/);
  });

  it('marks the current level with a text badge (SEU NÍVEL), not color-only', () => {
    expect(planSrc).toMatch(/SEU NÍVEL/);
    expect(planSrc).toMatch(/current:\s*\{[\s\S]*label:\s*'SEU NÍVEL'/);
  });

  it('spells out completed/future level states as text (Concluído / Futuro)', () => {
    expect(planSrc).toMatch(/label:\s*'Concluído'/);
    expect(planSrc).toMatch(/label:\s*'Futuro'/);
  });

  it('clicking a level opens the level detail screen (sets selected level → renders CurriculumLevelDetail)', () => {
    expect(planSrc).toMatch(/onClick=\{\(\) => setSelectedLevelCode\(level\.levelCode\)\}/);
    expect(planSrc).toMatch(/import CurriculumLevelDetail from '\.\/CurriculumLevelDetail'/);
    expect(planSrc).toMatch(/<CurriculumLevelDetail level=\{selectedLevel\}/);
  });

  it('is read-only: no progress mutation and no level selector are wired in', () => {
    expect(planSrc).not.toMatch(/updateCurriculum(Progress|Level)/);
    expect(planSrc).not.toMatch(/setLevel\(|selectLevel\(|advance/i);
  });

  it('opening a level never mutates — the detail onBack only clears the local selection', () => {
    expect(planSrc).toMatch(/onBack=\{\(\) => setSelectedLevelCode\(null\)\}/);
  });

  it('handles curriculum_completed with a concluded message and no reset', () => {
    expect(planSrc).toMatch(/curriculum_completed/);
    expect(planSrc).toMatch(/Currículo concluído/);
  });

  it('keeps the modality preferences accessible from the plan', () => {
    expect(planSrc).toMatch(/import CurriculumModalityPreferences from '\.\/CurriculumModalityPreferences'/);
    expect(planSrc).toMatch(/<CurriculumModalityPreferences \/>/);
  });

  it('never renders recortes/subtopics or recorte counts', () => {
    expect(planSrc).not.toMatch(/recorte|subtopic|completedCount|totalCount|completedRecortes/i);
  });
});

describe('CurriculumLevelDetail.tsx — read-only module list for one level', () => {
  it('marks the current module "Você está aqui" (text, not color-only)', () => {
    expect(detailSrc).toMatch(/current:\s*\{[\s\S]*label:\s*'Você está aqui'/);
  });

  it('spells out completed/future module states as text', () => {
    expect(detailSrc).toMatch(/completed:\s*\{[\s\S]*label:\s*'Concluído'/);
    expect(detailSrc).toMatch(/future:\s*\{[\s\S]*label:\s*'Futuro'/);
  });

  it('renders the level band label from the endpoint', () => {
    expect(detailSrc).toMatch(/level\.band/);
  });

  it('iterates the modules provided by the endpoint (level.modules)', () => {
    expect(detailSrc).toMatch(/level\.modules\.map\(/);
    expect(detailSrc).toMatch(/mod\.title/);
    expect(detailSrc).toMatch(/mod\.status/);
  });

  it('performs NO writes and exposes NO recortes/subtopics or counts', () => {
    expect(detailSrc).not.toMatch(/fetch\(|updateCurriculum|apiFetch/);
    expect(detailSrc).not.toMatch(/recorte|subtopic|completedCount|totalCount/i);
  });
});
