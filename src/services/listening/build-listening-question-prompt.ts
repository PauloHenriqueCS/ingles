import type { CEFRLevel } from '../../domain/curriculum/cefr';
import type { ValidatedGeneratedQuestion, QuestionAIValidationResult } from './listening-question-schema';

export const GENERATOR_PROMPT_VERSION = 'listening-question-generator-v1';
export const VALIDATOR_PROMPT_VERSION = 'listening-question-validator-v1';

// ─── Regras por nível CEFR ────────────────────────────────────────────────────

const CEFR_RULES: Record<CEFRLevel, string> = {
  A1: `Level A1: Use only "detail" or "sequence" question types, or a very explicit "main_idea". Do NOT use inference. Questions must test explicitly stated facts. Avoid negative structures ("not", "except"). Keep options very short and clear.`,
  A2: `Level A2: Use "detail", "cause", "sequence", or "main_idea". Inference only if extremely simple and self-evident from the text. Avoid negative structures.`,
  B1: `Level B1: All six question types are allowed: main_idea, detail, cause, sequence, intention, simple_inference. Keep inference straightforward and clearly supported.`,
  B2: `Level B2: Prefer "intention", "cause" (possibly implicit), "simple_inference", and "main_idea". Answers may require connecting two sentences from the block.`,
  C1: `Level C1: Use "intention" (possibly implicit), "simple_inference", "main_idea", "cause". Focus on nuance, attitude change, or consequence. Avoid overly academic language.`,
  C2: `Level C2: Same as C1. Prioritize subtle inference and nuance. Avoid questions that test literary knowledge instead of listening comprehension.`,
};

// ─── Prompt do gerador ────────────────────────────────────────────────────────

export const GENERATOR_SYSTEM_PROMPT = `You are an expert in English listening comprehension for adult Brazilian learners. Your task is to generate exactly TWO multiple-choice questions — one per block — for a two-part English listening episode.

ABSOLUTE RULES:
- Return ONLY valid JSON. No markdown. No explanation outside JSON. First character must be "{".
- Generate EXACTLY 2 questions: one for Block 1 and one for Block 2.
- Each question has EXACTLY 3 options (no more, no less).
- Exactly ONE option is correct.
- Questions and options MUST be in English.
- explanationPt MUST be in Brazilian Portuguese.
- Base every question SOLELY on the provided block text. No external knowledge.
- Do NOT ask about grammar, translation, or word meaning.
- Do NOT include the answer in the question prompt.
- Do NOT use "all of the above" or "none of the above".
- Do NOT use double negatives or "except" / "not true" structures for A1/A2.
- Do NOT use information from Block 2 when writing the Question 1 (for Block 1).
- Question 2 must evaluate Block 2 content; it may use minimal Block 1 context only when truly indispensable, but the answer must be proven by Block 2.
- Distractors must be plausible (not absurd), grammatically parallel, and similar in length.
- No two options may be semantically identical or near-identical.
- evidenceSentenceKeys must be real sentence keys from the block. Select only the minimum necessary sentences that directly prove the answer.
- Recommended distribution: Question 1 → detail, cause, or sequence; Question 2 → main_idea, intention, simple_inference, or cause.
- Allowed questionType values: main_idea, detail, cause, sequence, intention, simple_inference.

JSON schema:
{
  "schemaVersion": "1.0",
  "episodeId": string,
  "cefrLevel": string,
  "questions": [
    {
      "questionOrder": 1,
      "blockOrder": 1,
      "questionType": string,
      "prompt": string,
      "options": [string, string, string],
      "correctOption": number (0-based index),
      "explanationPt": string,
      "evidenceSentenceKeys": [string, ...],
      "difficulty": "appropriate" | "easy" | "hard"
    },
    {
      "questionOrder": 2,
      "blockOrder": 2,
      "questionType": string,
      "prompt": string,
      "options": [string, string, string],
      "correctOption": number (0-based index),
      "explanationPt": string,
      "evidenceSentenceKeys": [string, ...],
      "difficulty": "appropriate" | "easy" | "hard"
    }
  ]
}`;

// ─── Prompt do validador ──────────────────────────────────────────────────────

export const VALIDATOR_SYSTEM_PROMPT = `You are an expert evaluator of English listening comprehension questions for adult Brazilian learners. Given a question and its source block, evaluate whether the question is valid for classroom use.

Evaluate:
1. answerSupported: Is the answer directly provable by the block text?
2. singleCorrectOption: Is there exactly one clearly correct answer?
3. distractorsPlausible: Are the wrong options plausible (not absurd) and parallel in structure and length?
4. levelAppropriate: Is the question difficulty appropriate for the stated CEFR level?
5. evidenceValid: Do the provided evidenceSentenceKeys actually prove the correct answer?
6. noExternalKnowledge: Does the question rely only on the provided block, not on world knowledge?
7. notAmbiguous: Is the question clear and unambiguous?

Return ONLY valid JSON. No explanation outside JSON. First character must be "{".

JSON schema:
{
  "schemaVersion": "1.0",
  "valid": boolean,
  "confidence": number (0.0–1.0),
  "checks": {
    "answerSupported": boolean,
    "singleCorrectOption": boolean,
    "distractorsPlausible": boolean,
    "levelAppropriate": boolean,
    "evidenceValid": boolean,
    "noExternalKnowledge": boolean,
    "notAmbiguous": boolean
  },
  "issues": [string],
  "suggestedCorrection": null
}`;

