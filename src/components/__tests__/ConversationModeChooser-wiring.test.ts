/**
 * Static source assertions for the Guided/Free conversation chooser UX.
 *
 * This repo has no DOM/component harness (vitest env is 'node', no
 * @testing-library/react — see CurriculumPlanView-wiring.test.ts), so the
 * chooser's behavior + layout are proven with static source-text assertions on
 * the declarative JSX and the i18n table.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const viewSrc = readFileSync(resolve(__dirname, '..', 'ConversationView.tsx'), 'utf8');
const i18nSrc = readFileSync(resolve(__dirname, '..', '..', 'i18n', 'curriculumUiStrings.ts'), 'utf8');

// Narrow to the chooser components so assertions can't accidentally match
// unrelated JSX elsewhere in the (large) view.
const chooser = viewSrc.slice(
  viewSrc.indexOf('// ── Guided vs Free chooser'),
  viewSrc.indexOf('export default function ConversationView'),
);

describe('conversation mode chooser — default & recommendation rule', () => {
  it('defaults the pre-selection to Guided (user can switch to Free)', () => {
    expect(viewSrc).toMatch(/const defaultMode: 'guided' \| 'free' = 'guided'/);
    expect(viewSrc).toMatch(/const effectiveMode:[^\n]*selectedMode \?\? defaultMode/);
  });

  it('recommends (badges) GUIDED only when Conversation is in the plan', () => {
    expect(viewSrc).toMatch(/recommendGuided=\{conversationInPlan\}/);
    // Guided row: badge iff recommendGuided; Free row: never a badge.
    expect(chooser).toMatch(/badge=\{recommendGuided \? t\.conversationRecommended : null\}/);
  });

  it('FREE never carries the Recomendado badge', () => {
    // The free ModeOptionRow passes badge={null} explicitly.
    const freeRow = chooser.slice(chooser.indexOf('conversationFreeTitle'));
    expect(freeRow).toMatch(/badge=\{null\}/);
    // And there is no `recommended === 'free'`-style path granting free a badge.
    expect(chooser).not.toMatch(/recommended === 'free'/);
  });
});

describe('conversation mode chooser — selection + start behavior', () => {
  it('clicking an option updates the selected mode', () => {
    expect(chooser).toMatch(/onClick=\{\(\) => onSelect\('guided'\)\}/);
    expect(chooser).toMatch(/onClick=\{\(\) => onSelect\('free'\)\}/);
    expect(viewSrc).toMatch(/onSelect=\{setSelectedMode\}/);
  });

  it('starting the session uses the SELECTED (effective) mode', () => {
    // Now also carries the effective language mode as a second argument.
    expect(viewSrc).toMatch(/session\.start\(effectiveMode, effectiveLanguageMode\)/);
  });

  it('the guided option shows the localized current focus (never a technical key)', () => {
    expect(chooser).toMatch(/sub=\{currentFocus \? t\.conversationFocusLabel\(currentFocus\) : null\}/);
    // currentFocus comes from the localized progress field, not a subtopic key.
    expect(viewSrc).toMatch(/const currentFocus = focusData\?\.currentFocus/);
    expect(viewSrc).not.toMatch(/subtopic_key|currentSubtopicKey|\.subtopicKey/);
  });
});

describe('conversation mode chooser — mobile-first stacked layout (no two columns)', () => {
  it('uses a stacked radiogroup, not a two-column grid/row', () => {
    expect(chooser).toContain('role="radiogroup"');
    expect(chooser).toMatch(/className="space-y-2\.5"/); // stacked
    // The options container is NOT a two-column grid or a side-by-side flex row.
    expect(chooser).not.toMatch(/grid-cols-2/);
    expect(chooser).not.toMatch(/className="flex gap-2\.5"/);
  });

  it('each option is a full-width row with a radio indicator', () => {
    expect(chooser).toContain('role="radio"');
    expect(chooser).toMatch(/aria-checked=\{active\}/);
    expect(chooser).toMatch(/w-full/);
  });

  it('selection differs only subtly — same treatment for both, color is not the recommendation', () => {
    // A light tint + blue border when active; neutral otherwise. No saturated
    // full-card blue for the active option.
    expect(chooser).toMatch(/border-blue-500 bg-blue-500\/10/);
    expect(chooser).not.toMatch(/bg-blue-950\/40/); // the old saturated look is gone
  });
});

describe('conversation chooser — i18n chrome (both languages, no PT leak)', () => {
  it('has the chooser title, guided/free titles and descriptions in pt-BR and en', () => {
    expect(i18nSrc).toMatch(/conversationChooserTitle:\s*'Como você quer conversar\?'/);
    expect(i18nSrc).toMatch(/conversationChooserTitle:\s*'How do you want to talk\?'/);
    expect(i18nSrc).toMatch(/conversationGuidedTitle:\s*'Conversa guiada'/);
    expect(i18nSrc).toMatch(/conversationGuidedTitle:\s*'Guided conversation'/);
    expect(i18nSrc).toMatch(/conversationFreeTitle:\s*'Conversa livre'/);
    expect(i18nSrc).toMatch(/conversationRecommended:\s*'Recomendado'/);
    expect(i18nSrc).toMatch(/conversationRecommended:\s*'Recommended'/);
  });

  it('renders chrome via the i18n table (no hardcoded pt-BR literals in the chooser)', () => {
    expect(chooser).toContain('t.conversationChooserTitle');
    expect(chooser).toContain('t.conversationGuidedTitle');
    expect(chooser).toContain('t.conversationFreeTitle');
    expect(chooser).toContain('t.conversationRecommended');
    // No hardcoded pt-BR JSX text literal for the titles.
    expect(chooser).not.toContain('Conversa guiada');
    expect(chooser).not.toContain('Conversa livre');
  });
});

describe('conversation tutor card — de-duplicated, still personalizable', () => {
  it('shows a single compact preferences line (no duplicated voice/pace chips)', () => {
    expect(viewSrc).toMatch(/const prefsLine =/);
    expect(viewSrc).not.toContain('<SummaryChips'); // the redundant chips block is gone
  });

  it('keeps the tutor personalization entry points (compact line + the button)', () => {
    // Tapping the prefs line opens the sheet…
    expect(viewSrc).toMatch(/onClick=\{\(\) => setShowSheet\(true\)\}/);
    // …and the explicit "Personalizar tutor" button is preserved.
    expect(viewSrc).toContain('Personalizar tutor');
  });
});
