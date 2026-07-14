import { useState } from 'react';
import { useRealtimeSession } from '../hooks/useRealtimeSession';
import { useAIPreferences } from '../hooks/useAIPreferences';
import AIPersonalitySettings from './AIPersonalitySettings';

function formatTime(ms: number) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

const WARNING_MS = 25 * 60 * 1000;

export default function ConversationView() {
  const { prefs, loading: prefsLoading, save: savePrefs } = useAIPreferences();
  const session = useRealtimeSession();
  const [showSettings, setShowSettings] = useState(false);

  const isActive = session.status === 'active';
  const isConnecting = session.status === 'connecting';
  const nearLimit = session.elapsedMs >= WARNING_MS;
  const isEnded = session.status === 'ended';
  const isError = session.status === 'error';
  const canStart = session.status === 'idle' || isEnded || isError;

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      {/* Hidden audio output for AI voice */}
      <audio id="realtime-audio" autoPlay style={{ display: 'none' }} />

      <div className="flex-1 flex flex-col px-4 pt-20 pb-8 max-w-lg mx-auto w-full">
        <div className="mb-6">
          <h2 className="text-lg font-bold text-slate-100">Conversa com IA</h2>
          <p className="text-sm text-slate-400 mt-0.5">
            Pratique inglês falado com seu tutor virtual
          </p>
        </div>

        {prefsLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <div className="flex flex-col gap-4">

            {/* Idle card */}
            {session.status === 'idle' && !showSettings && (
              <div className="bg-slate-800 rounded-2xl p-6 text-center space-y-3">
                <div className="text-5xl">🎙️</div>
                <div>
                  <p className="text-slate-200 font-semibold">
                    Fale com {prefs.teacherName}
                  </p>
                  <p className="text-sm text-slate-400 mt-1">
                    Toque em iniciar e comece a conversar em inglês
                  </p>
                </div>
              </div>
            )}

            {/* Connecting */}
            {isConnecting && (
              <div className="bg-slate-800 rounded-2xl p-8 text-center space-y-4">
                <div className="w-12 h-12 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto" />
                <p className="text-slate-400 text-sm">Conectando ao tutor...</p>
              </div>
            )}

            {/* Active session */}
            {isActive && (
              <div className="bg-slate-800 rounded-2xl p-6 flex flex-col items-center gap-6">
                <div className="relative">
                  <div
                    className={`w-24 h-24 rounded-full flex items-center justify-center text-4xl transition-all duration-300 ${
                      session.isSpeaking
                        ? 'bg-blue-600 scale-110 shadow-xl shadow-blue-600/40'
                        : 'bg-slate-700'
                    }`}
                  >
                    🎙️
                  </div>
                  {session.isSpeaking && (
                    <div className="absolute inset-0 rounded-full border-2 border-blue-400 animate-ping opacity-50" />
                  )}
                </div>

                <div className="text-center">
                  <p className="text-slate-200 font-medium">
                    {session.isSpeaking
                      ? `${prefs.teacherName} está falando…`
                      : 'Sua vez de falar'}
                  </p>
                  <p
                    className={`text-sm mt-0.5 tabular-nums ${
                      nearLimit ? 'text-amber-400' : 'text-slate-500'
                    }`}
                  >
                    {formatTime(session.elapsedMs)}
                    {nearLimit && ' — encerrando em breve'}
                  </p>
                </div>

                <button
                  onClick={session.end}
                  className="px-8 py-2.5 rounded-xl bg-red-700 hover:bg-red-600 text-white text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:ring-offset-slate-800"
                >
                  Encerrar conversa
                </button>
              </div>
            )}

            {/* Ended */}
            {isEnded && (
              <div className="bg-slate-800 rounded-2xl p-6 text-center space-y-3">
                <div className="text-4xl">✅</div>
                <div>
                  <p className="text-slate-200 font-semibold">Sessão encerrada</p>
                  <p className="text-sm text-slate-400 mt-1">
                    Duração: {formatTime(session.elapsedMs)}
                  </p>
                </div>
              </div>
            )}

            {/* Error */}
            {isError && (
              <div className="bg-red-900/30 border border-red-800 rounded-2xl p-5 space-y-3">
                <p className="text-sm text-red-300">{session.errorMessage}</p>
              </div>
            )}

            {/* Start / restart button */}
            {canStart && (
              <button
                onClick={session.start}
                className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-900"
              >
                {isEnded ? '🎙️ Nova conversa' : '🎙️ Iniciar conversa'}
              </button>
            )}

            {/* Settings toggle */}
            {!isActive && !isConnecting && (
              <button
                onClick={() => setShowSettings((s) => !s)}
                className="text-xs text-slate-500 hover:text-slate-300 transition-colors text-center focus:outline-none focus:underline"
              >
                {showSettings ? 'Ocultar configurações' : 'Configurações do tutor'}
              </button>
            )}

            {showSettings && !isActive && !isConnecting && (
              <AIPersonalitySettings
                prefs={prefs}
                onSave={savePrefs}
                sessionActive={isActive}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
