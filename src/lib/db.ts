import { supabase } from './supabase';
import { DayEntry, EntriesStore, AIFeedback, CefrLevel, MainMistake, VocabularyItem } from '../types';
import { getScheduleForDate } from '../data/calendar2026';

interface DBRow {
  entry_date: string;
  user_id: string | null;
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
  ai_score: number | null;
  cefr_level: string | null;
  grammar_score: number | null;
  vocabulary_score: number | null;
  naturalness_score: number | null;
  fluency_score: number | null;
  ai_summary: string | null;
  grammar_feedback: any[] | null;
  ai_main_errors: string[] | null;
  new_vocabulary: any[] | null;
  natural_expressions: any[] | null;
  grammar_goal_achieved: boolean | null;
  rewrite_challenge: string | null;
  reviewed_at: string | null;
}

function rowToEntry(row: DBRow): DayEntry {
  let aiReview: AIFeedback | null = null;
  if (row.ai_score != null) {
    const rawMistakes: any[] = Array.isArray(row.grammar_feedback) ? row.grammar_feedback : [];
    const mainMistakes: MainMistake[] = rawMistakes
      .filter((m) => m && typeof m === 'object' && 'original' in m)
      .map((m) => ({ original: m.original ?? '', correct: m.correct ?? '', explanation: m.explanation ?? '' }));

    const rawVocab: any[] = Array.isArray(row.new_vocabulary) ? row.new_vocabulary : [];
    const newVocabulary: VocabularyItem[] = rawVocab.map((v) => ({
      word: v.word ?? '',
      meaningPtBr: v.meaningPtBr ?? v.meaningPt ?? '',
      example: v.example ?? '',
    }));

    aiReview = {
      score: row.ai_score,
      level: (row.cefr_level ?? 'A1') as CefrLevel,
      grammar: row.grammar_score ?? 0,
      vocabulary: row.vocabulary_score ?? 0,
      naturalness: row.naturalness_score ?? 0,
      fluency: row.fluency_score ?? 0,
      summary: row.ai_summary ?? '',
      correctedText: row.corrected_text ?? '',
      mainMistakes,
      newVocabulary,
      objectiveFeedback: '',
      nextPractice: row.rewrite_challenge ?? '',
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

function entryToRow(entry: DayEntry, userId: string): Omit<DBRow, 'updated_at'> & { updated_at: string } {
  const schedule = getScheduleForDate(entry.date);
  const d = new Date(entry.date + 'T12:00:00');
  const r = entry.aiReview;
  return {
    entry_date: entry.date,
    user_id: userId,
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
    ai_score: r?.score ?? null,
    cefr_level: r?.level ?? null,
    grammar_score: r?.grammar ?? null,
    vocabulary_score: r?.vocabulary ?? null,
    naturalness_score: r?.naturalness ?? null,
    fluency_score: r?.fluency ?? null,
    ai_summary: r?.summary ?? null,
    grammar_feedback: r?.mainMistakes ?? null,
    ai_main_errors: r?.mainMistakes?.map((m) => m.original) ?? null,
    new_vocabulary: r?.newVocabulary ?? null,
    natural_expressions: null,
    grammar_goal_achieved: null,
    rewrite_challenge: r?.nextPractice ?? null,
    reviewed_at: entry.reviewedAt ?? null,
  };
}

export async function fetchAllEntries(): Promise<EntriesStore> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return {};

  const { data, error } = await supabase
    .from('writing_entries')
    .select('*')
    .eq('user_id', user.id);

  if (error) throw new Error(error.message);

  const store: EntriesStore = {};
  for (const row of (data ?? []) as DBRow[]) {
    const entry = rowToEntry(row);
    store[entry.date] = entry;
  }
  return store;
}

export async function upsertEntry(entry: DayEntry): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Não autenticado');

  const row = entryToRow(entry, user.id);
  const { error } = await supabase
    .from('writing_entries')
    .upsert(row, { onConflict: 'user_id,entry_date' });

  if (error) throw new Error(error.message);
}
