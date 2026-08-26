/**
 * Static source assertions for the conversation LANGUAGE chooser + the new
 * pre-conversation UX: a compact summary card on the screen, a fixed bottom CTA,
 * and the "Antes de começar" setup step (BeforeStartSheet) shown on first start.
 * Node-env vitest → static source-text assertions.
 *
 * Covers required scenarios: first-use opens the setup step; the summary reflects
 * the saved choice; the chosen mode is persisted and reaches session creation;
 * the fixed CTA stays out of the scroll flow.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const viewSrc = readFileSync(resolve(__dirname, '..', 'ConversationView.tsx'), 'utf8');
const i18nSrc = readFileSync(resolve(__dirname, '..', '..', 'i18n', 'curriculumUiStrings.ts'), 'utf8');
const apiSrc = readFileSync(resolve(__dirname, '..', '..', '..', 'api', 'conversation', '[...slug].ts'), 'utf8');
const hookSrc = readFileSync(resolve(__dirname, '..', '..', 'hooks', 'useRealtimeSession.ts'), 'utf8');

const langChooser = viewSrc.slice(
  viewSrc.indexOf('function ConversationLanguageChooser'),
  viewSrc.indexOf('// ── Settings summary'),
);
const summary = viewSrc.slice(
  viewSrc.indexOf('function ConversationSettingsSummary'),
  viewSrc.indexOf('// ── "Antes de começar"'),
);
const sheet = viewSrc.slice(
  viewSrc.indexOf('function BeforeStartSheet'),
  viewSrc.indexOf('export default function ConversationView'),
);

describe('language chooser — component (generalized values)', () => {
  it('offers exactly the two generalized modes with recommendation badges', () => {
    expect(langChooser).toContain('role="radiogroup"');
    expect(langChooser).toMatch(/onClick=\{\(\) => onSelect\('target_only'\)\}/);
    expect(langChooser).toMatch(/onClick=\{\(\) => onSelect\('bilingual_support'\)\}/);
    expect(langChooser).toMatch(/badge=\{recommended === 'target_only' \? t\.conversationRecommended : null\}/);
    expect(langChooser).toMatch(/badge=\{recommended === 'bilingual_support' \? t\.conversationRecommended : null\}/);
    expect(langChooser).not.toContain('english_only');
    expect(langChooser).not.toContain('bilingual_pt_en');
  });
});

describe('pre-conversation — recommendation + effective/first-use', () => {
  it('derives the recommendation from the user CEFR level', () => {
    expect(viewSrc).toMatch(/recommendConversationLanguageMode\(focusData\?\.currentLevel \?\? hp\.cefrLevel\)/);
  });

  it('effective values are the SAVED prefs, else recommendation/guided', () => {
    expect(viewSrc).toMatch(/hp\.saved\.conversationLanguageMode \?\? recommendedLanguageMode/);
    expect(viewSrc).toMatch(/hp\.saved\.conversationSessionMode \?\? 'guided'/);
  });

  it('first use is detected from the persisted pref, not local state', () => {
    expect(viewSrc).toMatch(/const needsSetup = !hp\.conversationConfigured/);
  });
});

describe('setup step (BeforeStartSheet) — shown on first start, saves then starts', () => {
  it('the fixed CTA opens the setup step on first use, else starts directly', () => {
    expect(viewSrc).toMatch(/if \(needsSetup\) \{ setShowBeforeStart\(true\); return; \}/);
    expect(viewSrc).toMatch(/session\.start\(effectiveMode, effectiveLanguageMode\)/);
  });

  it('renders BOTH choosers as numbered sections', () => {
    expect(sheet).toContain('<ConversationLanguageChooser');
    expect(sheet).toMatch(/stepNumber=\{1\}/);
    expect(sheet).toContain('<ConversationModeChooser');
    expect(sheet).toMatch(/stepNumber=\{2\}/);
  });

  it('"Salvar e iniciar" persists BOTH prefs then starts with the chosen values', () => {
    expect(viewSrc).toMatch(/hp\.saveConversationPrefs\(\{ conversationLanguageMode: language, conversationSessionMode: mode \}\)/);
    expect(viewSrc).toMatch(/session\.start\(mode, language\)/);
    expect(sheet).toContain('onSaveAndStart(language, mode)');
  });

  it('is dismissible without starting ("Agora não")', () => {
    expect(sheet).toContain('t.conversationNotNow');
    expect(viewSrc).toMatch(/onClose=\{\(\) => setShowBeforeStart\(false\)\}/);
  });
});

describe('summary card — informative, reflects the effective choices', () => {
  it('shows the language + mode labels and the "change in Personalizar tutor" helper', () => {
    expect(summary).toContain('t.conversationSummaryLanguageLabel');
    expect(summary).toContain('t.conversationSummaryModeLabel');
    expect(summary).toContain('t.conversationSummaryHelper');
    expect(summary).toMatch(/languageMode === 'bilingual_support' \? t\.conversationLanguageBilingualTitle : t\.conversationLanguageEnglishTitle/);
    expect(summary).toMatch(/sessionMode === 'free' \? t\.conversationFreeTitle : t\.conversationGuidedTitle/);
  });

  it('shows the current focus only for guided', () => {
    expect(summary).toMatch(/sessionMode === 'guided' && currentFocus/);
  });

  it('is fed the effective (saved-or-default) values', () => {
    expect(viewSrc).toMatch(/languageMode=\{effectiveLanguageMode\}/);
    expect(viewSrc).toMatch(/sessionMode=\{effectiveMode\}/);
  });
});

describe('fixed bottom CTA', () => {
  it('is position:fixed above the safe area, outside the scroll flow', () => {
    const cta = viewSrc.slice(viewSrc.indexOf('Fixed bottom CTA'), viewSrc.indexOf('{showBeforeStart && ('));
    expect(cta).toMatch(/fixed inset-x-0 bottom-0/);
    expect(cta).toContain('env(safe-area-inset-bottom)');
    expect(cta).toContain('data-testid="conversation-start-cta"');
    expect(cta).toContain('handlePressStart');
    expect(cta).toContain('focusStrings.conversationStartCta');
  });

  it('the scroll content reserves space so nothing hides behind the CTA', () => {
    expect(viewSrc).toMatch(/paddingBottom: canStart \? 'calc\(6\.5rem \+ env\(safe-area-inset-bottom\)\)'/);
  });
});

describe('language mode — client→server + server-side freeze (unchanged pipeline)', () => {
  it('the client sends languageMode in the /session POST body', () => {
    expect(hookSrc).toMatch(/\.\.\.\(languageMode \? \{ languageMode \} : \{\}\)/);
  });

  it('the server resolves + freezes it and injects a single coherent language directive', () => {
    expect(apiSrc).toMatch(/resolveConversationLanguageMode\(\(req\.body \?\? \{\}\)\.languageMode\)/);
    expect(apiSrc).toMatch(/conversation_language_mode: languageMode/);
    // One directive fills the base template placeholder (no contradictory append).
    expect(apiSrc).toContain('resolveConversationLanguageDirective(');
    expect(apiSrc).toMatch(/conversation_language_directive: conversationLanguageDirective/);
    expect(apiSrc).not.toContain('composeConversationInstructions');
  });
});

describe('i18n chrome for the new UX (pt-BR + en)', () => {
  it('has the setup/summary strings in both languages', () => {
    expect(i18nSrc).toMatch(/conversationBeforeStartTitle:\s*'Antes de começar'/);
    expect(i18nSrc).toMatch(/conversationBeforeStartTitle:\s*'Before you start'/);
    expect(i18nSrc).toMatch(/conversationStartCta:\s*'Iniciar conversa'/);
    expect(i18nSrc).toMatch(/conversationSaveAndStart:\s*'Salvar e iniciar conversa'/);
  });
});
