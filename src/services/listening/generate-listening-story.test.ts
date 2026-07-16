import { describe, it, expect, vi } from 'vitest';
import { countWords } from './listening-level-config';
import { buildStoryUserPrompt, buildRetryUserPrompt } from './build-listening-story-prompt';
import {
  parseStoryJson,
  validateListeningStoryResponse,
  StoryValidationError,
  StoryParseError,
} from './validate-listening-story';
import {
  generateListeningStory,
  StoryAITimeoutError,
  buildIdempotencyKey,
} from './generate-listening-story';
import type { AICallFn } from './generate-listening-story';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeWords(n: number): string {
  return Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
}

function makeRawSentence(
  blockOrder: 1 | 2,
  sentenceOrder: number,
  text: string,
  paragraphOrder = 1,
) {
  return {
    sentence_key: `b${blockOrder}s${String(sentenceOrder).padStart(2, '0')}`,
    sentence_order: sentenceOrder,
    paragraph_order: paragraphOrder,
    speaker: null,
    text_en: text,
  };
}

function makeRawBlock(blockOrder: 1 | 2, wordCount: number, questionOrder: 1 | 2) {
  const text = makeWords(wordCount);
  const words = text.split(' ');
  const half = Math.floor(words.length / 2);
  const s1 = words.slice(0, half).join(' ');
  const s2 = words.slice(half).join(' ');
  return {
    block_order: blockOrder,
    text_en: text,
    translation_pt: 'Tradução do bloco.',
    sentences: [
      makeRawSentence(blockOrder, 1, s1),
      makeRawSentence(blockOrder, 2, s2),
    ],
    question: {
      question_order: questionOrder,
      prompt: 'What is this story about?',
      options_json: ['Option A', 'Option B', 'Option C', 'Option D'],
      correct_option: 0,
      explanation_pt: 'Porque a opção A está correta.',
    },
  };
}

function makeValidRawStory(level = 'A1') {
  const wc = level === 'A1' ? 420 : level === 'B2' ? 570 : 420;
  return {
    title: 'A Day at the Market',
    synopsis: 'A short story about a visit to the local market.',
    blocks: [makeRawBlock(1, wc, 1), makeRawBlock(2, wc, 2)],
  };
}

// ── Group 1: countWords ────────────────────────────────────────────────────────

describe('countWords', () => {
  it('empty string returns 0', () => {
    expect(countWords('')).toBe(0);
  });

  it('counts words correctly', () => {
    expect(countWords('hello world foo')).toBe(3);
  });
});

// ── Group 2: buildStoryUserPrompt ─────────────────────────────────────────────

describe('buildStoryUserPrompt', () => {
  it('A1 prompt includes correct word count range', () => {
    const prompt = buildStoryUserPrompt({ cefrLevel: 'A1' });
    expect(prompt).toContain('400–475');
  });

  it('B2 prompt includes correct word count range', () => {
    const prompt = buildStoryUserPrompt({ cefrLevel: 'B2' });
    expect(prompt).toContain('550–625');
  });

  it('includes theme when provided', () => {
    const prompt = buildStoryUserPrompt({ cefrLevel: 'A1', theme: 'cooking' });
    expect(prompt).toContain('cooking');
  });

  it('does not include theme line when theme is null', () => {
    const prompt = buildStoryUserPrompt({ cefrLevel: 'A1', theme: null });
    expect(prompt).not.toContain('Theme:');
  });
});

// ── Group 2b: buildRetryUserPrompt ───────────────────────────────────────────

describe('buildRetryUserPrompt', () => {
  it('includes "Previous attempt" with the attempt number', () => {
    const prompt = buildRetryUserPrompt({ cefrLevel: 'A1' }, 2, 'Block 1 word count (233) is below minimum (400)');
    expect(prompt).toContain('Previous attempt 1');
  });

  it('includes the exact previous error message', () => {
    const error = 'Block 1 word count (233) is below minimum (400) for level A1';
    const prompt = buildRetryUserPrompt({ cefrLevel: 'A1' }, 2, error);
    expect(prompt).toContain(error);
  });

  it('includes instruction to regenerate COMPLETE JSON', () => {
    const prompt = buildRetryUserPrompt({ cefrLevel: 'A1' }, 2, 'some error');
    expect(prompt).toContain('Regenerate the COMPLETE JSON');
  });

  it('includes the min and max word counts', () => {
    const prompt = buildRetryUserPrompt({ cefrLevel: 'A1' }, 2, 'some error');
    expect(prompt).toContain('400');
    expect(prompt).toContain('475');
  });
});

