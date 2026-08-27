import { useState, useEffect, useRef } from 'react';
import { trackActivityCompleted } from '../lib/analytics/appsFlyerEvents';
import { Mic, AlertTriangle, Settings, XCircle, CheckCircle2, Lock, Globe, MessageSquare, X, Info } from 'lucide-react';
import { useRealtimeSession } from '../hooks/useRealtimeSession';
import { useCurriculumFocus } from '../hooks/useCurriculumFocus';
import { curriculumUiStrings } from '../i18n/curriculumUiStrings';
import { isAndroidApp } from '../lib/runtimeEnvironment';
import { openAndroidAppSettings } from '../lib/lemonNative';
import { useTutorPreferences } from '../hooks/useTutorPreferences';
import { useConversationCaptions } from '../hooks/useConversationCaptions';
import { usePlanEntitlements } from '../hooks/usePlanEntitlements';
import ActivityAccessBlocked from './ActivityAccessBlocked';
import ScreenHeader from './ScreenHeader';
import TutorPersonalizationSheet from './TutorPersonalizationSheet';
import AIAvatar, { type AvatarState } from './AIAvatar';
import CaptionToggle from './CaptionToggle';
import AiSpeechCaption from './AiSpeechCaption';
import { getPrefsSummaryChips, PACE_PLAYBACK_RATE } from '../lib/tutorPreferences';
import { completeConversationSession, getDayTotalSeconds } from '../lib/conversationSessions';
import { getTodaySP } from '../lib/timezone';
import ConversationDailyGoalCard from './ConversationDailyGoalCard';
import type { ConversationEntitlements } from '../domain/entitlements/entitlement-types';
import { ENTITLEMENT_MESSAGES } from '../domain/entitlements/entitlement-messages';
import { MINUTE_PACKAGES_MESSAGES } from '../domain/conversation/minute-packages-copy';
import { formatMonthlyRemaining, formatTrialRemaining, formatTotalMinutesAvailable, formatConversationBalanceBreakdown, formatExtraMinutesAvailable } from '../domain/entitlements/entitlement-formatting';
import { deriveMinuteBalance } from '../domain/conversation/minute-balance';
import { recommendConversationLanguageMode, type ConversationLanguageMode } from '../domain/conversation/conversationLanguageMode';

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

// ── Balance-exhausted call to action ──────────────────────────────────────────
// Shown when the balance is truly 0 (start blocked, or a session just ended by
// balance). Paid plans get a prominent "Comprar mais minutos" leading to the
// existing minute-packages screen; a trial (which cannot buy add-on packages)
// is pointed at the plans screen instead. Never claims the conversation was
// preserved — Orodim keeps no conversation history.
function BuyMoreMinutesCta({
  conversation,
  onBuyMinutes,
  onSubscribe,
}: {
  conversation: ConversationEntitlements;
  onBuyMinutes?: () => void;
  onSubscribe: () => void;
}) {
  const isTrial = conversation.monthlyTime.period === 'lifetime';
  const canBuyPackages = conversation.extraPurchaseEnabled === true && !isTrial && onBuyMinutes != null;

  return (
    <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 text-center space-y-3">
      <p className="text-sm text-amber-200 leading-relaxed">
        {isTrial ? ENTITLEMENT_MESSAGES.conversationTrialMinutesExhausted : ENTITLEMENT_MESSAGES.conversationMinutesExhausted}
      </p>
      {canBuyPackages ? (
        <button
          type="button"
          onClick={onBuyMinutes}
          data-testid="conversation-buy-minutes-button"
          className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 min-h-[44px]"
        >
          {MINUTE_PACKAGES_MESSAGES.entryCtaTitle}
        </button>
      ) : (
        <button
          type="button"
          onClick={onSubscribe}
          data-testid="conversation-view-plans-button"
          className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 min-h-[44px]"
        >
          {ENTITLEMENT_MESSAGES.viewPlansCta}
        </button>
      )}
    </div>
  );
}

