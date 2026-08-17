/**
 * Semantic validation for NORMAL (curriculum) writing missions. A parsed JSON
 * is NOT automatically a valid mission — an empty/partial mission must be
 * rejected so the retry loop tries again and, worst case, an operational error
 * is returned instead of an empty "Missão do dia" card ever reaching the user.
 */
import { describe, it, expect } from 'vitest';
import { normalizeTheme, validateNormalTheme } from '../generate-theme';

// A complete, valid AI object.
function validParsed(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Um recado para um amigo',
    missionSetup: 'Você vai encontrar um amigo neste fim de semana.',
    missionTask: 'Escreva uma mensagem curta combinando o horário e o lugar.',
    format: 'mensagem',
    context: 'vida cotidiana',
    objective: 'combinar um encontro',
    difficulty: 'easy',
    estimatedTimeMinutes: 12,
    requiredGrammar: ['presente simples'],
    suggestedVocabulary: ['meet', 'weekend'],
    useTheseWords: ['meet'],
    instructions: ['Cumprimente o amigo', 'Proponha um horário'],
    ...overrides,
  };
}

describe('validateNormalTheme', () => {
  it('accepts a complete, semantically valid mission', () => {
    const theme = normalizeTheme(validParsed());
    expect(validateNormalTheme(theme)).toBeNull();
  });

  it('rejects JSON that parsed but carries NO mission (missionSetup/missionTask/mission empty)', () => {
    const theme = normalizeTheme({ title: 'Um título específico' }); // no mission fields at all
    const reason = validateNormalTheme(theme);
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/mission/i);
  });

  it('rejects when missionSetup and missionTask are both empty strings', () => {
    const theme = normalizeTheme(validParsed({ missionSetup: '', missionTask: '', mission: '' }));
    expect(validateNormalTheme(theme)).not.toBeNull();
  });

  it('rejects an empty title', () => {
    const theme = normalizeTheme(validParsed({ title: '' }));
    // Empty title falls back to the generic sentinel, which is treated as empty.
    expect(validateNormalTheme(theme)).toMatch(/title/i);
  });

  it('rejects a mission that is ONLY the generic defaults (empty AI object)', () => {
    const theme = normalizeTheme({}); // title→'Missão do dia', mission→''
    const reason = validateNormalTheme(theme);
    expect(reason).not.toBeNull();
  });

  it('rejects the generic default title even if a mission is present', () => {
    const theme = normalizeTheme(validParsed({ title: 'Missão do dia' }));
    expect(validateNormalTheme(theme)).toMatch(/default|title/i);
  });

  it('rejects a partial return (title only, no task)', () => {
    const theme = normalizeTheme({ title: 'Só um título' });
    expect(validateNormalTheme(theme)).not.toBeNull();
  });

  it('builds mission from missionSetup + missionTask when `mission` is absent, and accepts it', () => {
    const theme = normalizeTheme(validParsed({ mission: undefined }));
    expect(theme.mission).toBe('Você vai encontrar um amigo neste fim de semana. Escreva uma mensagem curta combinando o horário e o lugar.');
    expect(validateNormalTheme(theme)).toBeNull();
  });

  it('rejects a token-thin mission that is not a real instruction', () => {
    const theme = normalizeTheme(validParsed({ missionSetup: 'Oi', missionTask: '', mission: 'Oi' }));
    expect(validateNormalTheme(theme)).not.toBeNull();
  });
});
