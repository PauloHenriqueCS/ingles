import { useState, useEffect, useRef } from 'react';
import { Mic, AlertTriangle, Settings, XCircle, CheckCircle2, Lock, Target, MessageCircle } from 'lucide-react';
import { useRealtimeSession } from '../hooks/useRealtimeSession';
import { useCurriculumFocus } from '../hooks/useCurriculumFocus';
import { curriculumUiStrings } from '../i18n/curriculumUiStrings';
import { isAndroidApp } from '../lib/runtimeEnvironment';
import { openAndroidAppSettings } from '../lib/lemonNative';
import { useTutorPreferences } from '../hooks/useTutorPreferences';
import { useConversationCaptions } from '../hooks/useConversationCaptions';
import { usePlanEntitlements } from '../hooks/usePlanEntitlements';
import ActivityAccessBlocked from './ActivityAccessBlocked';
import TutorPersonalizationSheet from './TutorPersonalizationSheet';
import AIAvatar, { type AvatarState } from './AIAvatar';
import CaptionToggle from './CaptionToggle';
import AiSpeechCaption from './AiSpeechCaption';
import { getPrefsSummaryChips, REALTIME_VOICES, PACE_LABELS, PACE_PLAYBACK_RATE } from '../lib/tutorPreferences';
import { completeConversationSession, getDayTotalSeconds, isConversationGoalMet } from '../lib/conversationSessions';
import { getTodaySP } from '../lib/timezone';
import ConversationDailyGoalCard from './ConversationDailyGoalCard';
import type { ConversationEntitlements } from '../domain/entitlements/entitlement-types';
import { ENTITLEMENT_MESSAGES } from '../domain/entitlements/entitlement-messages';
import { MINUTE_PACKAGES_MESSAGES } from '../domain/conversation/minute-packages-copy';
import { formatMonthlyRemaining, formatTrialRemaining, formatTotalMinutesAvailable, formatConversationBalanceBreakdown, formatExtraMinutesAvailable } from '../domain/entitlements/entitlement-formatting';
import { deriveMinuteBalance } from '../domain/conversation/minute-balance';

function formatTime(ms: number) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// Fallback warning threshold only for the rare case authorizedMaxSeconds is
// still unknown (e.g. right after connecting, before /session responds).
// Once a real commercial ceiling is known, the warning is computed from it
// instead — see nearLimit below.
const FALLBACK_WARNING_MS = 25 * 60 * 1000;

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

