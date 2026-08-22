import { supabase } from './supabase';
import { getCurrentUserId } from './authSession';
import { MainMistake } from '../types';
import { getNextActivePracticeDate } from './activePracticeDate';

interface CreateGroupParams {
  reviewId: string;
  mistakes: MainMistake[];
  entryDate?: string;
  theme?: string;
  activeWeekdays?: number[];
  /** Full text the student submitted — used to recover each mistake's original
   *  sentence (item #19) without any extra AI call. Best-effort. */
  originalText?: string;
}

/**
 * Best-effort extraction of the sentence containing `phrase` from `text`.
 * Deterministic, no AI. Returns null when the phrase can't be located.
 */
export function extractOriginalSentence(text: string | undefined, phrase: string): string | null {
  if (!text || !phrase.trim()) return null;
  const needle = phrase.trim().toLowerCase();
  // Split on sentence boundaries but keep it simple/robust.
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    if (s.toLowerCase().includes(needle)) {
      const trimmed = s.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
  }
  return null;
}

/**
 * CAPTURA dos erros da Escrita (preservada). Cria o grupo de revisão como
 * ORIGEM/AGREGADOR da correção e persiste cada erro como um CARD independente
 * com seu próprio scheduler (review_group_items ganhou status/review_level/
 * next_review_at). A atividade "Revisar meus erros" consome esses cards.
 *
 * Isto NÃO é mais uma revisão dentro da Escrita — a Escrita é sempre uma
 * Escrita normal. Aqui apenas registramos os erros para a atividade paralela.
 */
export async function createReviewGroupFromReview({
  reviewId,
  mistakes,
  entryDate,
  theme,
  activeWeekdays = [1, 2, 3, 4, 5],
  originalText,
}: CreateGroupParams): Promise<void> {
  if (mistakes.length === 0) return;

  const uid = await getCurrentUserId();
  if (!uid) throw new Error('Não autenticado');

  const rawDate = new Date();
  rawDate.setUTCDate(rawDate.getUTCDate() + 2);
  const groupNextReviewAt = getNextActivePracticeDate(rawDate, activeWeekdays);

  const { data: group, error: groupError } = await supabase
    .from('review_groups')
    .insert({
      user_id: uid,
      source_review_id: reviewId,
      source_entry_date: entryDate ?? null,
      original_theme: theme ?? null,
      status: 'scheduled',
      review_level: 0,
      next_review_at: groupNextReviewAt.toISOString(),
    })
    .select('id')
    .single();

  if (groupError) {
    // Unique constraint violation = group already exists for this review
    if (groupError.code === '23505') return;
    throw new Error(groupError.message);
  }

  // Novo erro → primeira revisão em +1 dia (scheduler POR ITEM).
  const itemNextReviewAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const items = mistakes.map((m) => ({
    review_group_id: group.id,
    user_id: uid,
    original_value: m.original,
    corrected_value: m.correct,
    explanation: m.explanation || null,
    original_sentence: extractOriginalSentence(originalText, m.original),
    status: 'scheduled',
    review_level: 0,
    next_review_at: itemNextReviewAt,
  }));

  const { error: itemsError } = await supabase
    .from('review_group_items')
    .insert(items);

  if (itemsError) throw new Error(itemsError.message);
}
