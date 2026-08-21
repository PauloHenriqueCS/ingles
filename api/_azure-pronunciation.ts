/**
 * SERVER ONLY — never import this module from src/ or any client-side code.
 *
 * Server-side Azure **continuous** Pronunciation Assessment.
 *
 * Why this exists
 * ---------------
 * The assessment used to run in the browser (src/lib/pronunciationService.ts),
 * which meant every analysis depended on the end-user device opening a WebSocket
 * straight to Azure. That leg failed silently in production: the SDK's
 * browser-only FileAudioSource parses the WAV header inside a FileReader.onload
 * callback that has NO onerror and NO try/catch, so any throw there leaves its
 * Deferred permanently pending. ServiceRecognizerBase awaits that promise BEFORE
 * it emits `sessionStarted` and before it calls receiveMessage()/sendAudio(), so
 * the recognizer produced literally zero events — no recognized, no canceled, no
 * sessionStopped — and the SDK ships no client-side watchdog. The app's blanket
 * "3x the recording length" timer was the only thing that ever fired, which is
 * why the single observable symptom was "A análise demorou demais".
 *
 * In Node the SAME SDK takes a different branch: `window` is undefined, so
 * FileAudioSource reads the Buffer synchronously (no FileReader, no unsettled
 * promise). Running the assessment here removes the failure mode entirely and is
 * platform-independent — Web, Android and iOS all take the identical path.
 *
 * Continuous recognition (not the REST short-audio endpoint) is deliberate:
 * readings routinely exceed 30–60 s, and Azure documents continuous mode as the
 * supported path above 30 s. EnableMiscue stays false because it is unsupported
 * in continuous mode — matching the previous browser configuration exactly.
 *
 * Scores come from the shared pure module, so results are identical to what the
 * browser produced: same aggregation, same wordsJson, same rawSegments (which is
 * what buildWordAlignment reads for per-word and per-phoneme detail).
 */

import {
  SpeechConfig,
  AudioConfig,
  SpeechRecognizer,
  PronunciationAssessmentConfig,
  PronunciationAssessmentGradingSystem,
  PronunciationAssessmentGranularity,
  ResultReason,
  PropertyId,
  CancellationReason,
} from 'microsoft-cognitiveservices-speech-sdk';
import {
  PronunciationServiceError,
  parseSegmentJson,
  buildNormalizedResult,
  type ParsedSegment,
} from '../src/domain/pronunciation/pronunciation-scoring';
import type { PronunciationNormalizedResult } from '../src/types';

// ── Tunables ──────────────────────────────────────────────────────────────────

/** Hard ceiling for one assessment. Stays under the Vercel function timeout. */
const MAX_ASSESSMENT_MS = 240_000;
/** Floor, so very short clips still get a sane budget. */
const MIN_ASSESSMENT_MS = 60_000;
/**
 * No-progress watchdog. Any session/recognition event resets it. This is what
 * turns "Azure went quiet" into a fast, specific failure instead of waiting out
 * the whole budget — the opposite of masking the problem with a bigger timeout.
 */
const IDLE_TIMEOUT_MS = 45_000;

/** Smallest WAV we will even hand to the SDK: 44-byte header + some samples. */
const MIN_WAV_BYTES = 1_024;

// ── WAV header validation ─────────────────────────────────────────────────────

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataBytes: number;
  durationMs: number;
}

/**
 * Parses and validates the RIFF/WAVE header ourselves before the SDK sees it.
 *
 * Two reasons this is not redundant with the SDK's own parser:
 *  1. The SDK's parser is the thing that hangs on malformed input in the browser
 *     and throws an opaque RangeError in Node; a degenerate recording must fail
 *     here with a clear, attributable error.
 *  2. The audio duration used for the timeout budget must come from the bytes we
 *     actually received, never from a client-supplied number.
 */
