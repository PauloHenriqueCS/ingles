import type { PronunciationNormalizedResult, PronunciationFailCode } from '../types';
import {
  PronunciationServiceError,
  parseSegmentJson,
  buildNormalizedResult,
  type ParsedSegment,
} from '../domain/pronunciation/pronunciation-scoring';

// Re-exported so existing importers (flows, views, tests) keep their import path.
export { PronunciationServiceError };

export interface PronunciationServiceOptions {
  token: string;
  region: string;
  referenceText: string;
  wavFile: File;
  audioDurationMs: number;
  // Data-driven Azure recognition locale resolved server-side from the user's
  // learning language (public.languages.speech_locale). Optional: when absent
  // the SDK auto-detects rather than forcing a hardcoded English locale.
  language?: string;
}

export interface RecognitionSession {
  run: () => Promise<PronunciationNormalizedResult>;
  cancel: () => void;
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
    // Recognition locale is data-driven (server resolves it from the learning
    // language). Set it only when provided; if absent (older server), let Azure
    // auto-detect rather than forcing a hardcoded English locale.
    if (options.language) {
      speechConfig.speechRecognitionLanguage = options.language;
    }

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
                  resolve(buildNormalizedResult(
                    segments,
                    rawJsons,
                    options.referenceText,
                    options.audioDurationMs,
                  ));
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
        // Azure SDK CancellationErrorCode: AuthenticationFailure = 1, Forbidden = 2.
        // Surface auth failures distinctly (previously mislabeled as
        // AZURE_NETWORK_ERROR) so the server can record a real Azure auth
        // failure for this browser-side call and raise an operational alert.
        const isAuthError = typeof e.errorCode === 'number' && (e.errorCode === 1 || e.errorCode === 2);
        const code: PronunciationFailCode = isAuthError ? 'AZURE_AUTH_FAILED' : 'AZURE_CANCELED';
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
