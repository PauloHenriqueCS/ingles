// ── Exported Types ────────────────────────────────────────────────────────────

export type PronWordErrorType =
  | 'none'
  | 'mispronunciation'
  | 'omission'
  | 'insertion'
  | 'unexpected_break'
  | 'missing_break'
  | 'monotone'
  | 'unknown';

export interface PronWordSyllable {
  syllable: string;
  accuracyScore: number | null;
  offset: number | null;
  duration: number | null;
}

export interface PronWordPhoneme {
  phoneme: string;
  accuracyScore: number | null;
  offset: number | null;
  duration: number | null;
}

export interface PronunciationWordDetail {
  id: string;
  referenceWord: string | null;
  recognizedWord: string | null;
  displayWord: string;
  normalizedWord: string;
  accuracyScore: number | null;
  errorType: PronWordErrorType;
  offset: number | null;
  duration: number | null;
  syllables: PronWordSyllable[];
  phonemes: PronWordPhoneme[];
}

export interface PronunciationWordAlignment {
  aligned: PronunciationWordDetail[];
  insertions: PronunciationWordDetail[];
}

export type WordBand = 'good' | 'attention' | 'practice' | 'omission' | 'insertion' | 'no_data';

export interface WordBandInfo {
  band: WordBand;
  label: string;
  colorClass: string;
  bgClass: string;
  borderClass: string;
  makeAriaLabel: (word: string, score: number | null) => string;
}

// ── Visual bands ──────────────────────────────────────────────────────────────

export const WORD_BANDS: Record<WordBand, WordBandInfo> = {
  good: {
    band: 'good',
    label: 'Boa pronúncia',
    colorClass: 'text-green-400',
    bgClass: 'bg-green-900/30',
    borderClass: 'border-green-700',
    makeAriaLabel: (w, s) => `Palavra ${w}, boa pronúncia${s !== null ? `, precisão ${Math.round(s)} de 100` : ''}.`,
  },
  attention: {
    band: 'attention',
    label: 'Pode melhorar',
    colorClass: 'text-yellow-400',
    bgClass: 'bg-yellow-900/30',
    borderClass: 'border-yellow-700',
    makeAriaLabel: (w, s) => `Palavra ${w}, pode melhorar${s !== null ? `, precisão ${Math.round(s)} de 100` : ''}.`,
  },
  practice: {
    band: 'practice',
    label: 'Pratique novamente',
    colorClass: 'text-red-400',
    bgClass: 'bg-red-900/30',
    borderClass: 'border-red-700',
    makeAriaLabel: (w, s) => `Palavra ${w}, pratique novamente${s !== null ? `, precisão ${Math.round(s)} de 100` : ''}.`,
  },
  omission: {
    band: 'omission',
    label: 'Não identificada',
    colorClass: 'text-slate-400',
    bgClass: 'bg-slate-800/60',
    borderClass: 'border-slate-600 border-dashed',
    makeAriaLabel: (w) => `Palavra ${w}, não identificada na gravação.`,
  },
  insertion: {
    band: 'insertion',
    label: 'Palavra adicional',
    colorClass: 'text-blue-400',
    bgClass: 'bg-blue-900/20',
    borderClass: 'border-blue-700',
    makeAriaLabel: (w) => `Palavra adicional ${w}, identificada pelo Azure, não faz parte do texto.`,
  },
  no_data: {
    band: 'no_data',
    label: 'Sem detalhes',
    colorClass: 'text-slate-500',
    bgClass: 'bg-slate-800/40',
    borderClass: 'border-slate-700',
    makeAriaLabel: (w) => `Palavra ${w}, sem detalhes disponíveis.`,
  },
};

export function getWordBand(word: PronunciationWordDetail): WordBandInfo {
  if (word.errorType === 'omission') return WORD_BANDS.omission;
  if (word.errorType === 'insertion') return WORD_BANDS.insertion;
  if (word.accuracyScore === null) return WORD_BANDS.no_data;
  if (word.accuracyScore >= 80) return WORD_BANDS.good;
  if (word.accuracyScore >= 60) return WORD_BANDS.attention;
  return WORD_BANDS.practice;
}