// ── Exhausted-balance modal ───────────────────────────────────────────────────
// A blocking popup so the "buy more minutes" / "see plans" action is never
// buried below the fold. Shown as soon as the balance hits 0 (a session ended
// by balance) and every time the screen is entered with 0 balance. Dismissible
// ("Agora não") so the student can still read the screen / choose a mode.
function ConversationExhaustedModal({
  conversation,
  onBuyMinutes,
  onSubscribe,
  onClose,
}: {
  conversation: ConversationEntitlements;
  onBuyMinutes?: () => void;
  onSubscribe: () => void;
  onClose: () => void;
}) {
  const isTrial = conversation.monthlyTime.period === 'lifetime';
  const canBuyPackages = conversation.extraPurchaseEnabled === true && !isTrial && onBuyMinutes != null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Minutos de conversa esgotados"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm bg-slate-800 border border-slate-700 rounded-2xl p-6 space-y-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-center space-y-2">
          <div className="w-12 h-12 mx-auto rounded-full bg-amber-500/15 flex items-center justify-center">
            <Lock className="w-6 h-6 text-amber-400 shrink-0" strokeWidth={2} aria-hidden="true" />
          </div>
          <h2 className="text-lg font-bold text-slate-100">Seus minutos acabaram</h2>
          <p className="text-sm text-slate-300 leading-relaxed">
            {isTrial ? ENTITLEMENT_MESSAGES.conversationTrialMinutesExhausted : ENTITLEMENT_MESSAGES.conversationMinutesExhausted}
          </p>
        </div>

        <button
          type="button"
          onClick={canBuyPackages ? onBuyMinutes : onSubscribe}
          data-testid="conversation-exhausted-modal-cta"
          className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 min-h-[44px]"
        >
          {canBuyPackages ? MINUTE_PACKAGES_MESSAGES.entryCtaTitle : ENTITLEMENT_MESSAGES.viewPlansCta}
        </button>

        <button
          type="button"
          onClick={onClose}
          className="w-full py-2.5 rounded-xl text-slate-400 hover:text-slate-200 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-slate-600"
        >
          Agora não
        </button>
      </div>
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
  /** Standardized back navigation (view-state, never WebView history). Optional
   *  so existing mounts/tests stay valid; when absent the header is not shown. */
  onBack?: () => void;
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
  /** Show the "Recomendado" badge on GUIDED — true iff Conversation is a
   *  selected modality in the teaching plan. Free never carries the badge. */
  recommendGuided: boolean;
  /** Localized current recorte title, or null when not resolvable. */
  currentFocus: string | null;
  onSelect: (mode: 'guided' | 'free') => void;
  /** Optional numbered badge shown before the title (used in the setup step). */
  stepNumber?: number;
}

/** Small numbered step badge for the "Antes de começar" setup sections. */
function StepBadge({ n }: { n: number }) {
  return (
    <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-[11px] font-bold flex items-center justify-center shrink-0" aria-hidden="true">
      {n}
    </span>
  );
}

/**
 * One full-width, compact selectable row (radio semantics). Selected vs
 * unselected differ only subtly (blue border + a light blue tint + a filled
 * radio) — the SAME treatment for both options, so color never signals
 * "recommended". Recommendation is communicated solely by the badge.
 */
function ModeOptionRow({
  active, title, description, sub, badge, onClick,
}: {
  active: boolean;
  title: string;
  description: string;
  sub?: string | null;
  badge?: string | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={`w-full text-left rounded-xl border p-3.5 flex items-start gap-3 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 ${
        active
          ? 'border-blue-500 bg-blue-500/10'
          : 'border-slate-700 bg-slate-800 hover:border-slate-600'
      }`}
    >
      <span
        aria-hidden="true"
        className={`mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center ${active ? 'border-blue-500' : 'border-slate-500'}`}
      >
        {active && <span className="w-2 h-2 rounded-full bg-blue-500" />}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-100">{title}</span>
          {badge && (
            <span className="ml-auto shrink-0 px-1.5 py-0.5 rounded bg-blue-900/50 border border-blue-800/50 text-blue-300 text-[10px] font-medium">
              {badge}
            </span>
          )}
        </div>
        <p className="text-xs text-slate-400 mt-1 leading-relaxed">{description}</p>
        {sub && <p className="text-xs text-blue-300/90 mt-1 break-words">{sub}</p>}
      </div>
    </button>
  );
}

