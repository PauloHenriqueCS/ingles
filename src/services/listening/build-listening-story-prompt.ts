import type { CEFRLevel } from '../../domain/curriculum/cefr';
import { WORD_COUNT_RANGES } from './listening-level-config';

export const PROMPT_VERSION = 'listening-story-v2';
export const CONTENT_VERSION = 1;

export interface StoryPromptOptions {
  cefrLevel: CEFRLevel;
  theme?: string | null;
  seed?: string | null;
}

export interface Block1Context {
  title: string;
  synopsis: string;
  outline: string;
  textEn: string;
}

// ── System prompts ────────────────────────────────────────────────────────────

export const BLOCK1_SYSTEM_PROMPT = `You are a professional EFL story writer for Brazilian adult learners.

Task: Write the FIRST HALF of a two-part graded reader at a specified CEFR level.

Return ONLY valid JSON. No markdown. No preamble. The first character must be "{".

JSON schema (exactly this, nothing more):
{
  "title": string,
  "synopsis": string,
  "outline": string,
  "text_en": string
}

Fields:
- title: an engaging title for the complete story
- synopsis: one-sentence summary of the whole story
- outline: 2–3 sentences describing what happens in BOTH halves (used to keep Part 2 coherent)
- text_en: the full narrative text of Part 1 only

CRITICAL WORD COUNT RULES for text_en:
- Count the words in text_en before returning.
- The word count MUST be between the minimum and maximum in the user prompt.
- Do NOT summarize. Write a full narrative with dialogue, description, and detail.
- If your draft is short, add more dialogue, inner thoughts, or description BEFORE returning.
- Do not return JSON until you have verified the word count meets the requirement.`;

export const BLOCK2_SYSTEM_PROMPT = `You are a professional EFL story writer for Brazilian adult learners.

Task: Write the SECOND HALF of a two-part graded reader. You receive context from Part 1.

Return ONLY valid JSON. No markdown. No preamble. The first character must be "{".

JSON schema (exactly this, nothing more):
{
  "text_en": string
}

- text_en: the full narrative text of Part 2 — must CONTINUE and CONCLUDE the story from Part 1.

CRITICAL WORD COUNT RULES for text_en:
- Count the words in text_en before returning.
- The word count MUST be between the minimum and maximum in the user prompt.
- Do NOT summarize. Write a full narrative with dialogue, resolution, and conclusion.
- If your draft is short, add more dialogue, inner thoughts, or descriptive detail BEFORE returning.
- The story must reach a satisfying conclusion.`;

export const EXPAND_BLOCK_SYSTEM_PROMPT = `You are rewriting a story block that is too short.

Return ONLY valid JSON. No markdown. No preamble. The first character must be "{".

JSON schema (exactly this, nothing more):
{
  "text_en": string
}

RULES:
- Rewrite the COMPLETE block from start to finish. Do NOT just append sentences at the end.
- Preserve ALL existing characters, events, and story continuity exactly.
- Add dialogue exchanges, inner thoughts, sensory descriptions, and scene details to reach the target.
- Count the words before returning.
- The word count MUST be between the minimum and maximum stated in the user prompt.`;

export const CONDENSE_BLOCK_SYSTEM_PROMPT = `You are rewriting a story block that is too long.

Return ONLY valid JSON. No markdown. No preamble. The first character must be "{".

JSON schema (exactly this, nothing more):
{
  "text_en": string
}

RULES:
- Rewrite the COMPLETE block, preserving all key events, characters, and continuity.
- Remove redundant phrases, over-description, and filler while maintaining narrative flow.
- The word count MUST be between the minimum and maximum stated in the user prompt.`;

// ── User prompt helpers ───────────────────────────────────────────────────────

function wordCountSection(range: { min: number; target: number; max: number }): string[] {
  return [
    '',
    'WORD COUNT REQUIREMENT for text_en:',
    `• Target: approximately ${range.target} words`,
    `• Minimum: ${range.min} words (HARD LIMIT — fewer words is INVALID)`,
    `• Maximum: ${range.max} words`,
    `• Acceptable range: ${range.min}–${range.max} words`,
    '• Count carefully before returning the JSON.',
  ];
}

export function buildBlock1UserPrompt(opts: StoryPromptOptions): string {
  const range = WORD_COUNT_RANGES[opts.cefrLevel];
  const lines: string[] = [`CEFR Level: ${opts.cefrLevel}`];
  if (opts.theme) lines.push(`Theme: ${opts.theme}`);
  if (opts.seed) lines.push(`Seed / additional context: ${opts.seed}`);
  lines.push(...wordCountSection(range), '', 'Generate Part 1 JSON now.');
  return lines.join('\n');
}

