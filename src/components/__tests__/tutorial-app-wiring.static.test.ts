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

  it('gates the trigger on the placement-released Home signal (§7)', () => {
    // develop does not carry the push-permission-prompt feature (main-only), so
    // there is no push gating to wire here — the tutorial reuses atHomeExperience.
    expect(app).toMatch(/atHomeExperience = !!user && !authLoading && !loading && placementReleased/);
    expect(app).not.toContain('usePushPermissionPrompt');
  });

  it('gives the walkthrough priority over the Android hardware back button (§6)', () => {
    expect(app).toMatch(/if \(isTutorialActive\) \{\s*tutorialBackRef\.current\?\.\(\);\s*return;/);
    expect(app).toContain('tutorialActive });');
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
