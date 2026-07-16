import { countWords, WORD_COUNT_RANGES } from './listening-level-config';
import type { ValidatedStory, ValidatedBlock } from './listening-story-schema';
import { segmentListeningText, SentenceSegmentationError } from './segment-listening-story-text';

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

function validateBlock(raw: Record<string, unknown>, cefrLevel: string): ValidatedBlock {
  const blockOrder = raw.block_order;
  if (blockOrder !== 1 && blockOrder !== 2) {
    throw new StoryValidationError(`Invalid block_order: ${blockOrder}`);
  }

  if (typeof raw.text_en !== 'string' || raw.text_en.trim() === '') {
    throw new StoryValidationError(`Block ${blockOrder} has empty text_en`);
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

  try {
    const sentences = segmentListeningText(raw.text_en, blockOrder as 1 | 2);
    return { blockOrder: blockOrder as 1 | 2, textEn: raw.text_en, wordCount, sentences };
  } catch (err) {
    if (err instanceof SentenceSegmentationError) {
      throw new StoryValidationError(`Block ${blockOrder}: ${err.message}`);
    }
    throw err;
  }
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

  const rawBlocks = r.blocks as Record<string, unknown>[];
  const orders = rawBlocks.map(b => b.block_order as number).sort((a, b) => a - b);
  if (orders[0] !== 1 || orders[1] !== 2) {
    throw new StoryValidationError(
      `Block orders must be [1, 2], got: [${orders.join(', ')}]`
    );
  }

  const sorted = [...rawBlocks].sort((a, b) => (a.block_order as number) - (b.block_order as number));
  const block1 = validateBlock(sorted[0], cefrLevel);
  const block2 = validateBlock(sorted[1], cefrLevel);

  return {
    title: r.title.trim(),
    synopsis: (r.synopsis as string).trim(),
    cefrLevel,
    blocks: [block1, block2],
  };
}
