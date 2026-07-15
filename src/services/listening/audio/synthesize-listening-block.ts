import {
  SpeechConfig,
  SpeechSynthesizer,
  SpeechSynthesisOutputFormat,
  ResultReason,
  CancellationDetails,
  CancellationReason,
  CancellationErrorCode,
} from 'microsoft-cognitiveservices-speech-sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  RawListeningBookmarkEvent,
  RawListeningWordBoundaryEvent,
  ListeningSynthesisRawResult,
  ListeningAzureSpeechConfig,
  SynthesizeListeningBlockInput,
  ListeningAudioBlockResult,
} from './listening-audio-types';
import {
  buildStagingAudioPath,
  NON_RETRYABLE_AZURE_ERROR_CODES,
  RETRY_DELAY_BASE_MS,
} from './listening-audio-config';
import { normalizeBookmarkTimings } from './normalize-listening-bookmarks';
import { normalizeWordBoundaryTimings } from './normalize-listening-word-boundaries';
import { validateListeningBookmarkEvents } from './validate-listening-bookmarks';
import { validateListeningAudioBuffer } from './validate-listening-audio';
import { computeListeningAudioHash } from './hash-listening-audio';
import { uploadListeningAudioStaging, listeningAudioFileExists } from './upload-listening-audio-staging';
import { persistListeningAudio } from './persist-listening-audio';
import { azureTicksToMilliseconds } from './normalize-listening-bookmarks';

// ─── Error classes ──────────────────────────────────────────────────────────

export class ListeningAzureConfigError extends Error {
  readonly code = 'LISTENING_AZURE_CONFIG_ERROR';
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = 'ListeningAzureConfigError';
  }
}

export class ListeningAzureSynthesisCanceledError extends Error {
  readonly code = 'LISTENING_AZURE_SYNTHESIS_CANCELED';
  constructor(
    readonly episodeId: string,
    readonly blockOrder: number,
    readonly retryable: boolean,
    readonly cancellationCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'ListeningAzureSynthesisCanceledError';
  }
}

export class ListeningAzureSynthesisTimeoutError extends Error {
  readonly code = 'LISTENING_AZURE_SYNTHESIS_TIMEOUT';
  readonly retryable = true;
  constructor(readonly episodeId: string, readonly blockOrder: number) {
    super(`Synthesis timed out for episode ${episodeId} block ${blockOrder}`);
    this.name = 'ListeningAzureSynthesisTimeoutError';
  }
}

export class ListeningAudioBookmarksMissingError extends Error {
  readonly code = 'LISTENING_AUDIO_BOOKMARKS_MISSING';
  readonly retryable = false;
  constructor(
    readonly episodeId: string,
    readonly blockOrder: number,
    readonly missing: string[],
  ) {
    super(`Block ${blockOrder} missing bookmarks: ${missing.join(', ')}`);
    this.name = 'ListeningAudioBookmarksMissingError';
  }
}

export class ListeningAudioEmptyError extends Error {
  readonly code = 'LISTENING_AUDIO_EMPTY';
  readonly retryable = true;
  constructor(readonly episodeId: string, readonly blockOrder: number) {
    super(`Empty audio returned for episode ${episodeId} block ${blockOrder}`);
    this.name = 'ListeningAudioEmptyError';
  }
}

export class ListeningAudioDurationInvalidError extends Error {
  readonly code = 'LISTENING_AUDIO_DURATION_INVALID';
  readonly retryable = false;
  constructor(
    readonly episodeId: string,
    readonly blockOrder: number,
    readonly durationMs: number,
    readonly details: string,
  ) {
    super(details);
    this.name = 'ListeningAudioDurationInvalidError';
  }
}

// ─── Tick conversion (re-exported for CLI convenience) ──────────────────────
export { azureTicksToMilliseconds };

// ─── Core synthesis (one attempt) ───────────────────────────────────────────

function isNonRetryableErrorCode(code: string): boolean {
  return NON_RETRYABLE_AZURE_ERROR_CODES.has(code);
}

