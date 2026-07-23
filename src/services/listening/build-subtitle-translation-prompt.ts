import type { CEFRLevel } from '../../domain/curriculum/cefr';
import type { EnglishCueDraft } from './listening-subtitle-schema';

export const TRANSLATION_PROMPT_VERSION = 'listening-subtitle-translation-v1';
export const VALIDATOR_PROMPT_VERSION = 'listening-subtitle-translation-validator-v2';

// ─── System prompts ───────────────────────────────────────────────────────────

// Rewritten after live evidence from three real generated episodes: the
// translator was scattering small, real content losses across long batches
// (a dropped "Anna nods.", a swapped name/gender, a lost preposition, a
// mistranslated idiom) — never total failures, always a handful of specific
// cues in a much larger set. "Keep translations concise" (the old wording)
// was in direct tension with "don't omit anything" and plausibly read by
// the model as license to drop low-salience beats (short reactions,
// gestures) for brevity. That instruction is gone; nothing here trades
// completeness for brevity.
export const TRANSLATION_SYSTEM_PROMPT = `You are a professional subtitle translator specialising in Brazilian Portuguese for English language learning applications.

Your task is to translate a batch of English subtitle cues into natural Brazilian Portuguese (pt-BR). Each cue is a short, independent unit identified by a stable cueKey — you will also see the full English block text and possibly a cue immediately before/after your batch, but those are for CONTEXT ONLY, to help you translate naturally; never translate or return them.

COMPLETENESS — the most common source of errors, follow these exactly:
- Translate EVERY cue you are asked for. Never skip one, even if it looks trivial (a single reaction, a short gesture, a one-word reply).
- Every action, gesture, and line of dialogue in a cue must appear in its translation. A cue like "Maria nods." or "They check in." is a complete beat — translate it as one, never drop it or fold it silently into a neighboring cue's translation.
- Do NOT summarize, shorten, or simplify the content to save space. A short English cue should produce a short — but COMPLETE — Portuguese cue, not a paraphrase that drops detail.
- Do NOT invent content that is not in the English cue.

IDENTITY AND REFERENCE — do not let translation choices blur who did what to whom:
- Preserve character names exactly (do not translate them, unless a well-known standard Brazilian Portuguese equivalent exists — e.g. real cities).
- Preserve the grammatical gender and number implied by the English (he/she/they, singular/plural) — check the surrounding context (previous/next cue, full block text) if a pronoun's referent is ambiguous in isolation.
- Preserve who is speaking and who is being addressed; do not swap subject and object.
- Preserve every digit that appears in the English cue, using the EXACT SAME numerals in the translation. Never convert a 12-hour time to 24-hour format (a cue with "2 PM" must keep the digit "2" — e.g. "às 2 da tarde", never rewritten as "14h"), never spell a digit out as a word (keep "3", do not write "três"), and never drop a number, date, address, or measurement that was present in English.

STRUCTURE — never restructure the cue list itself:
- Return exactly one translation per cueKey you were given — never combine two cueKeys into one translation, never split one cueKey's translation across two entries.
- Never invent a new cueKey, never omit a cueKey you were given, never alter a cueKey's spelling.
- Do NOT translate the cueKey itself — it is an identifier, not content.

LANGUAGE QUALITY:
- Use natural, idiomatic Brazilian Portuguese (pt-BR), NEVER European Portuguese (pt-PT).
- When the English uses an idiom, translate the MEANING naturally in pt-BR rather than word-for-word — but never at the cost of dropping information the idiom carried.
- Maintain the emotional tone (humor, tension, warmth) of the original.
- Match the terminal punctuation of the English cue: if it ends with "!", the translation must also end with "!" (never downgrade to "."); if it ends with "?", the translation must also end with "?"; preserve "..." the same way. An exclamation mark on a sign, exclamation, or excited line of dialogue carries tone that a period does not.

Examples of PROHIBITED behavior (do not do this):
- EN cue "Anna nods." → WRONG: omitting this cue's meaning, or merging it invisibly into the previous cue's translation. RIGHT: "Anna balança a cabeça." (or an equally complete natural equivalent) as its own translation for that cueKey.
- EN cues about "the Botanical Garden and the Opera House" (two different-gender nouns) referred to later as "they" → WRONG: guessing a gender that contradicts Portuguese's actual agreement rule for the referents in context. RIGHT: use the full block text/context to work out what "they" refers to before choosing eles/elas.
- EN cue "They check in and leave their bags in the room." → WRONG: "Eles vão para o quarto." (drops the check-in action). RIGHT: a translation that keeps BOTH the check-in and the leaving-bags actions.
- EN cue "Painting Class, Saturday at 2 PM!" → WRONG: "Aula de pintura, sábado às 14h." (reformats "2 PM" into 24-hour time, so the digit "2" no longer appears). RIGHT: "Aula de pintura, sábado às 2 da tarde!" (keeps the digit "2" exactly as in the English).
- EN cue "Join us and make friends!" → WRONG: "Junte-se a nós e faça amigos." (ends with "." instead of "!", losing the excited/inviting tone of the sign). RIGHT: "Junte-se a nós e faça amigos!" (ends with "!", matching the English).

Return ONLY valid JSON. No markdown. No explanation outside JSON. First character must be "{".`;

