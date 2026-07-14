import { describe, it, expect } from 'vitest';
import {
  canTransitionGrammarMastery,
  assertTransitionAllowed,
  InvalidGrammarMasteryTransitionError,
} from './grammar-mastery-transitions';
import { GrammarMasteryState } from './grammar-mastery-types';

// ── Transições válidas (progressão normal) ────────────────────────────────────

describe('canTransitionGrammarMastery — progressões válidas', () => {
  // Teste 13
  it('locked → introduced permitida', () => {
    expect(canTransitionGrammarMastery('locked', 'introduced')).toBe(true);
  });

  // Teste 14
  it('introduced → practicing permitida', () => {
    expect(canTransitionGrammarMastery('introduced', 'practicing')).toBe(true);
  });

  // Teste 15
  it('practicing → consolidating permitida', () => {
    expect(canTransitionGrammarMastery('practicing', 'consolidating')).toBe(true);
  });

  // Teste 16
  it('consolidating → mastered permitida', () => {
    expect(canTransitionGrammarMastery('consolidating', 'mastered')).toBe(true);
  });

  // Teste 17
  it('mastered → maintenance permitida', () => {
    expect(canTransitionGrammarMastery('mastered', 'maintenance')).toBe(true);
  });
});

// ── Transições inválidas (pulos e proibidas) ──────────────────────────────────

describe('canTransitionGrammarMastery — transições inválidas', () => {
  // Teste 18
  it('locked → mastered rejeitada (pulo de etapas)', () => {
    expect(canTransitionGrammarMastery('locked', 'mastered')).toBe(false);
  });

  it('locked → practicing rejeitada', () => {
    expect(canTransitionGrammarMastery('locked', 'practicing')).toBe(false);
  });

  it('locked → consolidating rejeitada', () => {
    expect(canTransitionGrammarMastery('locked', 'consolidating')).toBe(false);
  });

  it('locked → maintenance rejeitada', () => {
    expect(canTransitionGrammarMastery('locked', 'maintenance')).toBe(false);
  });

  it('introduced → mastered rejeitada', () => {
    expect(canTransitionGrammarMastery('introduced', 'mastered')).toBe(false);
  });

  it('introduced → maintenance rejeitada', () => {
    expect(canTransitionGrammarMastery('introduced', 'maintenance')).toBe(false);
  });

  it('practicing → locked rejeitada (locked = não introduzido)', () => {
    expect(canTransitionGrammarMastery('practicing', 'locked')).toBe(false);
  });

  it('mastered → locked rejeitada', () => {
    expect(canTransitionGrammarMastery('mastered', 'locked')).toBe(false);
  });

  it('maintenance → locked rejeitada', () => {
    expect(canTransitionGrammarMastery('maintenance', 'locked')).toBe(false);
  });

  it('transição para o mesmo estado rejeitada', () => {
    const states: GrammarMasteryState[] = [
      'locked', 'introduced', 'practicing', 'consolidating', 'mastered', 'maintenance',
    ];
    for (const s of states) {
      expect(canTransitionGrammarMastery(s, s)).toBe(false);
    }
  });
});

// ── Regressões (exigem motivo) ────────────────────────────────────────────────

describe('canTransitionGrammarMastery — regressões', () => {
  // Teste 19
  it('regressão sem motivo rejeitada', () => {
    expect(canTransitionGrammarMastery('mastered', 'consolidating')).toBe(false);
    expect(canTransitionGrammarMastery('mastered', 'consolidating', '')).toBe(false);
    expect(canTransitionGrammarMastery('mastered', 'consolidating', '   ')).toBe(false);
    expect(canTransitionGrammarMastery('consolidating', 'practicing')).toBe(false);
    expect(canTransitionGrammarMastery('maintenance', 'consolidating')).toBe(false);
    expect(canTransitionGrammarMastery('maintenance', 'practicing')).toBe(false);
    expect(canTransitionGrammarMastery('practicing', 'introduced')).toBe(false);
  });

  // Teste 20
  it('regressão válida com motivo não-vazio permitida', () => {
    expect(canTransitionGrammarMastery('mastered', 'consolidating', 'low_score_checkpoint')).toBe(true);
    expect(canTransitionGrammarMastery('consolidating', 'practicing', 'performance_drop')).toBe(true);
    expect(canTransitionGrammarMastery('maintenance', 'consolidating', 'failed_spaced_review')).toBe(true);
    expect(canTransitionGrammarMastery('maintenance', 'practicing', 'persistent_errors')).toBe(true);
    expect(canTransitionGrammarMastery('practicing', 'introduced', 'reassessment')).toBe(true);
  });

  it('introduced não pode regredir para locked (locked = não introduzido)', () => {
    expect(canTransitionGrammarMastery('introduced', 'locked', 'admin_reset')).toBe(false);
  });
});

// ── assertTransitionAllowed ───────────────────────────────────────────────────

describe('assertTransitionAllowed', () => {
  it('não lança em transição válida', () => {
    expect(() => assertTransitionAllowed('locked', 'introduced')).not.toThrow();
    expect(() => assertTransitionAllowed('mastered', 'consolidating', 'regression_reason')).not.toThrow();
  });

  it('lança InvalidGrammarMasteryTransitionError em transição inválida', () => {
    expect(() => assertTransitionAllowed('locked', 'mastered')).toThrow(InvalidGrammarMasteryTransitionError);
    expect(() => assertTransitionAllowed('mastered', 'consolidating')).toThrow(InvalidGrammarMasteryTransitionError);
  });

  it('mensagem de erro identifica os estados from e to', () => {
    try {
      assertTransitionAllowed('locked', 'mastered');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidGrammarMasteryTransitionError);
      expect((e as Error).message).toContain('locked');
      expect((e as Error).message).toContain('mastered');
    }
  });
});
