/**
 * Single source of truth for a writing entry's status.
 *
 * The status the History card shows, the buckets its filters use, and the
 * writing contribution to the calendar's daily color must all agree. This
 * module centralizes that definition so those places can no longer drift apart.
 *
 * The four canonical states (matching the writing_entries.status column):
 *   - 'nao-iniciado' : nothing written yet.
 *   - 'escrito'      : text saved, no AI correction yet.
 *   - 'corrigido'    : the AI review/correction is done and persisted.
 *   - 'revisado'     : the final corrected version (após a Versão 2) was
 *                      generated and persisted — the completion of the flow.
 *
 * Why derive instead of trusting the stored column alone: the stored column has
 * historically never received 'revisado', and legacy rows can carry a stale
 * value. Deriving from the strongest available evidence (a persisted final
 * version, then a persisted review, then text) reconciles those cases, while
 * still honoring the stored value when no stronger evidence is present.
 */

export type WritingEntryStatus = 'nao-iniciado' | 'escrito' | 'corrigido' | 'revisado';

export interface WritingEntryStatusInputs {
  /** The stored writing_entries.status value (may be null/legacy). */
  storedStatus?: string | null;
  /** The entry has non-empty original text. */
  hasText: boolean;
  /** At least one AI review exists for the entry. */
  hasReview: boolean;
  /** A final corrected version (version_2_final_text) is persisted. */
  hasFinalVersion: boolean;
}

export function deriveWritingEntryStatus(input: WritingEntryStatusInputs): WritingEntryStatus {
  const stored = input.storedStatus ?? null;
  if (input.hasFinalVersion || stored === 'revisado') return 'revisado';
  if (input.hasReview || stored === 'corrigido') return 'corrigido';
  if (input.hasText || stored === 'escrito') return 'escrito';
  return 'nao-iniciado';
}

/**
 * Collapses the four states into the three-state model the calendar uses for a
 * day's activity color. Reuses the same derivation so the calendar and History
 * never classify the same entry differently.
 */
export function deriveWritingActivityState(
  input: WritingEntryStatusInputs,
): 'not_started' | 'in_progress' | 'completed' {
  const status = deriveWritingEntryStatus(input);
  if (status === 'nao-iniciado') return 'not_started';
  if (status === 'escrito') return 'in_progress';
  return 'completed'; // 'corrigido' | 'revisado'
}
