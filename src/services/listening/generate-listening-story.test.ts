import { describe, it, expect, vi } from 'vitest';
import { countWords } from './listening-level-config';
import {
  buildBlock1UserPrompt, buildBlock2UserPrompt,
  buildExpandBlockUserPrompt, buildCondenseBlockUserPrompt,
  buildStoryUserPrompt, buildRetryUserPrompt, buildTruncatedRetryUserPrompt,
  BLOCK1_SYSTEM_PROMPT, BLOCK2_SYSTEM_PROMPT,
  EXPAND_BLOCK_SYSTEM_PROMPT, CONDENSE_BLOCK_SYSTEM_PROMPT,
} from './build-listening-story-prompt';
import {
  parseStoryJson,
  validateListeningStoryResponse,
  StoryValidationError,
  StoryParseError,
} from './validate-listening-story';
import {
  generateListeningStory,
  StoryAITimeoutError,
  StoryOutputTruncatedError,
  StoryBlock1TooShortError,
  StoryBlock2TooShortError,
  StoryBlockTooLongError,
  buildIdempotencyKey,
} from './generate-listening-story';
import type { AICallFn } from './generate-listening-story';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeWords(n: number): string {
  return Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
}

/** Block 1 AI response: full structure with title/synopsis/outline/text_en */
function makeBlock1Response(wordCount = 440, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: 'A Day at the Market',
    synopsis: 'A short story about a visit to the local market.',
    outline: 'Maria visits the market and meets a friendly vendor who helps her find what she needs.',
    text_en: makeWords(wordCount),
    ...extra,
  });
}

/** Block 2 AI response: just text_en */
function makeBlock2Response(wordCount = 440): string {
  return JSON.stringify({ text_en: makeWords(wordCount) });
}

/** Happy-path callAI: returns valid block1 then valid block2 */
function makeHappyCallAI(level = 'A1'): AICallFn {
  const wc = level === 'A1' ? 440 : level === 'A2' ? 490 : level === 'B2' ? 570 : 440;
  return vi.fn()
    .mockResolvedValueOnce(makeBlock1Response(wc))
    .mockResolvedValueOnce(makeBlock2Response(wc));
}

