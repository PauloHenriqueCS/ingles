/**
 * Static-wiring assertions for how App.tsx orchestrates the first-run tutorial:
 * the trigger gate (§7), the push-permission ordering (§10), the hardware-back
 * precedence (§6), and the replay-does-not-persist rule (§9).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const app = readFileSync(join(__dirname, '..', '..', 'App.tsx'), 'utf8');

describe('App.tsx — tutorial orchestration', () => {
  it('uses the server-persisted status hook and renders the overlay', () => {
    expect(app).toContain("import { useTutorialStatus } from './hooks/useTutorialStatus'");
    expect(app).toContain("import HomeTutorial from './components/tutorial/HomeTutorial'");
    expect(app).toMatch(/<HomeTutorial[\s\S]*onComplete=\{handleTutorialComplete\}[\s\S]*onSkip=\{handleTutorialSkip\}/);
  });

  it('auto-runs only on the real Home, once, for a pending user, not over the menu (§7)', () => {
    expect(app).toContain('tutorialAutoShownRef');
    expect(app).toMatch(/tutorialStatus === 'pending'/);
    expect(app).toMatch(/view === 'home'/);
    expect(app).toMatch(/!menuOpen/);
    expect(app).toMatch(/atHomeExperience &&/);
  });

  it('holds the native push prompt until the tutorial is settled (§10)', () => {
    // push no longer keys directly off atHomeExperience
    expect(app).toContain('usePushPermissionPrompt(readyForPush)');
    expect(app).toMatch(/readyForPush =[\s\S]*!tutorialActive[\s\S]*!tutorialShouldRun/);
    expect(app).toMatch(/tutorialShouldRun = tutorialStatus === 'pending'/);
  });

  it('gives the walkthrough priority over the Android hardware back button (§6)', () => {
    expect(app).toMatch(/if \(isTutorialActive\) \{\s*tutorialBackRef\.current\?\.\(\);\s*return;/);
    // The back-button state ref tracks tutorialActive (the study-routine gate
    // adds a sibling field after it — see study-routine-wiring.static.test.ts).
    expect(app).toMatch(/tutorialActive, studyRoutineGateActive \}\);/);
  });

  it('persists completed/skipped ONLY for a real run, never for a replay (§9)', () => {
    expect(app).toMatch(/if \(!tutorialReplay\) void completeTutorial\(\)/);
    expect(app).toMatch(/if \(!tutorialReplay\) void skipTutorial\(\)/);
    expect(app).toContain('startTutorialReplay');
    // replay routes to Home and marks the run as a replay
    expect(app).toMatch(/setTutorialReplay\(true\)/);
  });

  it('wires the replay entry point from Configurações', () => {
    expect(app).toMatch(/onReplayTutorial=\{startTutorialReplay\}/);
  });
});
