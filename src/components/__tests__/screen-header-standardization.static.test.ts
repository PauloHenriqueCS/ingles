/**
 * Standardized internal header (problems 8 & 12): every internal screen uses the
 * single shared ScreenHeader (back arrow + Orodim logo + safe-area), and App
 * shows the global chrome header only for top-level views so activity screens
 * never stack two bars. Static-wiring assertions per this repo's convention.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');

const screenHeaderSrc = read('ScreenHeader.tsx');
const appSrc = readFileSync(join(__dirname, '..', '..', 'App.tsx'), 'utf8');

describe('ScreenHeader is the shared, notch-safe, back+logo bar', () => {
  it('renders a back button, the Orodim logo, and handles the safe-area inset', () => {
    expect(screenHeaderSrc).toContain('ArrowLeft');
    expect(screenHeaderSrc).toContain('/brand/lemon-logo.png');
    expect(screenHeaderSrc).toContain('env(safe-area-inset-top)');
    expect(screenHeaderSrc).toContain('h-14'); // same height as the global AppHeader
  });
});

describe('every internal activity screen uses ScreenHeader (no bespoke bars)', () => {
  for (const file of ['DayView.tsx', 'ConversationView.tsx', 'ListeningView.tsx', 'PronunciationTrainingView.tsx', 'ErrorReviewView.tsx']) {
    it(`${file} imports and renders ScreenHeader`, () => {
      const src = read(file);
      expect(src).toContain("from './ScreenHeader'");
      expect(src).toMatch(/<ScreenHeader/);
      // the old ad-hoc "←" glyph button is gone from these screens
      expect(src).not.toContain('>←<');
    });
  }

  it('Escrita keeps the header across every sub-state (it is outside the conditional content)', () => {
    const src = read('DayView.tsx');
    const headerIdx = src.indexOf('<ScreenHeader');
    const contentIdx = src.indexOf('flex-1 overflow-auto');
    expect(headerIdx).toBeGreaterThan(0);
    expect(headerIdx).toBeLessThan(contentIdx); // header precedes (and is not nested in) the conditional body
  });
});

describe('App shows the global chrome header only for top-level views', () => {
  it('activity views render their own header instead of the global one', () => {
    expect(appSrc).toMatch(/const usesOwnHeader\s*=/);
    expect(appSrc).toContain("view === 'conversation'");
    expect(appSrc).toContain('{!usesOwnHeader && (');
    // the content offset is dropped when the screen owns its (sticky) header
    expect(appSrc).toMatch(/usesOwnHeader \? undefined :/);
  });

  it('Conversation now has a wired back affordance', () => {
    expect(appSrc).toMatch(/view === 'conversation'[\s\S]{0,200}onBack=\{\(\) => setView\('home'\)\}/);
  });
});
