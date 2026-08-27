import { describe, it, expect } from 'vitest';
import {
  deriveInitialStep,
  evidenceFurthestSlot,
  isSlotReachable,
  slotForStep,
  stepperSlotState,
  maxSlot,
  WRITING_STEP_SLOTS,
  type WritingFlowEvidence,
} from './writing-flow-steps';

const BLANK: WritingFlowEvidence = {
  hasTheme: false,
  hasText: false,
  hasReview: false,
  hasV2: false,
  hasFinalVersion: false,
  concluded: false,
};

describe('writing-flow-steps — stepper structure', () => {
  it('has exactly the four slots in order', () => {
    expect(WRITING_STEP_SLOTS).toEqual(['mission', 'write', 'feedback', 'done']);
  });

  it('folds the improve sub-flow into the central feedback slot', () => {
    expect(slotForStep('improve')).toBe('feedback');
    expect(slotForStep('feedback')).toBe('feedback');
    expect(slotForStep('mission')).toBe('mission');
    expect(slotForStep('write')).toBe('write');
    expect(slotForStep('done')).toBe('done');
  });
});

describe('deriveInitialStep — restore from persisted evidence', () => {
  it('a brand-new writing opens on Missão', () => {
    expect(deriveInitialStep(BLANK)).toBe('mission');
  });

  it('a loaded mission with no text stays on Missão', () => {
    expect(deriveInitialStep({ ...BLANK, hasTheme: true })).toBe('mission');
  });

  it('a started draft opens on Escrever', () => {
    expect(deriveInitialStep({ ...BLANK, hasTheme: true, hasText: true })).toBe('write');
  });

  it('a reviewed writing opens on Feedback', () => {
    expect(deriveInitialStep({ ...BLANK, hasTheme: true, hasText: true, hasReview: true })).toBe('feedback');
  });

  it('a concluded (V1-only) writing opens on Concluído even without a V2', () => {
    expect(
      deriveInitialStep({ ...BLANK, hasTheme: true, hasText: true, hasReview: true, concluded: true }),
    ).toBe('done');
  });

  it('a writing with a final V2 version opens on Concluído', () => {
    expect(
      deriveInitialStep({
        ...BLANK,
        hasTheme: true,
        hasText: true,
        hasReview: true,
        hasV2: true,
        hasFinalVersion: true,
        concluded: false,
      }),
    ).toBe('done');
  });
});

describe('evidenceFurthestSlot + reachability', () => {
  it('unlocks only Missão for a blank writing', () => {
    const f = evidenceFurthestSlot(BLANK);
    expect(f).toBe('mission');
    expect(isSlotReachable('mission', f)).toBe(true);
    expect(isSlotReachable('write', f)).toBe(false);
    expect(isSlotReachable('feedback', f)).toBe(false);
    expect(isSlotReachable('done', f)).toBe(false);
  });

  it('a loaded mission unlocks up to Escrever', () => {
    const f = evidenceFurthestSlot({ ...BLANK, hasTheme: true });
    expect(f).toBe('write');
    expect(isSlotReachable('write', f)).toBe(true);
    expect(isSlotReachable('feedback', f)).toBe(false);
  });

  it('a reviewed writing unlocks up to Feedback but NOT Concluir until concluded', () => {
    const f = evidenceFurthestSlot({ ...BLANK, hasTheme: true, hasText: true, hasReview: true });
    expect(f).toBe('feedback');
    expect(isSlotReachable('feedback', f)).toBe(true);
    expect(isSlotReachable('done', f)).toBe(false);
  });

  it('a concluded writing unlocks Concluir', () => {
    const f = evidenceFurthestSlot({ ...BLANK, hasReview: true, concluded: true });
    expect(f).toBe('done');
    expect(isSlotReachable('done', f)).toBe(true);
  });
});

describe('stepperSlotState — current/completed/reachable/locked', () => {
  it('marks the current slot, completed past slots, and locks future ones', () => {
    // On Feedback with a reviewed (not concluded) writing.
    const furthest = 'feedback' as const;
    expect(stepperSlotState('mission', 'feedback', furthest)).toBe('completed');
    expect(stepperSlotState('write', 'feedback', furthest)).toBe('completed');
    expect(stepperSlotState('feedback', 'feedback', furthest)).toBe('current');
    expect(stepperSlotState('done', 'feedback', furthest)).toBe('locked');
  });

  it('while improving, the feedback slot is current (improve folds into it)', () => {
    const furthest = 'feedback' as const;
    expect(stepperSlotState('feedback', 'improve', furthest)).toBe('current');
    expect(stepperSlotState('done', 'improve', furthest)).toBe('locked');
  });

  it('once concluded, Concluir is current and earlier slots stay tappable/completed', () => {
    const furthest = 'done' as const;
    expect(stepperSlotState('mission', 'done', furthest)).toBe('completed');
    expect(stepperSlotState('feedback', 'done', furthest)).toBe('completed');
    expect(stepperSlotState('done', 'done', furthest)).toBe('current');
    // Going back to Feedback from Done: Done becomes a reachable (already visited) slot.
    expect(stepperSlotState('done', 'feedback', furthest)).toBe('reachable');
  });
});

describe('maxSlot', () => {
  it('returns the furthest of two slots', () => {
    expect(maxSlot('write', 'feedback')).toBe('feedback');
    expect(maxSlot('done', 'mission')).toBe('done');
    expect(maxSlot('mission', 'mission')).toBe('mission');
  });
});
