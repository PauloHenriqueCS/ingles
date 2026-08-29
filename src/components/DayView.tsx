import { useState, useEffect, useRef } from 'react';
import { trackActivityCompleted } from '../lib/analytics/appsFlyerEvents';
import { BrainCircuit, Moon, BookOpen, CalendarDays, Target as TargetIcon, Loader2 } from 'lucide-react';
import ScreenHeader from './ScreenHeader';
import { DayEntry, DaySchedule, Difficulty, Status, AIFeedback, EnglishDailyTheme, RewriteComparisonResult } from '../types';
import { usePlanEntitlements } from '../hooks/usePlanEntitlements';
import { useCurriculumFocus } from '../hooks/useCurriculumFocus';
import { writingUiStrings } from '../i18n/writingUiStrings';
import { ENTITLEMENT_MESSAGES } from '../domain/entitlements/entitlement-messages';
import { canOfferNewWriting } from '../domain/writing/writing-practice';
import {
  deriveInitialStep,
  evidenceFurthestSlot,
  isSlotReachable,
  maxSlot,
  type WritingStep,
  type WritingStepSlot,
  type WritingFlowEvidence,
} from '../domain/writing/writing-flow-steps';
import { getScheduleForDate } from '../data/calendar2026';
import { checkLearningDayOverride, addLearningDayOverride } from '../lib/learningSettings';
import { countWords } from '../utils/wordCount';
import { countCharacters } from '../domain/text/text-normalization';
import { updateReviewV2, updateV2FinalText, markReviewConcluded } from '../lib/reviews';
import { discardCurrentMission } from '../lib/missionDiscard';
import { fetchReviewByDate } from '../lib/reviewsHistory';
import { buildMissionSnapshot } from '../lib/missionSnapshot';
import { updateLearningMemory } from '../lib/learningMemory';
import { createReviewGroupFromReview } from '../lib/reviewGroups';
import { getAuthHeader } from '../lib/apiAuth';
import { apiUrl } from '../lib/apiUrl';
import CollapsibleBlock from './CollapsibleBlock';
import DailyThemeCard from './DailyThemeCard';
import MissionGrammarGuide from './MissionGrammarGuide';
import ActivityAccessBlocked from './ActivityAccessBlocked';
import WritingStepper from './writing/WritingStepper';
import MissionSheet from './writing/MissionSheet';
import FeedbackStep from './writing/FeedbackStep';
import ImproveStep from './writing/ImproveStep';
import DoneStep from './writing/DoneStep';

interface Props {
  date: string;
  entry: DayEntry | null;
  onSave: (patch: Partial<DayEntry> & { date: string }) => Promise<void>;
  onBack: () => void;
  onNavigateToSubscription: () => void;
  activeWeekdays?: number[];
  onActivateDay?: (date: string) => Promise<void>;
}

const DIFF_OPTS: { value: Difficulty; label: (t: ReturnType<typeof writingUiStrings>) => string; cls: string }[] = [
  { value: 'facil', label: (t) => t.diffEasy, cls: 'bg-green-700 text-green-100' },
  { value: 'medio', label: (t) => t.diffMedium, cls: 'bg-amber-700 text-amber-100' },
  { value: 'dificil', label: (t) => t.diffHard, cls: 'bg-red-700 text-red-100' },
];

