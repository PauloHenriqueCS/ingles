import { supabase } from './supabase';
import { DayEntry, EntriesStore, AIFeedback, GrammarFeedbackItem, VocabularyItem, NaturalExpression } from '../types';
import { getScheduleForDate } from '../data/calendar2026';

interface DBRow {
  entry_date: string;
  month: number;
  year: number;
  theme: string;
  grammar_goal: string | null;
  main_tense: string | null;
  title: string | null;
  original_text: string | null;
  corrected_text: string | null;
  notes: string | null;
  main_errors: string | null;
  difficulty: string | null;
  status: string;
  word_count: number;
  updated_at: string;
  // AI review columns (v2)
  ai_score: number | null;
  cefr_level: string | null;
  grammar_score: number | null;
  vocabulary_score: number | null;
  naturalness_score: number | null;
  fluency_score: number | null;
  ai_summary: string | null;
  grammar_feedback: GrammarFeedbackItem[] | null;
  ai_main_errors: string[] | null;
  new_vocabulary: VocabularyItem[] | null;
  natural_expressions: NaturalExpression[] | null;
  grammar_goal_achieved: boolean | null;
  rewrite_challenge: string | null;
  reviewed_at: string | null;
}

function rowToEntry(row: DBRow): DayEntry {
  let aiReview: AIFeedback | null = null;
  if (row.ai_score != null) {
    aiReview = {
      score: row.ai_score,
      cefrLevel: row.cefr_level ?? '',
      grammarScore: row.grammar_score ?? 0,
      vocabularyScore: row.vocabulary_score ?? 0,
      naturalnessScore: row.naturalness_score ?? 0,
      fluencyScore: row.fluency_score ?? 0,
      correctedText: row.corrected_text ?? '',
      summary: row.ai_summary ?? '',
      grammarFeedback: row.grammar_feedback ?? [],
      mainErrors: row.ai_main_errors ?? [],
      newVocabulary: row.new_vocabulary ?? [],
      naturalExpressions: row.natural_expressions ?? [],
      grammarGoalAchieved: row.grammar_goal_achieved ?? false,
      rewriteChallenge: row.rewrite_challenge ?? '',
    };
  }

  return {
    date: row.entry_date,
    title: row.title ?? '',
    originalText: row.original_text ?? '',
    correctedText: row.corrected_text ?? '',
    observations: row.notes ?? '',
    mainErrors: row.main_errors ?? '',
    difficulty: (row.difficulty as DayEntry['difficulty']) ?? null,
    status: (row.status as DayEntry['status']) ?? 'nao-iniciado',
    wordCount: row.word_count ?? 0,
    updatedAt: row.updated_at ?? new Date().toISOString(),
    aiReview,
    reviewedAt: row.reviewed_at ?? null,
  };
}

function entryToRow(entry: DayEntry): Omit<DBRow, 'updated_at'> & { updated_at: string } {
  const schedule = getScheduleForDate(entry.date);
  const d = new Date(entry.date + 'T12:00:00');
  const r = entry.aiReview;
  return {
    entry_date: entry.date,
    month: d.getMonth() + 1,
    year: d.getFullYear(),
    theme: schedule?.theme ?? '',
    grammar_goal: schedule?.grammarObjective ?? null,
    main_tense: schedule?.verbTense ?? null,
    title: entry.title || null,
    original_text: entry.originalText || null,
    corrected_text: entry.correctedText || null,
    notes: entry.observations || null,
    main_errors: entry.mainErrors || null,
    difficulty: entry.difficulty,
    status: entry.status,
    word_count: entry.wordCount,
    updated_at: entry.updatedAt,
    // AI review columns
    ai_score: r?.score ?? null,
    cefr_level: r?.cefrLevel ?? null,
    grammar_score: r?.grammarScore ?? null,
    vocabulary_score: r?.vocabularyScore ?? null,
    naturalness_score: r?.naturalnessScore ?? null,
    fluency_score: r?.fluencyScore ?? null,
    ai_summary: r?.summary ?? null,
    grammar_feedback: r?.grammarFeedback ?? null,
    ai_main_errors: r?.mainErrors ?? null,
    new_vocabulary: r?.newVocabulary ?? null,
    natural_expressions: r?.naturalExpressions ?? null,
    grammar_goal_achieved: r?.grammarGoalAchieved ?? null,
    rewrite_challenge: r?.rewriteChallenge ?? null,
    reviewed_at: entry.reviewedAt ?? null,
  };
}

export async function fetchAllEntries(): Promise<EntriesStore> {
  const { data, error } = await supabase
    .from('writing_entries')
    .select('*');

  if (error) throw new Error(error.message);

  const store: EntriesStore = {};
  for (const row of (data ?? []) as DBRow[]) {
    const entry = rowToEntry(row);
    store[entry.date] = entry;
  }
  return store;
}

export async function upsertEntry(entry: DayEntry): Promise<void> {
  const row = entryToRow(entry);
  const { error } = await supabase
    .from('writing_entries')
    .upsert(row, { onConflict: 'entry_date' });

  if (error) throw new Error(error.message);
}
