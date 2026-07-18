/**
 * SERVER-ONLY: Shared prompt fragment + validation for the "Antes de escrever"
 * grammar guide and optional exercises returned alongside a generated mission.
 *
 * Generated in the SAME AI call as the mission itself (see generate-theme.ts) —
 * never a second request. Both grammarGuide and optionalExercises are optional
 * from the frontend's perspective: if the AI omits or malforms them, the
 * mission and the writing field must keep working normally.
 */

export type OptionalExerciseType =
  | 'fill_blank'
  | 'multiple_choice'
  | 'transform_sentence'
  | 'correct_error'
  | 'translate';

const VALID_EXERCISE_TYPES: ReadonlySet<string> = new Set([
  'fill_blank', 'multiple_choice', 'transform_sentence', 'correct_error', 'translate',
]);

export interface GrammarGuideExample {
  english: string;
  portuguese: string;
}

export interface GrammarGuideStructures {
  affirmative: string;
  negative: string;
  interrogative: string;
}

export interface GrammarGuide {
  title: string;
  explanationPtBr: string;
  usagePtBr: string[];
  structures: GrammarGuideStructures;
  examples: GrammarGuideExample[];
  commonMistakes: string[];
}

export interface OptionalExercise {
  id: string;
  type: OptionalExerciseType;
  instructionPtBr: string;
  question: string;
  options?: string[];
  correctAnswer: string;
  explanationPtBr: string;
}

// ── Prompt fragments — shared between SYSTEM_PROMPT and REVIEW_SYSTEM_PROMPT ──

export const GRAMMAR_GUIDE_JSON_FIELDS = `  "verbTense": string,
  "grammarGuide": {
    "title": string,
    "explanationPtBr": string,
    "usagePtBr": string[],
    "structures": { "affirmative": string, "negative": string, "interrogative": string },
    "examples": [{ "english": string, "portuguese": string }],
    "commonMistakes": string[]
  },
  "optionalExercises": [
    {
      "id": string,
      "type": "fill_blank"|"multiple_choice"|"transform_sentence"|"correct_error"|"translate",
      "instructionPtBr": string,
      "question": string,
      "options": string[],
      "correctAnswer": string,
      "explanationPtBr": string
    }
  ]`;

export const GRAMMAR_GUIDE_FILL_RULES = `- verbTense: nome do tempo verbal principal exigido pela missão (ex: "Present Perfect", "Simple Past"). Deve ser coerente com requiredGrammar[0].
- grammarGuide: guia didático em português sobre o tempo verbal de verbTense, para um aluno brasileiro que ainda não domina essa estrutura.
  title: mesmo valor de verbTense.
  explanationPtBr: 2-4 frases explicando quando e por que usar esse tempo verbal.
  usagePtBr: 2-4 situações de uso, em itens curtos.
  structures: estrutura afirmativa, negativa e interrogativa em inglês (ex: "Subject + have/has + past participle").
  examples: 2-4 pares de frases curtas em inglês com tradução em português, relacionadas ao contexto da missão.
  commonMistakes: 2-4 erros comuns que brasileiros cometem com esse tempo verbal, descritos em português.
- optionalExercises: EXATAMENTE 5 exercícios de prática do mesmo tempo verbal (verbTense), relacionados ao tema da missão. Misture os tipos fill_blank, multiple_choice, transform_sentence, correct_error e translate — não repita o mesmo tipo em todos.
  id: identificador curto único (ex: "ex1", "ex2"...).
  type: um dos 5 tipos listados acima.
  instructionPtBr: instrução curta em português (ex: "Complete a frase com o verbo no Present Perfect").
  question: o enunciado do exercício (frase em inglês com lacuna, frase para transformar, frase com erro para corrigir, ou frase em português para traduzir).
  options: apenas quando type="multiple_choice" — 3 a 4 alternativas incluindo a correta. Omitir ou deixar vazio nos demais tipos.
  correctAnswer: a resposta correta exata, no mesmo formato esperado da resposta do aluno.
  explanationPtBr: explicação curta em português de por que essa é a resposta correta.`;

// ── Normalization / validation ─────────────────────────────────────────────────

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

export function normalizeGrammarGuide(raw: unknown): GrammarGuide | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Record<string, unknown>;

  if (!isNonEmptyString(g.title) || !isNonEmptyString(g.explanationPtBr)) return null;

  const structuresRaw = (g.structures && typeof g.structures === 'object') ? g.structures as Record<string, unknown> : {};
  if (!isNonEmptyString(structuresRaw.affirmative) || !isNonEmptyString(structuresRaw.negative) || !isNonEmptyString(structuresRaw.interrogative)) {
    return null;
  }

  const examples = Array.isArray(g.examples)
    ? (g.examples as unknown[])
        .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
        .map((e) => ({ english: String(e.english || ''), portuguese: String(e.portuguese || '') }))
        .filter((e) => e.english.trim() && e.portuguese.trim())
    : [];
  if (examples.length === 0) return null;

  const usagePtBr = Array.isArray(g.usagePtBr)
    ? (g.usagePtBr as unknown[]).map((u) => String(u)).filter((u) => u.trim())
    : [];

  const commonMistakes = Array.isArray(g.commonMistakes)
    ? (g.commonMistakes as unknown[]).map((m) => String(m)).filter((m) => m.trim())
    : [];

  return {
    title: g.title.trim(),
    explanationPtBr: g.explanationPtBr.trim(),
    usagePtBr,
    structures: {
      affirmative: structuresRaw.affirmative.trim(),
      negative: structuresRaw.negative.trim(),
      interrogative: structuresRaw.interrogative.trim(),
    },
    examples,
    commonMistakes,
  };
}

export function normalizeOptionalExercises(raw: unknown): OptionalExercise[] | null {
  if (!Array.isArray(raw)) return null;

  const seenIds = new Set<string>();
  const exercises: OptionalExercise[] = [];

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;

    if (!isNonEmptyString(e.type) || !VALID_EXERCISE_TYPES.has(e.type)) continue;
    if (!isNonEmptyString(e.instructionPtBr)) continue;
    if (!isNonEmptyString(e.question)) continue;
    if (!isNonEmptyString(e.correctAnswer)) continue;
    if (!isNonEmptyString(e.explanationPtBr)) continue;

    let id = isNonEmptyString(e.id) ? e.id.trim() : `ex${i + 1}`;
    if (seenIds.has(id)) id = `ex${i + 1}`;
    seenIds.add(id);

    const options = e.type === 'multiple_choice' && Array.isArray(e.options)
      ? (e.options as unknown[]).map((o) => String(o)).filter((o) => o.trim())
      : undefined;

    if (e.type === 'multiple_choice' && (!options || options.length < 2)) continue;

    exercises.push({
      id,
      type: e.type as OptionalExerciseType,
      instructionPtBr: e.instructionPtBr.trim(),
      question: e.question.trim(),
      ...(options ? { options } : {}),
      correctAnswer: e.correctAnswer.trim(),
      explanationPtBr: e.explanationPtBr.trim(),
    });
  }

  return exercises.length > 0 ? exercises : null;
}
