import { convertToWavPcm, AudioConversionError } from './audioConverter';
import { fileToBase64 } from './base64Audio';
import { getAuthHeader } from './apiAuth';
import { apiUrl } from './apiUrl';
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
  mountedRef:            { current: boolean };
  attemptIdRef:          { current: string | null };
  assessmentIdRef:       { current: string | null };
  cancelRecognitionRef:  { current: (() => void) | null };
  flowLockRef:           { current: boolean };
  /**
   * Optional: opaque Gateway session id returned by /start (only present
   * when pronunciation.assess_text is in observe mode). Threaded through to
   * /complete and /fail so the backend can correlate technical completion —
   * never used for anything else, never required.
   */
  gatewaySessionIdRef?:  { current: string | null };
}

const PHASE_MESSAGES: Partial<Record<AnalysisPhase, string>> = {
  preparing_audio: 'Preparando sua gravação…',
  reserving:       'Preparando sua gravação…',
  analyzing:       'Analisando sua pronúncia…',
  saving_result:   'Salvando seu resultado…',
};

export { PHASE_MESSAGES };

async function reportFail(refs: FlowRefs, code: PronunciationFailCode): Promise<void> {
  const aid  = refs.assessmentIdRef.current;
  const atid = refs.attemptIdRef.current;
  if (!aid || !atid) return;
  const gatewaySessionId = refs.gatewaySessionIdRef?.current ?? undefined;
  try {
    const headers = await getAuthHeader();
    await fetch(apiUrl('/api/pronunciation/fail'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ assessmentId: aid, attemptId: atid, code, ...(gatewaySessionId ? { gatewaySessionId } : {}) }),
    });
  } catch {
    // best effort
  }
}

export async function runAnalysisFlow(
  input: {
    reviewId: string | null;
    attemptId: string;
    audioBlob: Blob | null;
    audioDurationMs: number;
  },
  refs: FlowRefs,
  onPhaseChange: (state: AnalysisState) => void,
): Promise<void> {
  refs.attemptIdRef.current   = input.attemptId;
  refs.assessmentIdRef.current = null;

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
    attemptId: string;
    token: string;
    region: string;
    referenceText: string;
    language?: string;
    gatewaySessionId?: string;
  };
  try {
    const headers = await getAuthHeader();
    const resp = await fetch(apiUrl('/api/pronunciation/start'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ textVersionId: input.reviewId, attemptId: input.attemptId }),
    });
    const json = await resp.json();
    if (!resp.ok) {
      const msg =
        json.code === 'ASSESSMENT_IN_PROGRESS'
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
  if (refs.gatewaySessionIdRef) refs.gatewaySessionIdRef.current = startBody.gatewaySessionId ?? null;

  // Step 3: Upload the WAV — Azure runs SERVER-side (continuous pronunciation
  // assessment). The browser no longer opens a WebSocket to Azure: that leg
  // could stall with zero SDK events and only ever surfaced as "A análise
  // demorou demais". /assess runs the provider AND finalizes the assessment
  // (same complete_pronunciation_assessment RPC), so there is no separate
  // /complete round-trip. The reference text is read from the reserved row
  // server-side — never sent by the client.
  setPhase({ phase: 'analyzing' });
  let result: PronunciationNormalizedResult;
  try {
    const audioBase64 = await fileToBase64(wavFile);
    const headers = await getAuthHeader();
    const resp = await fetch(apiUrl('/api/pronunciation/assess'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        assessmentId: startBody.assessmentId,
        attemptId:    input.attemptId,
        audioBase64,
        ...(startBody.gatewaySessionId ? { gatewaySessionId: startBody.gatewaySessionId } : {}),
      }),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      // The server already released the reserved slot for provider failures, so
      // the attempt is NOT consumed and the user can retry.
      const message = (json?.message as string | undefined) ?? 'Ocorreu um erro durante a análise. Tente novamente.';
      setPhase({ phase: 'failed', errorMessage: message });
      refs.flowLockRef.current = false;
      return;
    }
    result = json.result as PronunciationNormalizedResult;
  } catch {
    // Network failure while uploading/awaiting: the reservation is still open,
    // so report a retryable failure to release the slot.
    setPhase({ phase: 'failed', errorMessage: 'Erro de rede durante a análise. Tente novamente.' });
    await reportFail(refs, 'AZURE_NETWORK_ERROR');
    refs.flowLockRef.current = false;
    return;
  }

  if (!refs.mountedRef.current) {
    // Component unmounted while the server was assessing. The assessment already
    // completed server-side, so the cleanup effect's /fail is a no-op.
    return;
  }

  // Clear IDs — successful completion
  refs.assessmentIdRef.current = null;
  refs.attemptIdRef.current    = null;
  refs.flowLockRef.current     = false;

  setPhase({ phase: 'completed', result });
}