// Legacy helpers for existing tests that test validateListeningStoryResponse
function makeRawSentence(blockOrder: 1 | 2, sentenceOrder: number, text: string, paragraphOrder = 1) {
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

// ── Group 2: buildBlock1UserPrompt ────────────────────────────────────────────

describe('buildBlock1UserPrompt', () => {
  it('A1 prompt includes correct word count range', () => {
    const prompt = buildBlock1UserPrompt({ cefrLevel: 'A1' });
    expect(prompt).toContain('400');
    expect(prompt).toContain('475');
  });

  it('B2 prompt includes correct word count range', () => {
    const prompt = buildBlock1UserPrompt({ cefrLevel: 'B2' });
    expect(prompt).toContain('550');
    expect(prompt).toContain('625');
  });

  it('includes theme when provided', () => {
    const prompt = buildBlock1UserPrompt({ cefrLevel: 'A1', theme: 'cooking' });
    expect(prompt).toContain('cooking');
  });

  it('does not include theme line when theme is null', () => {
    const prompt = buildBlock1UserPrompt({ cefrLevel: 'A1', theme: null });
    expect(prompt).not.toContain('Theme:');
  });

  it('includes target word count for A1', () => {
    const prompt = buildBlock1UserPrompt({ cefrLevel: 'A1' });
    expect(prompt).toContain('440'); // A1 target
  });
});

// ── Group 2b: buildBlock2UserPrompt ──────────────────────────────────────────

describe('buildBlock2UserPrompt', () => {
  const context = {
    title: 'The Market Visit',
    synopsis: 'Maria goes shopping.',
    outline: 'Maria visits the market and meets a vendor.',
    textEn: 'Maria walked to the market early in the morning.',
  };

  it('includes the title in the prompt', () => {
    const prompt = buildBlock2UserPrompt({ cefrLevel: 'A1' }, context);
    expect(prompt).toContain('The Market Visit');
  });

  it('includes the outline in the prompt', () => {
    const prompt = buildBlock2UserPrompt({ cefrLevel: 'A1' }, context);
    expect(prompt).toContain('Maria visits the market and meets a vendor.');
  });

  it('includes block 1 text in the prompt', () => {
    const prompt = buildBlock2UserPrompt({ cefrLevel: 'A1' }, context);
    expect(prompt).toContain('Maria walked to the market');
  });

  it('includes word count range', () => {
    const prompt = buildBlock2UserPrompt({ cefrLevel: 'A1' }, context);
    expect(prompt).toContain('400');
    expect(prompt).toContain('475');
  });
});

// ── Group 2c: buildExpandBlockUserPrompt ──────────────────────────────────────

describe('buildExpandBlockUserPrompt', () => {
  it('includes current word count', () => {
    const prompt = buildExpandBlockUserPrompt({ cefrLevel: 'A1' }, 1, makeWords(350), 350);
    expect(prompt).toContain('350');
  });

  it('includes the minimum word count', () => {
    const prompt = buildExpandBlockUserPrompt({ cefrLevel: 'A1' }, 1, makeWords(350), 350);
    expect(prompt).toContain('400');
  });

  it('includes the current block text', () => {
    const prompt = buildExpandBlockUserPrompt({ cefrLevel: 'A1' }, 1, 'Once upon a time.', 5);
    expect(prompt).toContain('Once upon a time.');
  });

  it('mentions expand/expand instruction', () => {
    const prompt = buildExpandBlockUserPrompt({ cefrLevel: 'A1' }, 1, makeWords(350), 350);
    expect(prompt.toLowerCase()).toContain('expand');
  });
});

// ── Group 2d: buildCondenseBlockUserPrompt ────────────────────────────────────

describe('buildCondenseBlockUserPrompt', () => {
  it('includes current word count and maximum', () => {
    const prompt = buildCondenseBlockUserPrompt({ cefrLevel: 'A1' }, 1, makeWords(500), 500);
    expect(prompt).toContain('500');
    expect(prompt).toContain('475'); // A1 max
  });

  it('mentions condense instruction', () => {
    const prompt = buildCondenseBlockUserPrompt({ cefrLevel: 'A1' }, 1, makeWords(500), 500);
    expect(prompt.toLowerCase()).toContain('condense');
  });
});

// ── Group 2e: backward-compat prompt functions ────────────────────────────────

describe('buildStoryUserPrompt (compat)', () => {
  it('A1 prompt includes correct word count range', () => {
    const prompt = buildStoryUserPrompt({ cefrLevel: 'A1' });
    expect(prompt).toContain('400');
    expect(prompt).toContain('475');
  });
});

describe('buildRetryUserPrompt (compat)', () => {
  it('includes "Previous attempt" with the attempt number', () => {
    const prompt = buildRetryUserPrompt({ cefrLevel: 'A1' }, 2, 'Block 1 word count (233) is below minimum (400)');
    expect(prompt).toContain('Previous attempt 1');
  });

  it('includes instruction to regenerate COMPLETE JSON', () => {
    const prompt = buildRetryUserPrompt({ cefrLevel: 'A1' }, 2, 'some error');
    expect(prompt).toContain('Regenerate the COMPLETE JSON');
  });
});

describe('buildTruncatedRetryUserPrompt (compat)', () => {
  it('includes "truncated" in the message', () => {
    const prompt = buildTruncatedRetryUserPrompt({ cefrLevel: 'A1' }, 2);
    expect(prompt.toLowerCase()).toContain('truncated');
  });

  it('includes instruction to return only required fields', () => {
    const prompt = buildTruncatedRetryUserPrompt({ cefrLevel: 'A1' }, 2);
    expect(prompt).toContain('required fields');
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

  it('ignores sentences array in raw block (slim schema)', () => {
    const raw = makeValidRawStory();
    const noSentences = {
      ...raw,
      blocks: [{ ...raw.blocks[0], sentences: [] }, raw.blocks[1]],
    };
    expect(() => validateListeningStoryResponse(noSentences, 'A1')).not.toThrow();
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

// ── Group 5b: word count boundaries ──────────────────────────────────────────

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
    try { validateListeningStoryResponse(raw, 'A1'); }
    catch (e) { err = e as StoryValidationError; }
    expect(err).toBeInstanceOf(StoryValidationError);
    expect(err!.message).toContain('Block 2');
  });
});

// ── Group 6: slim schema (no translation or question) ─────────────────────────

describe('validateListeningStoryResponse — slim schema', () => {
  it('accepts a block without translation_pt', () => {
    const raw = {
      title: 'Test', synopsis: 'Test synopsis.',
      blocks: [
        { block_order: 1, text_en: makeWords(420) },
        { block_order: 2, text_en: makeWords(420) },
      ],
    };
    expect(() => validateListeningStoryResponse(raw, 'A1')).not.toThrow();
  });

  it('accepts a block without question and derives sentences', () => {
    const raw = {
      title: 'Test', synopsis: 'Test synopsis.',
      blocks: [
        { block_order: 1, text_en: makeWords(420) },
        { block_order: 2, text_en: makeWords(420) },
      ],
    };
    const story = validateListeningStoryResponse(raw, 'A1');
    expect(story.blocks[0].sentences.length).toBeGreaterThan(0);
  });

  it('ignores extra fields like translation_pt and question', () => {
    const raw = makeValidRawStory('A1');
    expect(() => validateListeningStoryResponse(raw, 'A1')).not.toThrow();
  });
});

// ── Group 7: generateListeningStory — happy path and errors ──────────────────

describe('generateListeningStory — happy path', () => {
  it('successful generation (2 calls: block1 + block2) returns ValidatedStory in dry-run', async () => {
    const callAI = makeHappyCallAI('A1');
    const result = await generateListeningStory({ cefrLevel: 'A1', dryRun: true }, callAI);
    expect(result.episodeId).toBeNull();
    expect(result.story.title).toBe('A Day at the Market');
    expect(result.story.blocks.length).toBe(2);
    expect(callAI).toHaveBeenCalledTimes(2);
  });

  it('block 1 uses BLOCK1_SYSTEM_PROMPT', async () => {
    const callAI = makeHappyCallAI('A1');
    await generateListeningStory({ cefrLevel: 'A1', dryRun: true }, callAI);
    const [firstSystem] = (callAI as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(firstSystem).toBe(BLOCK1_SYSTEM_PROMPT);
  });

  it('block 2 uses BLOCK2_SYSTEM_PROMPT', async () => {
    const callAI = makeHappyCallAI('A1');
    await generateListeningStory({ cefrLevel: 'A1', dryRun: true }, callAI);
    const [secondSystem] = (callAI as ReturnType<typeof vi.fn>).mock.calls[1] as [string, string];
    expect(secondSystem).toBe(BLOCK2_SYSTEM_PROMPT);
  });

  it('dry-run mode returns null episodeId without calling supabase', async () => {
    const callAI = makeHappyCallAI('A1');
    const mockSupabase = vi.fn();
    const result = await generateListeningStory(
      { cefrLevel: 'A1', dryRun: true },
      callAI,
      mockSupabase as unknown as Parameters<typeof generateListeningStory>[2],
    );
    expect(result.episodeId).toBeNull();
    expect(mockSupabase).not.toHaveBeenCalled();
  });

  it('throws StoryAITimeoutError when AI throws a timeout error', async () => {
    const timeoutErr = Object.assign(new Error('timeout'), { message: 'timeout' });
    const callAI: AICallFn = vi.fn().mockRejectedValue(timeoutErr);
    await expect(
      generateListeningStory({ cefrLevel: 'A1', dryRun: true }, callAI)
    ).rejects.toThrow(StoryAITimeoutError);
  });
});

// ── Group 8: block 1 word count enforcement ───────────────────────────────────

describe('generateListeningStory — block 1 too short triggers expansion', () => {
  it('short block 1 is expanded without regenerating block 2', async () => {
    const callAI: AICallFn = vi.fn()
      .mockResolvedValueOnce(makeBlock1Response(350))   // block1: 350 words (below A1 min 400)
      .mockResolvedValueOnce(makeBlock2Response(440))   // expand block1: 440 words (valid)
      .mockResolvedValueOnce(makeBlock2Response(440));  // block2: 440 words (valid)

    const result = await generateListeningStory({ cefrLevel: 'A1', dryRun: true }, callAI);
    expect(callAI).toHaveBeenCalledTimes(3);
    expect(result.story.blocks[0].wordCount).toBe(440);
    // The expand call uses EXPAND_BLOCK_SYSTEM_PROMPT, not BLOCK2_SYSTEM_PROMPT
    const [secondSystem] = (callAI as ReturnType<typeof vi.fn>).mock.calls[1] as [string, string];
    expect(secondSystem).toBe(EXPAND_BLOCK_SYSTEM_PROMPT);
    // Block 2 is the 3rd call, using BLOCK2_SYSTEM_PROMPT
    const [thirdSystem] = (callAI as ReturnType<typeof vi.fn>).mock.calls[2] as [string, string];
    expect(thirdSystem).toBe(BLOCK2_SYSTEM_PROMPT);
  });

  it('A1 with exactly 399 words is rejected after all expand attempts', async () => {
    const callAI: AICallFn = vi.fn()
      .mockResolvedValueOnce(makeBlock1Response(399))  // initial: 399
      .mockResolvedValueOnce(makeBlock2Response(399))  // expand 1: still 399
      .mockResolvedValueOnce(makeBlock2Response(399)); // expand 2: still 399

    await expect(
      generateListeningStory({ cefrLevel: 'A1', dryRun: true }, callAI)
    ).rejects.toThrow(StoryBlock1TooShortError);
    expect(callAI).toHaveBeenCalledTimes(3);
  });

  it('A1 with exactly 400 words is accepted', async () => {
    const callAI: AICallFn = vi.fn()
      .mockResolvedValueOnce(makeBlock1Response(400))
      .mockResolvedValueOnce(makeBlock2Response(400));

    const result = await generateListeningStory({ cefrLevel: 'A1', dryRun: true }, callAI);
    expect(result.story.blocks[0].wordCount).toBe(400);
  });

  it('A2 with exactly 449 words is rejected', async () => {
    const callAI: AICallFn = vi.fn()
      .mockResolvedValueOnce(makeBlock1Response(449))
      .mockResolvedValueOnce(makeBlock2Response(449))
      .mockResolvedValueOnce(makeBlock2Response(449));

    await expect(
      generateListeningStory({ cefrLevel: 'A2', dryRun: true }, callAI)
    ).rejects.toThrow(StoryBlock1TooShortError);
  });

  it('A2 with exactly 450 words is accepted', async () => {
    const callAI: AICallFn = vi.fn()
      .mockResolvedValueOnce(makeBlock1Response(450))
      .mockResolvedValueOnce(makeBlock2Response(450));

    const result = await generateListeningStory({ cefrLevel: 'A2', dryRun: true }, callAI);
    expect(result.story.blocks[0].wordCount).toBe(450);
  });

  it('block 1 above maximum is condensed', async () => {
    const callAI: AICallFn = vi.fn()
      .mockResolvedValueOnce(makeBlock1Response(500))  // initial: 500 (A1 max is 475)
      .mockResolvedValueOnce(makeBlock2Response(440))  // condense: 440 (valid)
      .mockResolvedValueOnce(makeBlock2Response(440)); // block2: 440

    const result = await generateListeningStory({ cefrLevel: 'A1', dryRun: true }, callAI);
    expect(result.story.blocks[0].wordCount).toBe(440);
    const [secondSystem] = (callAI as ReturnType<typeof vi.fn>).mock.calls[1] as [string, string];
    expect(secondSystem).toBe(CONDENSE_BLOCK_SYSTEM_PROMPT);
  });
});

// ── Group 9: block 2 word count enforcement ───────────────────────────────────

describe('generateListeningStory — block 2 too short triggers expansion', () => {
  it('short block 2 is expanded without altering block 1', async () => {
    const callAI: AICallFn = vi.fn()
      .mockResolvedValueOnce(makeBlock1Response(440))  // block1: valid
      .mockResolvedValueOnce(makeBlock2Response(350))  // block2: 350 (below A1 min 400)
      .mockResolvedValueOnce(makeBlock2Response(440)); // expand block2: 440 (valid)

    const result = await generateListeningStory({ cefrLevel: 'A1', dryRun: true }, callAI);
    expect(callAI).toHaveBeenCalledTimes(3);
    expect(result.story.blocks[0].wordCount).toBe(440); // block 1 unchanged
    expect(result.story.blocks[1].wordCount).toBe(440);
    // The expand call uses EXPAND_BLOCK_SYSTEM_PROMPT
    const [thirdSystem] = (callAI as ReturnType<typeof vi.fn>).mock.calls[2] as [string, string];
    expect(thirdSystem).toBe(EXPAND_BLOCK_SYSTEM_PROMPT);
  });

  it('block 2 too short after all expand attempts throws StoryBlock2TooShortError', async () => {
    const callAI: AICallFn = vi.fn()
      .mockResolvedValueOnce(makeBlock1Response(440))  // block1: valid
      .mockResolvedValueOnce(makeBlock2Response(350))  // block2: 350
      .mockResolvedValueOnce(makeBlock2Response(350))  // expand 1: still 350
      .mockResolvedValueOnce(makeBlock2Response(350)); // expand 2: still 350

    await expect(
      generateListeningStory({ cefrLevel: 'A1', dryRun: true }, callAI)
    ).rejects.toThrow(StoryBlock2TooShortError);
    expect(callAI).toHaveBeenCalledTimes(4); // 1 block1 + 3 block2 attempts
  });
});

// ── Group 9b: block 2 too long — deterministic fallback after AI condense exhaustion ──

describe('generateListeningStory — block 2 too long triggers condense, then deterministic fallback', () => {
  function makeSentenceBlock(sentenceCount: number, wordsPerSentence: number): string {
    return Array.from({ length: sentenceCount }, (_, i) =>
      `Sentence number ${i + 1} has some extra ${Array.from({ length: wordsPerSentence - 6 }, (_, w) => `w${w}`).join(' ')} words.`
    ).join(' ');
  }

  it('condenses only block 2 without regenerating block 1 (reparo direcionado, not full regeneration)', async () => {
    const callAI: AICallFn = vi.fn()
      .mockResolvedValueOnce(makeBlock1Response(440)) // block1: valid, must stay untouched
      .mockResolvedValueOnce(makeBlock2Response(600))  // block2: 600 words (A1 max 475)
      .mockResolvedValueOnce(makeBlock2Response(440)); // condense: 440 (valid)

    const result = await generateListeningStory({ cefrLevel: 'A1', dryRun: true }, callAI);
    expect(callAI).toHaveBeenCalledTimes(3);
    expect(result.story.blocks[0].wordCount).toBe(440); // block 1 unchanged
    expect(result.story.blocks[1].wordCount).toBe(440);
    const [firstSystem] = (callAI as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(firstSystem).toBe(BLOCK1_SYSTEM_PROMPT);
    const [thirdSystem] = (callAI as ReturnType<typeof vi.fn>).mock.calls[2] as [string, string];
    expect(thirdSystem).toBe(CONDENSE_BLOCK_SYSTEM_PROMPT);
  });

  it('reproduces the reported failure (779 words, A1 max 475): AI condense exhausted, deterministic trim repairs it within [min,max] with no extra AI calls', async () => {
    const overLongBlock2 = makeSentenceBlock(80, 10); // 800 words, well-formed sentences
    const callAI: AICallFn = vi.fn()
      .mockResolvedValueOnce(makeBlock1Response(440))                              // block1: valid
      .mockResolvedValueOnce(JSON.stringify({ text_en: overLongBlock2 }))          // block2 initial: 800 words
      .mockResolvedValueOnce(JSON.stringify({ text_en: overLongBlock2 }))          // condense attempt 1: still 800
      .mockResolvedValueOnce(JSON.stringify({ text_en: overLongBlock2 }));         // condense attempt 2: still 800

    const result = await generateListeningStory({ cefrLevel: 'A1', dryRun: true }, callAI);

    // Exactly 4 AI calls total (1 block1 + 1 initial block2 + 2 condense retries) —
    // the deterministic repair adds zero further AI/OpenAI calls.
    expect(callAI).toHaveBeenCalledTimes(4);
    expect(result.story.blocks[1].wordCount).toBeGreaterThanOrEqual(400); // A1 min
    expect(result.story.blocks[1].wordCount).toBeLessThanOrEqual(475);   // A1 max
    // Deterministic trim only ever removes trailing sentences — never fabricates
    // content, so the repaired text must be an exact prefix of the AI's last draft.
    expect(overLongBlock2.startsWith(result.story.blocks[1].textEn)).toBe(true);
  });

  it('throws StoryBlockTooLongError when even deterministic trim cannot find a valid prefix', async () => {
    // A single giant run-on sentence: no sentence boundary to trim at, so the
    // deterministic fallback cannot produce a shorter whole-sentence text.
    const oneGiantSentence = `This is one single sentence with ${Array.from({ length: 700 }, (_, i) => `word${i}`).join(' ')} words in it and no other punctuation`;
    const callAI: AICallFn = vi.fn()
      .mockResolvedValueOnce(makeBlock1Response(440))
      .mockResolvedValueOnce(JSON.stringify({ text_en: oneGiantSentence }))
      .mockResolvedValueOnce(JSON.stringify({ text_en: oneGiantSentence }))
      .mockResolvedValueOnce(JSON.stringify({ text_en: oneGiantSentence }));

    await expect(
      generateListeningStory({ cefrLevel: 'A1', dryRun: true }, callAI)
    ).rejects.toThrow(StoryBlockTooLongError);
    expect(callAI).toHaveBeenCalledTimes(4); // still respects MAX_BLOCK_ATTEMPTS — no extra AI calls from the fallback attempt
  });
});

// ── Group 10: block 2 continuity ─────────────────────────────────────────────

describe('generateListeningStory — block 2 receives block 1 context', () => {
  it('block 2 user prompt includes the title from block 1', async () => {
    const callAI = makeHappyCallAI('A1');
    await generateListeningStory({ cefrLevel: 'A1', dryRun: true }, callAI);
    const [, block2UserPrompt] = (callAI as ReturnType<typeof vi.fn>).mock.calls[1] as [string, string];
    expect(block2UserPrompt).toContain('A Day at the Market');
  });

  it('block 2 user prompt includes the outline from block 1', async () => {
    const callAI = makeHappyCallAI('A1');
    await generateListeningStory({ cefrLevel: 'A1', dryRun: true }, callAI);
    const [, block2UserPrompt] = (callAI as ReturnType<typeof vi.fn>).mock.calls[1] as [string, string];
    expect(block2UserPrompt).toContain('Maria visits the market');
  });
});

// ── Group 11: JSON truncation ─────────────────────────────────────────────────

describe('generateListeningStory — truncation handling', () => {
  it('StoryOutputTruncatedError has retryable = true', () => {
    const err = new StoryOutputTruncatedError('gpt-4o', 1234);
    expect(err.retryable).toBe(true);
    expect(err.code).toBe('STORY_OUTPUT_TRUNCATED');
  });

  it('truncation on block 1 retries with fresh block 1 call', async () => {
    const truncatedError = new StoryOutputTruncatedError('gpt-4o', 100);
    const callAI: AICallFn = vi.fn()
      .mockRejectedValueOnce(truncatedError)     // block1 attempt 1: truncated
      .mockResolvedValueOnce(makeBlock1Response(440)) // block1 attempt 2: valid
      .mockResolvedValueOnce(makeBlock2Response(440)); // block2: valid

    const result = await generateListeningStory({ cefrLevel: 'A1', dryRun: true }, callAI);
    expect(callAI).toHaveBeenCalledTimes(3);
    expect(result.story.title).toBe('A Day at the Market');
    // Both block1 retries use BLOCK1_SYSTEM_PROMPT (no expand on truncation)
    const [firstSystem] = (callAI as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    const [secondSystem] = (callAI as ReturnType<typeof vi.fn>).mock.calls[1] as [string, string];
    expect(firstSystem).toBe(BLOCK1_SYSTEM_PROMPT);
    expect(secondSystem).toBe(BLOCK1_SYSTEM_PROMPT);
  });

  it('throws StoryOutputTruncatedError after 3 truncation failures on block 1', async () => {
    const truncatedError = new StoryOutputTruncatedError('gpt-4o', 100);
    const callAI: AICallFn = vi.fn().mockRejectedValue(truncatedError);
    await expect(
      generateListeningStory({ cefrLevel: 'A1', dryRun: true }, callAI)
    ).rejects.toThrow(StoryOutputTruncatedError);
    expect(callAI).toHaveBeenCalledTimes(3);
  });
});

// ── Group 12: block 1 parse error retry ──────────────────────────────────────

describe('generateListeningStory — parse errors', () => {
  it('retries block 1 after JSON parse error and succeeds', async () => {
    const callAI: AICallFn = vi.fn()
      .mockResolvedValueOnce('not json at all %%')
      .mockResolvedValueOnce(makeBlock1Response(440))
      .mockResolvedValueOnce(makeBlock2Response(440));

    const result = await generateListeningStory({ cefrLevel: 'A1', dryRun: true }, callAI);
    expect(callAI).toHaveBeenCalledTimes(3);
    expect(result.story.title).toBe('A Day at the Market');
  });

  it('throws StoryParseError after 3 failed block 1 parse attempts', async () => {
    const callAI: AICallFn = vi.fn().mockResolvedValue('not json %%');
    await expect(
      generateListeningStory({ cefrLevel: 'A1', dryRun: true }, callAI)
    ).rejects.toThrow(StoryParseError);
    expect(callAI).toHaveBeenCalledTimes(3);
  });
});

// ── Group 13: pipeline — episodeId returned when not dryRun ──────────────────

describe('generateListeningStory — pipeline advancement', () => {
  it('returns non-null episodeId when not dryRun (verifies pipeline advances)', async () => {
    const callAI = makeHappyCallAI('A1');
    const fakeEpisodeId = 'ep-test-uuid-1234';
    const fakeBlockId1 = 'block-id-1';
    const fakeBlockId2 = 'block-id-2';

    // insertEpisode: .from().insert().select('id').single()
    // insertBlock x2: .from().insert().select('id').single()
    // insertSentences x2: .from().insert()
    // markContentReady: .from().update().eq() x3 (1 episode + 2 blocks)
    const makeSingle = (data: unknown) => ({
      single: vi.fn().mockResolvedValue({ data, error: null }),
    });
    const makeInsertSelect = (data: unknown) => ({
      insert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue(makeSingle(data)),
      }),
    });
    const makeInsertOnly = () => ({
      insert: vi.fn().mockResolvedValue({ error: null }),
    });
    const makeUpdateEq = () => ({
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
    });

    let callCount = 0;
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'listening_episodes') {
          callCount++;
          if (callCount === 1) {
            // insertEpisode
            return makeInsertSelect({ id: fakeEpisodeId });
          }
          // markContentReady episode update
          return makeUpdateEq();
        }
        if (table === 'listening_blocks') {
          // insertBlock for block1 or block2, then markContentReady updates
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn()
                  .mockResolvedValueOnce({ data: { id: fakeBlockId1 }, error: null })
                  .mockResolvedValueOnce({ data: { id: fakeBlockId2 }, error: null }),
              }),
            }),
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ error: null }),
            }),
          };
        }
        if (table === 'listening_sentences') {
          return makeInsertOnly();
        }
        return {};
      }),
    };

    const result = await generateListeningStory(
      { cefrLevel: 'A1', dryRun: false },
      callAI,
      mockSupabase as unknown as Parameters<typeof generateListeningStory>[2],
    );
    expect(result.episodeId).toBe(fakeEpisodeId);
  });
});