type ReviewState = 'idle' | 'loading' | 'done' | 'error';
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export default function DayView({ date, entry, onSave, onBack, onNavigateToSubscription, activeWeekdays = [1, 2, 3, 4, 5], onActivateDay }: Props) {
  const dow = new Date(date + 'T12:00:00').getDay();
  const isScheduledDay = activeWeekdays.includes(dow);

  const [hasOverride, setHasOverride] = useState<boolean | null>(isScheduledDay ? false : null);

  useEffect(() => {
    if (isScheduledDay) { setHasOverride(false); return; }
    setHasOverride(null);
    checkLearningDayOverride(date)
      .then(setHasOverride)
      .catch(() => setHasOverride(false));
  }, [date, isScheduledDay]);

  const overrideDates = hasOverride ? [date] : [];
  const schedule = getScheduleForDate(date, activeWeekdays, overrideDates);
  const isPracticeDay = schedule?.isPracticeDay ?? true;
  const hasContent = !!(entry?.originalText?.trim());
  const showInactiveMessage = !isPracticeDay && hasOverride !== null && !hasContent;

  // Auto-open: a non-practice day no longer parks the user on the "Dia de
  // revisão" / "Dia inativo" interstitial — we activate it right away and drop
  // them straight into the activity. Fires once per date; the manual card only
  // reappears as a fallback if activation errors.
  const [activateError, setActivateError] = useState(false);
  const autoActivatedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (showInactiveMessage && autoActivatedForRef.current !== date) {
      autoActivatedForRef.current = date;
      void handleActivateDay();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showInactiveMessage, date]);

  const focus = useCurriculumFocus();
  const t = writingUiStrings(focus.data?.interfaceLanguage);

  const [title, setTitle] = useState(entry?.title ?? '');
  const [originalText, setOriginalText] = useState(entry?.originalText ?? '');
  const [difficulty, setDifficulty] = useState<Difficulty>(entry?.difficulty ?? null);
  const [status, setStatus] = useState<Status>(entry?.status ?? 'nao-iniciado');
  const [aiReview, setAiReview] = useState<AIFeedback | null>(entry?.aiReview ?? null);
  const [reviewedAt, setReviewedAt] = useState<string | null>(entry?.reviewedAt ?? null);
  const [reviewState, setReviewState] = useState<ReviewState>(entry?.aiReview ? 'done' : 'idle');
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [dailyTheme, setDailyTheme] = useState<EnglishDailyTheme | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [existingV2Text, setExistingV2Text] = useState<string | null>(null);
  const [existingV2Comparison, setExistingV2Comparison] = useState<RewriteComparisonResult | null>(null);
  const [existingV2FinalText, setExistingV2FinalText] = useState<string | null>(null);
  const [ptDraft, setPtDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Guided-flow navigation state (a projection of the persisted work — see
  // src/domain/writing/writing-flow-steps.ts). `step` is what the user is
  // looking at; `furthestSlot` is how far the stepper is unlocked.
  const [step, setStep] = useState<WritingStep>('mission');
  const [furthestSlot, setFurthestSlot] = useState<WritingStepSlot>('mission');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [concluding, setConcluding] = useState(false);
  const [exitConfirm, setExitConfirm] = useState(false);
  // Which date the step was last hydrated for — so entry updates on the SAME
  // date (e.g. a draft save) never yank the user off their current step.
  const hydratedRef = useRef<string | null>(null);

  // True while inside a freshly-started EXTRA practice ("Nova missão"): the
  // day's stored entry must NOT restore over the blank practice. Cleared on day
  // navigation.
  const freshPracticeRef = useRef(false);
  // Guards the step-independent mission restore below (fires at most once/date).
  const themeRestoreStartedRef = useRef(false);

  function advanceFurthest(slot: WritingStepSlot) {
    setFurthestSlot((prev) => maxSlot(prev, slot));
  }

  // Restore today's already-assigned mission WITHOUT mounting DailyThemeCard.
  // DailyThemeCard self-restores, but it only renders on the Missão step — when
  // the flow resumes directly into Escrever/Feedback/Concluído (a saved draft or
  // a completed review), the mission would otherwise be missing, breaking the
  // mission summary/sheet and, on a resumed draft, the exact-mission credit
  // binding (generatedThemeId). This read-only 'retrieve' makes NO AI call and
  // consumes nothing; it only fills dailyTheme if still empty.
  function ensureThemeRestored() {
    if (themeRestoreStartedRef.current) return;
    themeRestoreStartedRef.current = true;
    (async () => {
      try {
        const authHeader = await getAuthHeader();
        const res = await fetch(apiUrl('/api/generate-theme'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify({ mode: 'retrieve' }),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!data?.theme) return;
        setDailyTheme((prev) => prev ?? { ...(data.theme as EnglishDailyTheme), id: data.themeId ?? undefined });
      } catch {
        // best-effort — never blocks the resumed step
      }
    })();
  }

  // Reset mission + schedule only when navigating to a different day.
  useEffect(() => {
    setDailyTheme(null);
    freshPracticeRef.current = false;
    themeRestoreStartedRef.current = false;
    hydratedRef.current = null;
  }, [date]);

  // Seed the editor surface from the stored entry AND hydrate the stepper from
  // the strongest persisted evidence (entry + english_reviews). Step hydration
  // happens ONCE per date (hydratedRef) — after the async review fetch settles,
  // so a concluded/V2 writing restores to Concluído and not to Feedback. Plain
  // entry updates on the same date only re-seed fields, never the step.
  useEffect(() => {
    if (freshPracticeRef.current) return;
    setTitle(entry?.title ?? '');
    setOriginalText(entry?.originalText ?? '');
    setDifficulty(entry?.difficulty ?? null);
    setStatus(entry?.status ?? 'nao-iniciado');
    setAiReview(entry?.aiReview ?? null);
    setReviewedAt(entry?.reviewedAt ?? null);
    setReviewState(entry?.aiReview ? 'done' : 'idle');
    setReviewError(null);
    setSaveState('idle');
    setReviewId(null);
    setExistingV2Text(null);
    setExistingV2Comparison(null);
    setExistingV2FinalText(null);

    const shouldHydrate = hydratedRef.current !== date;

    if (entry?.aiReview) {
      // A reviewed writing resumes past the Missão step, so restore the mission
      // independently (DailyThemeCard won't mount here).
      ensureThemeRestored();
      // Provisional (no V2/concluded info yet); the fetch below refines it.
      if (shouldHydrate) {
        setStep('feedback');
        setFurthestSlot('feedback');
      }
      fetchReviewByDate(date)
        .then((r) => {
          if (!r) return;
          setReviewId(r.id);
          setExistingV2Text(r.version2Text ?? null);
          setExistingV2Comparison(r.version2Comparison ?? null);
          setExistingV2FinalText(r.version2FinalText ?? null);
          const ev: WritingFlowEvidence = {
            hasTheme: true,
            hasText: !!entry?.originalText?.trim(),
            hasReview: true,
            hasV2: !!r.version2Comparison,
            hasFinalVersion: !!r.version2FinalText,
            concluded: !!r.concludedAt || !!r.version2FinalText,
          };
          if (shouldHydrate) {
            setStep(deriveInitialStep(ev));
            setFurthestSlot((prev) => maxSlot(prev, evidenceFurthestSlot(ev)));
            hydratedRef.current = date;
          }
        })
        .catch(() => { if (shouldHydrate) hydratedRef.current = date; });
    } else if (shouldHydrate) {
      const ev: WritingFlowEvidence = {
        hasTheme: false,
        hasText: !!entry?.originalText?.trim(),
        hasReview: false,
        hasV2: false,
        hasFinalVersion: false,
        concluded: false,
      };
      const initial = deriveInitialStep(ev);
      // A resumed draft lands on Escrever without mounting DailyThemeCard —
      // restore the mission so the summary/sheet + credit binding are present.
      if (initial !== 'mission') ensureThemeRestored();
      setStep(initial);
      setFurthestSlot(evidenceFurthestSlot(ev));
      hydratedRef.current = date;
    }
  }, [date, entry]);

  function handleSaveV2(v2Text: string, v2Comparison: RewriteComparisonResult) {
    if (!reviewId) return;
    updateReviewV2(reviewId, v2Text, v2Comparison).catch((err) => {
      console.error('Failed to save v2:', err);
    });
    setExistingV2Text(v2Text);
    setExistingV2Comparison(v2Comparison);
  }

  // Persistence of the final corrected version is normally done server-side by
  // /api/compare-rewrite (idempotent, bound to the review). We only persist here
  // as a fallback when the backend reported it did not (no reviewId). Local UI
  // state is set ONLY after persistence is confirmed, and any failure is thrown.
  async function handleV2FinalText(finalText: string, alreadyPersisted: boolean) {
    if (!alreadyPersisted) {
      if (!reviewId) throw new Error('missing reviewId — cannot persist final text');
      await updateV2FinalText(reviewId, finalText);
    }
    setExistingV2FinalText(finalText);
    setStatus('revisado');
  }

  async function handleActivateDay() {
    setActivateError(false);
    try {
      await addLearningDayOverride(date);
      setHasOverride(true);
      await onActivateDay?.(date);
    } catch {
      // Surface a fallback card with a retry — the auto-open effect below drops
      // the user straight into the activity on the happy path, so the manual
      // card only ever appears if activation actually failed.
      setActivateError(true);
    }
  }

  // Clears EVERY piece of the writing/review surface that belongs to a specific
  // mission, so the next mission starts identical to a freshly-generated,
  // not-yet-answered one. Deliberately does NOT touch dailyTheme (the caller
  // sets the next mission) and performs NO network call and consumes nothing.
  function resetWritingState() {
    setTitle('');
    setOriginalText('');
    setPtDraft('');
    setDifficulty(null);
    setStatus('nao-iniciado');
    setAiReview(null);
    setReviewedAt(null);
    setReviewState('idle');
    setReviewError(null);
    setSaveState('idle');
    setReviewId(null);
    setExistingV2Text(null);
    setExistingV2Comparison(null);
    setExistingV2FinalText(null);
    setStep('mission');
    setFurthestSlot('mission');
  }

  // "Nova missão": start a NEW, independent writing practice for the same day.
  // A durable, clean reset (the previous mission was concluded):
  //  1. wipe the on-screen practice → Missão step (local),
  //  2. supersede the previous mission server-side so a reload doesn't restore
  //     it (best-effort; no AI call, no generation consumed),
  //  3. blank the day's stored entry so a reload lands on Missão, not the old
  //     Concluído — the previous attempt stays in History (english_reviews) and
  //     its streak/curriculum credit are already banked (idempotent).
  // Never generates a mission or consumes a generation by itself.
  function handleNewMission() {
    freshPracticeRef.current = true;
    hydratedRef.current = date; // this session owns the step; don't re-hydrate
    themeRestoreStartedRef.current = true; // and don't auto-restore the old theme
    resetWritingState();
    setDailyTheme(null); // re-open "Receber missão" for a brand-new mission
    void discardCurrentMission();
    void onSave({
      date, title: '', originalText: '', correctedText: '', observations: '',
      mainErrors: '', difficulty: null, status: 'nao-iniciado', aiReview: null, reviewedAt: null,
    }).catch(() => {});
    entitlements.refetch();
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // A genuinely NEW mission was generated in DailyThemeCard. Adopt its theme AND
  // wipe the previous mission's writing/review surface in the same commit.
  function handleMissionGenerated(newTheme: EnglishDailyTheme) {
    freshPracticeRef.current = true;
    resetWritingState();
    setDailyTheme(newTheme);
    entitlements.refetch();
  }

  function handleStartWriting() {
    setStep('write');
    advanceFurthest('write');
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
    // Focus the textarea after the step renders.
    setTimeout(() => textareaRef.current?.focus(), 60);
  }

  function handleNavigate(slot: WritingStepSlot) {
    if (!isSlotReachable(slot, furthestSlot)) return;
    setSheetOpen(false);
    setStep(slot); // 'feedback' slot also exits the improve sub-state
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function handleImprove() {
    setStep('improve');
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function handleConclude() {
    setConcluding(true);
    if (reviewId) {
      // Best-effort — the calendar/curriculum credit already counts this writing
      // at 'corrigido'; this only makes the Concluído screen sticky on refresh.
      markReviewConcluded(reviewId).catch((err) => console.error('conclude persist failed:', err));
    }
    setStep('done');
    advanceFurthest('done');
    setConcluding(false);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleSaveDraft() {
    const finalStatus: Status =
      status === 'nao-iniciado' && originalText.trim().length > 0 ? 'escrito' : status;
    setSaveState('saving');
    try {
      await onSave({
        date, title, originalText,
        correctedText: aiReview?.correctedText ?? entry?.correctedText ?? '',
        observations: entry?.observations ?? '',
        mainErrors: aiReview ? aiReview.mainMistakes.map((m) => m.original).join('\n') : (entry?.mainErrors ?? ''),
        difficulty, status: finalStatus, aiReview, reviewedAt,
      });
      setStatus(finalStatus);
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 2000);
    } catch {
      setSaveState('error');
      setTimeout(() => setSaveState('idle'), 3000);
    }
  }

  async function handleReview() {
    if (!originalText.trim()) return;
    setReviewState('loading');
    setReviewError(null);
    const attemptId = crypto.randomUUID();
    try {
      const authHeader = await getAuthHeader();
      const res = await fetch(apiUrl('/api/review-text'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({
          entryId: date,
          originalText,
          theme: dailyTheme?.themeEn ?? '',
          grammarGoal: dailyTheme?.objective ?? '',
          mainTense: dailyTheme?.verbTense ?? '',
          mode: 'normal',
          missionTitle: dailyTheme?.title ?? '',
          studentLevel: dailyTheme?.level ?? '',
          attemptId,
          reviewCategory: dailyTheme?.category ?? null,
          reviewDifficulty: difficulty ?? dailyTheme?.difficulty ?? null,
          missionSnapshot: dailyTheme ? buildMissionSnapshot(dailyTheme) : null,
          generatedThemeId: dailyTheme?.id ?? null,
        }),
      });
      let data: { feedback?: AIFeedback; reviewedAt?: string; error?: string; message?: string; reviewId?: string };
      try {
        data = await res.json();
      } catch {
        throw new Error(`Servidor retornou status ${res.status}`);
      }
      if (!res.ok) {
        throw new Error(data.message ?? data.error ?? `Erro ${res.status}`);
      }
      entitlements.refetch();
      const feedback = data.feedback!;
      const ts = data.reviewedAt ?? new Date().toISOString();
      setAiReview(feedback);
      setReviewedAt(ts);
      setReviewState('done');
      // Advance to the Feedback step now that V1 has a report.
      setStep('feedback');
      advanceFurthest('feedback');
      hydratedRef.current = date;
      if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
      await onSave({
        date, title, originalText,
        correctedText: feedback.correctedText,
        observations: entry?.observations ?? '',
        mainErrors: feedback.mainMistakes.map((m) => m.original).join('\n'),
        difficulty, status: 'corrigido', aiReview: feedback, reviewedAt: ts,
      });
      setStatus('corrigido');

      if (data.reviewId) {
        setReviewId(data.reviewId);
        void trackActivityCompleted('writing');
        updateLearningMemory().catch((err) => console.error('Memory update failed:', err));
        if (feedback.mainMistakes.length > 0) {
          createReviewGroupFromReview({
            reviewId: data.reviewId,
            mistakes: feedback.mainMistakes,
            entryDate: date,
            theme: dailyTheme?.themeEn || undefined,
            activeWeekdays,
            originalText,
          }).catch((err) => console.error('Review group creation failed:', err));
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro desconhecido';
      setReviewError(msg);
      setReviewState('error');
      setTimeout(() => { setReviewState('idle'); setReviewError(null); }, 8000);
    }
  }

  function handleBackRequest() {
    const hasUnsavedDraft =
      !aiReview && originalText.trim().length > 0 && originalText !== (entry?.originalText ?? '');
    if (hasUnsavedDraft) {
      setExitConfirm(true);
      return;
    }
    onBack();
  }

  const words = countWords(originalText);
  const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('pt-BR', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
  const isReviewing = reviewState === 'loading';

  const entitlements = usePlanEntitlements();
  const writingEntitlements = entitlements.data?.writing ?? null;
  const pronunciationEntitlements = entitlements.data?.pronunciation ?? null;
  const writingLoading = entitlements.data === null;
  const writingDisabledByPlan = writingEntitlements ? !writingEntitlements.enabled : false;
  const reviewsBlocked = writingEntitlements ? !writingEntitlements.reviews.canStart : false;
  const charCount = countCharacters(originalText);
  const titleCharCount = countCharacters(title);
  const rawMaxChars = writingEntitlements && !writingEntitlements.maxCharactersUnlimited
    ? writingEntitlements.maxCharactersPerText
    : null;
  const maxChars = rawMaxChars !== null && rawMaxChars > 0 ? rawMaxChars : null;
  const overLimitBy = maxChars !== null ? Math.max(charCount - maxChars, 0) : 0;
  const nearLimit = maxChars !== null && overLimitBy === 0 && charCount >= Math.floor(maxChars * 0.9);

  const canSubmit = !writingLoading && !writingDisabledByPlan && !reviewsBlocked && overLimitBy === 0;
  const canStartNewWriting = canOfferNewWriting(writingEntitlements, writingDisabledByPlan);
  const remainingWritings = writingEntitlements && !writingEntitlements.reviews.unlimited
    ? writingEntitlements.reviews.remaining
    : null;

  const v1Locked = !!aiReview; // once V1 is analyzed, its text is read-only

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      <ScreenHeader
        onBack={handleBackRequest}
        title={dateLabel}
        subtitle={dailyTheme?.title ?? '—'}
      />

      {!showInactiveMessage && (
        <div className="sticky top-0 z-20 bg-slate-900/95 backdrop-blur border-b border-slate-800 px-4 py-2.5 max-w-lg mx-auto w-full">
          <WritingStepper
            current={step}
            furthest={furthestSlot}
            improving={step === 'improve'}
            onNavigate={handleNavigate}
            t={t}
          />
        </div>
      )}

      <div className="flex-1 overflow-auto p-4 max-w-lg mx-auto w-full space-y-4 pb-10">
        {showInactiveMessage ? (
          activateError ? (
            <InactiveDayCard schedule={schedule} onActivate={handleActivateDay} />
          ) : (
            <div
              className="bg-slate-800 rounded-xl p-6 flex flex-col items-center justify-center gap-3 py-10"
              role="status"
              aria-live="polite"
            >
              <Loader2 className="w-6 h-6 text-slate-400 animate-spin" aria-hidden="true" />
              <p className="text-sm text-slate-400">Abrindo atividade…</p>
            </div>
          )
        ) : (
          <>
            {!writingLoading && writingDisabledByPlan && (
              <ActivityAccessBlocked compact onSubscribe={onNavigateToSubscription} />
            )}

            {/* ── Step: Missão ── */}
            {step === 'mission' && (
              <>
                <DailyThemeCard
                  theme={dailyTheme}
                  onThemeReady={(t2) => { setDailyTheme(t2); entitlements.refetch(); }}
                  onMissionGenerated={handleMissionGenerated}
                  onStartWriting={handleStartWriting}
                  writingEntitlements={writingEntitlements}
                  startLabel={t.startWriting}
                  suppressRestore={freshPracticeRef.current}
                />
                {dailyTheme && (
                  <MissionGrammarGuide
                    key={dailyTheme.id ?? dailyTheme.title}
                    theme={dailyTheme}
                    onSkipToWriting={handleStartWriting}
                  />
                )}
              </>
            )}

            {/* ── Step: Escrever ── */}
            {step === 'write' && (
              <>
                {dailyTheme && (
                  <button
                    type="button"
                    onClick={() => setSheetOpen(true)}
                    className="w-full flex items-center justify-between gap-3 bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-left hover:border-slate-600 transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-100 truncate">{dailyTheme.title}</p>
                      <p className="text-xs text-slate-500 truncate">
                        {dailyTheme.objective || dailyTheme.mission || dailyTheme.themePtBr || ''}
                      </p>
                    </div>
                    <span className="shrink-0 flex items-center gap-1 text-xs text-blue-400 font-medium">
                      <TargetIcon className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
                      {t.missionSummaryAction}
                    </span>
                  </button>
                )}

                <div>
                  <div className="flex justify-between mb-2">
                    <label className="text-xs text-slate-400">{t.titleLabel} <span className="text-slate-600">· {t.titleOptional}</span></label>
                    <span className="text-xs text-slate-500">{`${titleCharCount.toLocaleString('pt-BR')} caracteres`}</span>
                  </div>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    readOnly={v1Locked}
                    placeholder={t.titlePlaceholder}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-slate-100 placeholder-slate-600 text-sm focus:outline-none focus:border-blue-500 read-only:opacity-70"
                  />
                </div>

                {!v1Locked && (
                  <CollapsibleBlock title={t.ptIdeaTitle} badge={t.optional} defaultOpen={false}>
                    <div className="space-y-2 pt-1">
                      <p className="text-xs text-slate-500">{t.ptIdeaHint}</p>
                      <textarea
                        value={ptDraft}
                        onChange={(e) => setPtDraft(e.target.value)}
                        placeholder={t.ptIdeaPlaceholder}
                        className="w-full bg-slate-700 border border-slate-600 rounded-lg p-3 text-slate-200 placeholder-slate-500 text-sm focus:outline-none focus:border-slate-500 min-h-[120px] resize-none"
                      />
                      {ptDraft && (
                        <button type="button" onClick={() => setPtDraft('')} className="text-xs text-slate-500 hover:text-slate-300 transition-colors">
                          {t.ptIdeaClear}
                        </button>
                      )}
                    </div>
                  </CollapsibleBlock>
                )}

                <div>
                  <div className="flex justify-between mb-2">
                    <label className="text-xs text-slate-400">{t.yourTextLabel}</label>
                    <span className={`text-xs ${overLimitBy > 0 ? 'text-red-400' : nearLimit ? 'text-amber-400' : 'text-slate-500'}`}>
                      {maxChars !== null ? t.charsOfMax(charCount, maxChars) : t.wordsChars(words, charCount)}
                    </span>
                  </div>
                  <textarea
                    ref={textareaRef}
                    value={originalText}
                    onChange={(e) => setOriginalText(e.target.value)}
                    readOnly={v1Locked}
                    placeholder={t.yourTextPlaceholder}
                    aria-invalid={overLimitBy > 0}
                    className={`w-full bg-slate-800 border rounded-xl p-3 text-slate-100 placeholder-slate-600 text-sm focus:outline-none min-h-[200px] resize-none read-only:opacity-80 ${overLimitBy > 0 ? 'border-red-500 focus:border-red-500' : 'border-slate-700 focus:border-blue-500'}`}
                  />
                  {overLimitBy > 0 && (
                    <p className="text-xs text-red-400 mt-1.5">{ENTITLEMENT_MESSAGES.characterOverLimitAfterPlanChange(overLimitBy)}</p>
                  )}
                </div>

                {!v1Locked && (
                  <div>
                    <label className="text-xs text-slate-400 mb-2 block">{t.difficultyLabel}</label>
                    <div className="flex gap-2">
                      {DIFF_OPTS.map((opt) => (
                        <button
                          key={opt.value}
                          onClick={() => setDifficulty(difficulty === opt.value ? null : opt.value)}
                          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-opacity ${opt.cls} ${difficulty === opt.value ? 'opacity-100 ring-2 ring-white/30' : 'opacity-40'}`}
                        >
                          {opt.label(t)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {writingDisabledByPlan && (
                  <p className="text-xs text-amber-400">{ENTITLEMENT_MESSAGES.featureUnavailable}</p>
                )}
                {!writingDisabledByPlan && reviewsBlocked && !v1Locked && (
                  <p className="text-xs text-amber-400">{ENTITLEMENT_MESSAGES.writingReviewsExhausted}</p>
                )}
                {!writingDisabledByPlan && !reviewsBlocked && writingEntitlements && !v1Locked && (
                  <p className="text-xs text-slate-500 text-right -mb-1">
                    {writingEntitlements.reviews.unlimited
                      ? ENTITLEMENT_MESSAGES.unlimitedLabel
                      : `${writingEntitlements.reviews.remaining} revis${writingEntitlements.reviews.remaining === 1 ? 'ão restante' : 'ões restantes'} hoje`}
                  </p>
                )}

                {v1Locked ? (
                  <button
                    onClick={() => handleNavigate('feedback')}
                    className="w-full py-3 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors"
                  >
                    {t.stepFeedback}
                  </button>
                ) : (
                  <div className="flex gap-3">
                    <button
                      onClick={handleSaveDraft}
                      disabled={saveState === 'saving'}
                      className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                        saveState === 'saved' ? 'bg-green-700 text-white' :
                        saveState === 'error' ? 'bg-red-800 text-white' :
                        saveState === 'saving' ? 'bg-slate-700 text-slate-400' :
                        'bg-slate-700 hover:bg-slate-600 text-slate-200'}`}
                    >
                      {saveState === 'saving' ? t.saving : saveState === 'saved' ? t.savedShort : saveState === 'error' ? t.saveError : t.saveDraft}
                    </button>
                    <button
                      onClick={handleReview}
                      disabled={!originalText.trim() || isReviewing || !canSubmit}
                      className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {isReviewing ? (
                        <span className="flex items-center justify-center gap-2">
                          <Loader2 className="w-4 h-4 shrink-0 animate-spin" strokeWidth={2} />
                          {t.analyzing}
                        </span>
                      ) : t.reviewWithAi}
                    </button>
                  </div>
                )}

                {reviewState === 'loading' && (
                  <div className="bg-slate-800 rounded-xl p-8 text-center space-y-3">
                    <BrainCircuit className="w-10 h-10 text-blue-400/60 shrink-0 mx-auto" strokeWidth={1.5} aria-hidden="true" />
                    <p className="text-slate-200 font-medium">Seu professor está analisando seu texto...</p>
                    <p className="text-slate-500 text-sm">Isso pode levar alguns segundos</p>
                  </div>
                )}

                {reviewState === 'error' && (
                  <div className="bg-red-900/30 border border-red-800 rounded-xl p-4 space-y-2">
                    <p className="text-red-300 text-sm font-medium">Erro ao revisar</p>
                    {reviewError && <p className="text-red-400 text-xs break-all">{reviewError}</p>}
                    <button
                      onClick={() => { setReviewState('idle'); setReviewError(null); }}
                      className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                    >
                      Tentar novamente
                    </button>
                  </div>
                )}
              </>
            )}

            {/* ── Step: Feedback ── */}
            {step === 'feedback' && aiReview && (
              <FeedbackStep
                review={aiReview}
                grammarObjective={dailyTheme?.objective ?? ''}
                onConclude={handleConclude}
                onImprove={handleImprove}
                concluding={concluding}
                t={t}
              />
            )}

            {/* ── Step: Melhorar (improve) ── */}
            {step === 'improve' && aiReview && (
              <ImproveStep
                originalText={originalText}
                aiReview={aiReview}
                reviewId={reviewId ?? undefined}
                initialV2Text={existingV2Text ?? undefined}
                initialV2Comparison={existingV2Comparison ?? undefined}
                initialV2FinalText={existingV2FinalText ?? undefined}
                analyzed={!!existingV2Comparison}
                onSaveV2={handleSaveV2}
                onV2FinalText={handleV2FinalText}
                onAnalyzed={() => advanceFurthest('feedback')}
                onBackToFeedback={() => handleNavigate('feedback')}
                onConclude={handleConclude}
                t={t}
              />
            )}

            {/* ── Step: Concluído ── */}
            {step === 'done' && aiReview && (
              <DoneStep
                review={aiReview}
                finalText={existingV2FinalText || aiReview.correctedText}
                v2Comparison={existingV2Comparison}
                reviewId={reviewId}
                pronunciation={pronunciationEntitlements}
                canStartNewWriting={canStartNewWriting}
                remainingWritings={remainingWritings}
                onNewMission={handleNewMission}
                t={t}
              />
            )}
          </>
        )}
      </div>

      {sheetOpen && dailyTheme && (
        <MissionSheet theme={dailyTheme} t={t} onClose={() => setSheetOpen(false)} />
      )}

      {exitConfirm && (
        <ExitConfirmDialog
          t={t}
          onLeave={() => { setExitConfirm(false); onBack(); }}
          onStay={() => setExitConfirm(false)}
        />
      )}
    </div>
  );
}

// ── Exit confirmation ─────────────────────────────────────────────────────────

function ExitConfirmDialog({
  t, onLeave, onStay,
}: { t: ReturnType<typeof writingUiStrings>; onLeave: () => void; onStay: () => void }) {
  const stayRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    stayRef.current?.focus();
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onStay(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onStay]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget) onStay(); }}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-label={t.exitConfirmTitle}
        className="relative w-full max-w-sm bg-slate-800 border border-slate-700 rounded-2xl p-5 space-y-4 shadow-2xl">
        <div className="space-y-1.5">
          <p className="text-base font-bold text-slate-100">{t.exitConfirmTitle}</p>
          <p className="text-sm text-slate-400 leading-relaxed">{t.exitConfirmBody}</p>
        </div>
        <div className="flex flex-col gap-2">
          <button ref={stayRef} onClick={onStay}
            className="w-full py-2.5 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors">
            {t.exitConfirmStay}
          </button>
          <button onClick={onLeave}
            className="w-full py-2.5 rounded-xl text-sm font-medium text-slate-400 hover:text-slate-200 transition-colors">
            {t.exitConfirmLeave}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Inactive day card ─────────────────────────────────────────────────────────

function InactiveDayCard({ schedule, onActivate }: { schedule: DaySchedule | null; onActivate: () => void }) {
  const isWeekend = schedule?.isWeekend ?? false;
  const isDescanso = schedule?.weekendActivity === 'descanso';

  return (
    <div className="bg-slate-800 rounded-xl p-6 text-center space-y-4">
      <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-slate-700 mx-auto">
        {isWeekend ? (
          isDescanso
            ? <Moon className="w-6 h-6 text-slate-400 shrink-0" strokeWidth={2} aria-hidden="true" />
            : <BookOpen className="w-6 h-6 text-slate-400 shrink-0" strokeWidth={2} aria-hidden="true" />
        ) : (
          <CalendarDays className="w-6 h-6 text-slate-400 shrink-0" strokeWidth={2} aria-hidden="true" />
        )}
      </div>
      <div>
        <p className="font-medium text-slate-300">
          {isWeekend ? (isDescanso ? 'Dia de descanso' : 'Dia de revisão') : 'Dia inativo'}
        </p>
        <p className="text-sm text-slate-400 mt-1">
          {isWeekend
            ? (isDescanso
                ? 'Aproveite para descansar. Você pode praticar mesmo assim se quiser.'
                : 'Um bom dia para revisar. Você pode praticar mesmo assim se quiser.')
            : 'Este dia não está nos seus dias de prática. Configure os dias ativos em Memória → Dias de prática.'}
        </p>
      </div>
      <button
        onClick={onActivate}
        className="px-5 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-medium transition-colors"
      >
        Praticar hoje mesmo
      </button>
    </div>
  );
}
