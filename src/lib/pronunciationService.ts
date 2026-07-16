import type { PronunciationNormalizedResult, PronunciationFailCode } from '../types';

export class PronunciationServiceError extends Error {
  constructor(
    public readonly code: PronunciationFailCode,
    message: string,
  ) {
    super(message);
    this.name = 'PronunciationServiceError';
  }
}

export interface PronunciationServiceOptions {
  token: string;
  region: string;
  referenceText: string;
  wavFile: File;
  audioDurationMs: number;
}

export interface RecognitionSession {
  run: () => Promise<PronunciationNormalizedResult>;
  cancel: () => void;
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

interface SegmentPA {
  accuracyScore: number;
  fluencyScore: number;
  completenessScore: number;
  pronScore: number;
  prosodyScore: number | null;
}

interface SegmentWord {
  accuracyScore: number;
  errorType: string;
}

interface ParsedSegment {
  pa: SegmentPA;
  words: SegmentWord[];
  durationTicks: number;
  display: string;
}

function parseSegmentJson(json: string): ParsedSegment | null {
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

function aggregateScores(
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

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

function validateScores(r: Pick<PronunciationNormalizedResult, 'pronunciationScore' | 'accuracyScore' | 'fluencyScore' | 'completenessScore' | 'prosodyScore'>): void {
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

// ── Session factory ───────────────────────────────────────────────────────────

/**
 * Creates a recognition session that runs continuous Azure Pronunciation Assessment.
 * Call run() to start and cancel() to abort from outside (e.g., on unmount).
 */
export function createRecognitionSession(options: PronunciationServiceOptions): RecognitionSession {
  let cancelFn: (() => void) | null = null;

  const run = async (): Promise<PronunciationNormalizedResult> => {
    // Dynamic import keeps SDK out of SSR bundles
    const sdk = await import('microsoft-cognitiveservices-speech-sdk');

    const {
      SpeechConfig,
      AudioConfig,
      SpeechRecognizer,
      PronunciationAssessmentConfig,
      PronunciationAssessmentGradingSystem,
      PronunciationAssessmentGranularity,
      ResultReason,
      PropertyId,
      CancellationReason,
    } = sdk;

    const speechConfig = SpeechConfig.fromAuthorizationToken(options.token, options.region);
    speechConfig.speechRecognitionLanguage = 'en-US';

    const paCfg = new PronunciationAssessmentConfig(
      options.referenceText,
      PronunciationAssessmentGradingSystem.HundredMark,
      PronunciationAssessmentGranularity.Phoneme,
      false, // EnableMiscue not supported in continuous mode
    );
    paCfg.enableProsodyAssessment = true;

    const audioConfig = AudioConfig.fromWavFileInput(options.wavFile);
    const recognizer = new SpeechRecognizer(speechConfig, audioConfig);
    paCfg.applyTo(recognizer);

    // Timeout: 3× the audio duration, bounded to [30s, 5min]
    const timeoutMs = Math.max(30_000, Math.min(300_000, options.audioDurationMs * 3));

    return new Promise<PronunciationNormalizedResult>((resolve, reject) => {
      const segments: ParsedSegment[] = [];
      const rawJsons: unknown[] = [];
      let done = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      function finish(err?: PronunciationServiceError) {
        if (done) return;
        done = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        cancelFn = null;

        // Stop and clean up regardless of outcome
        recognizer
          .stopContinuousRecognitionAsync(
            () => {
              recognizer.close();
              audioConfig.close?.();
              speechConfig.close?.();
              if (err) {
                reject(err);
              } else {
                try {
                  const recognizedText = segments.map((s) => s.display).join(' ').trim();
                  const allWords = segments.flatMap((s) => s.words);
                  const scores = aggregateScores(segments, options.referenceText);
                  validateScores(scores);
                  resolve({
                    ...scores,
                    recognizedText,
                    wordsJson: allWords,
                    rawSegments: rawJsons,
                    audioDurationSeconds: options.audioDurationMs / 1000,
                  });
                } catch (e) {
                  reject(e instanceof PronunciationServiceError ? e : new PronunciationServiceError('RESULT_INVALID', String(e)));
                }
              }
            },
            (stopErr: unknown) => {
              recognizer.close();
              audioConfig.close?.();
              speechConfig.close?.();
              reject(err ?? new PronunciationServiceError('AZURE_CANCELED', String(stopErr)));
            },
          );
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recognizer.recognized = (_s: unknown, e: any) => {
        if (e.result.reason !== ResultReason.RecognizedSpeech) return;
        const json = e.result.properties?.getProperty(PropertyId.SpeechServiceResponse_JsonResult);
        if (!json) return;
        const seg = parseSegmentJson(json);
        if (seg) {
          segments.push(seg);
          try { rawJsons.push(JSON.parse(json)); } catch { rawJsons.push(json); }
        }
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recognizer.canceled = (_s: unknown, e: any) => {
        if (done) return;
        if (e.reason === CancellationReason.EndOfStream) {
          finish();
          return;
        }
        // CancellationErrorCode.AuthenticationFailure = 1
        const isAuthError = typeof e.errorCode === 'number' && e.errorCode === 1;
        const code: PronunciationFailCode = isAuthError ? 'AZURE_NETWORK_ERROR' : 'AZURE_CANCELED';
        finish(new PronunciationServiceError(code, e.errorDetails ?? 'Azure cancelou a sessão.'));
      };

      recognizer.sessionStopped = () => {
        finish();
      };

      cancelFn = () => {
        finish(new PronunciationServiceError('CLIENT_INTERRUPTED', 'Análise interrompida pelo usuário.'));
      };

      timeoutHandle = setTimeout(() => {
        finish(new PronunciationServiceError('AZURE_TIMEOUT', 'A análise de pronúncia demorou demais.'));
      }, timeoutMs);

      recognizer.startContinuousRecognitionAsync(
        () => { /* started */ },
        (startErr: unknown) => {
          finish(new PronunciationServiceError('AZURE_CANCELED', String(startErr)));
        },
      );
    });
  };

  return {
    run,
    cancel: () => cancelFn?.(),
  };
}
