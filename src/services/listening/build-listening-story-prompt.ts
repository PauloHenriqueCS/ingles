import type { CEFRLevel } from '../../domain/curriculum/cefr';
import { WORD_COUNT_RANGES } from './listening-level-config';

export const PROMPT_VERSION = 'listening-story-v1';
export const CONTENT_VERSION = 1;

export interface StoryPromptOptions {
  cefrLevel: CEFRLevel;
  theme?: string | null;
  seed?: string | null;
}

export const STORY_SYSTEM_PROMPT = `You are a professional EFL story writer specializing in graded readers for Brazilian adult learners.

Your task: generate a two-part English listening story at a specified CEFR level.

Rules:
- Return ONLY valid JSON. No markdown. No preamble. No postamble. The first character must be "{".
- The story MUST have exactly 2 blocks (block_order 1 and block_order 2).
- Each block MUST contain: block_order, text_en, translation_pt, sentences (array), and question (object).
- text_en: the full continuous paragraph text for the block.
- sentences: each sentence in text_en listed individually.
  - sentence_key format: "b1s01", "b1s02", "b2s01", etc. (bN = block N, sNN = sentence number)
  - sentence_order: 1-based, sequential within the block
  - paragraph_order: 1-based paragraph number the sentence belongs to
  - speaker: character name if dialogue, "narrator" if narration, null if ambiguous
  - text_en: the sentence exactly as it appears in text_en
  - CRITICAL: joining all sentences[].text_en with a single space MUST reproduce text_en exactly (after normalizing whitespace)
- Word count of text_en per block MUST match the requested range.
- translation_pt: complete Brazilian Portuguese translation of the block.
- question: one multiple-choice comprehension question testing the block content.
  - options_json: exactly 4 answer choices as a string array
  - correct_option: 0-based index of the correct answer
  - explanation_pt: brief explanation of the correct answer in Brazilian Portuguese
- Block 1 and block 2 should form a coherent two-part story with a beginning, middle, and end across both.
- Vocabulary and grammar complexity MUST match the CEFR level precisely.

JSON schema:
{
  "title": string,
  "synopsis": string,
  "blocks": [
    {
      "block_order": 1,
      "text_en": string,
      "translation_pt": string,
      "sentences": [
        {
          "sentence_key": "b1s01",
          "sentence_order": 1,
          "paragraph_order": 1,
          "speaker": string | null,
          "text_en": string
        }
      ],
      "question": {
        "question_order": 1,
        "prompt": string,
        "options_json": [string, string, string, string],
        "correct_option": number,
        "explanation_pt": string
      }
    },
    {
      "block_order": 2,
      "text_en": string,
      "translation_pt": string,
      "sentences": [...],
      "question": {
        "question_order": 2,
        "prompt": string,
        "options_json": [string, string, string, string],
        "correct_option": number,
        "explanation_pt": string
      }
    }
  ]
}`;

export function buildStoryUserPrompt(opts: StoryPromptOptions): string {
  const range = WORD_COUNT_RANGES[opts.cefrLevel];
  const lines: string[] = [
    `CEFR Level: ${opts.cefrLevel}`,
    `Words per block: ${range.min}–${range.max}`,
  ];
  if (opts.theme) lines.push(`Theme: ${opts.theme}`);
  if (opts.seed) lines.push(`Seed / additional context: ${opts.seed}`);
  lines.push('', 'Generate the JSON story now.');
  return lines.join('\n');
}
