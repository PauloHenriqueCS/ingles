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
- Each block MUST contain: block_order (integer 1 or 2) and text_en (string).
- text_en: the full continuous paragraph text for the block.
- Do NOT include translation_pt, sentences arrays, or questions — those are generated in separate steps.
- Block 1 and block 2 should form a coherent two-part story with a beginning, middle, and end.
- Vocabulary and grammar complexity MUST match the CEFR level precisely.
- The story should be engaging, culturally appropriate for Brazilian adults, and educational.

JSON schema (return EXACTLY this structure, nothing more):
{
  "title": string,
  "synopsis": string,
  "blocks": [
    {
      "block_order": 1,
      "text_en": string
    },
    {
      "block_order": 2,
      "text_en": string
    }
  ]
}`;

function wordCountHeader(cefrLevel: string): string[] {
  const range = WORD_COUNT_RANGES[cefrLevel as keyof typeof WORD_COUNT_RANGES];
  const target = Math.round((range.min + range.max) / 2);
  return [
    '',
    'IMPORTANT — WORD COUNT RULES:',
    `• Target: approximately ${target} words per text_en block.`,
    `• Minimum absolute: ${range.min} words — fewer than ${range.min} words is INVALID.`,
    `• Maximum absolute: ${range.max} words.`,
    '• Both blocks must independently satisfy this range.',
    '• Only the words in text_en count — do NOT add translation, questions, or sentences.',
    '• Before returning the JSON, verify the word count of each text_en block.',
    '• Do not summarize the story to save tokens. Write the full narrative.',
    `• Do not return the JSON until BOTH blocks contain between ${range.min} and ${range.max} words.`,
  ];
}

export function buildStoryUserPrompt(opts: StoryPromptOptions): string {
  const range = WORD_COUNT_RANGES[opts.cefrLevel];
  const lines: string[] = [
    `CEFR Level: ${opts.cefrLevel}`,
    `Words per block: ${range.min}–${range.max}`,
  ];
  if (opts.theme) lines.push(`Theme: ${opts.theme}`);
  if (opts.seed) lines.push(`Seed / additional context: ${opts.seed}`);
  lines.push(...wordCountHeader(opts.cefrLevel), '', 'Generate the JSON story now.');
  return lines.join('\n');
}

export function buildRetryUserPrompt(
  opts: StoryPromptOptions,
  attempt: number,
  previousError: string,
): string {
  const range = WORD_COUNT_RANGES[opts.cefrLevel];
  const lines: string[] = [
    `CEFR Level: ${opts.cefrLevel}`,
    `Words per block: ${range.min}–${range.max}`,
  ];
  if (opts.theme) lines.push(`Theme: ${opts.theme}`);
  if (opts.seed) lines.push(`Seed / additional context: ${opts.seed}`);
  lines.push(
    ...wordCountHeader(opts.cefrLevel),
    '',
    `Previous attempt ${attempt - 1} failed validation:`,
    `"${previousError}"`,
    '',
    'Regenerate the COMPLETE JSON from scratch.',
    'Do not fix or complete only part of the JSON — generate the entire object again.',
    'Return ONLY the required fields: title, synopsis, blocks (block_order + text_en).',
    'Do NOT include translation_pt, questions, explanations, or sentences arrays.',
    `Each text_en must contain between ${range.min} and ${range.max} words independently.`,
    '',
    'Generate the JSON story now.',
  );
  return lines.join('\n');
}

export function buildTruncatedRetryUserPrompt(opts: StoryPromptOptions, attempt: number): string {
  const range = WORD_COUNT_RANGES[opts.cefrLevel];
  const lines: string[] = [
    `CEFR Level: ${opts.cefrLevel}`,
    `Words per block: ${range.min}–${range.max}`,
  ];
  if (opts.theme) lines.push(`Theme: ${opts.theme}`);
  if (opts.seed) lines.push(`Seed / additional context: ${opts.seed}`);
  lines.push(
    ...wordCountHeader(opts.cefrLevel),
    '',
    `Previous attempt ${attempt - 1} failed because the JSON output was truncated (too long).`,
    '',
    'Generate the COMPLETE JSON again.',
    'Return ONLY the required fields: title, synopsis, blocks (block_order + text_en).',
    'Do NOT include translation_pt, questions, explanations, or sentences arrays.',
    `Each text_en must contain between ${range.min} and ${range.max} words independently.`,
    '',
    'Generate the JSON story now.',
  );
  return lines.join('\n');
}
