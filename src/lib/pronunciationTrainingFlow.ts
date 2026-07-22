import { convertToWavPcm, AudioConversionError } from './audioConverter';
import { createRecognitionSession, PronunciationServiceError } from './pronunciationService';
import { getAuthHeader } from './apiAuth';
import { apiUrl } from './apiUrl';
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
  let startBody: {
    sessionId: string;
    attemptId: string;
    token: string;
    region: string;
    referenceText: string;
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
    await reportTrainingFail(refs, code);
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
    const resp = await fetch(apiUrl('/api/pronunciation-training/complete'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        sessionId: startBody.sessionId,
        attemptId: input.attemptId,
        result,
      }),
    });
    if (!resp.ok) {
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
  refs.sessionIdRef.current = null;
  refs.attemptIdRef.current = null;
  refs.flowLockRef.current  = false;

  setPhase({ phase: 'completed', result });
}
