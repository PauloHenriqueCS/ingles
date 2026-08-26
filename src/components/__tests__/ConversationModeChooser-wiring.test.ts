/**
 * Static source assertions for the Guided/Free conversation chooser. The chooser
 * now lives inside the "Antes de começar" setup step (BeforeStartSheet), not the
 * always-visible screen — the main screen shows a compact summary and a fixed
 * CTA. This repo has no DOM/component harness (vitest env is 'node'), so behavior
 * + layout are proven with static source-text assertions.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const viewSrc = readFileSync(resolve(__dirname, '..', 'ConversationView.tsx'), 'utf8');
const i18nSrc = readFileSync(resolve(__dirname, '..', '..', 'i18n', 'curriculumUiStrings.ts'), 'utf8');

// The ConversationModeChooser component body.
const modeChooser = viewSrc.slice(
  viewSrc.indexOf('function ConversationModeChooser'),
  viewSrc.indexOf('// ── Settings summary'),
);
// The setup sheet body.
const sheet = viewSrc.slice(
  viewSrc.indexOf('function BeforeStartSheet'),
  viewSrc.indexOf('export default function ConversationView'),
);

describe('conversation mode chooser — component', () => {
  it('recommends (badges) GUIDED only when Conversation is in the plan; FREE never', () => {
    expect(modeChooser).toMatch(/badge=\{recommendGuided \? t\.conversationRecommended : null\}/);
    const freeRow = modeChooser.slice(modeChooser.indexOf('conversationFreeTitle'));
    expect(freeRow).toMatch(/badge=\{null\}/);
    expect(modeChooser).not.toMatch(/recommended === 'free'/);
  });

  it('clicking an option calls onSelect with guided/free', () => {
    expect(modeChooser).toMatch(/onClick=\{\(\) => onSelect\('guided'\)\}/);
    expect(modeChooser).toMatch(/onClick=\{\(\) => onSelect\('free'\)\}/);
  });

  it('the guided option shows the localized current focus (never a technical key)', () => {
    expect(modeChooser).toMatch(/sub=\{currentFocus \? t\.conversationFocusLabel\(currentFocus\) : null\}/);
    expect(viewSrc).toMatch(/const currentFocus = focusData\?\.currentFocus/);
    expect(viewSrc).not.toMatch(/subtopic_key|currentSubtopicKey|\.subtopicKey/);
  });

  it('uses a stacked radiogroup, not a two-column grid', () => {
    expect(modeChooser).toContain('role="radiogroup"');
    expect(modeChooser).toMatch(/className="space-y-2\.5"/);
    expect(modeChooser).not.toMatch(/grid-cols-2/);
  });
});

describe('conversation mode — default + where it is chosen', () => {
  it('the effective mode defaults to Guided (saved pref, else guided)', () => {
    expect(viewSrc).toMatch(/hp\.saved\.conversationSessionMode \?\? 'guided'/);
  });

  it('the chooser is rendered inside the setup step with a numbered badge (not inline on the screen)', () => {
    expect(sheet).toContain('<ConversationModeChooser');
    expect(sheet).toMatch(/stepNumber=\{2\}/);
  });

  it('starting a session passes the effective mode (setup path and direct path)', () => {
    expect(viewSrc).toMatch(/session\.start\(effectiveMode, effectiveLanguageMode\)/); // direct (already configured)
    expect(viewSrc).toMatch(/session\.start\(mode, language\)/);                        // after "Salvar e iniciar"
  });
});

describe('conversation chooser — i18n chrome (both languages, no PT leak)', () => {
  it('has the chooser titles/labels in pt-BR and en', () => {
    expect(i18nSrc).toMatch(/conversationChooserTitle:\s*'Como você quer conversar\?'/);
    expect(i18nSrc).toMatch(/conversationChooserTitle:\s*'How do you want to talk\?'/);
    expect(i18nSrc).toMatch(/conversationGuidedTitle:\s*'Conversa guiada'/);
    expect(i18nSrc).toMatch(/conversationRecommended:\s*'Recomendado'/);
  });

  it('renders chrome via the i18n table (no hardcoded pt-BR literals in the chooser)', () => {
    expect(modeChooser).toContain('t.conversationChooserTitle');
    expect(modeChooser).toContain('t.conversationGuidedTitle');
    expect(modeChooser).not.toContain('Conversa guiada');
  });
});
