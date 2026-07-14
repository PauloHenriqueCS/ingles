import { convertToWavPcm, AudioConversionError } from './audioConverter';
import { createRecognitionSession, PronunciationServiceError } from './pronunciationService';
import { getAuthHeader } from './apiAuth';
import type { PronunciationFailCode, PronunciationNormalizedResult } from '../types';

export type AnalysisPhase =
  | 'loading_status'
  | 'idle'
  | 'confirming'
  | 'preparing_audio'
  | 'reserving'
  | 'analyzing'
  | 'saving_result'
  | 'completed'
  | 'failed'
  | 'processing'
  | 'failed_retryable'
  | 'failed_final';

export interface AnalysisState {
  phase: AnalysisPhase;
  result?: PronunciationNormalizedResult;
  errorMessage?: string;
}

export interface FlowRefs {
  mountedRef:           { current: boolean };
  idempotencyKeyRef:    { current: string | null };
  assessmentIdRef:      { current: string | null };
  cancelRecognitionRef: { current: (() => void) | null };
  flowLockRef:          { current: boolean };
}

const PHASE_MESSAGES: Partial<Record<AnalysisPhase, string>> = {
  preparing_audio: 'Preparando sua gravação…',
  reserving:       'Preparando sua gravação…',
  analyzing:       'Analisando sua pronúncia…',
  saving_result:   'Salvando seu resultado…',
};

export { PHASE_MESSAGES };

async function reportFail(refs: FlowRefs, code: PronunciationFailCode): Promise<void> {
  const aid = refs.assessmentIdRef.current;
  if (!aid) return;
  try {
    const headers = await getAuthHeader();
    await fetch('/api/pronunciation/fail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ assessmentId: aid, code }),
    });
  } catch {
    // best effort
  }
}

export async function runAnalysisFlow(
  input: {
    reviewId:         string | null;
    idempotencyKey:   string;
    audioBlob:        Blob | null;
    audioDurationMs:  number;
  },
  refs: FlowRefs,
  onPhaseChange: (state: AnalysisState) => void,
): Promise<void> {
  refs.idempotencyKeyRef.current = input.idempotencyKey;
  refs.assessmentIdRef.current   = null;

  const setPhase = (state: AnalysisState) => {
    if (refs.mountedRef.current) onPhaseChange(state);
  };

  // Step 1: Convert audio to WAV PCM
  setPhase({ phase: 'preparing_audio' });
  let wavFile: File;
  try {
    if (!input.audioBlob) throw new AudioConversionError('AUDIO_EMPTY', 'Sem áudio gravado.');
    wavFile = await convertToWavPcm(input.audioBlob);
  } catch (err) {
    const code: PronunciationFailCode =
      err instanceof AudioConversionError ? (err.code as PronunciationFailCode) : 'AUDIO_DECODE_FAILED';
    const message =
      err instanceof AudioConversionError && err.code === 'AUDIO_DECODE_FAILED'
        ? 'Não foi possível preparar esta gravação para análise. Grave novamente e tente outra vez.'
        : 'A gravação está vazia. Grave o áudio antes de enviar.';
    setPhase({ phase: 'failed', errorMessage: message });
    await reportFail(refs, code); // no-op when assessmentIdRef is null
    refs.flowLockRef.current = false;
    return;
  }

  // Step 2: Reserve the assessment slot
  setPhase({ phase: 'reserving' });
  let startBody: {
    assessmentId: string;
    token: string;
    region: string;
    referenceText: string;
  };
  try {
    const headers = await getAuthHeader();
    const resp = await fetch('/api/pronunciation/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ textVersionId: input.reviewId, idempotencyKey: input.idempotencyKey }),
    });
    const json = await resp.json();
    if (!resp.ok) {
      const msg =
        json.code === 'ASSESSMENT_IN_PROGRESS' || json.code === 'ASSESSMENT_PREPARING'
          ? 'Outra análise está em andamento. Aguarde ou tente em outra aba.'
          : (json.message as string | undefined) ?? 'Não foi possível iniciar a análise. Tente novamente.';
      setPhase({ phase: 'failed', errorMessage: msg });
      refs.flowLockRef.current = false;
      return;
    }
    startBody = json;
  } catch {
    setPhase({ phase: 'failed', errorMessage: 'Erro de rede ao iniciar a análise. Tente novamente.' });
    refs.flowLockRef.current = false;
    return;
  }

  refs.assessmentIdRef.current = startBody.assessmentId;

  // Step 3: Run Azure Pronunciation Assessment (continuous)
  setPhase({ phase: 'analyzing' });
  let result: PronunciationNormalizedResult;
  try {
    const session = createRecognitionSession({
      token:           startBody.token,
      region:          startBody.region,
      referenceText:   startBody.referenceText, // always from /start, never from caller
      wavFile,
      audioDurationMs: input.audioDurationMs,
    });
    refs.cancelRecognitionRef.current = session.cancel;
    result = await session.run();
    refs.cancelRecognitionRef.current = null;
  } catch (err) {
    refs.cancelRecognitionRef.current = null;
    const code: PronunciationFailCode =
      err instanceof PronunciationServiceError ? (err.code as PronunciationFailCode) : 'AZURE_CANCELED';
    const message =
      code === 'AZURE_NO_MATCH'
        ? 'Nenhuma fala foi detectada no áudio. Grave novamente e tente outra vez.'
        : code === 'AZURE_TIMEOUT'
        ? 'A análise demorou demais. Tente novamente.'
        : 'Ocorreu um erro durante a análise. Tente novamente.';
    setPhase({ phase: 'failed', errorMessage: message });
    await reportFail(refs, code);
    refs.flowLockRef.current = false;
    return;
  }

  if (!refs.mountedRef.current) {
    // Component unmounted while Azure was running — /fail sent by cleanup effect
    return;
  }

  // Step 4: Save the result
  setPhase({ phase: 'saving_result' });
  try {
    const headers = await getAuthHeader();
    const resp = await fetch('/api/pronunciation/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        assessmentId: startBody.assessmentId,
        result,
      }),
    });
    if (!resp.ok) {
      const json = await resp.json().catch(() => ({}));
      console.error('[flow] /complete failed:', json);
      setPhase({ phase: 'failed', errorMessage: 'Não foi possível salvar o resultado. Tente novamente.' });
      refs.flowLockRef.current = false;
      return;
    }
  } catch {
    setPhase({ phase: 'failed', errorMessage: 'Erro de rede ao salvar o resultado. Tente novamente.' });
    refs.flowLockRef.current = false;
    return;
  }

  // Clear IDs — successful completion
  refs.assessmentIdRef.current   = null;
  refs.idempotencyKeyRef.current = null;
  refs.flowLockRef.current       = false;

  setPhase({ phase: 'completed', result });
}