async function runSynthesisOnce(
  ssml: string,
  azureConfig: ListeningAzureSpeechConfig,
): Promise<ListeningSynthesisRawResult> {
  const speechConfig = SpeechConfig.fromSubscription(
    azureConfig.subscriptionKey,
    azureConfig.region,
  );
  speechConfig.speechSynthesisOutputFormat =
    azureConfig.outputFormatValue as SpeechSynthesisOutputFormat;
  speechConfig.speechSynthesisVoiceName = azureConfig.voiceName;

  const synthesizer = new SpeechSynthesizer(speechConfig);

  const bookmarkEvents: RawListeningBookmarkEvent[] = [];
  const wordBoundaryEvents: RawListeningWordBoundaryEvent[] = [];
  let bookmarkOrder = 0;
  let wordOrder = 0;

  synthesizer.bookmarkReached = (_s, e) => {
    bookmarkEvents.push({
      bookmarkName: e.text,
      audioOffsetTicks: e.audioOffset,
      receivedOrder: bookmarkOrder++,
    });
  };

  synthesizer.wordBoundary = (_s, e) => {
    wordBoundaryEvents.push({
      text: e.text,
      audioOffsetTicks: e.audioOffset,
      durationTicks: (e as unknown as { duration?: number }).duration ?? null,
      textOffset: e.textOffset ?? null,
      wordLength: e.wordLength ?? null,
      boundaryType: e.boundaryType != null ? String(e.boundaryType) : null,
      receivedOrder: wordOrder++,
    });
  };

  let synthesizerClosed = false;

  const synthesisPromise = new Promise<ListeningSynthesisRawResult>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      if (!synthesizerClosed) {
        synthesizerClosed = true;
        try { synthesizer.close(); } catch { /* ignore */ }
      }
      reject(new Error('__TIMEOUT__'));
    }, azureConfig.synthesisTimeoutMs);

    synthesizer.speakSsmlAsync(
      ssml,
      result => {
        clearTimeout(timeoutId);
        if (!synthesizerClosed) {
          synthesizerClosed = true;
          try { synthesizer.close(); } catch { /* ignore */ }
        }
        resolve({
          audioData: result.audioData,
          audioDurationTicks: result.audioDuration ?? 0,
          bookmarkEvents,
          wordBoundaryEvents,
          resultId: result.resultId ?? '',
          _sdkResult: result,
        } as ListeningSynthesisRawResult & { _sdkResult: unknown });
      },
      error => {
        clearTimeout(timeoutId);
        if (!synthesizerClosed) {
          synthesizerClosed = true;
          try { synthesizer.close(); } catch { /* ignore */ }
        }
        reject(new Error(String(error)));
      },
    );
  });

  return synthesisPromise;
}

function extractSdkResult(raw: ListeningSynthesisRawResult): unknown {
  return (raw as ListeningSynthesisRawResult & { _sdkResult?: unknown })._sdkResult;
}

// ─── Per-block synthesis orchestrator ───────────────────────────────────────

