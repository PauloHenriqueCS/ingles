import type { PronunciationNormalizedResult, PronunciationFailCode } from '../../types';

/**
 * Pure Azure Pronunciation Assessment parsing + score aggregation.
 *
 * Extracted from src/lib/pronunciationService.ts (browser) so the SERVER-side
 * assessment (api/_azure-pronunciation.ts) runs the exact same math on the exact
 * same raw Azure payloads. Both callers import this module, so a normalized
 * result produced server-side is byte-identical to what the browser used to
 * produce — same scores, same wordsJson, same rawSegments (which is what
 * buildWordAlignment reads to render per-word and per-phoneme detail).
 *
 * No DOM and no Speech SDK imports: this must stay importable from Node.
 */

export class PronunciationServiceError extends Error {
  constructor(
    public readonly code: PronunciationFailCode,
    message: string,
  ) {
    super(message);
    this.name = 'PronunciationServiceError';
  }
}

// ── Score aggregation ─────────────────────────────────────────────────────────
//
// Strategy from Microsoft's official continuous Pronunciation Assessment samples:
//   fluencyScore   = duration-weighted average across segments (Σ fluency_i × dur_i / Σ dur_i)
//   prosodyScore   = duration-weighted average across segments
//   accuracyScore  = word-count-weighted average (Σ word.accuracyScore / total words)
//   completeness   = (words correctly pronounced / reference word count) × 100, capped at 100
//   pronunciationScore = 0.4 × accuracy + 0.2 × fluency + 0.2 × completeness + 0.2 × prosody
//                        (without prosody: 0.4 × accuracy + 0.4 × fluency + 0.2 × completeness)
//
// Duration in the Azure JSON is in ticks (100 ns each). Word-level accuracy data
// comes from NBest[0].Words[].PronunciationAssessment.AccuracyScore.

export interface SegmentPA {
  accuracyScore: number;
  fluencyScore: number;
  completenessScore: number;
  pronScore: number;
  prosodyScore: number | null;
}

export interface SegmentWord {
  accuracyScore: number;
  errorType: string;
}

export interface ParsedSegment {
  pa: SegmentPA;
  words: SegmentWord[];
  durationTicks: number;
  display: string;
}

export function parseSegmentJson(json: string): ParsedSegment | null {
  try {
    const parsed = JSON.parse(json);
    const nb = Array.isArray(parsed?.NBest) ? parsed.NBest[0] : null;
    if (!nb) return null;

    const pa = nb.PronunciationAssessment;
    if (!pa) return null;

    const words: SegmentWord[] = (nb.Words ?? []).map((w: Record<string, unknown>) => {
      const wpa = (w.PronunciationAssessment ?? {}) as Record<string, unknown>;
      return {
        accuracyScore: typeof wpa.AccuracyScore === 'number' ? wpa.AccuracyScore : 0,
        errorType: typeof wpa.ErrorType === 'string' ? wpa.ErrorType : 'Unknown',
      };
    });

    const prosody = typeof pa.ProsodyScore === 'number' ? pa.ProsodyScore : null;

    return {
      pa: {
        accuracyScore:    typeof pa.AccuracyScore    === 'number' ? pa.AccuracyScore    : 0,
        fluencyScore:     typeof pa.FluencyScore     === 'number' ? pa.FluencyScore     : 0,
        completenessScore:typeof pa.CompletenessScore=== 'number' ? pa.CompletenessScore: 0,
        pronScore:        typeof pa.PronScore        === 'number' ? pa.PronScore        : 0,
        prosodyScore:     prosody,
      },
      words,
      durationTicks: typeof parsed.Duration === 'number' ? parsed.Duration : 0,
      display: typeof nb.Display === 'string' ? nb.Display : '',
    };
  } catch {
    return null;
  }
}

export function aggregateScores(
  segments: ParsedSegment[],
  referenceText: string,
): Omit<PronunciationNormalizedResult, 'recognizedText' | 'wordsJson' | 'rawSegments' | 'audioDurationSeconds'> {
  if (segments.length === 0) {
    throw new PronunciationServiceError('AZURE_NO_MATCH', 'Nenhum segmento de fala foi reconhecido.');
  }

  const totalDuration = segments.reduce((s, g) => s + g.durationTicks, 0);
  const hasProsody = segments.some((g) => g.pa.prosodyScore !== null);

  // Duration-weighted fluency and prosody
  const weightedFluency = segments.reduce((s, g) => s + g.pa.fluencyScore * g.durationTicks, 0);
  const fluencyScore = totalDuration > 0 ? weightedFluency / totalDuration : 0;

  let prosodyScore: number | null = null;
  if (hasProsody) {
    const weightedProsody = segments.reduce(
      (s, g) => s + (g.pa.prosodyScore ?? 0) * g.durationTicks,
      0,
    );
    prosodyScore = totalDuration > 0 ? weightedProsody / totalDuration : 0;
  }

  // Word-count-weighted accuracy
  const allWords = segments.flatMap((g) => g.words);
  const accuracyScore =
    allWords.length > 0
      ? allWords.reduce((s, w) => s + w.accuracyScore, 0) / allWords.length
      : 0;

  // Completeness: correctly pronounced words vs reference word count
  const refWordCount = referenceText.trim().split(/\s+/).filter(Boolean).length;
  const correctWords = allWords.filter((w) => w.errorType === 'None').length;
  const completenessScore = refWordCount > 0 ? Math.min(100, (correctWords / refWordCount) * 100) : 0;

  // pronunciationScore: official Microsoft formula
  const pronunciationScore = hasProsody
    ? 0.4 * accuracyScore + 0.2 * fluencyScore + 0.2 * completenessScore + 0.2 * (prosodyScore ?? 0)
    : 0.4 * accuracyScore + 0.4 * fluencyScore + 0.2 * completenessScore;

  return {
    pronunciationScore: clampScore(pronunciationScore),
    accuracyScore:      clampScore(accuracyScore),
    fluencyScore:       clampScore(fluencyScore),
    completenessScore:  clampScore(completenessScore),
    prosodyScore:       prosodyScore !== null ? clampScore(prosodyScore) : null,
  };
}

export function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

export function validateScores(
  r: Pick<PronunciationNormalizedResult, 'pronunciationScore' | 'accuracyScore' | 'fluencyScore' | 'completenessScore' | 'prosodyScore'>,
): void {
  const checks: [string, number | null][] = [
    ['pronunciationScore', r.pronunciationScore],
    ['accuracyScore', r.accuracyScore],
    ['fluencyScore', r.fluencyScore],
    ['completenessScore', r.completenessScore],
    ['prosodyScore', r.prosodyScore],
  ];
  for (const [name, val] of checks) {
    if (val === null) continue;
    if (!Number.isFinite(val) || val < 0 || val > 100) {
      throw new PronunciationServiceError('RESULT_INVALID', `Score inválido: ${name} = ${val}`);
    }
  }
}

/**
 * Builds the normalized result from collected segments. Shared by the browser
 * session and the server-side assessor so both emit the identical payload that
 * /complete persists and buildWordAlignment consumes.
 */
export function buildNormalizedResult(
  segments: ParsedSegment[],
  rawSegments: unknown[],
  referenceText: string,
  audioDurationMs: number,
): PronunciationNormalizedResult {
  const recognizedText = segments.map((s) => s.display).join(' ').trim();
  const allWords = segments.flatMap((s) => s.words);
  const scores = aggregateScores(segments, referenceText);
  validateScores(scores);
  return {
    ...scores,
    recognizedText,
    wordsJson: allWords,
    rawSegments,
    audioDurationSeconds: audioDurationMs / 1000,
  };
}
