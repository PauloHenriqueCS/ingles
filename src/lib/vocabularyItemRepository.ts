/**
 * SERVER-ONLY: CRUD for vocabulary_items and vocabulary_item_forms tables.
 * Never import in React components or client-side bundles.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  VocabularyItem,
  VocabularyItemForm,
  VocabularyItemKind,
  VocabularyFormType,
} from '../domain/vocabulary/vocabulary-types';

export interface CreateVocabularyItemInput {
  canonicalValue: string;
  normalizedValue: string;
  kind: VocabularyItemKind;
  language?: string;
  translationPtBR?: string;
  definitionEn?: string;
  definitionPtBR?: string;
  cefrMinimumLevel?: string;
  partOfSpeech?: string;
  lemma?: string;
  isMultiword?: boolean;
}

function rowToItem(row: Record<string, unknown>): VocabularyItem {
  return {
    id: String(row.id),
    canonicalValue: String(row.canonical_value),
    normalizedValue: String(row.normalized_value),
    kind: String(row.kind) as VocabularyItemKind,
    language: String(row.language ?? 'en'),
    translationPtBR: row.translation_pt_br != null ? String(row.translation_pt_br) : null,
    definitionEn: row.definition_en != null ? String(row.definition_en) : null,
    definitionPtBR: row.definition_pt_br != null ? String(row.definition_pt_br) : null,
    cefrMinimumLevel: row.cefr_minimum_level != null ? String(row.cefr_minimum_level) : null,
    partOfSpeech: row.part_of_speech != null ? String(row.part_of_speech) : null,
    lemma: row.lemma != null ? String(row.lemma) : null,
    isMultiword: Boolean(row.is_multiword),
    isActive: Boolean(row.is_active ?? true),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToForm(row: Record<string, unknown>): VocabularyItemForm {
  return {
    id: String(row.id),
    vocabularyItemId: String(row.vocabulary_item_id),
    formValue: String(row.form_value),
    normalizedForm: String(row.normalized_form),
    formType: String(row.form_type) as VocabularyFormType,
    locale: String(row.locale ?? 'en'),
    isPrimary: Boolean(row.is_primary),
    createdAt: String(row.created_at),
  };
}

export async function findVocabularyItemByNormalizedValue(
  supabase: SupabaseClient,
  normalizedValue: string,
  language = 'en',
): Promise<VocabularyItem | null> {
  const { data, error } = await supabase
    .from('vocabulary_items')
    .select('*')
    .eq('normalized_value', normalizedValue)
    .eq('language', language)
    .eq('is_active', true)
    .maybeSingle();

  if (error) throw new Error(`findVocabularyItemByNormalizedValue: ${error.message}`);
  if (!data) return null;
  return rowToItem(data as Record<string, unknown>);
}

export async function findVocabularyItemByForm(
  supabase: SupabaseClient,
  normalizedForm: string,
): Promise<VocabularyItem | null> {
  const { data, error } = await supabase
    .from('vocabulary_item_forms')
    .select('vocabulary_item_id, vocabulary_items(*)')
    .eq('normalized_form', normalizedForm)
    .maybeSingle();

  if (error) throw new Error(`findVocabularyItemByForm: ${error.message}`);
  if (!data) return null;

  const row = data as Record<string, unknown>;
  const item = row.vocabulary_items as Record<string, unknown> | null;
  if (!item) return null;
  return rowToItem(item);
}

export async function findOrCreateVocabularyItem(
  supabase: SupabaseClient,
  input: CreateVocabularyItemInput,
): Promise<VocabularyItem> {
  const language = input.language ?? 'en';

  // Try to find by normalized_value first
  const existing = await findVocabularyItemByNormalizedValue(
    supabase,
    input.normalizedValue,
    language,
  );
  if (existing) return existing;

  // Insert new item
  const payload = {
    canonical_value: input.canonicalValue,
    normalized_value: input.normalizedValue,
    kind: input.kind,
    language,
    translation_pt_br: input.translationPtBR ?? null,
    definition_en: input.definitionEn ?? null,
    definition_pt_br: input.definitionPtBR ?? null,
    cefr_minimum_level: input.cefrMinimumLevel ?? null,
    part_of_speech: input.partOfSpeech ?? null,
    lemma: input.lemma ?? null,
    is_multiword: input.isMultiword ?? false,
  };

  const { data: inserted, error: insertError } = await supabase
    .from('vocabulary_items')
    .insert(payload)
    .select()
    .maybeSingle();

  if (insertError) {
    // ON CONFLICT (normalized_value, language) — re-select
    if (
      insertError.code === '23505' ||
      insertError.message.includes('duplicate') ||
      insertError.message.includes('unique')
    ) {
      const { data: existing2, error: fetchError } = await supabase
        .from('vocabulary_items')
        .select('*')
        .eq('normalized_value', input.normalizedValue)
        .eq('language', language)
        .single();
      if (fetchError) throw new Error(`findOrCreateVocabularyItem (re-select): ${fetchError.message}`);
      return rowToItem(existing2 as Record<string, unknown>);
    }
    throw new Error(`findOrCreateVocabularyItem: ${insertError.message}`);
  }

  if (!inserted) {
    // Race condition: re-select
    const { data: existing3, error: fetchError } = await supabase
      .from('vocabulary_items')
      .select('*')
      .eq('normalized_value', input.normalizedValue)
      .eq('language', language)
      .single();
    if (fetchError) throw new Error(`findOrCreateVocabularyItem (re-select after null): ${fetchError.message}`);
    return rowToItem(existing3 as Record<string, unknown>);
  }

  return rowToItem(inserted as Record<string, unknown>);
}

export async function getVocabularyItemById(
  supabase: SupabaseClient,
  itemId: string,
): Promise<VocabularyItem | null> {
  const { data, error } = await supabase
    .from('vocabulary_items')
    .select('*')
    .eq('id', itemId)
    .maybeSingle();

  if (error) throw new Error(`getVocabularyItemById: ${error.message}`);
  if (!data) return null;
  return rowToItem(data as Record<string, unknown>);
}

export async function getFormsForItem(
  supabase: SupabaseClient,
  vocabularyItemId: string,
): Promise<VocabularyItemForm[]> {
  const { data, error } = await supabase
    .from('vocabulary_item_forms')
    .select('*')
    .eq('vocabulary_item_id', vocabularyItemId)
    .order('is_primary', { ascending: false });

  if (error) throw new Error(`getFormsForItem: ${error.message}`);
  return (data ?? []).map(row => rowToForm(row as Record<string, unknown>));
}

export async function addFormToItem(
  supabase: SupabaseClient,
  vocabularyItemId: string,
  formValue: string,
  normalizedForm: string,
  formType: VocabularyFormType,
  isPrimary = false,
): Promise<VocabularyItemForm> {
  const payload = {
    vocabulary_item_id: vocabularyItemId,
    form_value: formValue,
    normalized_form: normalizedForm,
    form_type: formType,
    is_primary: isPrimary,
  };

  const { data: inserted, error: insertError } = await supabase
    .from('vocabulary_item_forms')
    .insert(payload)
    .select()
    .maybeSingle();

  if (insertError) {
    // ON CONFLICT (vocabulary_item_id, normalized_form) DO NOTHING
    if (
      insertError.code === '23505' ||
      insertError.message.includes('duplicate') ||
      insertError.message.includes('unique')
    ) {
      const { data: existing, error: fetchError } = await supabase
        .from('vocabulary_item_forms')
        .select('*')
        .eq('vocabulary_item_id', vocabularyItemId)
        .eq('normalized_form', normalizedForm)
        .single();
      if (fetchError) throw new Error(`addFormToItem (fetch existing): ${fetchError.message}`);
      return rowToForm(existing as Record<string, unknown>);
    }
    throw new Error(`addFormToItem: ${insertError.message}`);
  }

  if (!inserted) {
    const { data: existing, error: fetchError } = await supabase
      .from('vocabulary_item_forms')
      .select('*')
      .eq('vocabulary_item_id', vocabularyItemId)
      .eq('normalized_form', normalizedForm)
      .single();
    if (fetchError) throw new Error(`addFormToItem (fetch after null): ${fetchError.message}`);
    return rowToForm(existing as Record<string, unknown>);
  }

  return rowToForm(inserted as Record<string, unknown>);
}
