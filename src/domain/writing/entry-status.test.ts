import { describe, it, expect } from 'vitest';
import { deriveWritingEntryStatus, deriveWritingActivityState } from './entry-status';

/**
 * Status matrix. Each case documents WHY the entry belongs to that status.
 * These are the buckets the History filters and the card badge both consume,
 * so the derivation is the single source of truth for both.
 */
describe('deriveWritingEntryStatus', () => {
  it('nao-iniciado: no text, no review, no final version, no meaningful stored status', () => {
    expect(deriveWritingEntryStatus({ storedStatus: 'nao-iniciado', hasText: false, hasReview: false, hasFinalVersion: false }))
      .toBe('nao-iniciado');
    expect(deriveWritingEntryStatus({ storedStatus: null, hasText: false, hasReview: false, hasFinalVersion: false }))
      .toBe('nao-iniciado');
  });

  it('escrito: has text but no review yet (even if stored status is stale nao-iniciado)', () => {
    expect(deriveWritingEntryStatus({ storedStatus: 'escrito', hasText: true, hasReview: false, hasFinalVersion: false }))
      .toBe('escrito');
    // legacy row: text exists but the column was never advanced past nao-iniciado
    expect(deriveWritingEntryStatus({ storedStatus: 'nao-iniciado', hasText: true, hasReview: false, hasFinalVersion: false }))
      .toBe('escrito');
  });

  it('corrigido: a review exists (AI correction persisted) but no final version yet', () => {
    expect(deriveWritingEntryStatus({ storedStatus: 'corrigido', hasText: true, hasReview: true, hasFinalVersion: false }))
      .toBe('corrigido');
    // even if the stored column is behind, the presence of a review wins
    expect(deriveWritingEntryStatus({ storedStatus: 'escrito', hasText: true, hasReview: true, hasFinalVersion: false }))
      .toBe('corrigido');
  });

  it('revisado: a final corrected version is persisted (completes the flow)', () => {
    expect(deriveWritingEntryStatus({ storedStatus: 'corrigido', hasText: true, hasReview: true, hasFinalVersion: true }))
      .toBe('revisado');
    // the stored column historically never received 'revisado' — the derivation
    // reconciles that from the persisted final version.
    expect(deriveWritingEntryStatus({ storedStatus: 'revisado', hasText: true, hasReview: true, hasFinalVersion: false }))
      .toBe('revisado');
  });

  it('is total and mutually exclusive: every input yields exactly one of the four states', () => {
    const states = new Set<string>();
    for (const hasText of [false, true]) {
      for (const hasReview of [false, true]) {
        for (const hasFinalVersion of [false, true]) {
          for (const storedStatus of [null, 'nao-iniciado', 'escrito', 'corrigido', 'revisado', 'legacy-unknown']) {
            const s = deriveWritingEntryStatus({ storedStatus, hasText, hasReview, hasFinalVersion });
            states.add(s);
            expect(['nao-iniciado', 'escrito', 'corrigido', 'revisado']).toContain(s);
          }
        }
      }
    }
    expect(states.size).toBeGreaterThan(1);
  });
});

describe('deriveWritingActivityState (calendar 3-state)', () => {
  it('collapses corrigido and revisado into completed', () => {
    expect(deriveWritingActivityState({ storedStatus: 'corrigido', hasText: true, hasReview: true, hasFinalVersion: false })).toBe('completed');
    expect(deriveWritingActivityState({ storedStatus: 'revisado', hasText: true, hasReview: true, hasFinalVersion: true })).toBe('completed');
  });
  it('maps escrito to in_progress and empty to not_started', () => {
    expect(deriveWritingActivityState({ storedStatus: 'escrito', hasText: true, hasReview: false, hasFinalVersion: false })).toBe('in_progress');
    expect(deriveWritingActivityState({ storedStatus: null, hasText: false, hasReview: false, hasFinalVersion: false })).toBe('not_started');
  });
});
