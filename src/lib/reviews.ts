import { supabase } from './supabase';
import { AIFeedback, MissionSnapshot, RewriteComparisonResult } from '../types';

export interface SaveReviewParams {
  originalText: string;
  feedback: AIFeedback;
  category?: string;
  difficulty?: string;
  objective?: string;
  entryDate?: string;
  missionSnapshot?: MissionSnapshot;
}

export async function saveEnglishReview(params: SaveReviewParams): Promise<{ id: string }> {
  if (!params.originalText.trim()) throw new Error('originalText não pode estar vazio');
  if (typeof params.feedback.score !== 'number') throw new Error('score inválido');
  if (!params.feedback.level) throw new Error('level inválido');

  const { data: { user } } = await supabase.auth.getUser();

  const mainMistakes = Array.isArray(params.feedback.mainMistakes) ? params.feedback.mainMistakes : [];
  const newVocabulary = Array.isArray(params.feedback.newVocabulary) ? params.feedback.newVocabulary : [];

  const { data, error } = await supabase
    .from('english_reviews')
    .insert({
      user_id: user?.id ?? null,
      original_text: params.originalText.trim(),
      corrected_text: params.feedback.correctedText ?? null,
      score: params.feedback.score,
      level: params.feedback.level,
      grammar: params.feedback.grammar,
      vocabulary: params.feedback.vocabulary,
      naturalness: params.feedback.naturalness,
      fluency: params.feedback.fluency,
      summary: params.feedback.summary ?? null,
      main_mistakes: mainMistakes,
      new_vocabulary: newVocabulary,
      objective_feedback: params.feedback.objectiveFeedback ?? null,
      next_practice: params.feedback.nextPractice ?? null,
      category: params.category ?? null,
      difficulty: params.difficulty ?? null,
      objective: params.objective ?? null,
      entry_date: params.entryDate ?? null,
      mission_snapshot: params.missionSnapshot ?? null,
    })
    .select('id')
    .single();

  if (error) throw new Error(error.message);
  return { id: (data as { id: string }).id };
}

export async function updateReviewV2(
  reviewId: string,
  v2Text: string,
  v2Comparison: RewriteComparisonResult,
): Promise<void> {
  const { error } = await supabase
    .from('english_reviews')
    .update({
      version_2_text: v2Text,
      version_2_comparison: v2Comparison,
      version_2_improvement_score: v2Comparison.improvementScore,
    })
    .eq('id', reviewId);
  if (error) throw new Error(error.message);
}

export async function updateV2FinalText(
  reviewId: string,
  v2FinalText: string,
): Promise<void> {
  const { error } = await supabase
    .from('english_reviews')
    .update({ version_2_final_text: v2FinalText })
    .eq('id', reviewId);
  if (error) throw new Error(error.message);
}