/**
 * Lets the user explicitly pick Guided (practise the current curriculum focus)
 * or Free (talk about anything) BEFORE starting a session. Options are STACKED
 * full-width (never two columns), compact, with a clear radio. Only Guided can
 * show the "Recomendado" badge, and only when Conversation is a selected
 * modality — Free never does. The chosen mode is passed to session.start(); the
 * server remains the sole authority on mode + curricular credit.
 */
function ConversationModeChooser({ t, selected, recommendGuided, currentFocus, onSelect, stepNumber }: ModeChooserProps) {
  return (
    <div className="space-y-2.5" role="radiogroup" aria-label={t.conversationChooserTitle}>
      <div className="flex items-center gap-2">
        {stepNumber != null && <StepBadge n={stepNumber} />}
        <p className="text-sm font-semibold text-slate-200">{t.conversationChooserTitle}</p>
      </div>
      <ModeOptionRow
        active={selected === 'guided'}
        title={t.conversationGuidedTitle}
        description={t.conversationGuidedDesc}
        sub={currentFocus ? t.conversationFocusLabel(currentFocus) : null}
        badge={recommendGuided ? t.conversationRecommended : null}
        onClick={() => onSelect('guided')}
      />
      <ModeOptionRow
        active={selected === 'free'}
        title={t.conversationFreeTitle}
        description={t.conversationFreeDesc}
        badge={null}
        onClick={() => onSelect('free')}
      />
    </div>
  );
}

// ── Language chooser (English-only vs Bilingual PT+EN) ──────────────────────────

interface LanguageChooserProps {
  t: ReturnType<typeof curriculumUiStrings>;
  selected: ConversationLanguageMode;
  /** Which option carries the "Recomendado" badge — a level-based hint that
   *  never blocks: any level can pick either option. */
  recommended: ConversationLanguageMode;
  onSelect: (mode: ConversationLanguageMode) => void;
  /** Optional numbered badge shown before the title (used in the setup step). */
  stepNumber?: number;
}

/**
 * Lets the user choose the conversation LANGUAGE before every new session:
 * target-only (fully in the learned language), or bilingual-support (base
 * language for explanations while practising the target). Orthogonal to
 * Guided/Free. The recommended option (bilingual for A1/A2, target-only
 * otherwise) carries a badge but never blocks — either can be picked. The
 * generalized mode is passed to session.start() and remembered as the next
 * session's default; the server owns all pedagogical behavior. The user-facing
 * copy comes from the i18n table (conversationLanguage* keys) — product copy,
 * kept as-is — while the internal identity is language-pair agnostic.
 */
function ConversationLanguageChooser({ t, selected, recommended, onSelect, stepNumber }: LanguageChooserProps) {
  return (
    <div className="space-y-2.5" role="radiogroup" aria-label={t.conversationLanguageChooserTitle}>
      <div className="flex items-center gap-2">
        {stepNumber != null && <StepBadge n={stepNumber} />}
        <p className="text-sm font-semibold text-slate-200">{t.conversationLanguageChooserTitle}</p>
      </div>
      <ModeOptionRow
        active={selected === 'target_only'}
        title={t.conversationLanguageEnglishTitle}
        description={t.conversationLanguageEnglishDesc}
        badge={recommended === 'target_only' ? t.conversationRecommended : null}
        onClick={() => onSelect('target_only')}
      />
      <ModeOptionRow
        active={selected === 'bilingual_support'}
        title={t.conversationLanguageBilingualTitle}
        description={t.conversationLanguageBilingualDesc}
        badge={recommended === 'bilingual_support' ? t.conversationRecommended : null}
        onClick={() => onSelect('bilingual_support')}
      />
    </div>
  );
}