export function getWordGuidance(word: PronunciationWordDetail): string {
  if (word.errorType === 'omission') {
    return 'Esta palavra não foi identificada na gravação.';
  }
  if (word.errorType === 'insertion') {
    return 'O Azure identificou uma palavra adicional que não fazia parte do texto.';
  }
  if (word.accuracyScore === null) {
    return 'O serviço não retornou detalhes suficientes para esta palavra.';
  }
  if (word.accuracyScore >= 80) {
    return 'Boa pronúncia. O som ficou próximo do padrão esperado.';
  }
  if (word.accuracyScore >= 60) {
    return 'Está próxima do esperado, mas ainda pode ficar mais clara.';
  }
  return 'Pratique esta palavra com mais calma e atenção aos sons destacados.';
}

// Omissions first, then lowest-scored words; excludes insertions and null-score words.
export function selectWorstWords(
  aligned: PronunciationWordDetail[],
  limit = 5,
): PronunciationWordDetail[] {
  const omissions = aligned.filter((w) => w.errorType === 'omission');

  const scoredWorst = aligned
    .filter((w) => w.errorType !== 'omission' && w.errorType !== 'insertion' && w.accuracyScore !== null)
    .sort((a, b) => (a.accuracyScore as number) - (b.accuracyScore as number));

  return [...omissions, ...scoredWorst].slice(0, limit);
}

// ── Internal types ────────────────────────────────────────────────────────────

interface RefToken {
  index: number;
  displayForm: string;
  normalizedForm: string;
}

interface AzureWord {
  word: string;
  normalizedForm: string;
  accuracyScore: number | null;
  errorType: string;
  offset: number | null;
  duration: number | null;
  syllables: PronWordSyllable[];
  phonemes: PronWordPhoneme[];
}

type AlignedOp =
  | { type: 'match'; refIdx: number; recIdx: number }
  | { type: 'sub'; refIdx: number; recIdx: number }
  | { type: 'omit'; refIdx: number }
  | { type: 'insert'; recIdx: number };

// ── Normalization ─────────────────────────────────────────────────────────────

export function normalizeWord(raw: string): string {
  let s = raw.toLowerCase();
  // Normalize typographic quotes/apostrophes to ASCII
  s = s.replace(/[“”]/g, '"');
  s = s.replace(/[‘’]/g, "'");
  // Strip leading non-alphanumeric (preserves internal apostrophes and hyphens)
  s = s.replace(/^[^a-z0-9]+/, '');
  // Strip trailing non-alphanumeric
  s = s.replace(/[^a-z0-9]+$/, '');
  return s;
}

// ── Reference tokenization ────────────────────────────────────────────────────

function tokenizeReference(text: string): RefToken[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((raw, i) => ({
      index: i,
      displayForm: raw,
      normalizedForm: normalizeWord(raw),
    }))
    .filter((t) => t.normalizedForm.length > 0); // skip tokens that normalize to empty
}

// ── Azure raw segment parsing ─────────────────────────────────────────────────

function toScore(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v < 0 || v > 100) return null;
  return v;
}

function toTicks(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return v;
}

function mapErrorType(azure: string): PronWordErrorType {
  switch (azure) {
    case 'None':             return 'none';
    case 'Omission':         return 'omission';
    case 'Insertion':        return 'insertion';
    case 'Mispronunciation': return 'mispronunciation';
    case 'UnexpectedBreak':  return 'unexpected_break';
    case 'MissingBreak':     return 'missing_break';
    case 'Monotone':         return 'monotone';
    default:                 return 'unknown';
  }
}

function parseSyllables(wpa: Record<string, unknown>): PronWordSyllable[] {
  if (!Array.isArray(wpa.Syllables)) return [];
  return wpa.Syllables.flatMap((syl: unknown) => {
    if (!syl || typeof syl !== 'object') return [];
    const sr = syl as Record<string, unknown>;
    const syllable = typeof sr.Syllable === 'string' ? sr.Syllable : '';
    if (!syllable) return [];
    return [{
      syllable,
      accuracyScore: toScore(sr.AccuracyScore),
      offset: toTicks(sr.Offset),
      duration: toTicks(sr.Duration),
    }];
  });
}

