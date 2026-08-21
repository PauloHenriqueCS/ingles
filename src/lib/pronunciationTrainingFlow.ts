import { convertToWavPcm, AudioConversionError } from './audioConverter';
import { getAuthHeader } from './apiAuth';
import { apiUrl } from './apiUrl';
import { fileToBase64 } from './base64Audio';
import type { PronunciationFailCode, PronunciationNormalizedResult } from '../types';

/**
 * Client-side orchestration for the Treino de Pronúncia official submission
 * (POST /api/pronunciation-training/start → Azure → /complete or /fail) —
 * the training-flow counterpart of pronunciationFlow.ts's runAnalysisFlow,
 * kept as a separate module because it talks to a separate day-scoped
 * reservation (pronunciation_training_sessions), not text_version_id.
 */

export type TrainingAnalysisPhase =
  | 'idle'
  | 'preparing_audio'
  | 'reserving'
  | 'analyzing'
  | 'saving_result'
  | 'completed'
  | 'failed';

export interface TrainingAnalysisState {
  phase: TrainingAnalysisPhase;
  result?: PronunciationNormalizedResult;
  errorMessage?: string;
  errorCode?: string;
  /** Authoritative count of completed analyses today (SP), from the server. */
  dailyCompleted?: number;
}

export interface TrainingFlowRefs {
  mountedRef: { current: boolean };
  attemptIdRef: { current: string | null };
  sessionIdRef: { current: string | null };
  cancelRecognitionRef: { current: (() => void) | null };
  flowLockRef: { current: boolean };
}

export const TRAINING_PHASE_MESSAGES: Partial<Record<TrainingAnalysisPhase, string>> = {
  preparing_audio: 'Preparando sua gravação…',
  reserving: 'Preparando sua gravação…',
  analyzing: 'Analisando sua pronúncia…',
  saving_result: 'Salvando seu resultado…',
};

async function reportTrainingFail(refs: TrainingFlowRefs, code: PronunciationFailCode): Promise<void> {
  const sid = refs.sessionIdRef.current;
  const atid = refs.attemptIdRef.current;
  if (!sid || !atid) return;
  try {
    const headers = await getAuthHeader();
    await fetch(apiUrl('/api/pronunciation-training/fail'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ sessionId: sid, attemptId: atid, code }),
    });
  } catch {
    // best effort
  }
}

export async function runTrainingAnalysisFlow(
  input: {
    attemptId: string;
    audioBlob: Blob | null;
    audioDurationMs: number;
  },
  refs: TrainingFlowRefs,
  onPhaseChange: (state: TrainingAnalysisState) => void,
): Promise<void> {
  refs.attemptIdRef.current  = input.attemptId;
  refs.sessionIdRef.current  = null;

  const setPhase = (state: TrainingAnalysisState) => {
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
    await reportTrainingFail(refs, code);
    refs.flowLockRef.current = false;
    return;
  }

  // Step 2: Reserve today's single official submission slot
  setPhase({ phase: 'reserving' });
  // /start still returns token/region/referenceText/language for older clients;
  // this flow no longer reads them — Azure is called server-side by /assess,
  // which reads the reference text straight from the reserved session row.
  let startBody: {
    sessionId: string;
    attemptId: string;
  };
  try {
    const headers = await getAuthHeader();
    const resp = await fetch(apiUrl('/api/pronunciation-training/start'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ attemptId: input.attemptId }),
    });
    const json = await resp.json();
    if (!resp.ok) {
      const msg =
        json.code === 'ASSESSMENT_IN_PROGRESS'
          ? 'Outra análise está em andamento. Aguarde ou tente em outra aba.'
          : (json.message as string | undefined) ?? 'Não foi possível iniciar a análise. Tente novamente.';
      setPhase({ phase: 'failed', errorMessage: msg, errorCode: json.code });
      refs.flowLockRef.current = false;
      return;
    }
    startBody = json;
  } catch {
    setPhase({ phase: 'failed', errorMessage: 'Erro de rede ao iniciar a análise. Tente novamente.' });
    refs.flowLockRef.current = false;
    return;
  }

  refs.sessionIdRef.current = startBody.sessionId;

  // Step 3: Upload the WAV — Azure runs SERVER-side (continuous pronunciation
  // assessment). The browser no longer opens a WebSocket to Azure: that leg
  // could stall with zero SDK events and no way to tell why, which surfaced only
  // as "A análise demorou demais". /assess runs the provider and finalizes the
  // assessment atomically, so it also returns the authoritative dailyCompleted.
  setPhase({ phase: 'analyzing' });
  let result: PronunciationNormalizedResult;
  let dailyCompleted: number | undefined;
  try {
    const audioBase64 = await fileToBase64(wavFile);
    const headers = await getAuthHeader();
    const resp = await fetch(apiUrl('/api/pronunciation-training/assess'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        sessionId: startBody.sessionId,
        attemptId: input.attemptId,
        audioBase64,
      }),
    });
    const json = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      // The server already released the reserved slot for provider failures, so
      // the attempt is NOT consumed and the user can retry the same day.
      const message = (json?.message as string | undefined)
        ?? 'Ocorreu um erro durante a análise. Tente novamente.';
      setPhase({ phase: 'failed', errorMessage: message, errorCode: json?.code });
      refs.flowLockRef.current = false;
      return;
    }

    result = json.result as PronunciationNormalizedResult;
    dailyCompleted = typeof json?.dailyCompleted === 'number' ? json.dailyCompleted : undefined;
  } catch {
    // Network failure while uploading/awaiting: the reservation is still open,
    // so report it as a retryable failure to release the daily slot.
    setPhase({ phase: 'failed', errorMessage: 'Erro de rede durante a análise. Tente novamente.' });
    await reportTrainingFail(refs, 'AZURE_NETWORK_ERROR');
    refs.flowLockRef.current = false;
    return;
  }

  if (!refs.mountedRef.current) {
    // Component unmounted while the server was assessing. The assessment already
    // completed server-side, so the cleanup effect's /fail is a no-op on a
    // completed row — nothing to undo here.
    return;
  }

  // Clear IDs — successful completion
  refs.sessionIdRef.current = null;
  refs.attemptIdRef.current = null;
  refs.flowLockRef.current  = false;

  setPhase({ phase: 'completed', result, dailyCompleted });
}
