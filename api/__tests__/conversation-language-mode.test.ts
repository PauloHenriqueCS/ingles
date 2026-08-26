/**
 * Server-authoritative resolution of the conversation LANGUAGE mode and the
 * bilingual tutor directive it produces. The client sends only an enum; the
 * prose is authored server-side. english_only must leave base instructions
 * byte-for-byte unchanged (preserve current English behavior); bilingual_pt_en
 * appends a scoped override that keeps English as the language being produced.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveConversationLanguageMode,
  buildBilingualDirective,
  applyConversationLanguageMode,
  isConversationLanguageMode,
  DEFAULT_CONVERSATION_LANGUAGE_MODE,
} from '../conversation/_language-mode';

describe('resolveConversationLanguageMode', () => {
  it('honors an explicit english_only', () => {
    expect(resolveConversationLanguageMode('english_only')).toBe('english_only');
  });

  it('honors an explicit bilingual_pt_en', () => {
    expect(resolveConversationLanguageMode('bilingual_pt_en')).toBe('bilingual_pt_en');
  });

  it('falls back to english_only when absent (older clients / legacy rows)', () => {
    expect(resolveConversationLanguageMode(undefined)).toBe('english_only');
    expect(resolveConversationLanguageMode(null)).toBe('english_only');
    expect(DEFAULT_CONVERSATION_LANGUAGE_MODE).toBe('english_only');
  });

  it('ignores an unknown value and falls back to english_only', () => {
    expect(resolveConversationLanguageMode('portuguese')).toBe('english_only');
    expect(resolveConversationLanguageMode(42)).toBe('english_only');
    expect(resolveConversationLanguageMode({})).toBe('english_only');
  });

  it('type guard accepts only the two known modes', () => {
    expect(isConversationLanguageMode('english_only')).toBe(true);
    expect(isConversationLanguageMode('bilingual_pt_en')).toBe(true);
    expect(isConversationLanguageMode('bilingual')).toBe(false);
  });
});

describe('applyConversationLanguageMode — english_only is unchanged', () => {
  it('returns the base instructions verbatim for english_only (no PT introduced)', () => {
    const base = 'You are a tutor. Speak in English. Correction explanations may be given in Portuguese.';
    const out = applyConversationLanguageMode(base, 'english_only', {
      targetLabel: 'inglês', supportLabel: 'português', cefrLevel: 'A1',
    });
    expect(out).toBe(base);
  });
});

describe('applyConversationLanguageMode — bilingual_pt_en appends an override', () => {
  const base = 'You are a tutor. Responda SEMPRE em inglês.';
  const out = applyConversationLanguageMode(base, 'bilingual_pt_en', {
    targetLabel: 'inglês', supportLabel: 'português', cefrLevel: 'A1',
  });

  it('keeps the base and appends (never replaces)', () => {
    expect(out.startsWith(base)).toBe(true);
    expect(out.length).toBeGreaterThan(base.length);
  });

  it('explicitly overrides the "always English" rule', () => {
    expect(out).toMatch(/ATUALIZAÇÃO DA REGRA DE IDIOMA/i);
    expect(out).toContain('AJUSTADA');
  });
});

describe('buildBilingualDirective — encodes the pedagogical rules', () => {
  const d = buildBilingualDirective({ targetLabel: 'inglês', supportLabel: 'português', cefrLevel: 'B1' });

  it('states the goal is to PRODUCE the target language, support language is auxiliary', () => {
    expect(d).toMatch(/PRODUZIR inglês/);
    expect(d).toMatch(/português é apoio/i);
  });

  it('covers "não entendi" → explain in support language then steer back to target', () => {
    expect(d).toMatch(/não entendeu/i);
    expect(d).toMatch(/reconduza o aluno a responder em inglês/i);
  });

  it('covers "como eu falo X?" → give the expression in the target language and encourage its use', () => {
    expect(d).toMatch(/como eu falo X/i);
    expect(d).toMatch(/forneça a expressão em inglês/i);
  });

  it('keeps corrections in the target language', () => {
    expect(d).toMatch(/forma correta em inglês/i);
  });

  it('never turns the activity fully into the support language', () => {
    expect(d).toMatch(/nunca conduza a atividade inteira em português/i);
  });

  it('adapts to level: A1/A2 get simpler, shorter guidance', () => {
    const beginner = buildBilingualDirective({ targetLabel: 'inglês', supportLabel: 'português', cefrLevel: 'A1' });
    const advanced = buildBilingualDirective({ targetLabel: 'inglês', supportLabel: 'português', cefrLevel: 'C1' });
    expect(beginner).toMatch(/frases curtas e simples/i);
    expect(advanced).toMatch(/reduza progressivamente a dependência/i);
  });

  it('is parameterized by the resolved language labels (not brittle-hardcoded)', () => {
    const es = buildBilingualDirective({ targetLabel: 'English', supportLabel: 'Spanish', cefrLevel: 'A2' });
    expect(es).toContain('Spanish');
    expect(es).toContain('English');
  });
});
