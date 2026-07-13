import { useAudioRecorder } from '../hooks/useAudioRecorder';

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

export default function PronunciationRecorder({ referenceText }: Props) {
  const { phase, elapsedMs, audioUrl, durationMs, errorMessage, startRecording, stopRecording, deleteRecording } = useAudioRecorder();

  return (
    <div className="space-y-4">
      {/* Section header */}
      <div className="flex items-center gap-2 py-2">
        <div className="h-px flex-1 bg-slate-700" />
        <span className="text-xs text-slate-500 font-medium uppercase tracking-wider">Treino de pronúncia</span>
        <div className="h-px flex-1 bg-slate-700" />
      </div>

      {/* Reference text */}
      <div className="bg-slate-800 rounded-xl p-4 space-y-3">
        <p className="text-xs text-slate-400 leading-relaxed">
          Leia em voz alta o texto abaixo. Você pode gravar quantas vezes quiser antes de enviar para análise.
        </p>
        <div className="border-t border-slate-700 pt-3">
          <p className="text-xs text-slate-500 mb-2 font-medium uppercase tracking-wider">Texto para praticar</p>
          <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-wrap">{referenceText}</p>
        </div>
      </div>

      {/* Idle */}
      {phase === 'idle' && (
        <button
          onClick={startRecording}
          className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-900"
          aria-label="Iniciar gravação de áudio"
        >
          🎙 Gravar áudio
        </button>
      )}

      {/* Requesting permission */}
      {phase === 'requesting' && (
        <div className="bg-slate-800 rounded-xl p-4 text-center">
          <p className="text-sm text-slate-400">Aguardando permissão do microfone...</p>
        </div>
      )}

      {/* Recording */}
      {phase === 'recording' && (
        <div className="space-y-3">
          <div className="bg-slate-800 rounded-xl p-4 flex items-center gap-3" role="status" aria-live="polite">
            <span className="text-red-500 animate-pulse text-lg" aria-hidden="true">●</span>
            <span className="text-sm text-slate-200 font-medium">Gravando</span>
            <span className="text-sm text-slate-400 tabular-nums ml-auto" aria-label={`Tempo decorrido: ${formatTime(elapsedMs)}`}>
              {formatTime(elapsedMs)}
            </span>
          </div>
          <button
            onClick={stopRecording}
            className="w-full py-3 rounded-xl bg-red-700 hover:bg-red-600 text-white text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:ring-offset-slate-900"
            aria-label="Finalizar gravação"
          >
            Finalizar gravação
          </button>
        </div>
      )}

      {/* Done */}
      {phase === 'done' && audioUrl && (
        <div className="space-y-3">
          <div className="bg-slate-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-200 font-medium">Sua gravação</span>
              <span className="text-xs text-slate-500 tabular-nums">{formatTime(durationMs)}</span>
            </div>
            <audio
              src={audioUrl}
              controls
              className="w-full rounded-lg"
              aria-label="Reproduzir gravação"
            />
          </div>

          <div className="flex gap-2">
            <button
              onClick={startRecording}
              className="flex-1 py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2 focus:ring-offset-slate-900 min-h-[44px]"
              aria-label="Descartar gravação atual e gravar novamente"
            >
              Gravar novamente
            </button>
            <button
              onClick={deleteRecording}
              className="flex-1 py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2 focus:ring-offset-slate-900 min-h-[44px]"
              aria-label="Excluir gravação"
            >
              Excluir gravação
            </button>
          </div>

          <button
            disabled
            aria-disabled="true"
            className="w-full py-2.5 rounded-xl bg-slate-800 border border-slate-700 text-slate-600 text-sm font-medium cursor-not-allowed select-none min-h-[44px]"
          >
            Enviar para análise
          </button>
          <p className="text-xs text-slate-600 text-center">
            O envio para análise estará disponível em breve.
          </p>
        </div>
      )}

      {/* Error */}
      {phase === 'error' && (
        <div className="bg-red-900/30 border border-red-800 rounded-xl p-4 space-y-2">
          <p className="text-sm text-red-300 leading-relaxed">{errorMessage}</p>
          <button
            onClick={startRecording}
            className="text-xs text-slate-400 hover:text-slate-200 transition-colors focus:outline-none focus:underline"
          >
            Tentar novamente
          </button>
        </div>
      )}
    </div>
  );
}
