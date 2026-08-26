/**
 * Static source assertions for the conversation LANGUAGE chooser (English-only
 * vs Bilingual PT+EN). This repo has no DOM/component harness (vitest env is
 * 'node'), so behavior + layout are proven with static source-text assertions
 * on the declarative JSX, the i18n table, and the API session handler.
 *
 * Maps to the required scenarios:
 *  - A1/A2 see bilingual recommended; B1/B2/C1/C2 see English recommended
 *    (recommendation is level-derived; the rule itself is unit-tested in
 *    src/domain/conversation/__tests__/conversationLanguageMode.test.ts).
 *  - Either option is selectable; the Start button passes the chosen mode.
 *  - The last choice is loaded and pre-selects the chooser.
 *  - The chooser appears only before a NEW session (canStart), never mid-session.
 *  - The chosen mode is frozen server-side on the authorization row.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const viewSrc = readFileSync(resolve(__dirname, '..', 'ConversationView.tsx'), 'utf8');
const i18nSrc = readFileSync(resolve(__dirname, '..', '..', 'i18n', 'curriculumUiStrings.ts'), 'utf8');
const apiSrc = readFileSync(resolve(__dirname, '..', '..', '..', 'api', 'conversation', '[...slug].ts'), 'utf8');

// Narrow to the language chooser component.
const chooser = viewSrc.slice(
  viewSrc.indexOf('// ── Language chooser (English-only'),
  viewSrc.indexOf('export default function ConversationView'),
);

describe('language chooser — options + recommendation', () => {
  it('offers exactly the two modes as radio rows', () => {
    expect(chooser).toContain('role="radiogroup"');
    expect(chooser).toMatch(/onClick=\{\(\) => onSelect\('english_only'\)\}/);
    expect(chooser).toMatch(/onClick=\{\(\) => onSelect\('bilingual_pt_en'\)\}/);
  });

  it('badges the recommended option (either can be recommended; never blocks)', () => {
    expect(chooser).toMatch(/badge=\{recommended === 'english_only' \? t\.conversationRecommended : null\}/);
    expect(chooser).toMatch(/badge=\{recommended === 'bilingual_pt_en' \? t\.conversationRecommended : null\}/);
  });

  it('derives the recommendation from the user CEFR level', () => {
    expect(viewSrc).toMatch(/recommendConversationLanguageMode\(focusData\?\.currentLevel \?\? null\)/);
  });

  it('the effective mode is the saved/clicked choice, else the recommendation', () => {
    expect(viewSrc).toMatch(/selectedLanguageMode \?\? recommendedLanguageMode/);
  });
});

describe('language chooser — selection + start behavior', () => {
  it('clicking an option updates the selected language mode', () => {
    expect(viewSrc).toMatch(/onSelect=\{setSelectedLanguageMode\}/);
  });

  it('starting the session passes the effective language mode', () => {
    expect(viewSrc).toMatch(/session\.start\(effectiveMode, effectiveLanguageMode\)/);
  });

  it('remembers the choice for next time on start', () => {
    expect(viewSrc).toMatch(/saveLastConversationLanguageMode\(effectiveLanguageMode\)/);
  });

  it('loads the last saved choice on mount to pre-select the chooser', () => {
    expect(viewSrc).toContain('loadLastConversationLanguageMode()');
    expect(viewSrc).toMatch(/setSelectedLanguageMode\(m\)/);
  });
});

describe('language chooser — shown only before a NEW session', () => {
  it('is rendered inside the canStart block (idle/ended/error), not during an active call', () => {
    const canStartBlock = viewSrc.slice(viewSrc.indexOf('{canStart && ('), viewSrc.indexOf('{/* ── Personalizar tutor'));
    expect(canStartBlock).toContain('<ConversationLanguageChooser');
  });
});

describe('language chooser — i18n chrome (both languages, no PT leak in JSX)', () => {
  it('has the chooser title + option titles/descriptions in pt-BR and en', () => {
    expect(i18nSrc).toMatch(/conversationLanguageChooserTitle:\s*'Idioma da conversa'/);
    expect(i18nSrc).toMatch(/conversationLanguageChooserTitle:\s*'Conversation language'/);
    expect(i18nSrc).toMatch(/conversationLanguageEnglishTitle:\s*'Inglês'/);
    expect(i18nSrc).toMatch(/conversationLanguageEnglishTitle:\s*'English'/);
    expect(i18nSrc).toMatch(/conversationLanguageBilingualTitle:\s*'Português \+ Inglês'/);
    expect(i18nSrc).toMatch(/conversationLanguageBilingualTitle:\s*'Portuguese \+ English'/);
  });

  it('renders chrome via the i18n table (no hardcoded pt-BR literal in the JSX)', () => {
    expect(chooser).toContain('t.conversationLanguageChooserTitle');
    expect(chooser).toContain('t.conversationLanguageEnglishTitle');
    expect(chooser).toContain('t.conversationLanguageBilingualTitle');
    expect(chooser).not.toContain('Português + Inglês');
  });
});

describe('language mode — client→server + server-side freeze', () => {
  it('the client sends languageMode in the /session POST body', () => {
    const hookSrc = readFileSync(resolve(__dirname, '..', '..', 'hooks', 'useRealtimeSession.ts'), 'utf8');
    expect(hookSrc).toMatch(/\.\.\.\(languageMode \? \{ languageMode \} : \{\}\)/);
  });

  it('the server resolves it and FREEZES it on the authorization row (identityCols)', () => {
    expect(apiSrc).toMatch(/resolveConversationLanguageMode\(\(req\.body \?\? \{\}\)\.languageMode\)/);
    expect(apiSrc).toMatch(/conversation_language_mode: languageMode/);
  });

  it('the server only appends the bilingual directive (english_only left unchanged)', () => {
    expect(apiSrc).toMatch(/languageMode === 'bilingual_pt_en'/);
    expect(apiSrc).toContain('applyConversationLanguageMode(instructions, languageMode');
  });
});
