import { useState, useEffect, useRef } from 'react';
import { Mic, AlertTriangle, Settings, XCircle, CheckCircle2, Lock } from 'lucide-react';
import { useRealtimeSession } from '../hooks/useRealtimeSession';
import { useTutorPreferences } from '../hooks/useTutorPreferences';
import { useConversationCaptions } from '../hooks/useConversationCaptions';
import { usePlanEntitlements } from '../hooks/usePlanEntitlements';
import TutorPersonalizationSheet from './TutorPersonalizationSheet';
import AIAvatar, { type AvatarState } from './AIAvatar';
import CaptionToggle from './CaptionToggle';
import AiSpeechCaption from './AiSpeechCaption';
import { getPrefsSummaryChips, REALTIME_VOICES, PACE_LABELS, PACE_PLAYBACK_RATE } from '../lib/tutorPreferences';
import { recordConversationSession, getDayTotalSeconds, isConversationGoalMet } from '../lib/conversationSessions';
import { getTodaySP } from '../lib/timezone';
import ConversationDailyGoalCard from './ConversationDailyGoalCard';
import type { ConversationEntitlements } from '../domain/entitlements/entitlement-types';
import { ENTITLEMENT_MESSAGES } from '../domain/entitlements/entitlement-messages';
import { formatMonthlyRemaining, formatExtraMinutesRemaining } from '../domain/entitlements/entitlement-formatting';

function formatTime(ms: number) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

const WARNING_MS = 25 * 60 * 1000;

// ── Goal progress bar ─────────────────────────────────────────────────────────

function GoalProgress({ todayTotalSec, goalMinutes }: { todayTotalSec: number; goalMinutes: number }) {
  const totalMin = todayTotalSec / 60;
  const pct = Math.min(100, Math.round((totalMin / goalMinutes) * 100));
  const met = isConversationGoalMet(todayTotalSec, goalMinutes);
  const displayedMin = Math.floor(totalMin);
  const remaining = Math.ceil(goalMinutes - totalMin);

  return (
    <div className="mt-2 space-y-2 text-left">
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-400">Meta diária</span>
        <span className={met ? 'text-green-400 font-semibold' : 'text-slate-300'}>
          {met ? '✓ Meta concluída' : `${displayedMin}/${goalMinutes} min`}
        </span>
      </div>
      <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${met ? 'bg-green-500' : 'bg-blue-500'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {!met && (
        <p className="text-xs text-slate-500">
          Faltam {remaining} minuto{remaining !== 1 ? 's' : ''}
        </p>
      )}
    </div>
  );
}

// ── Monthly conversation balance indicator (commercial plan, not the daily goal) ──

function ConversationBalanceIndicator({ conversation }: { conversation: ConversationEntitlements }) {
  if (!conversation.enabled) {
    return (
      <p className="text-xs text-amber-400 flex items-center gap-1.5 justify-center">
        <Lock className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
        {ENTITLEMENT_MESSAGES.conversationUnavailable}
      </p>
    );
  }
  if (conversation.monthlyTime.unlimited) {
    return <p className="text-xs text-teal-400 font-medium text-center">{ENTITLEMENT_MESSAGES.conversationUnlimitedLabel}</p>;
  }
  if (conversation.monthlyTime.state === 'monthly_limit_reached') {
    return <p className="text-xs text-amber-400 text-center">{ENTITLEMENT_MESSAGES.conversationMinutesExhausted}</p>;
  }
  if (conversation.monthlyTime.state === 'available_with_extra_credits') {
    return <p className="text-xs text-amber-300 text-center">{formatExtraMinutesRemaining(conversation.monthlyTime.remaining)}</p>;
  }
  return <p className="text-xs text-slate-400 text-center">{formatMonthlyRemaining(conversation.monthlyTime.remaining)}</p>;
}

// ── Summary chips ─────────────────────────────────────────────────────────────

function SummaryChips({ chips, onChipClick }: { chips: string[]; onChipClick: () => void }) {
  return (
    <div className="flex flex-wrap gap-1.5 justify-center mt-2">
      {chips.map((chip) => (
        <button
          key={chip}
          onClick={onChipClick}
          className="px-2.5 py-1 rounded-full bg-slate-700 text-slate-300 text-xs hover:bg-slate-600 transition-colors focus:outline-none focus:ring-1 focus:ring-blue-500"
          aria-label={`Configuração: ${chip}. Toque para personalizar.`}
        >
          {chip}
        </button>
      ))}
    </div>
  );
}

// ── First-access banner ───────────────────────────────────────────────────────

function FirstAccessBanner({ onPersonalize, onDismiss }: { onPersonalize: () => void; onDismiss: () => void }) {
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 space-y-3">
      <p className="text-sm text-slate-300 font-medium">Olá! Conheça seu tutor virtual</p>
      <p className="text-xs text-slate-400 leading-relaxed">
        A configuração padrão é adaptada ao seu nível. Você pode personalizar voz, ritmo e personalidade agora ou a qualquer momento.
      </p>
      <div className="flex gap-2">
        <button
          onClick={onPersonalize}
          className="flex-1 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          Personalizar agora
        </button>
        <button
          onClick={onDismiss}
          className="flex-1 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs font-medium transition-colors focus:outline-none focus:ring-1 focus:ring-slate-500"
        >
          Usar recomendado
        </button>
      </div>
    </div>
  );
}

