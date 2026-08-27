import { describe, it, expect } from 'vitest';
import { writingUiStrings } from './writingUiStrings';

describe('writingUiStrings — interface-language aware chrome', () => {
  it('resolves pt-BR and en from one module, keyed by interface language', () => {
    expect(writingUiStrings('pt-BR').stepMission).toBe('Missão');
    expect(writingUiStrings('en').stepMission).toBe('Mission');
    expect(writingUiStrings('pt-BR').doneTitle).toBe('Escrita concluída');
    expect(writingUiStrings('en').doneTitle).toBe('Writing complete');
  });

  it('labels the V2 headline as a SCORE, never as "improvement/melhora"', () => {
    // Regression guard for the misleading "Melhora da versão 2: X/100" label —
    // the number is an absolute composite score of V2, not a delta.
    expect(writingUiStrings('pt-BR').v2ScoreLabel).toBe('Nota da versão 2');
    expect(writingUiStrings('pt-BR').v2ScoreLabel.toLowerCase()).not.toContain('melhora');
    expect(writingUiStrings('en').v2ScoreLabel.toLowerCase()).not.toContain('improvement');
  });

  it('pluralizes the recommendation and quota copy', () => {
    const pt = writingUiStrings('pt-BR');
    expect(pt.improveTitle(1)).toBe('Você tem 1 ponto para melhorar');
    expect(pt.improveTitle(2)).toBe('Você tem 2 pontos para melhorar');
    const en = writingUiStrings('en');
    expect(en.improveTitle(1)).toContain('1 point');
    expect(en.improveTitle(3)).toContain('3 points');
    expect(pt.pronQuotaRemaining(1)).toContain('avaliação restante');
    expect(en.pronQuotaRemaining(2)).toContain('assessments left');
  });

  it('falls back to pt-BR for an unknown interface language', () => {
    expect(writingUiStrings('zz').stepDone).toBe('Concluir');
    expect(writingUiStrings(null).stepDone).toBe('Concluir');
  });

  it('has full key parity between pt-BR and en (no missing translation)', () => {
    const pt = writingUiStrings('pt-BR') as Record<string, unknown>;
    const en = writingUiStrings('en') as Record<string, unknown>;
    expect(Object.keys(en).sort()).toEqual(Object.keys(pt).sort());
    for (const k of Object.keys(pt)) {
      expect(typeof en[k]).toBe(typeof pt[k]);
    }
  });
});
