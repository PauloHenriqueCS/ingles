import { useState, useRef, useEffect, useCallback } from 'react';
import { useAudioRecorder } from '../hooks/useAudioRecorder';
import { usePronunciationStatus } from '../hooks/usePronunciationStatus';
import ConfirmPronunciationModal from './ConfirmPronunciationModal';
import PronunciationResult from './PronunciationResult';
import { getAuthHeader } from '../lib/apiAuth';
import {
  runAnalysisFlow,
  PHASE_MESSAGES,
  type AnalysisPhase,
  type AnalysisState,
} from '../lib/pronunciationFlow';

interface Props {
  referenceText: string;
  reviewId: string | null;
}

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export default function PronunciationRecorder({ referenceText, reviewId }: Props) {
  const recorder   = useAudioRecorder();
  const statusData = usePronunciationStatus(reviewId);

  const [analysis, setAnalysis] = useState<AnalysisState>({
    phase: reviewId !== null ? 'loading_status' : 'idle',
  });

  // Prevents double-click from launching two concurrent executions.
  const flowLockRef            = useRef(false);
  const attemptIdRef           = useRef<string | null>(null);
  const assessmentIdRef        = useRef<string | null>(null);
  const cancelRecognitionRef   = useRef<(() => void) | null>(null);
  const mountedRef             = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Apply status data to analysis — only while not in an active analysis flow
  useEffect(() => {
    if (statusData.isLoading) return;

    setAnalysis((prev) => {
      const activePhases: AnalysisPhase[] = [
        'confirming', 'preparing_audio', 'reserving', 'analyzing', 'saving_result',
      ];
      if (activePhases.includes(prev.phase)) return prev;

      const d = statusData.data;
      if (!d) return { phase: 'idle' };

      if (d.status === 'completed' && d.result) {
        return { phase: 'completed', result: d.result };
      }
      if (d.status === 'processing') {
        return { phase: 'processing' };
      }
      if (d.status === 'failed_retryable') {
        return {
          phase: 'failed_retryable',
          errorMessage: 'A análise anterior falhou. Você pode gravar novamente e tentar outra vez.',
        };
      }
      if (d.status === 'failed_final') {
        return {
          phase: 'failed_final',
          errorMessage: 'Esta avaliação não pôde ser concluída. Edite o texto para realizar uma nova avaliação.',
        };
      }
      return { phase: 'idle' }; // 'available'
    });
  }, [statusData]);

  // Best-effort /fail + cancel recognition on unmount during active analysis
  useEffect(() => {
    return () => {
      if (cancelRecognitionRef.current) {
        cancelRecognitionRef.current();
      }
      const aid  = assessmentIdRef.current;
      const atid = attemptIdRef.current;
      if (aid && atid) {
        getAuthHeader().then((headers) => {
          fetch('/api/pronunciation/fail', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({ assessmentId: aid, attemptId: atid, code: 'CLIENT_INTERRUPTED' }),
          }).catch(() => undefined);
        }).catch(() => undefined);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Button handlers ────────────────────────────────────────────────────────

  const handleSubmitClick = useCallback(() => {
    setAnalysis((prev) => ({ ...prev, phase: 'confirming' }));
  }, []);

  const handleCancelModal = useCallback(() => {
    setAnalysis({ phase: 'idle' });
  }, []);

  const handleConfirm = useCallback(() => {
    if (flowLockRef.current) return;
    flowLockRef.current = true;

    const attemptId = crypto.randomUUID();
    setAnalysis({ phase: 'preparing_audio' });

    void runAnalysisFlow(
      {
        reviewId,
        attemptId,
        audioBlob:      recorder.audioBlob,
        audioDurationMs: recorder.durationMs,
      },
      { mountedRef, attemptIdRef, assessmentIdRef, cancelRecognitionRef, flowLockRef },
      (state) => { if (mountedRef.current) setAnalysis(state); },
    );
  }, [reviewId, recorder.audioBlob, recorder.durationMs]);

  const handleRetry = useCallback(() => {
    assessmentIdRef.current = null;
    attemptIdRef.current    = null;
    setAnalysis({ phase: 'idle' });
  }, []);

  // ── Derived flags ──────────────────────────────────────────────────────────
  const isProcessing =
    analysis.phase === 'preparing_audio' ||
    analysis.phase === 'reserving'       ||
    analysis.phase === 'analyzing'       ||
    analysis.phase === 'saving_result';

  const canSubmit =
    recorder.phase === 'done'    &&
    recorder.audioBlob !== null  &&
    !isProcessing                &&
    analysis.phase === 'idle';

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Section header */}
      <div className="flex items-center gap-2 py-2">
        <div className="h-px flex-1 bg-slate-700" />
        <span className="text-xs text-slate-500 font-medium uppercase tracking-wider">Treino de pronúncia</span>
        <div className="h-px flex-1 bg-slate-700" />
      </div>

      {/* ── Loading initial status ─────────────────────────────────────────── */}
      {analysis.phase === 'loading_status' && (
        <div
          className="bg-slate-800 rounded-xl p-4 flex items-center gap-3"
          role="status"
          aria-live="polite"
          aria-label="Carregando avaliação"
        >
          <div
            className="w-5 h-5 border-2 border-slate-600 border-t-slate-300 rounded-full animate-spin shrink-0"
            aria-hidden="true"
          />
          <p className="text-sm text-slate-400">Carregando avaliação...</p>
        </div>
      )}

      {/* ── Analysis in progress on server ────────────────────────────────── */}
      {analysis.phase === 'processing' && (
        <div className="bg-slate-800 rounded-xl p-4 space-y-1">
          <p className="text-sm text-slate-200 font-medium">Análise em andamento</p>
          <p className="text-xs text-slate-500 leading-relaxed">
            Existe uma avaliação em processamento para este texto. Aguarde a conclusão ou tente em outra aba.
          </p>
        </div>
      )}

      {/* ── Permanent failure ─────────────────────────────────────────────── */}
      {analysis.phase === 'failed_final' && (
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 space-y-1">
          <p className="text-sm text-slate-300 font-medium">Avaliação indisponível</p>
          <p className="text-xs text-slate-500 leading-relaxed">{analysis.errorMessage}</p>
        </div>
      )}

      {/* ── Retryable failure (from previous session) ─────────────────────── */}
      {analysis.phase === 'failed_retryable' && (
        <div className="bg-red-900/30 border border-red-800 rounded-xl p-4 space-y-2">
          <p className="text-sm text-red-300 leading-relaxed">{analysis.errorMessage}</p>
          <button
            onClick={handleRetry}
            className="text-xs text-slate-400 hover:text-slate-200 transition-colors focus:outline-none focus:underline"
          >
            Gravar novamente
          </button>
        </div>
      )}

      {/* ── Completed: show result only ───────────────────────────────────── */}
      {analysis.phase === 'completed' && analysis.result && (
        <>
          <PronunciationResult result={analysis.result} referenceText={referenceText} />
          <p className="text-xs text-slate-600 text-center">
            Esta versão do texto já foi analisada. Edite o texto para fazer uma nova avaliação.
          </p>
        </>
      )}

      {/* ── Active recording flow (not completed / not loading / not processing / not final) */}
      {analysis.phase !== 'completed'      &&
       analysis.phase !== 'loading_status' &&
       analysis.phase !== 'processing'     &&
       analysis.phase !== 'failed_final'   &&
       analysis.phase !== 'failed_retryable' && (
        <>
          <div className="bg-slate-800 rounded-xl p-4 space-y-3">
            <p className="text-xs text-slate-400 leading-relaxed">
              Leia em voz alta o texto abaixo. Você pode gravar quantas vezes quiser antes de enviar
              para análise. A gravação será processada pelo serviço Azure Speech.
            </p>
            <div className="border-t border-slate-700 pt-3">
              <p className="text-xs text-slate-500 mb-2 font-medium uppercase tracking-wider">Texto para praticar</p>
              <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-wrap">{referenceText}</p>
            </div>
          </div>

          {/* Processing overlay */}
          {isProcessing && (
            <div className="bg-slate-800 rounded-xl p-4 flex items-center gap-3" role="status" aria-live="polite">
              <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin shrink-0" aria-hidden="true" />
              <div>
                <p className="text-sm text-slate-200 font-medium">{PHASE_MESSAGES[analysis.phase]}</p>
                <p className="text-xs text-slate-500 mt-0.5">Isso pode levar alguns segundos.</p>
              </div>
            </div>
          )}

          {/* Error state from current flow */}
          {analysis.phase === 'failed' && (
            <div className="bg-red-900/30 border border-red-800 rounded-xl p-4 space-y-2">
              <p className="text-sm text-red-300 leading-relaxed">{analysis.errorMessage}</p>
              <button
                onClick={handleRetry}
                className="text-xs text-slate-400 hover:text-slate-200 transition-colors focus:outline-none focus:underline"
              >
                Tentar novamente
              </button>
            </div>
          )}

          {/* Recorder controls — only when not processing and not failed */}
          {!isProcessing && analysis.phase !== 'failed' && (
            <>
              {recorder.phase === 'idle' && (
                <button
                  onClick={recorder.startRecording}
                  className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-900"
                  aria-label="Iniciar gravação de áudio"
                >
                  🎙 Gravar áudio
                </button>
              )}

              {recorder.phase === 'requesting' && (
                <div className="bg-slate-800 rounded-xl p-4 text-center">
                  <p className="text-sm text-slate-400">Aguardando permissão do microfone...</p>
                </div>
              )}

              {recorder.phase === 'recording' && (
                <div className="space-y-3">
                  <div className="bg-slate-800 rounded-xl p-4 flex items-center gap-3" role="status" aria-live="polite">
                    <span className="text-red-500 animate-pulse text-lg" aria-hidden="true">●</span>
                    <span className="text-sm text-slate-200 font-medium">Gravando</span>
                    <span
                      className="text-sm text-slate-400 tabular-nums ml-auto"
                      aria-label={`Tempo decorrido: ${formatTime(recorder.elapsedMs)}`}
                    >
                      {formatTime(recorder.elapsedMs)}
                    </span>
                  </div>
                  <button
                    onClick={recorder.stopRecording}
                    className="w-full py-3 rounded-xl bg-red-700 hover:bg-red-600 text-white text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:ring-offset-slate-900"
                    aria-label="Finalizar gravação"
                  >
                    Finalizar gravação
                  </button>
                </div>
              )}

              {recorder.phase === 'done' && recorder.audioUrl && (
                <div className="space-y-3">
                  <div className="bg-slate-800 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-slate-200 font-medium">Sua gravação</span>
                      <span className="text-xs text-slate-500 tabular-nums">{formatTime(recorder.durationMs)}</span>
                    </div>
                    <audio
                      src={recorder.audioUrl}
                      controls
                      className="w-full rounded-lg"
                      aria-label="Reproduzir gravação"
                    />
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={recorder.startRecording}
                      disabled={isProcessing}
                      className="flex-1 py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed text-slate-200 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2 focus:ring-offset-slate-900 min-h-[44px]"
                      aria-label="Descartar gravação atual e gravar novamente"
                    >
                      Gravar novamente
                    </button>
                    <button
                      onClick={recorder.deleteRecording}
                      disabled={isProcessing}
                      className="flex-1 py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed text-slate-200 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2 focus:ring-offset-slate-900 min-h-[44px]"
                      aria-label="Excluir gravação"
                    >
                      Excluir gravação
                    </button>
                  </div>

                  <button
                    onClick={handleSubmitClick}
                    disabled={!canSubmit}
                    aria-disabled={!canSubmit}
                    className={`w-full py-2.5 rounded-xl text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-900 min-h-[44px] ${
                      canSubmit
                        ? 'bg-blue-600 hover:bg-blue-500 text-white cursor-pointer'
                        : 'bg-slate-800 border border-slate-700 text-slate-600 cursor-not-allowed'
                    }`}
                  >
                    Enviar para análise
                  </button>
                </div>
              )}

              {recorder.phase === 'error' && (
                <div className="bg-red-900/30 border border-red-800 rounded-xl p-4 space-y-2">
                  <p className="text-sm text-red-300 leading-relaxed">{recorder.errorMessage}</p>
                  <button
                    onClick={recorder.startRecording}
                    className="text-xs text-slate-400 hover:text-slate-200 transition-colors focus:outline-none focus:underline"
                  >
                    Tentar novamente
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* Confirmation modal */}
      {analysis.phase === 'confirming' && (
        <ConfirmPronunciationModal
          onConfirm={handleConfirm}
          onCancel={handleCancelModal}
        />
      )}
    </div>
  );
}
