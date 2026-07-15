import type {
  RawQuestionsResponse,
  RawGeneratedQuestion,
  ValidatedGeneratedQuestion,
} from './listening-question-schema';
import {
  LISTENING_QUESTION_TYPES,
  LISTENING_QUESTION_DIFFICULTIES,
} from '../../domain/listening/listening-types';
import type {
  ListeningQuestionType,
  ListeningQuestionDifficulty,
} from '../../domain/listening/listening-types';

export class QuestionParseError extends Error {
  readonly code = 'LISTENING_INVALID_QUESTION_JSON';
  constructor(message: string) {
    super(message);
    this.name = 'QuestionParseError';
  }
}

export class QuestionValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'QuestionValidationError';
    this.code = code;
  }
}

const QUESTION_TYPE_SET = new Set<string>(LISTENING_QUESTION_TYPES as ListeningQuestionType[]);
const DIFFICULTY_SET = new Set<string>(LISTENING_QUESTION_DIFFICULTIES as ListeningQuestionDifficulty[]);

const FORBIDDEN_OPTIONS = new Set([
  'all of the above',
  'none of the above',
  'all the above',
  'none the above',
]);

export function parseQuestionsJson(rawText: string): unknown {
  const trimmed = rawText.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new QuestionParseError('AI response contains no valid JSON object');
    try {
      return JSON.parse(match[0]);
    } catch {
      throw new QuestionParseError('Failed to parse JSON from AI question response');
    }
  }
}