// ── Group 3: parseStoryJson ───────────────────────────────────────────────────

describe('parseStoryJson', () => {
  it('parses valid JSON correctly', () => {
    const result = parseStoryJson('{"title":"Test"}');
    expect((result as Record<string, unknown>).title).toBe('Test');
  });

  it('extracts JSON from markdown code fences', () => {
    const raw = '```json\n{"title":"Test"}\n```';
    const result = parseStoryJson(raw);
    expect((result as Record<string, unknown>).title).toBe('Test');
  });
});

// ── Group 4: validateListeningStoryResponse — structure ───────────────────────

describe('validateListeningStoryResponse — structure', () => {
  it('throws StoryValidationError when title is empty', () => {
    const raw = { ...makeValidRawStory(), title: '' };
    expect(() => validateListeningStoryResponse(raw, 'A1')).toThrow(StoryValidationError);
  });

  it('throws when blocks count is 1', () => {
    const raw = makeValidRawStory();
    const oneBlock = { ...raw, blocks: [raw.blocks[0]] };
    expect(() => validateListeningStoryResponse(oneBlock, 'A1')).toThrow(StoryValidationError);
  });

  it('throws when blocks count is 3', () => {
    const raw = makeValidRawStory();
    const threeBlocks = { ...raw, blocks: [...raw.blocks, raw.blocks[0]] };
    expect(() => validateListeningStoryResponse(threeBlocks, 'A1')).toThrow(StoryValidationError);
  });

  it('throws when block_orders are duplicate [1, 1]', () => {
    const raw = makeValidRawStory();
    const dupBlocks = { ...raw, blocks: [raw.blocks[0], { ...raw.blocks[1], block_order: 1 }] };
    expect(() => validateListeningStoryResponse(dupBlocks, 'A1')).toThrow(StoryValidationError);
  });

  it('throws when sentences array is empty', () => {
    const raw = makeValidRawStory();
    const noSentences = {
      ...raw,
      blocks: [{ ...raw.blocks[0], sentences: [] }, raw.blocks[1]],
    };
    expect(() => validateListeningStoryResponse(noSentences, 'A1')).toThrow(StoryValidationError);
  });

  it('valid response passes validation', () => {
    const raw = makeValidRawStory('A1');
    const story = validateListeningStoryResponse(raw, 'A1');
    expect(story.title).toBe('A Day at the Market');
    expect(story.blocks.length).toBe(2);
  });
});

// ── Group 5: validateListeningStoryResponse — word count ──────────────────────

describe('validateListeningStoryResponse — word count', () => {
  it('throws when block word count is below A1 minimum', () => {
    const raw = makeValidRawStory();
    const tooShort = {
      ...raw,
      blocks: [makeRawBlock(1, 200, 1), makeRawBlock(2, 420, 2)],
    };
    expect(() => validateListeningStoryResponse(tooShort, 'A1')).toThrow(StoryValidationError);
  });

  it('throws when block word count exceeds A1 maximum', () => {
    const raw = makeValidRawStory();
    const tooLong = {
      ...raw,
      blocks: [makeRawBlock(1, 600, 1), makeRawBlock(2, 420, 2)],
    };
    expect(() => validateListeningStoryResponse(tooLong, 'A1')).toThrow(StoryValidationError);
  });

  it('passes when word count is exactly at A1 minimum', () => {
    const raw = makeValidRawStory();
    const exact = {
      ...raw,
      blocks: [makeRawBlock(1, 400, 1), makeRawBlock(2, 400, 2)],
    };
    expect(() => validateListeningStoryResponse(exact, 'A1')).not.toThrow();
  });
});

// ── Group 5b: validateListeningStoryResponse — word count boundaries ──────────