// ── Settings summary (compact, informative — not a selector) ────────────────────

function ConversationSettingsSummary({
  t, languageMode, sessionMode, currentFocus,
}: {
  t: ReturnType<typeof curriculumUiStrings>;
  languageMode: ConversationLanguageMode;
  sessionMode: 'guided' | 'free';
  currentFocus: string | null;
}) {
  const langLabel = languageMode === 'bilingual_support' ? t.conversationLanguageBilingualTitle : t.conversationLanguageEnglishTitle;
  const modeLabel = sessionMode === 'free' ? t.conversationFreeTitle : t.conversationGuidedTitle;
  return (
    <div className="bg-slate-800 rounded-2xl p-4 space-y-2.5" data-testid="conversation-settings-summary">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-sm text-slate-300 min-w-0">
          <Globe className="w-4 h-4 text-teal-400 shrink-0" strokeWidth={2} aria-hidden="true" />
          {t.conversationSummaryLanguageLabel}
        </span>
        <span className="text-sm font-medium text-teal-300 text-right shrink-0">{langLabel}</span>
      </div>
      <div className="flex items-start justify-between gap-3">
        <span className="flex items-center gap-2 text-sm text-slate-300 min-w-0">
          <MessageSquare className="w-4 h-4 text-teal-400 shrink-0" strokeWidth={2} aria-hidden="true" />
          {t.conversationSummaryModeLabel}
        </span>
        <span className="text-right shrink-0">
          <span className="block text-sm font-medium text-teal-300">{modeLabel}</span>
          {sessionMode === 'guided' && currentFocus && (
            <span className="block text-xs text-slate-500 mt-0.5">{t.conversationFocusLabel(currentFocus)}</span>
          )}
        </span>
      </div>
      <p className="text-xs text-slate-500 pt-0.5">{t.conversationSummaryHelper}</p>
    </div>
  );
}

// ── "Antes de começar" setup step (bottom sheet, shown on first start) ──────────

function BeforeStartSheet({
  t, initialLanguage, initialMode, recommendedLanguage, recommendGuided, currentFocus, saving, onSaveAndStart, onClose,
}: {
  t: ReturnType<typeof curriculumUiStrings>;
  initialLanguage: ConversationLanguageMode;
  initialMode: 'guided' | 'free';
  recommendedLanguage: ConversationLanguageMode;
  recommendGuided: boolean;
  currentFocus: string | null;
  saving: boolean;
  onSaveAndStart: (language: ConversationLanguageMode, mode: 'guided' | 'free') => void;
  onClose: () => void;
}) {
  const [language, setLanguage] = useState<ConversationLanguageMode>(initialLanguage);
  const [mode, setMode] = useState<'guided' | 'free'>(initialMode);

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-40" onClick={onClose} aria-hidden="true" />
      <div
        className="fixed inset-x-0 bottom-0 z-50 bg-slate-900 border-t border-slate-700 rounded-t-2xl max-h-[92dvh] flex flex-col sm:inset-auto sm:left-1/2 sm:-translate-x-1/2 sm:top-1/2 sm:-translate-y-1/2 sm:w-full sm:max-w-lg sm:rounded-2xl sm:border"
        role="dialog"
        aria-modal="true"
        aria-label={t.conversationBeforeStartTitle}
        data-testid="conversation-before-start-sheet"
      >
        {/* Drag handle + close */}
        <div className="relative pt-3 shrink-0">
          <div className="mx-auto h-1 w-10 rounded-full bg-slate-600" aria-hidden="true" />
          <button
            onClick={onClose}
            className="absolute right-3 top-2 w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
            aria-label="Fechar"
          ><X className="w-4 h-4 shrink-0" strokeWidth={2} aria-hidden="true" /></button>
        </div>

        {/* Header */}
        <div className="px-5 pt-2 pb-1 shrink-0">
          <h2 className="text-xl font-bold text-slate-100">{t.conversationBeforeStartTitle}</h2>
          <p className="text-sm text-slate-400 mt-1 leading-relaxed">{t.conversationBeforeStartHelper}</p>
        </div>

        {/* Sections */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          <ConversationLanguageChooser
            t={t}
            selected={language}
            recommended={recommendedLanguage}
            onSelect={setLanguage}
            stepNumber={1}
          />
          <ConversationModeChooser
            t={t}
            selected={mode}
            recommendGuided={recommendGuided}
            currentFocus={currentFocus}
            onSelect={setMode}
            stepNumber={2}
          />
        </div>

        {/* Footer */}
        <div
          className="shrink-0 border-t border-slate-700 px-5 py-3 flex items-center justify-between gap-3"
          style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
        >
          <button
            onClick={onClose}
            disabled={saving}
            className="px-3 py-2 text-sm font-medium text-blue-400 hover:text-blue-300 transition-colors focus:outline-none focus:underline disabled:opacity-50"
          >
            {t.conversationNotNow}
          </button>
          <button
            onClick={() => onSaveAndStart(language, mode)}
            disabled={saving}
            data-testid="conversation-save-and-start"
            className="px-5 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-900 min-h-[44px] disabled:opacity-60"
          >
            {saving ? 'Salvando…' : t.conversationSaveAndStart}
          </button>
        </div>
      </div>
    </>
  );
}

