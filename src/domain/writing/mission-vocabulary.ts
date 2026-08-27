import { VocabularyItem } from '../../types';

/**
 * The mission's "Vocabulário útil" list is generated per-mission by the AI, so
 * its shape is not guaranteed: the model can return blank entries, or bare
 * strings coerced into objects with an empty `word`. Rendering the section on a
 * raw `.length > 0` check then shows the heading with no visible items — the
 * reported empty-vocabulary bug.
 *
 * This returns only the items worth showing (a non-empty word). Callers must
 * gate the whole section on the RESULT being non-empty, never on the raw array,
 * so an all-blank list renders nothing at all. It never invents vocabulary —
 * the data stays fully data-driven/multilingual.
 */
export function visibleVocabulary(
  items: VocabularyItem[] | null | undefined,
): VocabularyItem[] {
  if (!Array.isArray(items)) return [];
  return items.filter(
    (v): v is VocabularyItem =>
      !!v && typeof v.word === 'string' && v.word.trim().length > 0,
  );
}