describe('validateListeningStoryResponse — word count boundaries', () => {
  it('rejects a block with exactly 399 words', () => {
    const raw = { ...makeValidRawStory(), blocks: [makeRawBlock(1, 399, 1), makeRawBlock(2, 420, 2)] };
    expect(() => validateListeningStoryResponse(raw, 'A1')).toThrow(StoryValidationError);
  });

  it('accepts a block with exactly 475 words (A1 maximum)', () => {
    const raw = { ...makeValidRawStory(), blocks: [makeRawBlock(1, 475, 1), makeRawBlock(2, 420, 2)] };
    expect(() => validateListeningStoryResponse(raw, 'A1')).not.toThrow();
  });

  it('rejects a block with exactly 476 words (one above A1 maximum)', () => {
    const raw = { ...makeValidRawStory(), blocks: [makeRawBlock(1, 476, 1), makeRawBlock(2, 420, 2)] };
    expect(() => validateListeningStoryResponse(raw, 'A1')).toThrow(StoryValidationError);
  });

  it('validates both blocks independently — error in block 2 while block 1 is valid', () => {
    const raw = { ...makeValidRawStory(), blocks: [makeRawBlock(1, 420, 1), makeRawBlock(2, 200, 2)] };
    let err: StoryValidationError | null = null;
    try {
      validateListeningStoryResponse(raw, 'A1');
    } catch (e) {
      err = e as StoryValidationError;
    }
    expect(err).toBeInstanceOf(StoryValidationError);
    expect(err!.message).toContain('Block 2');
  });
});

// ── Group 6: validateListeningStoryResponse — question validation ─────────────

describe('validateListeningStoryResponse — question', () => {
  it('throws when correct_option is out of range', () => {
    const raw = makeValidRawStory();
    const badBlock = {
      ...raw.blocks[0],
      question: { ...raw.blocks[0].question, correct_option: 99 },
    };
    const story = { ...raw, blocks: [badBlock, raw.blocks[1]] };
    expect(() => validateListeningStoryResponse(story, 'A1')).toThrow(StoryValidationError);
  });

  it('throws when options_json has fewer than 2 options', () => {
    const raw = makeValidRawStory();
    const badBlock = {
      ...raw.blocks[0],
      question: { ...raw.blocks[0].question, options_json: ['Only one'] },
    };
    const story = { ...raw, blocks: [badBlock, raw.blocks[1]] };
    expect(() => validateListeningStoryResponse(story, 'A1')).toThrow(StoryValidationError);
  });

  it('throws when correct_option is negative', () => {
    const raw = makeValidRawStory();
    const badBlock = {
      ...raw.blocks[0],
      question: { ...raw.blocks[0].question, correct_option: -1 },
    };
    const story = { ...raw, blocks: [badBlock, raw.blocks[1]] };
    expect(() => validateListeningStoryResponse(story, 'A1')).toThrow(StoryValidationError);
  });
});

// ── Group 7: generateListeningStory — mocked callAI ──────────────────────────

describe('generateListeningStory — mocked callAI', () => {
  function makeValidAIResponse(level = 'A1'): string {
    return JSON.stringify(makeValidRawStory(level));
  }

  it('successful generation returns a ValidatedStory in dry-run mode', async () => {
    const callAI: AICallFn = vi.fn().mockResolvedValue(makeValidAIResponse('A1'));
    const result = await generateListeningStory({ cefrLevel: 'A1', dryRun: true }, callAI);
    expect(result.episodeId).toBeNull();
    expect(result.story.title).toBe('A Day at the Market');
    expect(result.story.blocks.length).toBe(2);
  });

  it('retries after JSON parse error and succeeds on second attempt', async () => {
    const callAI: AICallFn = vi.fn()
      .mockResolvedValueOnce('not json at all %%')
      .mockResolvedValueOnce(makeValidAIResponse('A1'));
    const result = await generateListeningStory({ cefrLevel: 'A1', dryRun: true }, callAI);
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(result.story.title).toBe('A Day at the Market');
  });

  it('throws StoryParseError after 3 failed parse attempts', async () => {
    const callAI: AICallFn = vi.fn().mockResolvedValue('not json %%');
    await expect(
      generateListeningStory({ cefrLevel: 'A1', dryRun: true }, callAI)
    ).rejects.toThrow(StoryParseError);
    expect(callAI).toHaveBeenCalledTimes(3);
  });

  it('throws StoryAITimeoutError when AI throws a timeout error', async () => {
    const timeoutErr = Object.assign(new Error('timeout'), { message: 'timeout' });
    const callAI: AICallFn = vi.fn().mockRejectedValue(timeoutErr);
    await expect(
      generateListeningStory({ cefrLevel: 'A1', dryRun: true }, callAI)
    ).rejects.toThrow(StoryAITimeoutError);
  });

  it('dry-run mode returns null episodeId without calling supabase', async () => {
    const callAI: AICallFn = vi.fn().mockResolvedValue(makeValidAIResponse('A1'));
    const mockSupabase = vi.fn();
    const result = await generateListeningStory(
      { cefrLevel: 'A1', dryRun: true },
      callAI,
      mockSupabase as unknown as Parameters<typeof generateListeningStory>[2],
    );
    expect(result.episodeId).toBeNull();
    expect(mockSupabase).not.toHaveBeenCalled();
  });
});

