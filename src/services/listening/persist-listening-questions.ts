import type { SupabaseClient } from '@supabase/supabase-js';
import type { ValidatedGeneratedQuestion, QuestionAIValidationResult } from './listening-question-schema';
import { GENERATOR_PROMPT_VERSION, VALIDATOR_PROMPT_VERSION } from './build-listening-question-prompt';

export class ListeningQuestionPersistenceError extends Error {
  readonly code = 'LISTENING_QUESTION_PERSISTENCE_ERROR';
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ListeningQuestionPersistenceError';
  }
}

export interface PersistListeningQuestionsInput {
  supabase: SupabaseClient;
  episodeId: string;
  blockIdByOrder: Map<number, string>;
  questions: [ValidatedGeneratedQuestion, ValidatedGeneratedQuestion];
  validationResults: [QuestionAIValidationResult, QuestionAIValidationResult];
  cefrLevel: string;
}

async function deleteExistingQuestions(
  supabase: SupabaseClient,
  episodeId: string,
): Promise<void> {
  const { error } = await supabase
    .from('listening_questions')
    .delete()
    .eq('episode_id', episodeId);

  if (error) {
    throw new ListeningQuestionPersistenceError(
      `Failed to delete existing questions for episode ${episodeId}: ${error.message}`,
      error,
    );
  }
}

async function insertQuestion(
  supabase: SupabaseClient,
  episodeId: string,
  blockId: string,
  question: ValidatedGeneratedQuestion,
  validationResult: QuestionAIValidationResult,
): Promise<string> {
  const { data, error } = await supabase
    .from('listening_questions')
    .insert({
      episode_id: episodeId,
      block_id: blockId,
      question_order: question.questionOrder,
      prompt: question.prompt,
      options_json: question.options,
      correct_option: question.correctOption,
      explanation_pt: question.explanationPt,
      max_attempts: 3,
      question_type: question.questionType,
      difficulty: question.difficulty,
      evidence_sentence_keys: question.evidenceSentenceKeys,
      validation_status: 'valid',
      validation_notes: validationResult,
      generator_prompt_version: GENERATOR_PROMPT_VERSION,
      validator_prompt_version: VALIDATOR_PROMPT_VERSION,
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new ListeningQuestionPersistenceError(
      `Failed to insert question ${question.questionOrder} for episode ${episodeId}: ${error?.message ?? 'no data returned'}`,
      error,
    );
  }

  return (data as { id: string }).id;
}

async function updateEpisodeQuestionsStatus(
  supabase: SupabaseClient,
  episodeId: string,
  status: 'ready' | 'failed',
): Promise<void> {
  const update: Record<string, unknown> = { questions_status: status };
  if (status === 'ready') {
    update.questions_generated_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from('listening_episodes')
    .update(update)
    .eq('id', episodeId);

  if (error) {
    throw new ListeningQuestionPersistenceError(
      `Failed to update episode ${episodeId} questions_status to ${status}: ${error.message}`,
      error,
    );
  }
}

/**
 * Persiste as duas perguntas geradas para o episódio.
 *
 * Comportamento transacional simulado:
 * 1. Remove perguntas existentes do episódio.
 * 2. Insere pergunta 1.
 * 3. Se falhar, marca episódio como 'failed' e relança.
 * 4. Insere pergunta 2.
 * 5. Se falhar, remove a pergunta 1 recém-inserida, marca 'failed' e relança.
 * 6. Marca episódio como 'ready'.
 */
export async function persistListeningQuestions(
  input: PersistListeningQuestionsInput,
): Promise<void> {
  const { supabase, episodeId, blockIdByOrder, questions, validationResults } = input;

  // 1. Remover perguntas antigas
  await deleteExistingQuestions(supabase, episodeId);

  // 2. Inserir pergunta 1
  let q1Id: string;
  try {
    const blockId1 = blockIdByOrder.get(questions[0].blockOrder);
    if (!blockId1) {
      throw new ListeningQuestionPersistenceError(
        `Block ID not found for block order ${questions[0].blockOrder}`
      );
    }
    q1Id = await insertQuestion(supabase, episodeId, blockId1, questions[0], validationResults[0]);
  } catch (err) {
    await updateEpisodeQuestionsStatus(supabase, episodeId, 'failed').catch(() => {});
    throw err;
  }

  // 3. Inserir pergunta 2
  try {
    const blockId2 = blockIdByOrder.get(questions[1].blockOrder);
    if (!blockId2) {
      throw new ListeningQuestionPersistenceError(
        `Block ID not found for block order ${questions[1].blockOrder}`
      );
    }
    await insertQuestion(supabase, episodeId, blockId2, questions[1], validationResults[1]);
  } catch (err) {
    // Tentar remover a pergunta 1 já inserida para evitar estado parcial
    try { await supabase.from('listening_questions').delete().eq('id', q1Id); } catch {}
    try { await updateEpisodeQuestionsStatus(supabase, episodeId, 'failed'); } catch {}
    throw err;
  }

  // 4. Marcar episódio como pronto
  await updateEpisodeQuestionsStatus(supabase, episodeId, 'ready');
}