function parsePhonemes(wpa: Record<string, unknown>): PronWordPhoneme[] {
  if (!Array.isArray(wpa.Phonemes)) return [];
  return wpa.Phonemes.flatMap((ph: unknown) => {
    if (!ph || typeof ph !== 'object') return [];
    const pr = ph as Record<string, unknown>;
    const phoneme = typeof pr.Phoneme === 'string' ? pr.Phoneme : '';
    if (!phoneme) return [];
    return [{
      phoneme,
      accuracyScore: toScore(pr.AccuracyScore),
      offset: toTicks(pr.Offset),
      duration: toTicks(pr.Duration),
    }];
  });
}

export function parseRawSegments(rawSegments: unknown[]): AzureWord[] {
  const result: AzureWord[] = [];

  for (const seg of rawSegments) {
    if (!seg || typeof seg !== 'object') continue;
    const s = seg as Record<string, unknown>;
    const nBest = Array.isArray(s.NBest) ? s.NBest : [];
    const nb = nBest[0] as Record<string, unknown> | undefined;
    if (!nb) continue;
    const words = Array.isArray(nb.Words) ? nb.Words : [];

    for (const w of words) {
      if (!w || typeof w !== 'object') continue;
      const wr = w as Record<string, unknown>;
      const wordStr = typeof wr.Word === 'string' ? wr.Word : '';
      if (!wordStr) continue;

      const wpa = (wr.PronunciationAssessment ?? {}) as Record<string, unknown>;

      result.push({
        word: wordStr,
        normalizedForm: normalizeWord(wordStr),
        accuracyScore: toScore(wpa.AccuracyScore),
        errorType: typeof wpa.ErrorType === 'string' ? wpa.ErrorType : 'None',
        offset: toTicks(wr.Offset),
        duration: toTicks(wr.Duration),
        syllables: parseSyllables(wpa),
        phonemes: parsePhonemes(wpa),
      });
    }
  }

  return result;
}

// ── DP alignment ──────────────────────────────────────────────────────────────
//
// Classic Wagner-Fischer with backtracing.
// Priority on backtrack: match > substitute > omit-ref > insert-rec
// This makes the algorithm prefer pairing words as substitutions rather than
// declaring separate omissions + insertions, which better represents someone
// mispronouncing a word vs. skipping it entirely.

function alignRefToRec(ref: RefToken[], rec: AzureWord[]): AlignedOp[] {
  const m = ref.length;
  const n = rec.length;

  // Build DP table
  const dp: number[][] = [];
  for (let i = 0; i <= m; i++) {
    dp[i] = new Array(n + 1).fill(0);
    dp[i][0] = i;
  }
  for (let j = 0; j <= n; j++) {
    dp[0][j] = j;
  }

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const isMatch = ref[i - 1].normalizedForm === rec[j - 1].normalizedForm;
      dp[i][j] = Math.min(
        dp[i - 1][j - 1] + (isMatch ? 0 : 1), // match or substitute
        dp[i - 1][j] + 1,                       // omit ref[i-1]
        dp[i][j - 1] + 1,                       // insert rec[j-1]
      );
    }
  }

  // Backtrack
  const ops: AlignedOp[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i === 0) {
      ops.push({ type: 'insert', recIdx: j - 1 });
      j--;
    } else if (j === 0) {
      ops.push({ type: 'omit', refIdx: i - 1 });
      i--;
    } else {
      const isMatch = ref[i - 1].normalizedForm === rec[j - 1].normalizedForm;
      const diagCost = dp[i - 1][j - 1] + (isMatch ? 0 : 1);
      const upCost   = dp[i - 1][j] + 1;
      const leftCost = dp[i][j - 1] + 1;

      if (isMatch && dp[i][j] === dp[i - 1][j - 1]) {
        ops.push({ type: 'match', refIdx: i - 1, recIdx: j - 1 });
        i--; j--;
      } else if (dp[i][j] === diagCost) {
        ops.push({ type: 'sub', refIdx: i - 1, recIdx: j - 1 });
        i--; j--;
      } else if (dp[i][j] === upCost) {
        ops.push({ type: 'omit', refIdx: i - 1 });
        i--;
      } else {
        ops.push({ type: 'insert', recIdx: j - 1 });
        j--;
      }

      // Suppress TS "unused variable" warnings by satisfying the variable usage
      void leftCost;
    }
  }

  return ops.reverse();
}