export function buildBlock2UserPrompt(opts: StoryPromptOptions, context: Block1Context): string {
  const range = WORD_COUNT_RANGES[opts.cefrLevel];
  const lines: string[] = [
    `CEFR Level: ${opts.cefrLevel}`,
    `Title: ${context.title}`,
    `Synopsis: ${context.synopsis}`,
    '',
    'STORY OUTLINE (what happens in both parts):',
    context.outline,
    '',
    'PART 1 TEXT (continue directly from this):',
    context.textEn,
    ...wordCountSection(range),
    '',
    'Generate Part 2 JSON now. Continue and conclude the story.',
  ];
  return lines.join('\n');
}

export function buildExpandBlockUserPrompt(
  opts: StoryPromptOptions,
  blockNum: 1 | 2,
  currentText: string,
  currentWords: number,
): string {
  const range = WORD_COUNT_RANGES[opts.cefrLevel];
  const lines: string[] = [
    `CEFR Level: ${opts.cefrLevel}`,
    `Block: Part ${blockNum}`,
    `Current word count: ${currentWords} (BELOW MINIMUM of ${range.min} — must expand)`,
    '',
    `CURRENT PART ${blockNum} TEXT (rewrite and expand this):`,
    currentText,
    ...wordCountSection(range),
    '',
    `Rewrite and expand Part ${blockNum} to reach at least ${range.min} words.`,
    'Add dialogue, descriptions, inner thoughts, and sensory detail throughout.',
    'Return the COMPLETE rewritten block as JSON now.',
  ];
  return lines.join('\n');
}

export function buildCondenseBlockUserPrompt(
  opts: StoryPromptOptions,
  blockNum: 1 | 2,
  currentText: string,
  currentWords: number,
): string {
  const range = WORD_COUNT_RANGES[opts.cefrLevel];
  const lines: string[] = [
    `CEFR Level: ${opts.cefrLevel}`,
    `Block: Part ${blockNum}`,
    `Current word count: ${currentWords} (ABOVE MAXIMUM of ${range.max} — must condense)`,
    '',
    `CURRENT PART ${blockNum} TEXT (rewrite and condense this):`,
    currentText,
    ...wordCountSection(range),
    '',
    `Condense Part ${blockNum} to fit within ${range.max} words while keeping all key events.`,
    'Return the COMPLETE rewritten block as JSON now.',
  ];
  return lines.join('\n');
}

// ── Kept for backward compatibility with existing tests ───────────────────────

export function buildStoryUserPrompt(opts: StoryPromptOptions): string {
  return buildBlock1UserPrompt(opts);
}

export function buildRetryUserPrompt(
  opts: StoryPromptOptions,
  attempt: number,
  previousError: string,
): string {
  const range = WORD_COUNT_RANGES[opts.cefrLevel];
  const lines: string[] = [`CEFR Level: ${opts.cefrLevel}`];
  if (opts.theme) lines.push(`Theme: ${opts.theme}`);
  if (opts.seed) lines.push(`Seed / additional context: ${opts.seed}`);
  lines.push(
    ...wordCountSection(range),
    '',
    `Previous attempt ${attempt - 1} failed validation:`,
    `"${previousError}"`,
    '',
    'Regenerate the COMPLETE JSON from scratch.',
    'Return ONLY the required fields: title, synopsis, outline, text_en.',
    `Each text_en must contain between ${range.min} and ${range.max} words.`,
    '',
    'Generate the JSON now.',
  );
  return lines.join('\n');
}

export function buildTruncatedRetryUserPrompt(opts: StoryPromptOptions, attempt: number): string {
  const range = WORD_COUNT_RANGES[opts.cefrLevel];
  const lines: string[] = [`CEFR Level: ${opts.cefrLevel}`];
  if (opts.theme) lines.push(`Theme: ${opts.theme}`);
  if (opts.seed) lines.push(`Seed / additional context: ${opts.seed}`);
  lines.push(
    ...wordCountSection(range),
    '',
    `Previous attempt ${attempt - 1} failed because the JSON output was truncated (too long).`,
    '',
    'Generate the COMPLETE JSON again.',
    'Return ONLY the required fields: title, synopsis, outline, text_en.',
    `text_en must contain between ${range.min} and ${range.max} words.`,
    '',
    'Generate the JSON now.',
  );
  return lines.join('\n');
}
