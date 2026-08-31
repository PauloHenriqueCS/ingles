/**
 * Static-wiring assertions for the mandatory "Rotina de estudos" setup:
 *  - App.tsx sequences the gate AFTER the tutorial settles and BEFORE the Home,
 *    server-persisted, back-owned (§1/§3);
 *  - the config is REMOVED from the Calendar and the Plano de Ensino (§6);
 *  - the menu gains a "Rotina de estudos" entry (§5);
 *  - NOTHING permanent is added to the Home (§7).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (...p: string[]) => readFileSync(join(__dirname, '..', '..', ...p), 'utf8');

const app = read('App.tsx');
const menu = read('components', 'HamburgerMenu.tsx');
const month = read('components', 'MonthView.tsx');
const plan = read('components', 'CurriculumPlanView.tsx');
const home = read('components', 'HomePage.tsx');

describe('App.tsx — mandatory study-routine gate (§1/§3)', () => {
  it('uses the server-persisted status hook and the onboarding + menu components', () => {
    expect(app).toContain("import { useStudyRoutineStatus } from './hooks/useStudyRoutineStatus'");
    expect(app).toContain("import StudyRoutineOnboarding from './components/studyRoutine/StudyRoutineOnboarding'");
    expect(app).toContain("import StudyRoutineView from './components/studyRoutine/StudyRoutineView'");
  });

  it('fires the gate ONLY after the tutorial has settled and only for an unconfigured user', () => {
    expect(app).toMatch(/tutorialSettled\s*=\s*\n?\s*!tutorialLoading && tutorialStatus !== 'pending' && !tutorialActive/);
    expect(app).toMatch(/studyRoutineGateActive\s*=\s*\n?\s*atHomeExperience && tutorialSettled && studyRoutineStatus === 'unconfigured'/);
  });

  it('renders the full-screen gate before the Home is released', () => {
    expect(app).toMatch(/if \(studyRoutineGateActive\) \{[\s\S]*<StudyRoutineOnboarding[\s\S]*onComplete=\{handleStudyRoutineComplete\}/);
  });

  it('gives the gate priority over the Android hardware back button (§3)', () => {
    expect(app).toMatch(/if \(isRoutineGate\) \{\s*studyRoutineBackRef\.current\?\.\(\);\s*return;/);
    expect(app).toContain('studyRoutineGateActive });');
  });

  it('persists completion to the server on finish (survives reload/reinstall)', () => {
    expect(app).toMatch(/async function handleStudyRoutineComplete\(\)[\s\S]*await markStudyRoutineConfigured\(\)/);
  });

  it('exposes the editable version through the menu route', () => {
    expect(app).toMatch(/view === 'study-routine'[\s\S]*<StudyRoutineView/);
  });
});

describe('Menu (§5)', () => {
  it('adds a "Rotina de estudos" entry pointing at the study-routine view', () => {
    expect(menu).toMatch(/view: 'study-routine',\s*label: 'Rotina de estudos'/);
  });
});

describe('Calendar (§6) — "Dias de prática" removed, calendar still works', () => {
  it('drops the practice-days config block and its persistence from the Calendar', () => {
    expect(month).not.toContain('Dias de prática');
    expect(month).not.toContain('saveLearningSettings');
    expect(month).not.toContain('onSettingsChange');
  });

  it('still reads activeWeekdays to grey out non-practice days (unchanged logic)', () => {
    expect(month).toContain('activeWeekdays.includes(dow)');
  });
});

describe('Plano de Ensino (§6) — "Práticas do seu plano" removed', () => {
  it('no longer imports or mounts the modality preferences there', () => {
    expect(plan).not.toContain("import CurriculumModalityPreferences");
    expect(plan).not.toContain('<CurriculumModalityPreferences');
  });
});

describe('Home (§7) — nothing permanent added', () => {
  it('does not reference the study-routine config anywhere on the Home', () => {
    expect(home).not.toContain('study-routine');
    expect(home).not.toContain('Rotina de estudos');
    expect(home).not.toContain('StudyRoutine');
  });
});