// ── Public entry point ────────────────────────────────────────────────────────

export function buildWordAlignment(
  referenceText: string,
  rawSegments: unknown[],
): PronunciationWordAlignment {
  const refTokens = tokenizeReference(referenceText);
  const recWords = parseRawSegments(rawSegments);

  // If no reference text, return empty
  if (refTokens.length === 0) {
    return { aligned: [], insertions: [] };
  }

  // If no recognized words at all, all reference words are omissions
  if (recWords.length === 0) {
    const aligned = refTokens.map((t) => ({
      id: `ref-${t.index}`,
      referenceWord: t.displayForm,
      recognizedWord: null,
      displayWord: t.displayForm,
      normalizedWord: t.normalizedForm,
      accuracyScore: null,
      errorType: 'omission' as PronWordErrorType,
      offset: null,
      duration: null,
      syllables: [],
      phonemes: [],
    }));
    return { aligned, insertions: [] };
  }

  const ops = alignRefToRec(refTokens, recWords);
  const aligned: PronunciationWordDetail[] = [];
  const insertions: PronunciationWordDetail[] = [];

  for (const op of ops) {
    if (op.type === 'match') {
      const ref = refTokens[op.refIdx];
      const rec = recWords[op.recIdx];
      aligned.push({
        id: `ref-${ref.index}`,
        referenceWord: ref.displayForm,
        recognizedWord: rec.word,
        displayWord: ref.displayForm,
        normalizedWord: ref.normalizedForm,
        accuracyScore: rec.accuracyScore,
        errorType: mapErrorType(rec.errorType),
        offset: rec.offset,
        duration: rec.duration,
        syllables: rec.syllables,
        phonemes: rec.phonemes,
      });
    } else if (op.type === 'sub') {
      const ref = refTokens[op.refIdx];
      const rec = recWords[op.recIdx];
      const et = mapErrorType(rec.errorType);
      aligned.push({
        id: `ref-${ref.index}`,
        referenceWord: ref.displayForm,
        recognizedWord: rec.word,
        displayWord: ref.displayForm,
        normalizedWord: ref.normalizedForm,
        accuracyScore: rec.accuracyScore,
        // If Azure says 'none' but we detected a substitution, keep 'mispronunciation'
        errorType: et === 'none' ? 'mispronunciation' : et,
        offset: rec.offset,
        duration: rec.duration,
        syllables: rec.syllables,
        phonemes: rec.phonemes,
      });
    } else if (op.type === 'omit') {
      const ref = refTokens[op.refIdx];
      aligned.push({
        id: `ref-${ref.index}`,
        referenceWord: ref.displayForm,
        recognizedWord: null,
        displayWord: ref.displayForm,
        normalizedWord: ref.normalizedForm,
        accuracyScore: null,
        errorType: 'omission',
        offset: null,
        duration: null,
        syllables: [],
        phonemes: [],
      });
    } else {
      const rec = recWords[op.recIdx];
      insertions.push({
        id: `ins-${op.recIdx}`,
        referenceWord: null,
        recognizedWord: rec.word,
        displayWord: rec.word,
        normalizedWord: rec.normalizedForm,
        accuracyScore: rec.accuracyScore,
        errorType: 'insertion',
        offset: rec.offset,
        duration: rec.duration,
        syllables: rec.syllables,
        phonemes: rec.phonemes,
      });
    }
  }

  return { aligned, insertions };
}
