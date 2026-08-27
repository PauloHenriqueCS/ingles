/**
 * The Writing activity's guided flow, as a small pure state model.
 *
 * The activity is presented as a 4-slot stepper — Missão → Escrever → Feedback →
 * Concluir — that mirrors the mental model "estou nesta etapa, já concluí estas,
 * e depois vem aquilo". This module owns ONLY the navigation structure: which
 * step the user should land on given the work already persisted, which slot a
 * step highlights, and which slots are reachable. It holds no copy (localized in
 * writingUiStrings) and no network/persistence — the source of truth stays the
 * server-derived evidence the caller passes in.
 *
 * "Melhorar meu texto" (the optional V2) is deliberately NOT a fifth slot: it is
 * a sub-state of the central stage, so it shares the 'feedback' slot. Pronúncia
 * is not part of the flow at all — it is an optional extra on the Concluído
 * screen and never appears here.
 */

/** The concrete screen the user is looking at. */
export type WritingStep = 'mission' | 'write' | 'feedback' | 'improve' | 'done';

/** The four visible stepper slots (in order). 'improve' folds into 'feedback'. */
export type WritingStepSlot = 'mission' | 'write' | 'feedback' | 'done';

export const WRITING_STEP_SLOTS: readonly WritingStepSlot[] = [
  'mission',
  'write',
  'feedback',
  'done',
] as const;

const SLOT_ORDER: Record<WritingStepSlot, number> = {
  mission: 0,
  write: 1,
  feedback: 2,
  done: 3,
};

/** Ordinal position of a slot (0-based), for reachability comparisons. */
export function slotIndex(slot: WritingStepSlot): number {
  return SLOT_ORDER[slot];
}

/** The stepper slot a given step highlights. The improve sub-flow shares the
 *  central 'feedback' slot, so the stepper never grows to 5+ slots. */
export function slotForStep(step: WritingStep): WritingStepSlot {
  return step === 'improve' ? 'feedback' : step;
}

/**
 * The strongest evidence about a writing that is actually persisted server-side
 * (writing_entries.status + english_reviews). Everything here is derivable from
 * a page refresh — nothing depends on ephemeral in-session choices.
 */
export interface WritingFlowEvidence {
  /** A mission is currently assigned/loaded for this writing. */
  hasTheme: boolean;
  /** Non-empty original text exists (a saved draft or a submitted V1). */
  hasText: boolean;
  /** A persisted V1 AI review exists (writing_entries reached 'corrigido'). */
  hasReview: boolean;
  /** A persisted V2 evaluation exists (version_2_comparison). */
  hasV2: boolean;
  /** A persisted final corrected version exists (version_2_final_text ⇒ 'revisado'). */
  hasFinalVersion: boolean;
  /**
   * The user explicitly concluded the activity (english_reviews.concluded_at),
   * OR a final version exists. Either makes 'done' the persisted terminal state.
   */
  concluded: boolean;
}

/**
 * The step to land on when (re)entering the activity — derived ONLY from
 * persisted evidence, so a refresh or a return-from-Home restores the same
 * place. Precedence follows the flow's terminal-first order: a concluded/revised
 * writing opens on Concluído; a reviewed one on Feedback; a started one on
 * Escrever; otherwise on Missão (which itself shows "Receber missão" when no
 * theme is loaded yet).
 */
export function deriveInitialStep(e: WritingFlowEvidence): WritingStep {
  if (e.concluded || e.hasFinalVersion) return 'done';
  if (e.hasReview) return 'feedback';
  if (e.hasText) return 'write';
  return 'mission';
}

/**
 * The furthest slot the persisted evidence alone guarantees is reachable. The
 * stepper unlocks every slot up to and including this one (plus any slot the
 * user has advanced to in-session — the caller maxes the two). A future slot the
 * evidence has not unlocked can never be opened by tapping the stepper.
 */
export function evidenceFurthestSlot(e: WritingFlowEvidence): WritingStepSlot {
  if (e.concluded || e.hasFinalVersion) return 'done';
  if (e.hasReview) return 'feedback';
  if (e.hasText || e.hasTheme) return 'write';
  return 'mission';
}

/** A slot is reachable (tappable) when it is at or before the furthest slot. */
export function isSlotReachable(slot: WritingStepSlot, furthest: WritingStepSlot): boolean {
  return slotIndex(slot) <= slotIndex(furthest);
}

export type StepperSlotState = 'current' | 'completed' | 'reachable' | 'locked';

/**
 * Visual state of a stepper slot: the slot of the current step is 'current';
 * earlier reachable slots are 'completed'; later-but-reachable slots are
 * 'reachable' (tappable, e.g. Concluir once the user has advanced there); slots
 * beyond the furthest reached are 'locked' (never tappable).
 */
export function stepperSlotState(
  slot: WritingStepSlot,
  currentStep: WritingStep,
  furthest: WritingStepSlot,
): StepperSlotState {
  const current = slotForStep(currentStep);
  if (slot === current) return 'current';
  if (!isSlotReachable(slot, furthest)) return 'locked';
  return slotIndex(slot) < slotIndex(current) ? 'completed' : 'reachable';
}

/** The furthest of two slots (used to combine evidence with in-session progress). */
export function maxSlot(a: WritingStepSlot, b: WritingStepSlot): WritingStepSlot {
  return slotIndex(a) >= slotIndex(b) ? a : b;
}