function ConversationBalanceIndicator({ conversation, onBuyMinutes }: { conversation: ConversationEntitlements; onBuyMinutes?: () => void }) {
  if (!conversation.enabled) {
    return (
      <p className="text-xs text-amber-400 flex items-center gap-1.5 justify-center">
        <Lock className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
        {ENTITLEMENT_MESSAGES.conversationUnavailable}
      </p>
    );
  }
  const time = conversation.monthlyTime;
  if (time.unlimited) {
    return <p className="text-xs text-teal-400 font-medium text-center">{ENTITLEMENT_MESSAGES.conversationUnlimitedLabel}</p>;
  }

  // Trial (lifetime) — a trial cannot buy extra minutes (extraSecondsAvailable
  // is always 0), so keep the trial wording and never a buy CTA.
  if (time.period === 'lifetime') {
    const remaining = Math.max(0, time.limit - time.consumed);
    const line = remaining > 0 ? formatTrialRemaining(remaining) : ENTITLEMENT_MESSAGES.conversationTrialMinutesExhausted;
    return <p className={`text-xs text-center ${remaining > 0 ? 'text-slate-400' : 'text-amber-400'}`}>{line}</p>;
  }

  // Commercial (monthly): the SAME balance model as the packages screen — plan
  // remaining + purchased extra + total (deriveMinuteBalance). The old code
  // showed only plan minutes when the plan wasn't exhausted, hiding purchased
  // credits (the audited bug).
  const bal = deriveMinuteBalance(time.limit, time.consumed, false, conversation.extraSecondsAvailable);

  const isCommercial = conversation.extraPurchaseEnabled === true;
  // Contextual "buy extra minutes" entry (path B): plan exhausted, spending
  // extra, or nothing left / running low.
  const showBuy = onBuyMinutes != null && isCommercial &&
    (bal.planRemainingSeconds === 0 || bal.totalRemainingSeconds <= 300);
  const buyCta = showBuy ? (
    <button
      type="button"
      onClick={onBuyMinutes}
      className="mt-1 text-xs font-semibold text-blue-400 hover:text-blue-300 underline underline-offset-2"
      data-testid="conversation-buy-minutes-cta"
    >
      {MINUTE_PACKAGES_MESSAGES.entryCtaTitle}
    </button>
  ) : null;

  let mainLine: string;
  let subLine: string | null = null;
  let mainColor = 'text-slate-400';
  if (bal.planRemainingSeconds > 0 && bal.extraRemainingSeconds > 0) {
    mainLine = formatTotalMinutesAvailable(bal.totalRemainingSeconds);
    subLine = formatConversationBalanceBreakdown(bal.planRemainingSeconds, bal.extraRemainingSeconds);
  } else if (bal.planRemainingSeconds > 0) {
    mainLine = formatMonthlyRemaining(bal.planRemainingSeconds);
  } else if (bal.extraRemainingSeconds > 0) {
    mainLine = formatExtraMinutesAvailable(bal.extraRemainingSeconds);
    mainColor = 'text-amber-300';
  } else {
    mainLine = ENTITLEMENT_MESSAGES.conversationNoMinutes;
    mainColor = 'text-amber-400';
  }

  return (
    <div className="flex flex-col items-center gap-0.5">
      <p className={`text-xs text-center ${mainColor}`}>{mainLine}</p>
      {subLine && <p className="text-[11px] text-center text-slate-500">{subLine}</p>}
      {buyCta}
    </div>
  );
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

interface Props {
  onComplete?: () => void;
  onNavigateToSubscription: () => void;
  /** Opens the shared "Minutos adicionais" screen (path B). Optional so
   *  existing mounts/tests stay valid. */
  onNavigateToMinutePackages?: () => void;
}

// ── Guided vs Free chooser ─────────────────────────────────────────────────────

interface ModeChooserProps {
  t: ReturnType<typeof curriculumUiStrings>;
  selected: 'guided' | 'free';
  /** Which mode is recommended/default (guided iff Conversation is in the plan). */
  recommended: 'guided' | 'free';
  /** Localized current recorte title, or null when not resolvable. */
  currentFocus: string | null;
  onSelect: (mode: 'guided' | 'free') => void;
}

function ModeOptionCard({
  active, icon, title, description, sub, badge, onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  title: string;
  description: string;
  sub?: string | null;
  badge?: string | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex-1 text-left rounded-xl border p-3.5 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 ${
        active
          ? 'border-blue-500 bg-blue-950/40'
          : 'border-slate-700 bg-slate-800 hover:border-slate-600'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={active ? 'text-blue-300' : 'text-slate-400'}>{icon}</span>
        <span className="text-sm font-semibold text-slate-100">{title}</span>
        {badge && (
          <span className="ml-auto px-1.5 py-0.5 rounded bg-blue-900/50 border border-blue-800/50 text-blue-300 text-[10px] font-medium">
            {badge}
          </span>
        )}
      </div>
      <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">{description}</p>
      {sub && <p className="text-xs text-blue-300/90 mt-1.5 break-words">{sub}</p>}
    </button>
  );
}

/**
 * Lets the user explicitly pick Guided (practise the current curriculum focus)
 * or Free (talk about anything) BEFORE starting a session. The recommended
 * option is highlighted with a badge; the guided card surfaces the localized
 * current recorte when available. The chosen mode is passed to session.start()
 * and the server remains the authority on mode + curricular credit.
 */
function ConversationModeChooser({ t, selected, recommended, currentFocus, onSelect }: ModeChooserProps) {
  return (
    <div className="flex gap-2.5">
      <ModeOptionCard
        active={selected === 'guided'}
        icon={<Target className="w-4 h-4 shrink-0" strokeWidth={2} aria-hidden="true" />}
        title={t.conversationGuidedTitle}
        description={t.conversationGuidedDesc}
        sub={currentFocus ? t.conversationFocusLabel(currentFocus) : null}
        badge={recommended === 'guided' ? t.conversationRecommended : null}
        onClick={() => onSelect('guided')}
      />
      <ModeOptionCard
        active={selected === 'free'}
        icon={<MessageCircle className="w-4 h-4 shrink-0" strokeWidth={2} aria-hidden="true" />}
        title={t.conversationFreeTitle}
        description={t.conversationFreeDesc}
        badge={recommended === 'free' ? t.conversationRecommended : null}
        onClick={() => onSelect('free')}
      />
    </div>
  );
}

export default function ConversationView({ onComplete, onNavigateToSubscription, onNavigateToMinutePackages }: Props) {
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

  // Explicit Guided/Free choice. null = user hasn't overridden; the effective
  // mode then follows the plan-derived default (guided iff Conversation is a
  // selected modality). Reset per-session is unnecessary — the last choice is a
  // fine sticky default within the screen.
  const curriculumFocus = useCurriculumFocus();
  const [selectedMode, setSelectedMode] = useState<'guided' | 'free' | null>(null);

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
      // Duration is never reported by the client — completeConversationSession
      // only tells the server WHICH authorization row to close; the server
      // computes the authoritative duration itself from authorized_at. When
      // recordingAuthorizationId is absent (older cached bundle, or the
      // backend's best-effort insert failed at session start) there is
      // nothing to complete — the call simply won't be credited this time,
      // same fail-open direction as before this fix existed.
      const complete = session.recordingAuthorizationId
        ? completeConversationSession(session.recordingAuthorizationId)
        : Promise.resolve();
      complete
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
    // A failed turn (connection lost, WebRTC error, etc.) never writes
    // conversation_sessions above — nothing was optimistically deducted.
    // Still re-fetch so the displayed balance can never be stale after a
    // failure, even though nothing here actually changed it.
    if (session.status === 'error') {
      entitlements.refetch();
    }
  }, [session.status, session.elapsedMs, today]);

  const isActive     = session.status === 'active';
  const isConnecting = session.status === 'connecting';
  const isEnded      = session.status === 'ended';
  const isError      = session.status === 'error';
  const canStart     = session.status === 'idle' || isEnded || isError;

  // ── Guided vs Free mode choice ─────────────────────────────────────────────
  // The recommended/default mode follows the teaching plan: Guided when
  // Conversation is a selected modality, otherwise Free. The user can always
  // override. The server is the final authority on both the mode and whether the
  // session earns curricular credit — this is purely the UI's choice surface.
  const focusData = curriculumFocus.data;
  const conversationInPlan = focusData?.conversationInPlan ?? false;
  const currentFocus = focusData?.currentFocus?.trim() || null;
  const focusStrings = curriculumUiStrings(focusData?.interfaceLanguage ?? null);
  const defaultMode: 'guided' | 'free' = conversationInPlan ? 'guided' : 'free';
  const effectiveMode: 'guided' | 'free' = selectedMode ?? defaultMode;

  // The technical gateway ceiling ('technical') must never be surfaced to
  // the user as if it were a commercial benefit/countdown — only show a
  // max/warning when a real commercial limit (per-turn or monthly balance)
  // is the one actually governing this call.
  const showCommercialMax = session.authorizedMaxSeconds !== null && session.recordingLimitReason !== 'technical';
  const nearLimit = showCommercialMax
    ? session.elapsedMs >= (session.authorizedMaxSeconds as number) * 1000 - 15_000
    : session.elapsedMs >= FALLBACK_WARNING_MS;

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
  const isMicPermissionDenied = isError && session.errorCode === 'MIC_PERMISSION_DENIED';
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

            {/* ── No valid trial/subscription access — blocks starting a call,
                 independent of the Home screen's own visual block ────────── */}
            {!conversationLoading && conversationDisabledByPlan && (
              <ActivityAccessBlocked compact onSubscribe={onNavigateToSubscription} />
            )}

            {/* ── Monthly conversation balance (commercial plan) ──────────── */}
            {!conversationLoading && conversation && (
              <ConversationBalanceIndicator conversation={conversation} onBuyMinutes={onNavigateToMinutePackages} />
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
                      {showCommercialMax && ` / ${formatTime((session.authorizedMaxSeconds as number) * 1000)}`}
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
                  {session.stopMessage && (
                    <p className="text-xs text-amber-400 mt-2 leading-relaxed">{session.stopMessage}</p>
                  )}
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
                {isMicPermissionDenied && isAndroidApp && (
                  <button
                    onClick={() => { void openAndroidAppSettings(); }}
                    className="mt-3 ml-7 flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 transition-colors focus:outline-none focus:underline"
                  >
                    <Settings className="w-3.5 h-3.5" strokeWidth={2} aria-hidden="true" />
                    Abrir configurações
                  </button>
                )}
              </div>
            )}

            {/* ── Start / restart button ─────────────────────────────────── */}
            {canStart && (
              <>
                {/* Guided vs Free — explicit choice BEFORE starting a session */}
                <ConversationModeChooser
                  t={focusStrings}
                  selected={effectiveMode}
                  recommended={defaultMode}
                  currentFocus={currentFocus}
                  onSelect={setSelectedMode}
                />
                {!conversationLoading && conversationDisabledByPlan && (
                  <p className="text-xs text-amber-400 text-center">{ENTITLEMENT_MESSAGES.conversationUnavailable}</p>
                )}
                {!conversationLoading && !conversationDisabledByPlan && conversationBlocked && (
                  <p className="text-xs text-amber-400 text-center">{ENTITLEMENT_MESSAGES.conversationMinutesExhausted}</p>
                )}
                <button
                  onClick={() => { if (!startDisabled) session.start(effectiveMode); }}
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