export default function ConversationView({ onBack, onComplete, onNavigateToSubscription, onNavigateToMinutePackages }: Props) {
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

  // Language + mode are now persisted user PREFERENCES (via useTutorPreferences)
  // rather than an inline per-screen selection: the main screen shows a compact
  // summary, and the choices are made in the "Antes de começar" setup step (first
  // use) or in Personalizar tutor. The effective values are the saved prefs, else
  // the product default/recommendation (computed below).
  const curriculumFocus = useCurriculumFocus();
  const [showBeforeStart, setShowBeforeStart] = useState(false);
  const [startSaving, setStartSaving] = useState(false);

  const [showSheet,       setShowSheet]       = useState(false);
  const [showExhaustedModal, setShowExhaustedModal] = useState(false);
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

  // Auto-open the exhausted-balance popup so the buy/plans action is never
  // buried below the fold: the moment the balance hits 0 (a session just ended
  // by balance → entitlements refetched) and every time the screen is entered
  // with 0 balance. Never during an active/connecting call.
  useEffect(() => {
    const balanceExhausted = !conversationLoading && !!conversation?.enabled && conversationBlocked;
    const inCall = session.status === 'active' || session.status === 'connecting';
    if (balanceExhausted && !inCall) setShowExhaustedModal(true);
  }, [conversationLoading, conversation?.enabled, conversationBlocked, session.status]);

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
          // Genuine conversation completion: a conversation_sessions row (with
          // duration>0, guaranteed by the elapsedMs>0 gate above) was written
          // server-side only when there was an authorization to close. AppsFlyer
          // funnel — fire-and-forget & fail-safe.
          if (session.recordingAuthorizationId) void trackActivityCompleted('conversation');
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

  // Effective preferences applied to the next session: the SAVED user pref, else
  // the product default (guided) / level-based recommendation (A1/A2 → bilingual,
  // else target-only). The server stays authoritative on mode + curricular credit.
  const recommendedLanguageMode = recommendConversationLanguageMode(focusData?.currentLevel ?? hp.cefrLevel);
  const effectiveLanguageMode: ConversationLanguageMode = hp.saved.conversationLanguageMode ?? recommendedLanguageMode;
  const effectiveMode: 'guided' | 'free' = hp.saved.conversationSessionMode ?? 'guided';
  // First use = the user has not yet saved these preferences. On the first start
  // we open the setup step; afterwards we start straight from the saved prefs.
  const needsSetup = !hp.conversationConfigured;

  // The fixed CTA. First click with no saved prefs → open the setup step; else
  // start immediately with the effective (saved) prefs. Double-click safe: the
  // session hook ignores start() while connecting/active, and startDisabled gates.
  const handlePressStart = () => {
    if (startDisabled) return;
    if (needsSetup) { setShowBeforeStart(true); return; }
    session.start(effectiveMode, effectiveLanguageMode);
  };
  // Setup step "Salvar e iniciar": persist BOTH choices, then start immediately
  // with those exact values (never rely on async state). Persist failure is
  // non-blocking — the session still starts with the chosen values.
  const handleSaveAndStart = async (language: ConversationLanguageMode, mode: 'guided' | 'free') => {
    setStartSaving(true);
    await hp.saveConversationPrefs({ conversationLanguageMode: language, conversationSessionMode: mode });
    setStartSaving(false);
    setShowBeforeStart(false);
    session.start(mode, language);
  };

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

  // One compact preferences line ("Coral · Americano · Superdevagar · Paciente")
  // — the voice/pace are shown once here, never duplicated as separate chips.
  const prefsLine = getPrefsSummaryChips(hp.prefs).map((c) => c.replace(/^Voz:\s*/, '')).join(' · ');

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

      {onBack && <ScreenHeader onBack={onBack} title="Conversar com IA" />}

      <div
        className="flex-1 flex flex-col px-4 pt-6 max-w-lg mx-auto w-full"
        // Extra bottom padding whenever a fixed bottom CTA is shown (the
        // "Iniciar conversa" pre-session bar, or the "Encerrar conversa" in-call
        // bar) so scrollable content is never hidden behind it.
        style={{ paddingBottom: (canStart || isActive) ? 'calc(6.5rem + env(safe-area-inset-bottom))' : '2rem' }}
      >

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

            {/* ── Monthly conversation balance (commercial plan) ──────────────
                 Hidden during an active/connecting session so it can never
                 diverge from the authoritative in-session countdown (elapsed /
                 authorizedMax). The session card's timer is the single source of
                 truth while a call is running; this pre/post-session view shows
                 the reconciled server balance. */}
            {!conversationLoading && conversation && !isActive && !isConnecting && (
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
                </div>

                {/* One compact, tappable preferences line — no redundant voice/pace
                    repetition. Tapping opens the personalization sheet. */}
                <button
                  type="button"
                  onClick={() => setShowSheet(true)}
                  className="mx-auto block max-w-full rounded-full px-3 py-1 text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-700/50 transition-colors focus:outline-none focus:ring-1 focus:ring-blue-500 break-words"
                  aria-label={`Preferências do tutor: ${prefsLine}. Toque para personalizar.`}
                >
                  {prefsLine}
                </button>
              </div>
            )}

            {/* ── Settings summary (compact, informative) + first-time hint ── */}
            {canStart && (
              <>
                <ConversationSettingsSummary
                  t={focusStrings}
                  languageMode={effectiveLanguageMode}
                  sessionMode={effectiveMode}
                  currentFocus={currentFocus}
                />
                {needsSetup && (
                  <div className="flex items-start gap-2 px-1">
                    <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" strokeWidth={2} aria-hidden="true" />
                    <p className="text-xs text-slate-500 leading-relaxed">{focusStrings.conversationFirstTimeHint}</p>
                  </div>
                )}
              </>
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
                {/* "Encerrar conversa" is a fixed bottom bar (below), mirroring
                    the "Iniciar conversa" CTA — not part of this scrolling card. */}
              </div>
            )}

            {/* ── Session ended — compact indicator (never a big card that
                 pushes the CTA down or competes with the tutor hierarchy) ── */}
            {isEnded && (
              <div className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800/60 px-3 py-2">
                <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" strokeWidth={2} aria-hidden="true" />
                <p className="text-sm text-slate-300">
                  Sessão encerrada · {formatTime(session.elapsedMs)}
                </p>
                {session.stopMessage && (
                  <p className="text-xs text-amber-400 leading-snug ml-auto text-right">{session.stopMessage}</p>
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

            {/* ── Access / balance CTAs (the primary start CTA is the fixed
                 bottom bar; these only appear when start is blocked) ──────── */}
            {canStart && !conversationLoading && conversationDisabledByPlan && (
              <p className="text-xs text-amber-400 text-center">{ENTITLEMENT_MESSAGES.conversationUnavailable}</p>
            )}
            {canStart && !conversationLoading && !conversationDisabledByPlan && conversationBlocked && conversation && (
              <BuyMoreMinutesCta
                conversation={conversation}
                onBuyMinutes={onNavigateToMinutePackages}
                onSubscribe={onNavigateToSubscription}
              />
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

      {/* ── Fixed bottom CTA (pre-conversation only) — always reachable, above
           the iOS safe area, with its own opaque bar so scrolling content never
           bleeds through. The setup sheet (z-40/50) overlays it when open. ── */}
      {!hp.loading && canStart && (
        <div
          className="fixed inset-x-0 bottom-0 z-30 bg-slate-900/95 backdrop-blur border-t border-slate-800 px-4 pt-3"
          style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
        >
          <div className="max-w-lg mx-auto">
            <button
              onClick={handlePressStart}
              disabled={startDisabled}
              aria-disabled={startDisabled}
              data-testid="conversation-start-cta"
              className="w-full py-3.5 rounded-2xl bg-blue-600 hover:bg-blue-500 text-white text-base font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-900 min-h-[52px] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              <Mic className="w-5 h-5 shrink-0" strokeWidth={2} aria-hidden="true" />
              {focusStrings.conversationStartCta}
            </button>
          </div>
        </div>
      )}

      {/* ── Fixed bottom CTA (in-call) — "Encerrar conversa", mirroring the
           start bar: fixed above the iOS safe area, out of the scroll flow. ── */}
      {isActive && (
        <div
          className="fixed inset-x-0 bottom-0 z-30 bg-slate-900/95 backdrop-blur border-t border-slate-800 px-4 pt-3"
          style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
        >
          <div className="max-w-lg mx-auto">
            <button
              onClick={session.end}
              data-testid="conversation-end-cta"
              className="w-full py-3.5 rounded-2xl bg-red-700 hover:bg-red-600 text-white text-base font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:ring-offset-slate-900 min-h-[52px] flex items-center justify-center gap-2"
            >
              Encerrar conversa
            </button>
          </div>
        </div>
      )}

      {/* "Antes de começar" setup step — first start with no saved prefs */}
      {showBeforeStart && (
        <BeforeStartSheet
          t={focusStrings}
          initialLanguage={effectiveLanguageMode}
          initialMode={effectiveMode}
          recommendedLanguage={recommendedLanguageMode}
          recommendGuided={conversationInPlan}
          currentFocus={currentFocus}
          saving={startSaving}
          onSaveAndStart={handleSaveAndStart}
          onClose={() => setShowBeforeStart(false)}
        />
      )}

      {/* Personalization sheet */}
      {showSheet && (
        <TutorPersonalizationSheet
          hp={hp}
          sessionActive={isActive}
          onClose={() => setShowSheet(false)}
        />
      )}

      {/* Exhausted-balance popup — front and center, never buried below the fold */}
      {showExhaustedModal && !isActive && !isConnecting && conversation?.enabled && conversationBlocked && (
        <ConversationExhaustedModal
          conversation={conversation}
          onBuyMinutes={onNavigateToMinutePackages}
          onSubscribe={onNavigateToSubscription}
          onClose={() => setShowExhaustedModal(false)}
        />
      )}
    </div>
  );
}
