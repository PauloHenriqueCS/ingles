import { countWords, WORD_COUNT_RANGES } from './listening-level-config';
import type {
  RawStoryBlock,
  ValidatedStory,
  ValidatedBlock,
  ValidatedSentence,
  ValidatedQuestion,
} from './listening-story-schema';

export class StoryValidationError extends Error {
  readonly code = 'STORY_VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'StoryValidationError';
  }
}

export class StoryParseError extends Error {
  readonly code = 'STORY_PARSE_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'StoryParseError';
  }
}

export function parseStoryJson(rawText: string): unknown {
  const trimmed = rawText.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new StoryParseError('AI response contains no valid JSON object');
    try {
      return JSON.parse(match[0]);
    } catch {
      throw new StoryParseError('Failed to parse extracted JSON from AI response');
    }
  }
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function validateSentences(sentences: unknown, blockOrder: number, textEn: string): ValidatedSentence[] {
  if (!Array.isArray(sentences) || sentences.length === 0) {
    throw new StoryValidationError(`Block ${blockOrder} must have at least one sentence`);
  }

  const validated: ValidatedSentence[] = [];
  const keysSeen = new Set<string>();

  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i] as Record<string, unknown>;
    if (typeof s.sentence_key !== 'string' || s.sentence_key.trim() === '') {
      throw new StoryValidationError(`Block ${blockOrder} sentence ${i + 1} has invalid sentence_key`);
    }
    if (keysSeen.has(s.sentence_key)) {
      throw new StoryValidationError(`Block ${blockOrder} has duplicate sentence_key "${s.sentence_key}"`);
    }
    keysSeen.add(s.sentence_key);
    if (typeof s.text_en !== 'string' || s.text_en.trim() === '') {
      throw new StoryValidationError(`Block ${blockOrder} sentence ${i + 1} has empty text_en`);
    }
    if (typeof s.sentence_order !== 'number') {
      throw new StoryValidationError(`Block ${blockOrder} sentence ${i + 1} missing sentence_order`);
    }
    if (typeof s.paragraph_order !== 'number') {
      throw new StoryValidationError(`Block ${blockOrder} sentence ${i + 1} missing paragraph_order`);
    }
    const speaker = s.speaker === null || s.speaker === undefined ? null : String(s.speaker);
    validated.push({
      sentenceKey: s.sentence_key,
      sentenceOrder: s.sentence_order as number,
      paragraphOrder: s.paragraph_order as number,
      speaker,
      textEn: s.text_en,
    });
  }

  const reconstructed = normalizeWhitespace(validated.map(s => s.textEn).join(' '));
  const original = normalizeWhitespace(textEn);
  if (reconstructed !== original) {
    throw new StoryValidationError(
      `Block ${blockOrder}: sentence reconstruction does not match text_en (first 80 chars of original: "${original.slice(0, 80)}")`
    );
  }

  return validated;
}

function validateQuestion(q: unknown, blockOrder: number): ValidatedQuestion {
  if (!q || typeof q !== 'object') {
    throw new StoryValidationError(`Block ${blockOrder} is missing a question`);
  }
  const question = q as Record<string, unknown>;

  if (typeof question.prompt !== 'string' || question.prompt.trim() === '') {
    throw new StoryValidationError(`Block ${blockOrder} question is missing a prompt`);
  }
  if (!Array.isArray(question.options_json) || question.options_json.length < 2) {
    throw new StoryValidationError(
      `Block ${blockOrder} question must have at least 2 options, got: ${Array.isArray(question.options_json) ? question.options_json.length : 'none'}`
    );
  }
  if (
    typeof question.correct_option !== 'number' ||
    question.correct_option < 0 ||
    question.correct_option >= question.options_json.length
  ) {
    throw new StoryValidationError(
      `Block ${blockOrder} question correct_option (${question.correct_option}) is out of range for ${question.options_json.length} options`
    );
  }
  if (typeof question.explanation_pt !== 'string' || question.explanation_pt.trim() === '') {
    throw new StoryValidationError(`Block ${blockOrder} question is missing explanation_pt`);
  }
  const qOrder = question.question_order;
  if (qOrder !== 1 && qOrder !== 2) {
    throw new StoryValidationError(
      `Block ${blockOrder} question_order must be 1 or 2, got: ${qOrder}`
    );
  }

  return {
    questionOrder: qOrder as 1 | 2,
    prompt: question.prompt,
    optionsJson: question.options_json as string[],
    correctOption: question.correct_option as number,
    explanationPt: question.explanation_pt as string,
  };
}

function validateBlock(raw: RawStoryBlock, cefrLevel: string): ValidatedBlock {
  const blockOrder = raw.block_order;
  if (blockOrder !== 1 && blockOrder !== 2) {
    throw new StoryValidationError(`Invalid block_order: ${blockOrder}`);
  }

  if (typeof raw.text_en !== 'string' || raw.text_en.trim() === '') {
    throw new StoryValidationError(`Block ${blockOrder} has empty text_en`);
  }
  if (typeof raw.translation_pt !== 'string' || raw.translation_pt.trim() === '') {
    throw new StoryValidationError(`Block ${blockOrder} has empty translation_pt`);
  }

  const wordCount = countWords(raw.text_en);
  const range = WORD_COUNT_RANGES[cefrLevel as keyof typeof WORD_COUNT_RANGES];
  if (range) {
    if (wordCount < range.min) {
      throw new StoryValidationError(
        `Block ${blockOrder} word count (${wordCount}) is below minimum (${range.min}) for level ${cefrLevel}`
      );
    }
    if (wordCount > range.max) {
      throw new StoryValidationError(
        `Block ${blockOrder} word count (${wordCount}) exceeds maximum (${range.max}) for level ${cefrLevel}`
      );
    }
  }

  const sentences = validateSentences(raw.sentences, blockOrder, raw.text_en);
  const question = validateQuestion(raw.question, blockOrder);

  return {
    blockOrder: blockOrder as 1 | 2,
    textEn: raw.text_en,
    translationPt: raw.translation_pt,
    wordCount,
    sentences,
    question,
  };
}

export function validateListeningStoryResponse(raw: unknown, cefrLevel: string): ValidatedStory {
  if (!raw || typeof raw !== 'object') {
    throw new StoryValidationError('AI response is not a JSON object');
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.title !== 'string' || r.title.trim() === '') {
    throw new StoryValidationError('Story is missing a title');
  }
  if (typeof r.synopsis !== 'string' || r.synopsis.trim() === '') {
    throw new StoryValidationError('Story is missing a synopsis');
  }
  if (!Array.isArray(r.blocks)) {
    throw new StoryValidationError('Story is missing blocks array');
  }
  if (r.blocks.length !== 2) {
    throw new StoryValidationError(`Story must have exactly 2 blocks, got: ${r.blocks.length}`);
  }

  const rawBlocks = r.blocks as RawStoryBlock[];
  const orders = rawBlocks.map(b => b.block_order).sort((a, b) => a - b);
  if (orders[0] !== 1 || orders[1] !== 2) {
    throw new StoryValidationError(
      `Block orders must be [1, 2], got: [${orders.join(', ')}]`
    );
  }

  const sorted = [...rawBlocks].sort((a, b) => a.block_order - b.block_order);
  const block1 = validateBlock(sorted[0], cefrLevel);
  const block2 = validateBlock(sorted[1], cefrLevel);

  return {
    title: r.title.trim(),
    synopsis: (r.synopsis as string).trim(),
    cefrLevel,
    blocks: [block1, block2],
  };
}