// ─── Builders de user prompt ──────────────────────────────────────────────────

export interface BlockData {
  blockOrder: 1 | 2;
  textEn: string;
  sentences: Array<{ sentenceKey: string; textEn: string }>;
}

export interface GeneratorPromptInput {
  episodeId: string;
  title: string;
  synopsis: string | null;
  cefrLevel: CEFRLevel;
  blocks: [BlockData, BlockData];
}

export function buildGeneratorUserPrompt(input: GeneratorPromptInput): string {
  const { episodeId, title, synopsis, cefrLevel, blocks } = input;
  const cefrRules = CEFR_RULES[cefrLevel];

  const lines: string[] = [
    `Episode ID: ${episodeId}`,
    `Title: ${title}`,
    synopsis ? `Synopsis: ${synopsis}` : '',
    `CEFR Level: ${cefrLevel}`,
    '',
    `=== CEFR RULES FOR THIS LEVEL ===`,
    cefrRules,
    '',
  ];

  for (const block of blocks) {
    lines.push(`=== BLOCK ${block.blockOrder} TEXT ===`);
    lines.push(block.textEn);
    lines.push('');
    lines.push(`--- Block ${block.blockOrder} sentences with keys ---`);
    for (const s of block.sentences) {
      lines.push(`[${s.sentenceKey}] ${s.textEn}`);
    }
    lines.push('');
  }

  lines.push('Generate the two questions now. Return only valid JSON.');
  return lines.filter(l => l !== null).join('\n');
}

export interface ValidatorPromptInput {
  question: ValidatedGeneratedQuestion;
  block: BlockData;
  cefrLevel: CEFRLevel;
}

export function buildValidatorUserPrompt(input: ValidatorPromptInput): string {
  const { question, block, cefrLevel } = input;
  const lines: string[] = [
    `CEFR Level: ${cefrLevel}`,
    `Block ${block.blockOrder} text:`,
    block.textEn,
    '',
    '--- Sentences with keys ---',
    ...block.sentences.map(s => `[${s.sentenceKey}] ${s.textEn}`),
    '',
    `Question to validate:`,
    `prompt: ${question.prompt}`,
    `options: ${question.options.map((o, i) => `${i}. ${o}`).join(' | ')}`,
    `correctOption: ${question.correctOption}`,
    `explanationPt: ${question.explanationPt}`,
    `questionType: ${question.questionType}`,
    `evidenceSentenceKeys: ${question.evidenceSentenceKeys.join(', ')}`,
    '',
    'Evaluate and return only valid JSON.',
  ];
  return lines.join('\n');
}

export interface CorrectionPromptInput {
  questions: ValidatedGeneratedQuestion[];
  validationResults: QuestionAIValidationResult[];
  blocks: [BlockData, BlockData];
  cefrLevel: CEFRLevel;
}

export function buildCorrectionUserPrompt(input: CorrectionPromptInput): string {
  const { questions, validationResults, blocks, cefrLevel } = input;
  const lines: string[] = [
    `CEFR Level: ${cefrLevel}`,
    '',
    'The following questions were generated but have validation issues. Fix them.',
    'Return the same JSON structure as the generator (two questions). Fix ONLY what is necessary.',
    '',
  ];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const vr = validationResults[i];
    const block = blocks.find(b => b.blockOrder === q.blockOrder)!;

    lines.push(`=== Question ${q.questionOrder} (Block ${q.blockOrder}) ===`);
    if (!vr.valid) {
      lines.push(`Issues: ${vr.issues.join('; ')}`);
    } else {
      lines.push('Status: VALID (keep as is if possible)');
    }
    lines.push(`prompt: ${q.prompt}`);
    lines.push(`options: ${q.options.map((o, i) => `${i}. ${o}`).join(' | ')}`);
    lines.push(`correctOption: ${q.correctOption}`);
    lines.push(`explanationPt: ${q.explanationPt}`);
    lines.push(`evidenceSentenceKeys: ${q.evidenceSentenceKeys.join(', ')}`);
    lines.push('');
    lines.push(`Block ${block.blockOrder} text:`);
    lines.push(block.textEn);
    lines.push('');
    lines.push('Sentences:');
    for (const s of block.sentences) {
      lines.push(`[${s.sentenceKey}] ${s.textEn}`);
    }
    lines.push('');
  }

  lines.push('Return only valid JSON using the generator schema (schemaVersion, episodeId, cefrLevel, questions[]).');
  lines.push('episodeId: (use the same episode)');
  return lines.join('\n');
}