// ── Group 7b: generateListeningStory — retry with error feedback ──────────────

describe('generateListeningStory — retry feedback', () => {
  function makeTooShortStory(block1Words: number, block2Words: number): string {
    return JSON.stringify({
      title: 'Test',
      synopsis: 'Test synopsis.',
      blocks: [makeRawBlock(1, block1Words, 1), makeRawBlock(2, block2Words, 2)],
    });
  }

  it('first attempt receives normal prompt without "Previous attempt"', async () => {
    const callAI: AICallFn = vi.fn().mockResolvedValue(JSON.stringify(makeValidRawStory('A1')));
    await generateListeningStory({ cefrLevel: 'A1', dryRun: true }, callAI);
    const [, firstPrompt] = (callAI as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(firstPrompt).not.toContain('Previous attempt');
  });

  it('second attempt includes error from first attempt', async () => {
    const callAI: AICallFn = vi.fn()
      .mockResolvedValueOnce(makeTooShortStory(200, 420))
      .mockResolvedValueOnce(JSON.stringify(makeValidRawStory('A1')));
    await generateListeningStory({ cefrLevel: 'A1', dryRun: true }, callAI);
    expect(callAI).toHaveBeenCalledTimes(2);
    const [, secondPrompt] = (callAI as ReturnType<typeof vi.fn>).mock.calls[1] as [string, string];
    expect(secondPrompt).toContain('Previous attempt 1');
    expect(secondPrompt).toContain('below minimum');
  });

  it('third attempt includes error from second attempt', async () => {
    const callAI: AICallFn = vi.fn()
      .mockResolvedValueOnce(makeTooShortStory(200, 420))
      .mockResolvedValueOnce(makeTooShortStory(250, 420))
      .mockResolvedValueOnce(JSON.stringify(makeValidRawStory('A1')));
    await generateListeningStory({ cefrLevel: 'A1', dryRun: true }, callAI);
    expect(callAI).toHaveBeenCalledTimes(3);
    const [, thirdPrompt] = (callAI as ReturnType<typeof vi.fn>).mock.calls[2] as [string, string];
    expect(thirdPrompt).toContain('Previous attempt 2');
    expect(thirdPrompt).toContain('250');
  });

  it('error in one block forces full regeneration on next attempt', async () => {
    const callAI: AICallFn = vi.fn()
      .mockResolvedValueOnce(makeTooShortStory(420, 200))
      .mockResolvedValueOnce(JSON.stringify(makeValidRawStory('A1')));
    await generateListeningStory({ cefrLevel: 'A1', dryRun: true }, callAI);
    expect(callAI).toHaveBeenCalledTimes(2);
    const [, secondPrompt] = (callAI as ReturnType<typeof vi.fn>).mock.calls[1] as [string, string];
    expect(secondPrompt).toContain('Regenerate the COMPLETE JSON');
    expect(secondPrompt).toContain('Block 2');
  });
});

// ── Group 8: buildIdempotencyKey ──────────────────────────────────────────────

describe('buildIdempotencyKey', () => {
  it('same inputs produce the same key', () => {
    const k1 = buildIdempotencyKey({ cefrLevel: 'A1', theme: 'travel', seed: null });
    const k2 = buildIdempotencyKey({ cefrLevel: 'A1', theme: 'travel', seed: null });
    expect(k1).toBe(k2);
  });

  it('different levels produce different keys', () => {
    const k1 = buildIdempotencyKey({ cefrLevel: 'A1' });
    const k2 = buildIdempotencyKey({ cefrLevel: 'B2' });
    expect(k1).not.toBe(k2);
  });

  it('different themes produce different keys', () => {
    const k1 = buildIdempotencyKey({ cefrLevel: 'A1', theme: 'travel' });
    const k2 = buildIdempotencyKey({ cefrLevel: 'A1', theme: 'cooking' });
    expect(k1).not.toBe(k2);
  });
});