export function parseWavHeader(buf: Buffer): WavInfo {
  if (buf.length < MIN_WAV_BYTES) {
    throw new PronunciationServiceError(
      'AUDIO_EMPTY',
      `WAV too small: ${buf.length} bytes`,
    );
  }
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new PronunciationServiceError('AUDIO_DECODE_FAILED', 'Not a RIFF/WAVE file');
  }

  let pos = 12;
  let fmt: { sampleRate: number; channels: number; bitsPerSample: number; audioFormat: number } | null = null;
  let dataBytes = 0;

  // Walk the chunk list properly (tolerates JUNK/LIST/FLLR before `fmt `/`data`).
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;

    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = {
        audioFormat:   buf.readUInt16LE(body),
        channels:      buf.readUInt16LE(body + 2),
        sampleRate:    buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      // Trust the smaller of the declared size and what actually arrived.
      dataBytes = Math.min(size, Math.max(0, buf.length - body));
      break;
    }

    pos = body + size + (size % 2); // chunks are word-aligned
  }

  if (!fmt)          throw new PronunciationServiceError('AUDIO_DECODE_FAILED', 'WAV has no fmt chunk');
  if (dataBytes <= 0) throw new PronunciationServiceError('AUDIO_EMPTY', 'WAV has no audio samples');
  if (fmt.audioFormat !== 1) {
    throw new PronunciationServiceError('AUDIO_DECODE_FAILED', `WAV is not PCM (format ${fmt.audioFormat})`);
  }
  if (fmt.bitsPerSample !== 16 || fmt.channels !== 1) {
    throw new PronunciationServiceError(
      'AUDIO_DECODE_FAILED',
      `WAV must be mono 16-bit (got ${fmt.channels}ch/${fmt.bitsPerSample}bit)`,
    );
  }
  if (fmt.sampleRate < 8_000 || fmt.sampleRate > 48_000) {
    throw new PronunciationServiceError('AUDIO_DECODE_FAILED', `Unsupported sample rate ${fmt.sampleRate}`);
  }

  const byteRate = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
  const durationMs = Math.round((dataBytes / byteRate) * 1000);

  if (durationMs < 300) {
    throw new PronunciationServiceError('AUDIO_EMPTY', `WAV too short: ${durationMs}ms`);
  }

  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    dataBytes,
    durationMs,
  };
}

// ── Assessment ────────────────────────────────────────────────────────────────

export interface AssessPronunciationInput {
  wav: Buffer;
  referenceText: string;
  /** Azure recognition locale, resolved server-side from the learning language. */
  language?: string;
  /** Correlation id for the stage logs. Never a user id. */
  logLabel?: string;
}

export interface AssessPronunciationOutput {
  result: PronunciationNormalizedResult;
  wav: WavInfo;
  /** Per-stage timings, safe to log and to return to the client for diagnosis. */
  timings: Record<string, number>;
}

interface AzureCreds {
  key: string;
  region: string;
}

function getCreds(): AzureCreds {
  const key = (process.env.AZURE_SPEECH_KEY ?? '').trim();
  const region = (process.env.AZURE_SPEECH_REGION ?? '').trim();
  if (!key || !region || !/^[a-z0-9-]+$/.test(region)) {
    throw new PronunciationServiceError('AZURE_CANCELED', 'Azure Speech is not configured');
  }
  return { key, region };
}

/**
 * Runs continuous pronunciation assessment over a complete WAV buffer.
 *
 * Stage logs carry only sizes, durations, counts and codes — never audio bytes,
 * never the subscription key or token, never the reference text.
 */