// Judges MEANING/QUALITY only — cue identity, count, order, and number
// preservation are already enforced deterministically before this ever
// runs (validateTranslationDeterministic), so this prompt does not repeat
// them. Explicitly lenient about style: an earlier, stricter version of
// this prompt (with no leniency guidance and an all-7-checks-must-pass
// gate) was rejecting adequate translations over acceptable stylistic
// variation with no way to tell which specific cue caused the failure.
export const VALIDATOR_SYSTEM_PROMPT = `You are a linguistic quality reviewer for Brazilian Portuguese (pt-BR) subtitle translations used in an English-learning app.

For EACH cue below, judge ONLY:
- Meaning fidelity: does the Portuguese convey the same meaning as the English, without inventing information or omitting anything that matters to the meaning?
- Natural Brazilian Portuguese: does it read as natural, idiomatic pt-BR (not machine-literal, not European Portuguese)?
- Names: are character/place names preserved (not translated, unless a standard pt-BR equivalent exists)?

Do NOT mark a cue invalid for:
- word-for-word phrasing differences that preserve the same meaning;
- natural word reordering;
- register/synonym choices (formal vs. informal) that do not change the meaning;
- omitting filler words that carry no meaning in Portuguese;
- minor stylistic variation a native speaker would consider equally correct.

Only mark a cue invalid for a REAL problem: wrong or missing meaning, invented information, an omission that matters, unnatural/incorrect Portuguese, or a lost/altered name. When in doubt, and the translation is understandable and accurate, mark it valid.

Return ONLY valid JSON, exactly this shape — include EVERY cueKey you were given, in any order:
{
  "schemaVersion": "2.0",
  "cues": [
    { "cueKey": "<cueKey>", "valid": <boolean>, "issues": [<string>] }
  ]
}
"issues" must be empty when valid is true. When valid is false, state the SPECIFIC problem (not a vague label like "not natural") so it can be fixed without guessing.`;

// Dedicated to the correction step — distinct from VALIDATOR_SYSTEM_PROMPT,
// which describes a review/evaluation task, not a rewrite task. Same
// completeness rules as TRANSLATION_SYSTEM_PROMPT: a correction that fixes
// the stated problem by dropping other content is not a correction.
export const CORRECTION_SYSTEM_PROMPT = `You are correcting specific Brazilian Portuguese (pt-BR) subtitle translations that failed quality review.

RULES:
- Fix ONLY the cues listed as needing correction, using the exact problem stated for each. Do not change anything not called out in the stated problem.
- The correction must still contain every action, gesture, and line of dialogue that was in the original English cue — fixing the stated problem must never introduce a NEW omission or a new identity/gender/name error.
- Do not summarize or shorten the cue to "solve" the issue — produce a complete, accurate translation of the full English cue.
- Preserve character names exactly (do not translate them, unless a well-known standard Brazilian Portuguese equivalent exists).
- Preserve grammatical gender/number and who is speaking/being addressed — use the full block text given as context to resolve ambiguous pronouns correctly.
- Preserve every digit that appears in the English cue, using the EXACT SAME numerals. Never convert a 12-hour time to 24-hour format, never spell a digit out as a word, never drop a number, date, address, or measurement.
- Match the terminal punctuation of the English cue exactly: "!" stays "!", "?" stays "?", "..." stays "...". Never downgrade an exclamation mark to a period — it is a common, real cause of a cue failing review, and dropping it silently while "fixing" a different stated problem does not count as fixing it.
- Use natural, idiomatic Brazilian Portuguese (pt-BR), never European Portuguese — translate idioms by meaning, never word-for-word, without dropping information.
- Return a translation for exactly the cueKeys you were asked to fix — never a cueKey you were not given, never a cueKey you were not asked to change.

Return ONLY valid JSON, exactly this shape — one entry per cueKey you were asked to fix, nothing else:
{ "<cueKey>": "<corrected pt-BR text>" }`;

// ─── Prompt builders ──────────────────────────────────────────────────────────

export interface BlockCueData {
  blockOrder: 1 | 2;
  blockTextEn: string;
  cues: EnglishCueDraft[];
}