// ── Active status label ───────────────────────────────────────────────────────

function statusLabel(state: AvatarState, teacherName: string): string {
  if (state === 'speaking')  return `${teacherName} está falando…`;
  if (state === 'thinking')  return 'Processando…';
  if (state === 'listening') return 'Sua vez de falar';
  return '';
}

// ── Main view ─────────────────────────────────────────────────────────────────

export default function ConversationView({ onComplete }: { onComplete?: () => void } = {}) {
  const hp           = useTutorPreferences();
  const playbackRate = PACE_PLAYBACK_RATE[hp.prefs.speechPace] ?? 1.0;
  const session      = useRealtimeSession(playbackRate);
  const { captionsEnabled, toggleCaptions } = useConversationCaptions();
  const entitlements = usePlanEntitlements();
  const today   = getTodaySP();

  const conversation = entitlements.data?.conversation ?? null;
  const conversationLoading = entitlements.data === null;
  const conversationDisabledByPlan = conversation ? !conversation.enabled : false;
  const conversationBlocked = conversation ? !conversation.monthlyTime.canStart : false;
  const startDisabled = conversationLoading || conversationDisabledByPlan || conversationBlocked;

  const [showSheet,       setShowSheet]       = useState(false);
  const [showFirstAccess, setShowFirstAccess] = useState(false);
  const [firstAccessChecked, setFirstAccessChecked] = useState(false);
  const [todayTotalSec, setTodayTotalSec]     = useState<number | null>(null);
  const [previousDayTotalSec, setPreviousDayTotalSec] = useState<number>(0);
  const sessionSavedRef = useRef(false);

  // Thinking state: brief window after AI finishes speaking
  const [isThinking, setIsThinking] = useState(false);
  const prevSpeakingRef = useRef(false);
  const thinkTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load previous sessions total on mount
  useEffect(() => {
    getDayTotalSeconds(today).then(setPreviousDayTotalSec).catch(() => {});
  }, [today]);

  // Refresh previous total when a new session starts connecting
  useEffect(() => {
    if (session.status === 'connecting') {
      getDayTotalSeconds(today).then(setPreviousDayTotalSec).catch(() => {});
    }
  }, [session.status, today]);

  // Save session when it ends and fetch updated daily total
  useEffect(() => {
    if (session.status === 'ended' && !sessionSavedRef.current && session.elapsedMs > 0) {
      sessionSavedRef.current = true;
      const durationSec = Math.floor(session.elapsedMs / 1000);
      recordConversationSession(today, durationSec)
        .then(() => {
          onComplete?.();
          entitlements.refetch(); // reconcile the monthly balance with the server, never optimistic-only
          return getDayTotalSeconds(today);
        })
        .then(setTodayTotalSec)
        .catch(() => setTodayTotalSec(durationSec));
    }
    if (session.status === 'connecting') {
      sessionSavedRef.current = false;
      setTodayTotalSec(null);
    }
  }, [session.status, session.elapsedMs, today]);

  const isActive     = session.status === 'active';
  const isConnecting = session.status === 'connecting';
  const isEnded      = session.status === 'ended';
  const isError      = session.status === 'error';
  const canStart     = session.status === 'idle' || isEnded || isError;
  const nearLimit    = session.elapsedMs >= WARNING_MS;

  const accumulatedSec = isEnded && todayTotalSec !== null
    ? todayTotalSec
    : previousDayTotalSec + Math.floor(session.elapsedMs / 1000);

  useEffect(() => {
    const wasSpeaking = prevSpeakingRef.current;
    prevSpeakingRef.current = session.isSpeaking;

    if (wasSpeaking && !session.isSpeaking && isActive) {
      setIsThinking(true);
      thinkTimerRef.current = setTimeout(() => setIsThinking(false), 1300);
      return () => { if (thinkTimerRef.current) clearTimeout(thinkTimerRef.current); };
    }
    if (!isActive) setIsThinking(false);
  }, [session.isSpeaking, isActive]);

  if (!hp.loading && !firstAccessChecked) {
    setFirstAccessChecked(true);
  }

  const chips      = getPrefsSummaryChips(hp.prefs);
  const voiceLabel = REALTIME_VOICES.find((v) => v.id === hp.prefs.voice)?.label ?? hp.prefs.voice;
  const paceLabel  = PACE_LABELS[hp.prefs.speechPace]?.label ?? hp.prefs.speechPace;

  // Error visual helpers
  const isMicError    = isError && (session.errorCode?.startsWith('MIC') ?? false);
  const isConfigError = isError && (session.errorCode === 'OPENAI_INVALID_SESSION' || session.errorCode === 'OPENAI_AUTH_FAILED' || session.errorCode === 'OPENAI_NOT_CONFIGURED');
  const isRateError   = isError && session.errorCode === 'OPENAI_RATE_LIMITED';
  const ErrorIcon     = isMicError ? Mic : isRateError ? AlertTriangle : isConfigError ? Settings : XCircle;
  const errorBorder   = isConfigError ? 'border-amber-700 bg-amber-900/20' : 'border-red-800 bg-red-900/30';
  const errorText     = isConfigError ? 'text-amber-300' : 'text-red-300';

  const avatarState: AvatarState =
    isError      ? 'error'      :
    isConnecting ? 'connecting' :
    !isActive    ? 'idle'       :
    session.isSpeaking ? 'speaking' :
    isThinking   ? 'thinking'  : 'listening';

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      <audio id="realtime-audio" autoPlay style={{ display: 'none' }} />

      <div className="flex-1 flex flex-col px-4 pt-20 pb-8 max-w-lg mx-auto w-full">

        {/* Page header */}
        <div className="mb-5">
          <h2 className="text-lg font-bold text-slate-100">Conversa com IA</h2>
          <p className="text-sm text-slate-400 mt-0.5">Pratique inglês falado com seu tutor virtual</p>
        </div>

        {hp.loading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="w-6 h-6 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <div className="flex flex-col gap-4">

            {/* ── Monthly conversation balance (commercial plan) ──────────── */}
            {!conversationLoading && conversation && (
              <ConversationBalanceIndicator conversation={conversation} />
            )}

            {/* ── Daily goal card ────────────────────────────────────────── */}
            <ConversationDailyGoalCard
              accumulatedSec={accumulatedSec}
              goalMinutes={hp.prefs.dailyConversationGoalMinutes}
            />

            {/* ── Tutor card (idle / ended / error) ─────────────────────── */}
            {!isConnecting && !isActive && (
              <div className="bg-slate-800 rounded-2xl p-6 text-center space-y-3">
                <div className="flex justify-center">
                  <AIAvatar state={avatarState} size={100} />
                </div>

                <div>
                  <p className="text-slate-200 font-semibold text-base">{hp.prefs.teacherName}</p>
                  <p className="text-xs text-slate-400">Seu tutor de inglês</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {voiceLabel} · {paceLabel}
                  </p>
                </div>

                <SummaryChips chips={chips} onChipClick={() => setShowSheet(true)} />
              </div>
            )}

            {/* ── First-access banner ────────────────────────────────────── */}
            {showFirstAccess && !isActive && !isConnecting && (
              <FirstAccessBanner
                onPersonalize={() => { setShowFirstAccess(false); setShowSheet(true); }}
                onDismiss={() => setShowFirstAccess(false)}
              />
            )}

            {/* ── Connecting ─────────────────────────────────────────────── */}
            {isConnecting && (
              <div className="bg-slate-800 rounded-2xl p-8 text-center space-y-4">
                <div className="flex justify-center">
                  <AIAvatar state="connecting" size={88} />
                </div>
                <p className="text-slate-400 text-sm">Conectando ao tutor…</p>
              </div>
            )}

            {/* ── Active session ─────────────────────────────────────────── */}
            {isActive && (
              <div className="bg-slate-800 rounded-2xl p-6 flex flex-col items-center gap-5">
                <AIAvatar state={avatarState} size={112} />

                <div className="text-center w-full">
                  <p className="text-slate-200 font-medium text-base min-h-[1.5rem]">
                    {statusLabel(avatarState, hp.prefs.teacherName)}
                  </p>
                  <div className="flex items-center justify-center gap-2 mt-1">
                    <p className={`text-sm tabular-nums ${nearLimit ? 'text-amber-400' : 'text-slate-500'}`}>
                      {formatTime(session.elapsedMs)}
                      {nearLimit && ' — encerrando em breve'}
                    </p>
                    <CaptionToggle enabled={captionsEnabled} onToggle={toggleCaptions} />
                  </div>
                </div>

                <AiSpeechCaption text={session.transcriptText} visible={captionsEnabled} />

                <button
                  onClick={session.end}
                  className="px-8 py-2.5 rounded-xl bg-red-700 hover:bg-red-600 text-white text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:ring-offset-slate-800 min-h-[44px]"
                >
                  Encerrar conversa
                </button>
              </div>
            )}

            {/* ── Session ended ──────────────────────────────────────────── */}
            {isEnded && (
              <div className="bg-slate-800 rounded-2xl p-6 space-y-3">
                <div className="text-center">
                  <CheckCircle2 className="w-10 h-10 text-green-400 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                  <p className="text-slate-200 font-semibold mt-2">Sessão encerrada</p>
                  <p className="text-sm text-slate-400 mt-0.5">
                    Duração: {formatTime(session.elapsedMs)}
                  </p>
                </div>
                {todayTotalSec !== null && (
                  <GoalProgress
                    todayTotalSec={todayTotalSec}
                    goalMinutes={hp.prefs.dailyConversationGoalMinutes}
                  />
                )}
              </div>
            )}

            {/* ── Error ─────────────────────────────────────────────────── */}
            {isError && (
              <div className={`border rounded-2xl p-5 ${errorBorder}`}>
                <div className="flex items-start gap-2">
                  <ErrorIcon className="w-5 h-5 shrink-0" strokeWidth={2} aria-hidden="true" />
                  <p className={`text-sm leading-relaxed ${errorText}`}>{session.errorMessage}</p>
                </div>
              </div>
            )}

            {/* ── Start / restart button ─────────────────────────────────── */}
            {canStart && (
              <>
                {!conversationLoading && conversationDisabledByPlan && (
                  <p className="text-xs text-amber-400 text-center">{ENTITLEMENT_MESSAGES.conversationUnavailable}</p>
                )}
                {!conversationLoading && !conversationDisabledByPlan && conversationBlocked && (
                  <p className="text-xs text-amber-400 text-center">{ENTITLEMENT_MESSAGES.conversationMinutesExhausted}</p>
                )}
                <button
                  onClick={() => { if (!startDisabled) session.start(); }}
                  disabled={startDisabled}
                  aria-disabled={startDisabled}
                  className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-900 min-h-[44px] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <span className="flex items-center justify-center gap-2">
                    <Mic className="w-4 h-4 shrink-0" strokeWidth={2} aria-hidden="true" />
                    {isEnded ? 'Nova conversa' : 'Iniciar conversa'}
                  </span>
                </button>
              </>
            )}

            {/* ── Personalizar tutor button ─────────────────────────────── */}
            {!isActive && !isConnecting && (
              <button
                onClick={() => setShowSheet(true)}
                className="w-full py-2.5 rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-750 hover:border-slate-600 text-slate-300 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 min-h-[44px] flex items-center justify-center gap-2"
              >
                <Settings className="w-4 h-4 shrink-0" strokeWidth={2} aria-hidden="true" />
                Personalizar tutor
              </button>
            )}

          </div>
        )}
      </div>

      {/* Personalization sheet */}
      {showSheet && (
        <TutorPersonalizationSheet
          hp={hp}
          sessionActive={isActive}
          onClose={() => setShowSheet(false)}
        />
      )}
    </div>
  );
}