export async function assessPronunciation(
  input: AssessPronunciationInput,
): Promise<AssessPronunciationOutput> {
  const label = input.logLabel ?? 'assess';
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const mark = (stage: string) => { timings[stage] = Date.now() - t0; };

  const wavInfo = parseWavHeader(input.wav);
  mark('wav_validated');

  const { key, region } = getCreds();

  const speechConfig = SpeechConfig.fromSubscription(key, region);
  if (input.language) {
    speechConfig.speechRecognitionLanguage = input.language;
  }

  const paCfg = new PronunciationAssessmentConfig(
    input.referenceText,
    PronunciationAssessmentGradingSystem.HundredMark,
    PronunciationAssessmentGranularity.Phoneme,
    false, // EnableMiscue not supported in continuous mode
  );
  paCfg.enableProsodyAssessment = true;

  // Node path: FileAudioSource reads the Buffer synchronously — no FileReader,
  // so a malformed header throws here instead of hanging forever.
  const audioConfig = AudioConfig.fromWavFileInput(input.wav, 'recording.wav');
  const recognizer = new SpeechRecognizer(speechConfig, audioConfig);
  paCfg.applyTo(recognizer);
  mark('recognizer_ready');

  const budgetMs = Math.min(
    MAX_ASSESSMENT_MS,
    Math.max(MIN_ASSESSMENT_MS, wavInfo.durationMs * 3),
  );

  console.info(JSON.stringify({
    route: 'pronunciation/assess', event: 'start', label, region,
    language: input.language ?? null,
    wavBytes: input.wav.length, audioMs: wavInfo.durationMs,
    sampleRate: wavInfo.sampleRate, budgetMs,
  }));

  return new Promise<AssessPronunciationOutput>((resolve, reject) => {
    const segments: ParsedSegment[] = [];
    const rawJsons: unknown[] = [];
    let done = false;
    let segmentCount = 0;
    let overallTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = () => {
      if (overallTimer) { clearTimeout(overallTimer); overallTimer = null; }
      if (idleTimer)    { clearTimeout(idleTimer);    idleTimer = null; }
    };

    /** Any sign of life from Azure restarts the no-progress watchdog. */
    const bumpIdle = (stage: string) => {
      if (done) return;
      if (!timings[stage]) mark(stage);
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        finish(new PronunciationServiceError(
          'AZURE_TIMEOUT',
          `No progress from Azure for ${IDLE_TIMEOUT_MS}ms (segments=${segmentCount})`,
        ));
      }, IDLE_TIMEOUT_MS);
    };

    function finish(err?: PronunciationServiceError) {
      if (done) return;
      done = true;
      clearTimers();
      mark('finished');

      const settle = () => {
        try { recognizer.close(); } catch { /* already closed */ }
        if (err) {
          console.error(JSON.stringify({
            route: 'pronunciation/assess', event: 'failed', label,
            code: err.code, segments: segmentCount, timings,
          }));
          reject(err);
          return;
        }
        try {
          const result = buildNormalizedResult(
            segments, rawJsons, input.referenceText, wavInfo.durationMs,
          );
          console.info(JSON.stringify({
            route: 'pronunciation/assess', event: 'success', label,
            segments: segmentCount, words: result.wordsJson.length,
            pronunciationScore: result.pronunciationScore, timings,
          }));
          resolve({ result, wav: wavInfo, timings });
        } catch (e) {
          const mapped = e instanceof PronunciationServiceError
            ? e
            : new PronunciationServiceError('RESULT_INVALID', String(e));
          console.error(JSON.stringify({
            route: 'pronunciation/assess', event: 'failed', label,
            code: mapped.code, segments: segmentCount, timings,
          }));
          reject(mapped);
        }
      };

      recognizer.stopContinuousRecognitionAsync(settle, settle);
    }

    recognizer.sessionStarted = () => bumpIdle('session_started');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognizer.recognizing = () => bumpIdle('first_partial');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognizer.recognized = (_s: unknown, e: any) => {
      bumpIdle('first_result');
      if (e?.result?.reason !== ResultReason.RecognizedSpeech) return;
      const json = e.result.properties?.getProperty(PropertyId.SpeechServiceResponse_JsonResult);
      if (!json) return;
      const seg = parseSegmentJson(json);
      if (seg) {
        segments.push(seg);
        segmentCount = segments.length;
        try { rawJsons.push(JSON.parse(json)); } catch { rawJsons.push(json); }
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognizer.canceled = (_s: unknown, e: any) => {
      if (done) return;
      if (e?.reason === CancellationReason.EndOfStream) {
        finish();
        return;
      }
      // CancellationErrorCode: AuthenticationFailure = 1, Forbidden = 2
      const isAuth = typeof e?.errorCode === 'number' && (e.errorCode === 1 || e.errorCode === 2);
      finish(new PronunciationServiceError(
        isAuth ? 'AZURE_AUTH_FAILED' : 'AZURE_CANCELED',
        String(e?.errorDetails ?? 'Azure canceled the session'),
      ));
    };

    recognizer.sessionStopped = () => finish();

    overallTimer = setTimeout(() => {
      finish(new PronunciationServiceError(
        'AZURE_TIMEOUT',
        `Assessment exceeded ${budgetMs}ms (segments=${segmentCount})`,
      ));
    }, budgetMs);

    bumpIdle('connecting');

    recognizer.startContinuousRecognitionAsync(
      () => mark('recognition_started'),
      (startErr: unknown) => finish(
        new PronunciationServiceError('AZURE_CANCELED', String(startErr)),
      ),
    );
  });
}