export interface TranslationBatchPromptInput {
  episodeId: string;
  title: string;
  synopsis: string | null;
  cefrLevel: CEFRLevel;
  blockOrder: 1 | 2;
  blockTextEn: string;
  cues: EnglishCueDraft[];
  /** English text of the cue immediately before this batch (not part of it) — context only. */
  precedingCueText?: string;
  /** English text of the cue immediately after this batch (not part of it) — context only. */
  followingCueText?: string;
  batchIndex: number;
  batchCount: number;
  glossary?: Record<string, string>;
}

/**
 * Translates ONE batch of cues from ONE block. Real evidence (three
 * generated A1 episodes) showed a single block can produce 70+ cues; asking
 * for all of them translated precisely in one completion is where specific
 * cues were getting dropped or altered. Batches keep each call's cue count
 * small — see TRANSLATION_BATCH_SIZE in translate-listening-subtitles.ts —
 * while the full block text (always included) and the immediate
 * neighboring cues (when the batch boundary falls mid-block) keep enough
 * context to resolve pronouns/continuity across the split.
 */
export function buildTranslationBatchUserPrompt(input: TranslationBatchPromptInput): string {
  const {
    episodeId, title, synopsis, cefrLevel, blockOrder, blockTextEn, cues,
    precedingCueText, followingCueText, batchIndex, batchCount, glossary,
  } = input;
  const lines: string[] = [
    `Episode ID: ${episodeId}`,
    `Title: ${title}`,
    synopsis ? `Synopsis: ${synopsis}` : '',
    `CEFR Level: ${cefrLevel}`,
    '',
  ];

  if (glossary && Object.keys(glossary).length > 0) {
    lines.push('=== GLOSSARY (mandatory terms) ===');
    for (const [en, pt] of Object.entries(glossary)) {
      lines.push(`  ${en} → ${pt}`);
    }
    lines.push('');
  }

  lines.push(`=== BLOCK ${blockOrder} — FULL ENGLISH TEXT (context only — do not translate this, translate only the numbered cues below) ===`);
  lines.push(blockTextEn);
  lines.push('');

  if (batchCount > 1) {
    lines.push(`This is batch ${batchIndex + 1} of ${batchCount} for block ${blockOrder}. Translate ONLY the cues listed below — cues outside this batch are handled in other calls.`);
    lines.push('');
  }

  if (precedingCueText) {
    lines.push('--- Cue immediately BEFORE this batch (context only, do not translate or return it) ---');
    lines.push(precedingCueText);
    lines.push('');
  }

  lines.push(`--- Cues to translate, in order (${cues.length}) ---`);
  for (const cue of cues) {
    lines.push(`[${cue.cueKey}] ${cue.text}`);
  }
  lines.push('');

  if (followingCueText) {
    lines.push('--- Cue immediately AFTER this batch (context only, do not translate or return it) ---');
    lines.push(followingCueText);
    lines.push('');
  }

  lines.push(`Return ONLY the JSON below, with exactly ${cues.length} entries — one per cueKey listed above, nothing else. Replace <…> placeholders with actual translations:`);
  lines.push(JSON.stringify({
    cues: cues.map(c => ({ cueKey: c.cueKey, textPtBr: '<tradução aqui>' })),
  }, null, 2));

  return lines.filter(l => l !== undefined).join('\n');
}

export interface ValidationPromptInput {
  episodeId: string;
  cefrLevel: CEFRLevel;
  blockOrder: 1 | 2;
  blockTextEn: string;
  cues: Array<{ cueKey: string; sourceSentenceKeys: string[]; textEn: string; textPtBr: string }>;
  glossary?: Record<string, string>;
}

export function buildValidatorUserPrompt(input: ValidationPromptInput): string {
  const { episodeId, cefrLevel, blockOrder, blockTextEn, cues, glossary } = input;
  const lines: string[] = [
    `Episode ID: ${episodeId}`,
    `CEFR Level: ${cefrLevel}`,
    `Block: ${blockOrder}`,
    '',
    `Full English block text:`,
    blockTextEn,
    '',
  ];

  if (glossary && Object.keys(glossary).length > 0) {
    lines.push('=== GLOSSARY ===');
    for (const [en, pt] of Object.entries(glossary)) {
      lines.push(`  ${en} → ${pt}`);
    }
    lines.push('');
  }

  lines.push('Cues to validate (English → Portuguese):');
  for (const c of cues) {
    lines.push(`[${c.cueKey}] EN: ${c.textEn}`);
    lines.push(`[${c.cueKey}] PT: ${c.textPtBr}`);
    lines.push('');
  }

  lines.push('Return ONLY valid JSON, one entry per cue listed above:');
  lines.push(JSON.stringify({
    schemaVersion: '2.0',
    cues: cues.map(c => ({ cueKey: c.cueKey, valid: '<boolean>', issues: ['<string, only if valid is false>'] })),
  }, null, 2));

  return lines.join('\n');
}

