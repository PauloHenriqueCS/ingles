import { supabase } from './supabase';
import { DayEntry, EntriesStore, AIFeedback } from '../types';
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
  ai_review: AIFeedback | null;
}

function rowToEntry(row: DBRow): DayEntry {
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
    aiReview: row.ai_review ?? null,
  };
}

function entryToRow(entry: DayEntry): Omit<DBRow, 'updated_at'> & { updated_at: string } {
  const schedule = getScheduleForDate(entry.date);
  const d = new Date(entry.date + 'T12:00:00');
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
    ai_review: entry.aiReview ?? null,
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
