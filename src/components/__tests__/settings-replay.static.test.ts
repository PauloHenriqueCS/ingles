/**
 * Configurações must offer a discreet "Ver tutorial novamente" (§9) that triggers
 * the replay callback — shown only when the host provides it (so the section is
 * additive and never breaks the existing Conta-only Settings screen).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const settings = readFileSync(join(__dirname, '..', 'SettingsView.tsx'), 'utf8');

describe('SettingsView — replay tutorial', () => {
  it('accepts an optional onReplayTutorial and renders the section only when present', () => {
    expect(settings).toMatch(/onReplayTutorial\?: \(\) => void/);
    expect(settings).toMatch(/\{onReplayTutorial && \(/);
  });

  it('has a discreet "Ver tutorial novamente" button wired to the callback', () => {
    expect(settings).toContain('Ver tutorial novamente');
    expect(settings).toContain('data-testid="settings-replay-tutorial"');
    expect(settings).toContain('onClick={onReplayTutorial}');
  });
});