export interface MissingCuesPromptInput {
  episodeId: string;
  title: string;
  synopsis: string | null;
  cefrLevel: CEFRLevel;
  missingByBlock: Map<1 | 2, { blockTextEn: string; cues: EnglishCueDraft[] }>;
  glossary?: Record<string, string>;
}

/**
 * Targeted repair prompt for LISTENING_TRANSLATION_MISSING_CUE: asks for a
 * translation of ONLY the cues a previous pass omitted, identified by the
 * same stable cueKey used everywhere else — never re-requests the full set.
 */
export function buildMissingCuesUserPrompt(input: MissingCuesPromptInput): string {
  const { episodeId, title, synopsis, cefrLevel, missingByBlock, glossary } = input;
  const lines: string[] = [
    `Episode ID: ${episodeId}`,
    `Title: ${title}`,
    synopsis ? `Synopsis: ${synopsis}` : '',
    `CEFR Level: ${cefrLevel}`,
    '',
    'A previous translation pass omitted some cues. Translate ONLY the missing cues listed below.',
    'Do not return any cue that is not explicitly listed here.',
    '',
  ];

  if (glossary && Object.keys(glossary).length > 0) {
    lines.push('=== GLOSSARY (mandatory terms) ===');
    for (const [en, pt] of Object.entries(glossary)) {
      lines.push(`  ${en} → ${pt}`);
    }
    lines.push('');
  }

  const allCueKeys: string[] = [];
  for (const [blockOrder, data] of missingByBlock) {
    lines.push(`=== BLOCK ${blockOrder} — FULL ENGLISH TEXT (context) ===`);
    lines.push(data.blockTextEn);
    lines.push('');
    lines.push(`--- Block ${blockOrder} MISSING cues to translate ---`);
    for (const cue of data.cues) {
      lines.push(`[${cue.cueKey}] (source: ${cue.sourceSentenceKeys.join(', ')}) ${cue.text}`);
      allCueKeys.push(cue.cueKey);
    }
    lines.push('');
  }

  lines.push('Return ONLY the JSON below. Replace <…> placeholders with actual translations. Include EVERY cueKey listed here, and nothing else:');
  lines.push(JSON.stringify({
    cues: allCueKeys.map(cueKey => ({ cueKey, textPtBr: '<tradução aqui>' })),
  }, null, 2));

  return lines.filter(l => l !== undefined).join('\n');
}

export interface CorrectionPromptInput {
  episodeId: string;
  cefrLevel: CEFRLevel;
  blockOrder: 1 | 2;
  blockTextEn: string;
  failingCues: Array<{ cueKey: string; sourceSentenceKeys: string[]; textEn: string; textPtBr: string; issues: string[] }>;
  validCues: Array<{ cueKey: string; textPtBr: string }>;
  glossary?: Record<string, string>;
}

export function buildCorrectionUserPrompt(input: CorrectionPromptInput): string {
  const { episodeId, cefrLevel, blockOrder, blockTextEn, failingCues, validCues, glossary } = input;
  const lines: string[] = [
    `Episode ID: ${episodeId}`,
    `CEFR Level: ${cefrLevel}`,
    `Block: ${blockOrder}`,
    '',
    'The following cue translations have validation issues. Fix ONLY the failing cues.',
    'Keep the already-valid cues unchanged.',
    '',
    `Full English block text:`,
    blockTextEn,
    '',
  ];

  if (glossary && Object.keys(glossary).length > 0) {
    lines.push('=== GLOSSARY ===');
    for (const [en, pt] of Object.entries(glossary)) lines.push(`  ${en} → ${pt}`);
    lines.push('');
  }

  lines.push('=== ALREADY VALID (keep as-is) ===');
  for (const c of validCues) lines.push(`[${c.cueKey}] ${c.textPtBr}`);
  lines.push('');

  lines.push('=== NEEDS CORRECTION ===');
  for (const c of failingCues) {
    lines.push(`[${c.cueKey}] EN: ${c.textEn}`);
    lines.push(`[${c.cueKey}] Current PT: ${c.textPtBr}`);
    lines.push(`[${c.cueKey}] Issues: ${c.issues.join('; ')}`);
    lines.push('');
  }

  lines.push('Return ONLY a JSON object mapping cue_key → corrected pt-BR text for the FAILING cues:');
  lines.push(`{ "<cueKey>": "<corrected translation>", … }`);
  return lines.join('\n');
}