function normalizeOption(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function validateSingleQuestion(
  raw: RawGeneratedQuestion,
  sentenceKeysByBlock: Map<number, Set<string>> | undefined,
): ValidatedGeneratedQuestion {
  const { questionOrder, blockOrder } = raw;

  if (questionOrder !== 1 && questionOrder !== 2) {
    throw new QuestionValidationError('LISTENING_INVALID_QUESTION_COUNT',
      `questionOrder must be 1 or 2, got: ${questionOrder}`);
  }
  if (blockOrder !== 1 && blockOrder !== 2) {
    throw new QuestionValidationError('LISTENING_INVALID_BLOCK_STRUCTURE',
      `blockOrder must be 1 or 2, got: ${blockOrder}`);
  }
  if (questionOrder !== blockOrder) {
    throw new QuestionValidationError('LISTENING_INVALID_BLOCK_STRUCTURE',
      `questionOrder (${questionOrder}) must match blockOrder (${blockOrder})`);
  }

  if (typeof raw.prompt !== 'string' || raw.prompt.trim() === '') {
    throw new QuestionValidationError('LISTENING_INVALID_QUESTION_JSON',
      `Question ${questionOrder}: prompt is empty`);
  }

  if (!Array.isArray(raw.options)) {
    throw new QuestionValidationError('LISTENING_INVALID_OPTIONS',
      `Question ${questionOrder}: options must be an array`);
  }
  if (raw.options.length !== 3) {
    throw new QuestionValidationError('LISTENING_INVALID_OPTIONS',
      `Question ${questionOrder}: must have exactly 3 options, got ${raw.options.length}`);
  }
  for (let i = 0; i < raw.options.length; i++) {
    if (typeof raw.options[i] !== 'string' || raw.options[i].trim() === '') {
      throw new QuestionValidationError('LISTENING_INVALID_OPTIONS',
        `Question ${questionOrder}: option ${i} is empty`);
    }
    const norm = normalizeOption(raw.options[i]);
    if (FORBIDDEN_OPTIONS.has(norm)) {
      throw new QuestionValidationError('LISTENING_INVALID_OPTIONS',
        `Question ${questionOrder}: option "${raw.options[i]}" is not allowed`);
    }
  }

  // Check duplicate options after normalization
  const normalizedOpts = raw.options.map(normalizeOption);
  const uniqueOpts = new Set(normalizedOpts);
  if (uniqueOpts.size !== 3) {
    throw new QuestionValidationError('LISTENING_INVALID_OPTIONS',
      `Question ${questionOrder}: options must all be distinct (found duplicates after normalization)`);
  }

  if (typeof raw.correctOption !== 'number' || raw.correctOption < 0 || raw.correctOption > 2) {
    throw new QuestionValidationError('LISTENING_INVALID_CORRECT_OPTION',
      `Question ${questionOrder}: correctOption must be 0, 1, or 2, got: ${raw.correctOption}`);
  }

  if (typeof raw.explanationPt !== 'string' || raw.explanationPt.trim() === '') {
    throw new QuestionValidationError('LISTENING_INVALID_QUESTION_JSON',
      `Question ${questionOrder}: explanationPt is empty`);
  }

  if (!QUESTION_TYPE_SET.has(raw.questionType)) {
    throw new QuestionValidationError('LISTENING_INVALID_QUESTION_JSON',
      `Question ${questionOrder}: questionType "${raw.questionType}" is not allowed. Allowed: ${LISTENING_QUESTION_TYPES.join(', ')}`);
  }

  if (!DIFFICULTY_SET.has(raw.difficulty)) {
    throw new QuestionValidationError('LISTENING_INVALID_QUESTION_JSON',
      `Question ${questionOrder}: difficulty "${raw.difficulty}" is not valid. Allowed: ${LISTENING_QUESTION_DIFFICULTIES.join(', ')}`);
  }

  if (!Array.isArray(raw.evidenceSentenceKeys) || raw.evidenceSentenceKeys.length === 0) {
    throw new QuestionValidationError('LISTENING_INVALID_EVIDENCE',
      `Question ${questionOrder}: evidenceSentenceKeys must be a non-empty array`);
  }

  if (sentenceKeysByBlock) {
    const validKeysForBlock = sentenceKeysByBlock.get(blockOrder);
    if (!validKeysForBlock) {
      throw new QuestionValidationError('LISTENING_MISSING_SENTENCES',
        `No sentence keys found for block ${blockOrder}`);
    }
    for (const key of raw.evidenceSentenceKeys) {
      if (!validKeysForBlock.has(key)) {
        throw new QuestionValidationError('LISTENING_INVALID_EVIDENCE',
          `Question ${questionOrder}: evidence key "${key}" does not exist in block ${blockOrder}`);
      }
    }
  }

  // Check that answer is not in the prompt text itself
  const correctAnswerNorm = normalizeOption(raw.options[raw.correctOption]);
  const promptNorm = raw.prompt.toLowerCase();
  if (promptNorm.includes(correctAnswerNorm)) {
    throw new QuestionValidationError('LISTENING_AMBIGUOUS_QUESTION',
      `Question ${questionOrder}: the prompt appears to contain the correct answer`);
  }

  return {
    questionOrder: questionOrder as 1 | 2,
    blockOrder: blockOrder as 1 | 2,
    questionType: raw.questionType as ListeningQuestionType,
    prompt: raw.prompt.trim(),
    options: raw.options.map(o => o.trim()),
    correctOption: raw.correctOption,
    explanationPt: raw.explanationPt.trim(),
    evidenceSentenceKeys: raw.evidenceSentenceKeys,
    difficulty: raw.difficulty as ListeningQuestionDifficulty,
  };
}

/**
 * Validates the full set of generated questions deterministically.
 *
 * @param raw - Parsed JSON from AI response
 * @param sentenceKeysByBlock - Map of blockOrder → Set of valid sentence keys.
 *   When undefined (e.g. dry-run without DB), sentence key existence checks are skipped.
 */
export function validateGeneratedQuestions(
  raw: unknown,
  sentenceKeysByBlock?: Map<number, Set<string>>,
): [ValidatedGeneratedQuestion, ValidatedGeneratedQuestion] {
  if (!raw || typeof raw !== 'object') {
    throw new QuestionValidationError('LISTENING_INVALID_QUESTION_JSON',
      'AI response is not a JSON object');
  }

  const r = raw as Record<string, unknown>;

  if (!Array.isArray(r.questions)) {
    throw new QuestionValidationError('LISTENING_INVALID_QUESTION_JSON',
      'Response must have a "questions" array');
  }
  if (r.questions.length !== 2) {
    throw new QuestionValidationError('LISTENING_INVALID_QUESTION_COUNT',
      `Expected exactly 2 questions, got ${r.questions.length}`);
  }

  const rawQuestions = r.questions as RawGeneratedQuestion[];
  const orders = rawQuestions.map(q => q.questionOrder).sort((a, b) => a - b);
  if (orders[0] !== 1 || orders[1] !== 2) {
    throw new QuestionValidationError('LISTENING_INVALID_QUESTION_COUNT',
      `Question orders must be [1, 2], got [${orders.join(', ')}]`);
  }

  const blockOrders = rawQuestions.map(q => q.blockOrder).sort((a, b) => a - b);
  if (blockOrders[0] !== 1 || blockOrders[1] !== 2) {
    throw new QuestionValidationError('LISTENING_INVALID_BLOCK_STRUCTURE',
      `Question blockOrders must be [1, 2], got [${blockOrders.join(', ')}]`);
  }

  const sorted = [...rawQuestions].sort((a, b) => a.questionOrder - b.questionOrder);
  const q1 = validateSingleQuestion(sorted[0], sentenceKeysByBlock);
  const q2 = validateSingleQuestion(sorted[1], sentenceKeysByBlock);

  // Cross-block evidence check: Q1 must not use block 2 sentences (only when DB keys available)
  if (sentenceKeysByBlock) {
    const block2Keys = sentenceKeysByBlock.get(2) ?? new Set<string>();
    for (const key of q1.evidenceSentenceKeys) {
      if (block2Keys.has(key)) {
        throw new QuestionValidationError('LISTENING_INVALID_EVIDENCE',
          `Question 1 uses evidence key "${key}" from block 2, which is not allowed`);
      }
    }
  }

  // Q2 must use at least one block 2 sentence (already validated per-block above)

  return [q1, q2];
}