export async function synthesizeListeningBlock(
  input: SynthesizeListeningBlockInput,
  azureConfig: ListeningAzureSpeechConfig,
  supabase: SupabaseClient,
  cefrLevel: string,
): Promise<ListeningAudioBlockResult> {
  const { blockId, blockOrder, episodeId, contentVersion, ssml, ssmlHash, expectedBookmarks } = input;

  // Check idempotency: validated asset already exists for this ssmlHash?
  const { data: existingAsset } = await supabase
    .from('listening_audio_assets')
    .select('id, audio_path, duration_ms, file_size_bytes, audio_hash, word_timing_status')
    .eq('block_id', blockId)
    .eq('ssml_hash', ssmlHash)
    .eq('synthesis_config_version', azureConfig.synthesisConfigVersion)
    .eq('status', 'validated')
    .maybeSingle();

  if (existingAsset) {
    const ea = existingAsset as {
      id: string;
      audio_path: string;
      duration_ms: number;
      file_size_bytes: number;
      audio_hash: string;
      word_timing_status: string;
    };
    // Verify file still exists in Storage
    if (await listeningAudioFileExists(supabase, ea.audio_path)) {
      console.error(JSON.stringify({
        event: 'listening_audio_synthesis_idempotent',
        episodeId,
        blockId,
        blockOrder,
        audioAssetId: ea.id,
        t: Date.now(),
      }));
      return {
        blockId,
        blockOrder,
        audioAssetId: ea.id,
        audioPath: ea.audio_path,
        durationMs: ea.duration_ms,
        fileSizeBytes: ea.file_size_bytes,
        audioHash: ea.audio_hash,
        ssmlHash,
        bookmarkCount: expectedBookmarks.length,
        wordTimingCount: 0,
        wordTimingStatus: ea.word_timing_status as 'complete' | 'partial' | 'missing' | 'invalid',
        status: 'validated',
      };
    }
  }

  // Mark block as processing
  await supabase
    .from('listening_blocks')
    .update({ audio_status: 'processing', updated_at: new Date().toISOString() })
    .eq('id', blockId);

  console.error(JSON.stringify({
    event: 'listening_audio_synthesis_started',
    episodeId,
    blockId,
    blockOrder,
    ssmlHash,
    voiceName: azureConfig.voiceName,
    t: Date.now(),
  }));

  // Synthesize with retry
  let rawResult: ListeningSynthesisRawResult | null = null;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= azureConfig.maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAY_BASE_MS * attempt;
      await new Promise(r => setTimeout(r, delay));
      console.error(JSON.stringify({
        event: 'listening_audio_synthesis_retry',
        episodeId, blockId, blockOrder, attempt, t: Date.now(),
      }));
    }

    try {
      rawResult = await runSynthesisOnce(ssml, azureConfig);

      // Check if result is a cancellation
      const sdkResult = extractSdkResult(rawResult);
      if (sdkResult && (sdkResult as { reason?: number }).reason === ResultReason.Canceled) {
        const details = CancellationDetails.fromResult(sdkResult as Parameters<typeof CancellationDetails.fromResult>[0]);
        const errorCodeStr = CancellationErrorCode[details.ErrorCode] ?? String(details.ErrorCode);
        const retryable =
          details.reason !== CancellationReason.Error ||
          !isNonRetryableErrorCode(errorCodeStr);

        if (!retryable || attempt >= azureConfig.maxRetries) {
          throw new ListeningAzureSynthesisCanceledError(
            episodeId,
            blockOrder,
            retryable,
            errorCodeStr,
            `Azure synthesis canceled: ${details.errorDetails}`,
          );
        }
        lastError = new Error(`Cancellation: ${details.errorDetails}`);
        rawResult = null;
        continue;
      }
      break;
    } catch (err) {
      if (err instanceof ListeningAzureSynthesisCanceledError) throw err;

      const isTimeout = err instanceof Error && err.message === '__TIMEOUT__';
      if (isTimeout) {
        lastError = new ListeningAzureSynthesisTimeoutError(episodeId, blockOrder);
      } else {
        lastError = err instanceof Error ? err : new Error(String(err));
      }

      if (attempt >= azureConfig.maxRetries) break;
    }
  }

  if (!rawResult) {
    throw lastError ?? new Error(`Synthesis failed for block ${blockOrder}`);
  }

  // Validate result
  if (!rawResult.audioData || rawResult.audioData.byteLength === 0) {
    throw new ListeningAudioEmptyError(episodeId, blockOrder);
  }

  const durationMs = rawResult.audioDurationTicks > 0
    ? azureTicksToMilliseconds(rawResult.audioDurationTicks)
    : 0;

  const audioValidation = validateListeningAudioBuffer(rawResult.audioData, durationMs);
  if (!audioValidation.valid) {
    if (audioValidation.failureCode === 'LISTENING_AUDIO_EMPTY') {
      throw new ListeningAudioEmptyError(episodeId, blockOrder);
    }
    throw new ListeningAudioDurationInvalidError(
      episodeId, blockOrder, durationMs, audioValidation.details ?? 'Invalid audio',
    );
  }

  // Validate bookmarks
  const bookmarkValidation = validateListeningBookmarkEvents(
    rawResult.bookmarkEvents,
    expectedBookmarks,
  );
  if (!bookmarkValidation.valid) {
    if (bookmarkValidation.missing.length > 0) {
      throw new ListeningAudioBookmarksMissingError(episodeId, blockOrder, bookmarkValidation.missing);
    }
    // Duplicates or unexpected — log but allow if all expected are present
    console.error(JSON.stringify({
      event: 'listening_audio_bookmark_warning',
      episodeId, blockId, blockOrder,
      duplicated: bookmarkValidation.duplicated,
      unexpected: bookmarkValidation.unexpected,
      outOfOrder: bookmarkValidation.outOfOrder,
      t: Date.now(),
    }));
  }

  // Compute audio hash
  const audioHash = computeListeningAudioHash(rawResult.audioData);

  // Build Storage path
  const storagePath = buildStagingAudioPath(cefrLevel, episodeId, contentVersion, ssmlHash, blockOrder);

  // Upload to Storage
  console.error(JSON.stringify({
    event: 'listening_audio_synthesis_completed',
    episodeId, blockId, blockOrder,
    durationMs,
    fileSizeBytes: rawResult.audioData.byteLength,
    audioHash,
    ssmlHash,
    bookmarkCount: rawResult.bookmarkEvents.length,
    wordCount: rawResult.wordBoundaryEvents.length,
    t: Date.now(),
  }));

  await uploadListeningAudioStaging({
    supabase,
    audioData: rawResult.audioData,
    storagePath,
  });

  console.error(JSON.stringify({ event: 'listening_audio_uploaded', episodeId, blockId, storagePath, t: Date.now() }));

  // Normalize timings
  const placeholder = 'placeholder-asset-id'; // replaced after persist
  const bookmarkTimings = normalizeBookmarkTimings(placeholder, rawResult.bookmarkEvents);
  const wordTimings = normalizeWordBoundaryTimings(placeholder, rawResult.wordBoundaryEvents);

  const wordTimingStatus =
    wordTimings.length === 0
      ? 'missing'
      : wordTimings.length < 3
        ? 'partial'
        : 'complete';

  // Persist
  const { audioAssetId } = await persistListeningAudio({
    supabase,
    episodeId,
    blockId,
    blockOrder,
    audioPath: storagePath,
    fileSizeBytes: rawResult.audioData.byteLength,
    durationMs,
    voiceName: azureConfig.voiceName,
    locale: azureConfig.voiceName.split('-').slice(0, 2).join('-'),
    ssmlHash,
    audioHash,
    synthesisConfigVersion: azureConfig.synthesisConfigVersion,
    wordTimingStatus,
    durationStatus: audioValidation.durationStatus,
    bookmarkTimings: bookmarkTimings.map(t => ({ ...t, audioAssetId: '' })),
    wordTimings: wordTimings.map(t => ({ ...t, audioAssetId: '' })),
    rawSynthesisEventsJson: {
      bookmarkCount: rawResult.bookmarkEvents.length,
      wordCount: rawResult.wordBoundaryEvents.length,
      resultId: rawResult.resultId,
      bookmarkValidation,
      durationStatus: audioValidation.durationStatus,
    },
  });

  return {
    blockId,
    blockOrder,
    audioAssetId,
    audioPath: storagePath,
    durationMs,
    fileSizeBytes: rawResult.audioData.byteLength,
    audioHash,
    ssmlHash,
    bookmarkCount: rawResult.bookmarkEvents.length,
    wordTimingCount: wordTimings.length,
    wordTimingStatus,
    status: 'validated',
  };
}
