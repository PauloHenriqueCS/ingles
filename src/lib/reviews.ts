import { supabase } from './supabase';
import { AIFeedback } from '../types';

export interface SaveReviewParams {
  originalText: string;
  feedback: AIFeedback;
  category?: string;
  difficulty?: string;
  objective?: string;
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
    })
    .select('id')
    .single();

  if (error) throw new Error(error.message);
  return { id: (data as { id: string }).id };
}