// ── Group 14: buildIdempotencyKey ─────────────────────────────────────────────

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

  it('key includes PROMPT_VERSION to distinguish schema versions', () => {
    const k = buildIdempotencyKey({ cefrLevel: 'A1' });
    expect(k).toContain('listening-story-v2');
  });

  // The group-generation pipeline never sets theme, and uses the
  // generating job's own id as the seed — these two cases are what make
  // that scheme work: same job (same seed) always dedupes to the same key
  // across retries, and a different job (different seed) never collides
  // with it, so the whole CEFR level isn't permanently pinned to one story.
  it('same seed (same job id, retried) produces the same key with no theme', () => {
    const jobId = 'job-aaaa-1111';
    const k1 = buildIdempotencyKey({ cefrLevel: 'A1', seed: jobId });
    const k2 = buildIdempotencyKey({ cefrLevel: 'A1', seed: jobId });
    expect(k1).toBe(k2);
  });

  it('different seeds (different job ids) for the same level produce different keys', () => {
    const k1 = buildIdempotencyKey({ cefrLevel: 'A1', seed: 'job-aaaa-1111' });
    const k2 = buildIdempotencyKey({ cefrLevel: 'A1', seed: 'job-bbbb-2222' });
    expect(k1).not.toBe(k2);
  });

  it('with no seed and no theme, the key collapses to just the level (the pre-fix group-pipeline bug, kept as a regression marker)', () => {
    const k1 = buildIdempotencyKey({ cefrLevel: 'A1' });
    const k2 = buildIdempotencyKey({ cefrLevel: 'A1' });
    expect(k1).toBe(k2);
    expect(k1).toBe('A1|||listening-story-v2|1');
  });
});
