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
const moduleSrc = readFileSync(resolve(__dirname, '..', 'CurriculumModuleDetail.tsx'), 'utf8');
const i18nSrc = readFileSync(resolve(__dirname, '..', '..', 'i18n', 'curriculumUiStrings.ts'), 'utf8');

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

  it('marks the current level with an interface-language text badge (not color-only)', () => {
    // Label text is data-driven (i18n module), referenced via t.statusYourLevel.
    expect(planSrc).toMatch(/t\.statusYourLevel/);
    expect(i18nSrc).toMatch(/statusYourLevel:\s*'SEU NÍVEL'/); // pt-BR
    expect(i18nSrc).toMatch(/statusYourLevel:\s*'YOUR LEVEL'/); // en
  });

  it('spells out completed/future level states as localized text', () => {
    expect(planSrc).toMatch(/t\.statusCompleted/);
    expect(planSrc).toMatch(/t\.statusFuture/);
    expect(i18nSrc).toMatch(/statusCompleted:\s*'Concluído'/);
    expect(i18nSrc).toMatch(/statusFuture:\s*'Futuro'/);
  });

  it('never renders "A1 — A1": a redundant level name falls back to the band descriptor', () => {
    expect(planSrc).toMatch(/levelDescriptor\(/);
    expect(planSrc).toMatch(/name !== levelCode/);
  });

  it('is interface-language aware (uses curriculumUiStrings keyed by the tree interface language)', () => {
    expect(planSrc).toMatch(/curriculumUiStrings\(tree\?\.interfaceLanguage\)/);
  });

  it('clicking a level opens the level detail screen (sets selected level → renders CurriculumLevelDetail)', () => {
    expect(planSrc).toMatch(/onClick=\{\(\) => setSelectedLevelCode\(level\.levelCode\)\}/);
    expect(planSrc).toMatch(/import CurriculumLevelDetail from '\.\/CurriculumLevelDetail'/);
    expect(planSrc).toMatch(/<CurriculumLevelDetail level=\{selectedLevel\}/);
  });

  it('opening a module renders the read-only step detail (Plano → nível → módulo → etapas)', () => {
    expect(planSrc).toMatch(/import CurriculumModuleDetail from '\.\/CurriculumModuleDetail'/);
    expect(planSrc).toMatch(/setSelectedModuleKey/);
    expect(planSrc).toMatch(/<CurriculumModuleDetail /);
    // The level detail is wired to open a module (pure navigation callback).
    expect(planSrc).toMatch(/onSelectModule=\{setSelectedModuleKey\}/);
    // Back from the module clears only the local module selection (no write).
    expect(planSrc).toMatch(/onBack=\{\(\) => setSelectedModuleKey\(null\)\}/);
    // The module is derived from the CURRENT level's modules (no stale cross-level).
    expect(planSrc).toMatch(/selectedLevel\.modules\.find\(/);
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
    expect(planSrc).toMatch(/t\.curriculumCompletedTitle/);
    expect(i18nSrc).toMatch(/curriculumCompletedTitle:\s*'Currículo concluído'/);
  });

  it('no longer hosts the modality preferences — moved to the "Rotina de estudos" setup/menu (§6)', () => {
    expect(planSrc).not.toMatch(/import CurriculumModalityPreferences/);
    expect(planSrc).not.toMatch(/<CurriculumModalityPreferences/);
  });

  it('never renders recortes/subtopics or recorte counts', () => {
    expect(planSrc).not.toMatch(/recorte|subtopic|completedCount|totalCount|completedRecortes/i);
  });
});

describe('CurriculumLevelDetail.tsx — module list with step progress', () => {
  it('marks the current module "Você está aqui" (localized text, not color-only)', () => {
    expect(detailSrc).toMatch(/t\.statusYouAreHere/);
    expect(i18nSrc).toMatch(/statusYouAreHere:\s*'Você está aqui'/);
  });

  it('spells out completed/future module states as localized text', () => {
    expect(detailSrc).toMatch(/t\.statusCompleted/);
    expect(detailSrc).toMatch(/t\.statusFuture/);
  });

  it('shows each module\'s progress as friendly "X de Y etapas" (data-driven counts)', () => {
    expect(detailSrc).toMatch(/t\.stepsProgress\(mod\.completedSteps, mod\.totalSteps\)/);
    expect(i18nSrc).toMatch(/stepsProgress:/);
    expect(i18nSrc).toMatch(/etapas/); // pt-BR uses "etapas", never "recortes"
  });

  it('each module is tappable and opens the step detail (pure navigation, no write)', () => {
    expect(detailSrc).toMatch(/onClick=\{\(\) => onSelectModule\(mod\.moduleKey\)\}/);
  });

  it('renders the level band + iterates endpoint modules', () => {
    expect(detailSrc).toMatch(/level\.band/);
    expect(detailSrc).toMatch(/level\.modules\.map\(/);
    expect(detailSrc).toMatch(/mod\.title/);
    expect(detailSrc).toMatch(/mod\.status/);
  });

  it('performs NO writes and never uses technical recorte/subtopic terms', () => {
    expect(detailSrc).not.toMatch(/fetch\(|updateCurriculum|apiFetch/);
    expect(detailSrc).not.toMatch(/recorte|subtopic/i);
  });
});

describe('CurriculumModuleDetail.tsx — read-only steps (etapas) for one module', () => {
  it('shows the "X de Y etapas concluídas" summary and the "Etapas" label', () => {
    expect(moduleSrc).toMatch(/t\.stepsCompletedCount\(module\.completedSteps, module\.totalSteps\)/);
    expect(moduleSrc).toMatch(/t\.stepsLabel/);
    expect(i18nSrc).toMatch(/stepsLabel:\s*'Etapas'/);
  });

  it('lists endpoint steps with localized status labels (Atual / Concluída / Futuro)', () => {
    expect(moduleSrc).toMatch(/module\.steps\.map\(/);
    expect(moduleSrc).toMatch(/t\.stepCurrent/);
    expect(moduleSrc).toMatch(/t\.stepCompleted/);
    expect(moduleSrc).toMatch(/t\.stepFuture/);
    expect(i18nSrc).toMatch(/stepCurrent:\s*'Atual'/);
    expect(i18nSrc).toMatch(/stepCompleted:\s*'Concluída'/);
  });

  it('is READ-ONLY: no write, and steps are not interactive (only the back button clicks)', () => {
    expect(moduleSrc).not.toMatch(/fetch\(|updateCurriculum|apiFetch/);
    // The ONLY onClick in the screen is the header back button — a future step
    // click can never write because steps render as static rows.
    expect((moduleSrc.match(/onClick/g) || []).length).toBe(1);
    expect(moduleSrc).toMatch(/onClick=\{onBack\}/);
  });

  it('never exposes recorte/subtopic technical terms; the React key is the opaque step id', () => {
    expect(moduleSrc).not.toMatch(/recorte|subtopic|subtopic_key/i);
    expect(moduleSrc).toMatch(/key=\{step\.id\}/);
    expect(moduleSrc).toMatch(/t\.backToModules/);
    expect(i18nSrc).toMatch(/backToModules:/);
  });
});
