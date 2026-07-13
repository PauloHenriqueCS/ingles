import { supabase } from './supabase';
import { EnglishReviewSaved, CefrLevel, MainMistake, VocabularyItem, RewriteComparisonResult } from '../types';
import { parseMissionSnapshot } from './missionSnapshot';

function rowToReview(row: Record<string, unknown>): EnglishReviewSaved {
  const rawMistakes = Array.isArray(row.main_mistakes) ? row.main_mistakes as Record<string, unknown>[] : [];
  const mainMistakes: MainMistake[] = rawMistakes.map((m) => ({
    original: String(m.original ?? ''),
    correct: String(m.correct ?? ''),
    explanation: String(m.explanation ?? ''),
  }));

  const rawVocab = Array.isArray(row.new_vocabulary) ? row.new_vocabulary as Record<string, unknown>[] : [];
  const newVocabulary: VocabularyItem[] = rawVocab.map((v) => ({
    word: String(v.word ?? ''),
    meaningPtBr: String(v.meaningPtBr ?? v.meaningPt ?? ''),
    example: String(v.example ?? ''),
  }));

  return {
    id: String(row.id ?? ''),
    originalText: String(row.original_text ?? ''),
    correctedText: row.corrected_text != null ? String(row.corrected_text) : null,
    score: Number(row.score ?? 0),
    level: (String(row.level ?? 'A1')) as CefrLevel,
    grammar: Number(row.grammar ?? 0),
    vocabulary: Number(row.vocabulary ?? 0),
    naturalness: Number(row.naturalness ?? 0),
    fluency: Number(row.fluency ?? 0),
    summary: row.summary != null ? String(row.summary) : null,
    mainMistakes,
    newVocabulary,
    objectiveFeedback: row.objective_feedback != null ? String(row.objective_feedback) : null,
    nextPractice: row.next_practice != null ? String(row.next_practice) : null,
    category: row.category != null ? String(row.category) : null,
    difficulty: row.difficulty != null ? String(row.difficulty) : null,
    objective: row.objective != null ? String(row.objective) : null,
    createdAt: String(row.created_at ?? ''),
    entryDate: row.entry_date != null ? String(row.entry_date) : null,
    missionSnapshot: parseMissionSnapshot(row.mission_snapshot),
    version2Text: row.version_2_text != null ? String(row.version_2_text) : null,
    version2Comparison: row.version_2_comparison != null ? row.version_2_comparison as RewriteComparisonResult : null,
    version2ImprovementScore: row.version_2_improvement_score != null ? Number(row.version_2_improvement_score) : null,
  };
}

export async function fetchEnglishReviews(limit?: number): Promise<EnglishReviewSaved[]> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  let query = supabase
    .from('english_reviews')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (limit) query = query.limit(limit);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => rowToReview(row as Record<string, unknown>));
}

export async function fetchReviewByDate(date: string): Promise<EnglishReviewSaved | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from('english_reviews')
    .select('*')
    .eq('user_id', user.id)
    .eq('entry_date', date)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;
  return rowToReview(data as Record<string, unknown>);
}
