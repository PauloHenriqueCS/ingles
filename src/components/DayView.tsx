import { useState, useEffect, useRef } from 'react';
import { BrainCircuit, CheckCircle2, AlertTriangle, Target, Loader2, Moon, BookOpen, CalendarDays } from 'lucide-react';
import { DayEntry, DaySchedule, Difficulty, Status, AIFeedback, MainMistake, VocabularyItem, EnglishDailyTheme, ValidationResult, RequiredWordEvaluation, ReviewScheduleResult, RewriteComparisonResult } from '../types';
import { useRequiredWordsValidation } from '../hooks/useRequiredWordsValidation';
import { usePlanEntitlements } from '../hooks/usePlanEntitlements';
import { ENTITLEMENT_MESSAGES } from '../domain/entitlements/entitlement-messages';
import { getScheduleForDate } from '../data/calendar2026';
import { checkLearningDayOverride, addLearningDayOverride } from '../lib/learningSettings';
import { countWords } from '../utils/wordCount';
import { saveEnglishReview, updateReviewV2, updateV2FinalText } from '../lib/reviews';
import { fetchReviewByDate } from '../lib/reviewsHistory';
import { buildMissionSnapshot } from '../lib/missionSnapshot';
import { updateLearningMemory } from '../lib/learningMemory';
import { createReviewGroupFromReview } from '../lib/reviewGroups';
import { getAuthHeader } from '../lib/apiAuth';
import { apiUrl } from '../lib/apiUrl';
import CollapsibleBlock from './CollapsibleBlock';
import DailyThemeCard from './DailyThemeCard';
import MissionGrammarGuide from './MissionGrammarGuide';
import RewriteSection from './RewriteSection';
import PronunciationRecorder from './PronunciationRecorder';

interface Props {
  date: string;
  entry: DayEntry | null;
  onSave: (patch: Partial<DayEntry> & { date: string }) => Promise<void>;
  onBack: () => void;
  activeWeekdays?: number[];
  onActivateDay?: (date: string) => Promise<void>;
}

const DIFF_OPTS: { value: Difficulty; label: string; cls: string }[] = [
  { value: 'facil', label: 'Fácil', cls: 'bg-green-700 text-green-100' },
  { value: 'medio', label: 'Médio', cls: 'bg-amber-700 text-amber-100' },
  { value: 'dificil', label: 'Difícil', cls: 'bg-red-700 text-red-100' },
];

type ReviewState = 'idle' | 'loading' | 'done' | 'error';
type SaveState = 'idle' | 'saving' | 'saved' | 'error';
type HistoryState = 'idle' | 'saving' | 'saved' | 'failed';

export default function DayView({ date, entry, onSave, onBack, activeWeekdays = [1,2,3,4,5], onActivateDay }: Props) {
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

  const [title, setTitle] = useState(entry?.title ?? '');
  const [originalText, setOriginalText] = useState(entry?.originalText ?? '');
  const [difficulty, setDifficulty] = useState<Difficulty>(entry?.difficulty ?? null);
  const [status, setStatus] = useState<Status>(entry?.status ?? 'nao-iniciado');
  const [aiReview, setAiReview] = useState<AIFeedback | null>(entry?.aiReview ?? null);
  const [reviewedAt, setReviewedAt] = useState<string | null>(entry?.reviewedAt ?? null);
  const [reviewState, setReviewState] = useState<ReviewState>(entry?.aiReview ? 'done' : 'idle');
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [historyState, setHistoryState] = useState<HistoryState>('idle');
  const [dailyTheme, setDailyTheme] = useState<EnglishDailyTheme | null>(null);
  const [reviewSchedule, setReviewSchedule] = useState<ReviewScheduleResult | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [existingV2Text, setExistingV2Text] = useState<string | null>(null);
  const [existingV2Comparison, setExistingV2Comparison] = useState<RewriteComparisonResult | null>(null);
  const [existingV2FinalText, setExistingV2FinalText] = useState<string | null>(null);
  const [ptDraft, setPtDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset mission + schedule only when navigating to a different day,
  // NOT when entry changes (draft save), so dailyTheme survives draft saves
  useEffect(() => {
    setDailyTheme(null);
    setReviewSchedule(null);
  }, [date]);

  useEffect(() => {
    setTitle(entry?.title ?? '');
    setOriginalText(entry?.originalText ?? '');
    setDifficulty(entry?.difficulty ?? null);
    setStatus(entry?.status ?? 'nao-iniciado');
    setAiReview(entry?.aiReview ?? null);
    setReviewedAt(entry?.reviewedAt ?? null);
    setReviewState(entry?.aiReview ? 'done' : 'idle');
    setReviewError(null);
    setSaveState('idle');
    setHistoryState('idle');
    setReviewId(null);
    setExistingV2Text(null);
    setExistingV2Comparison(null);
    setExistingV2FinalText(null);
    if (entry?.aiReview) {
      fetchReviewByDate(date)
        .then((r) => {
          if (r) {
            setReviewId(r.id);
            setExistingV2Text(r.version2Text ?? null);
            setExistingV2Comparison(r.version2Comparison ?? null);
            setExistingV2FinalText(r.version2FinalText ?? null);
          }
        })
        .catch(() => {});
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

  function handleV2FinalText(finalText: string) {
    if (!reviewId) return;
    updateV2FinalText(reviewId, finalText).catch((err) => {
      console.error('Failed to save v2 final text:', err);
    });
    setExistingV2FinalText(finalText);
  }

  async function handleActivateDay() {
    try {
      await addLearningDayOverride(date);
      setHasOverride(true);
      await onActivateDay?.(date);
    } catch {
      // silent — user can still write regardless
    }
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
    try {
      const authHeader = await getAuthHeader();
      const res = await fetch(apiUrl('/api/review-text'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({
          entryId: date,
          originalText,
          theme: dailyTheme?.themeEn || schedule?.theme || '',
          grammarGoal: dailyTheme?.objective || schedule?.grammarObjective || '',
          mainTense: schedule?.verbTense ?? '',
          mode: dailyTheme?.mode ?? 'normal',
          reviewGroupId: dailyTheme?.reviewGroupId ?? null,
          missionTitle: dailyTheme?.title ?? '',
          studentLevel: dailyTheme?.level ?? '',
        }),
      });
      let data: { feedback?: AIFeedback; reviewedAt?: string; error?: string; message?: string; reviewSchedule?: ReviewScheduleResult };
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
      if (data.reviewSchedule?.applied) setReviewSchedule(data.reviewSchedule);
      setAiReview(feedback);
      setReviewedAt(ts);
      setReviewState('done');
      await onSave({
        date, title, originalText,
        correctedText: feedback.correctedText,
        observations: entry?.observations ?? '',
        mainErrors: feedback.mainMistakes.map((m) => m.original).join('\n'),
        difficulty, status: 'corrigido', aiReview: feedback, reviewedAt: ts,
      });
      setStatus('corrigido');

      setHistoryState('saving');
      saveEnglishReview({
        originalText,
        feedback,
        category: dailyTheme?.category || schedule?.theme || undefined,
        difficulty: difficulty ?? dailyTheme?.difficulty ?? undefined,
        objective: dailyTheme?.objective || schedule?.grammarObjective || undefined,
        entryDate: date,
        missionSnapshot: dailyTheme ? buildMissionSnapshot(dailyTheme) : undefined,
      }).then(({ id }) => {
        setReviewId(id);
        setHistoryState('saved');
        setTimeout(() => setHistoryState('idle'), 6000);
        updateLearningMemory().catch((err) => console.error('Memory update failed:', err));
        if (feedback.mainMistakes.length > 0) {
          createReviewGroupFromReview({
            reviewId: id,
            mistakes: feedback.mainMistakes,
            entryDate: date,
            theme: dailyTheme?.themeEn || schedule?.theme || undefined,
            activeWeekdays,
          }).catch((err) => console.error('Review group creation failed:', err));
        }
      }).catch((err) => {
        console.error('Erro ao salvar revisão no histórico:', err);
        setHistoryState('failed');
        setReviewError(`Histórico: ${err instanceof Error ? err.message : String(err)}`);
        setTimeout(() => { setHistoryState('idle'); setReviewError(null); }, 10000);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro desconhecido';
      setReviewError(msg);
      setReviewState('error');
      setTimeout(() => { setReviewState('idle'); setReviewError(null); }, 8000);
    }
  }

  function scrollToWritingField() {
    textareaRef.current?.focus();
    textareaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  const words = countWords(originalText);
  const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('pt-BR', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
  const isReviewing = reviewState === 'loading';
  const isReviewMode = dailyTheme?.mode === 'review';
  const validation = useRequiredWordsValidation(
    isReviewMode ? (dailyTheme?.requiredWords ?? []) : [],
    originalText,
  );

  const entitlements = usePlanEntitlements();
  const writingEntitlements = entitlements.data?.writing ?? null;
  const writingLoading = entitlements.data === null;
  const writingDisabledByPlan = writingEntitlements ? !writingEntitlements.enabled : false;
  const reviewsBlocked = writingEntitlements ? !writingEntitlements.reviews.canStart : false;
  const maxChars = writingEntitlements && !writingEntitlements.maxCharactersUnlimited ? writingEntitlements.maxCharactersPerText : null;
  const overLimitBy = maxChars !== null ? Math.max(originalText.length - maxChars, 0) : 0;

  const canSubmit = (!isReviewMode || validation.allFound)
    && !writingLoading && !writingDisabledByPlan && !reviewsBlocked && overLimitBy === 0;

  const saveBtnCls =
    saveState === 'saved' ? 'bg-green-700 text-white' :
    saveState === 'error' ? 'bg-red-800 text-white' :
    saveState === 'saving' ? 'bg-slate-700 text-slate-400' :
    'bg-slate-700 hover:bg-slate-600 text-slate-200';

  const saveBtnLabel =
    saveState === 'saving' ? 'Salvando...' :
    saveState === 'saved' ? '✓ Salvo!' :
    saveState === 'error' ? 'Erro' :
    'Salvar rascunho';

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      <header className="sticky top-0 bg-slate-800 border-b border-slate-700 px-4 py-3 flex items-center gap-3 z-10">
        <button onClick={onBack} className="text-slate-400 hover:text-slate-100 text-lg">←</button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-100 capitalize truncate">{dateLabel}</p>
          <p className="text-xs text-slate-400 truncate">{schedule?.theme ?? '—'}</p>
        </div>
        <StatusBadgePill status={status} />
      </header>

      <div className="flex-1 overflow-auto p-4 max-w-lg mx-auto w-full space-y-4 pb-10">
        {showInactiveMessage ? (
          <InactiveDayCard schedule={schedule} onActivate={handleActivateDay} />
        ) : (
          <>
        <DailyThemeCard
          theme={dailyTheme}
          onThemeReady={(t) => { setDailyTheme(t); entitlements.refetch(); }}
          onStartWriting={scrollToWritingField}
          writingEntitlements={writingEntitlements}
        />

        {dailyTheme && (
          <MissionGrammarGuide theme={dailyTheme} onSkipToWriting={scrollToWritingField} />
        )}

        <div>
          <label className="text-xs text-slate-400 mb-2 block">Título</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Ex: My Morning Routine"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-slate-100 placeholder-slate-600 text-sm focus:outline-none focus:border-blue-500"
          />
        </div>

        {/* Portuguese draft — local only, never sent anywhere */}
        <CollapsibleBlock title="Ideia em português" badge="opcional" defaultOpen={false}>
          <div className="space-y-2 pt-1">
            <p className="text-xs text-slate-500">
              Esse rascunho é só para você. A IA vai avaliar apenas o texto em inglês.
            </p>
            <textarea
              value={ptDraft}
              onChange={(e) => setPtDraft(e.target.value)}
              placeholder="Escreva aqui sua ideia em português. Esse texto não será corrigido nem salvo."
              className="w-full bg-slate-700 border border-slate-600 rounded-lg p-3 text-slate-200 placeholder-slate-500 text-sm focus:outline-none focus:border-slate-500 min-h-[120px] resize-none"
            />
            {ptDraft && (
              <button
                type="button"
                onClick={() => setPtDraft('')}
                className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
              >
                Limpar rascunho
              </button>
            )}
          </div>
        </CollapsibleBlock>

        <div>
          <div className="flex justify-between mb-2">
            <label className="text-xs text-slate-400">Seu texto</label>
            <span className={`text-xs ${overLimitBy > 0 ? 'text-red-400' : 'text-slate-500'}`}>
              {maxChars !== null
                ? `${originalText.length.toLocaleString('pt-BR')} / ${maxChars.toLocaleString('pt-BR')} caracteres`
                : `${words} palavras`}
            </span>
          </div>
          <textarea
            ref={textareaRef}
            value={originalText}
            onChange={(e) => setOriginalText(e.target.value)}
            placeholder="Escreva seu texto em inglês aqui..."
            maxLength={maxChars ?? undefined}
            className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-slate-100 placeholder-slate-600 text-sm focus:outline-none focus:border-blue-500 min-h-[200px] resize-none"
          />
          {overLimitBy > 0 && (
            <p className="text-xs text-red-400 mt-1.5">{ENTITLEMENT_MESSAGES.characterOverLimitAfterPlanChange(overLimitBy)}</p>
          )}
        </div>

        <div>
          <label className="text-xs text-slate-400 mb-2 block">Dificuldade</label>
          <div className="flex gap-2">
            {DIFF_OPTS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setDifficulty(difficulty === opt.value ? null : opt.value)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-opacity ${opt.cls} ${
                  difficulty === opt.value ? 'opacity-100 ring-2 ring-white/30' : 'opacity-40'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {isReviewMode && validation.words.length > 0 && (
          <RequiredWordsTracker validation={validation} />
        )}

        {writingDisabledByPlan && (
          <p className="text-xs text-amber-400">{ENTITLEMENT_MESSAGES.featureUnavailable}</p>
        )}
        {!writingDisabledByPlan && reviewsBlocked && (
          <p className="text-xs text-amber-400">{ENTITLEMENT_MESSAGES.writingReviewsExhausted}</p>
        )}
        {!writingDisabledByPlan && !reviewsBlocked && writingEntitlements && (
          <p className="text-xs text-slate-500 text-right -mb-1">
            {writingEntitlements.reviews.unlimited
              ? ENTITLEMENT_MESSAGES.unlimitedLabel
              : `${writingEntitlements.reviews.remaining} revis${writingEntitlements.reviews.remaining === 1 ? 'ão restante' : 'ões restantes'} hoje`}
          </p>
        )}

        <div className="flex gap-3">
          <button
            onClick={handleSaveDraft}
            disabled={saveState === 'saving'}
            className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors ${saveBtnCls}`}
          >
            {saveBtnLabel}
          </button>
          <button
            onClick={handleReview}
            disabled={!originalText.trim() || isReviewing || !canSubmit}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {isReviewing ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 shrink-0 animate-spin" strokeWidth={2} />
                Analisando...
              </span>
            ) : 'Revisar com IA'}
          </button>
        </div>

        {historyState === 'saving' && (
          <p className="text-xs text-slate-500 text-center py-1">Salvando no histórico...</p>
        )}
        {historyState === 'saved' && (
          <p className="text-xs text-green-500 text-center py-1">✓ Revisão salva no histórico.</p>
        )}
        {historyState === 'failed' && reviewError && (
          <p className="text-xs text-amber-400 text-center py-1 break-all">{reviewError}</p>
        )}

        {reviewState === 'loading' && (
          <div className="bg-slate-800 rounded-xl p-8 text-center space-y-3">
            <BrainCircuit className="w-10 h-10 text-blue-400/60 shrink-0" strokeWidth={1.5} aria-hidden="true" />
            <p className="text-slate-200 font-medium">Seu professor está analisando seu texto...</p>
            <p className="text-slate-500 text-sm">Isso pode levar alguns segundos</p>
          </div>
        )}

        {reviewState === 'error' && (
          <div className="bg-red-900/30 border border-red-800 rounded-xl p-4 space-y-2">
            <p className="text-red-300 text-sm font-medium">Erro ao revisar</p>
            {reviewError && (
              <p className="text-red-400 text-xs break-all">{reviewError}</p>
            )}
            <button
              onClick={() => { setReviewState('idle'); setReviewError(null); }}
              className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
            >
              Tentar novamente
            </button>
          </div>
        )}

        {reviewState === 'done' && aiReview && (
          <>
            {isReviewMode && reviewSchedule && (
              <ScheduleResultCard schedule={reviewSchedule} />
            )}
            <CollapsibleBlock title="Relatório do Professor" defaultOpen={true}>
              <TeacherReport
                review={aiReview}
                grammarObjective={schedule?.grammarObjective ?? ''}
                onReviewAgain={handleReview}
                reviewing={isReviewing}
              />
            </CollapsibleBlock>
            <CollapsibleBlock
              title="Versão 2"
              defaultOpen={!!(existingV2Text || existingV2Comparison)}
            >
              <RewriteSection
                key={reviewId ?? 'no-review'}
                originalText={originalText}
                aiReview={aiReview}
                reviewId={reviewId ?? undefined}
                initialV2Text={existingV2Text ?? undefined}
                initialV2Comparison={existingV2Comparison ?? undefined}
                initialV2FinalText={existingV2FinalText ?? undefined}
                onSaveV2={handleSaveV2}
                onV2FinalText={handleV2FinalText}
              />
            </CollapsibleBlock>
            <CollapsibleBlock title="Treino de pronúncia" defaultOpen={false}>
              {existingV2FinalText ? (
                <PronunciationRecorder
                  key={`pronunciation-${reviewId ?? 'no-review'}-final`}
                  referenceText={existingV2FinalText}
                  reviewId={reviewId}
                />
              ) : existingV2Text ? (
                <div className="py-3 space-y-1">
                  <p className="text-sm text-slate-400">Aguardando versão final corrigida.</p>
                  <p className="text-xs text-slate-500">Gere a versão final na seção Versão 2 para treinar pronúncia com o texto corrigido.</p>
                </div>
              ) : (
                <PronunciationRecorder
                  key={`pronunciation-${reviewId ?? 'no-review'}-v1`}
                  referenceText={aiReview.correctedText}
                  reviewId={reviewId}
                />
              )}
            </CollapsibleBlock>
          </>
        )}

          </>
        )}

      </div>
    </div>
  );
}

// ── Teacher report ────────────────────────────────────────────────────────────

function TeacherReport({
  review,
  grammarObjective,
  onReviewAgain,
  reviewing,
}: {
  review: AIFeedback;
  grammarObjective: string;
  onReviewAgain: () => void;
  reviewing: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 py-2">
        <div className="h-px flex-1 bg-slate-700" />
        <span className="text-xs text-slate-500 font-medium uppercase tracking-wider">Relatório do Professor</span>
        <div className="h-px flex-1 bg-slate-700" />
      </div>

      <ScoresCard review={review} />
      {review.summary && <SummaryCard text={review.summary} />}
      <CorrectedTextCard text={review.correctedText} />
      {review.mainMistakes.length > 0 && <MainMistakesCard items={review.mainMistakes} />}
      {review.requiredWordEvaluation && review.requiredWordEvaluation.length > 0 && (
        <RequiredWordEvaluationCard items={review.requiredWordEvaluation} />
      )}
      {review.newVocabulary.length > 0 && <VocabularyCard items={review.newVocabulary} />}
      {review.objectiveFeedback && (
        <ObjectiveFeedbackCard text={review.objectiveFeedback} objective={grammarObjective} />
      )}
      {review.nextPractice && <NextPracticeCard text={review.nextPractice} />}

      <button
        onClick={onReviewAgain}
        disabled={reviewing}
        className="w-full py-2.5 rounded-xl text-xs text-slate-500 hover:text-slate-300 transition-colors"
      >
        Revisar novamente
      </button>
    </div>
  );
}

// ── Scores card ───────────────────────────────────────────────────────────────

function ScoresCard({ review }: { review: AIFeedback }) {
  const scoreColor =
    review.score >= 75 ? 'text-green-400' :
    review.score >= 50 ? 'text-amber-400' : 'text-red-400';

  return (
    <div className="bg-slate-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">Nota Geral</p>
          <span className={`text-6xl font-bold tabular-nums ${scoreColor}`}>{review.score}</span>
          <span className="text-slate-500 text-lg">/100</span>
        </div>
        <div className="text-right space-y-2">
          <p className="text-xs text-slate-400 uppercase tracking-wider">Writing Level</p>
          <span className="block px-3 py-1.5 rounded-lg bg-blue-900 text-blue-300 text-lg font-bold">
            {review.level}
          </span>
        </div>
      </div>

      <div className="space-y-2.5 pt-2 border-t border-slate-700">
        <ScoreBar label="Gramática" value={review.grammar} />
        <ScoreBar label="Vocabulário" value={review.vocabulary} />
        <ScoreBar label="Naturalidade" value={review.naturalness} />
        <ScoreBar label="Fluência" value={review.fluency} />
      </div>
    </div>
  );
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  const color =
    value >= 75 ? 'bg-green-500' :
    value >= 50 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-slate-400 w-24 shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${value}%` }} />
      </div>
      <span className="text-xs text-slate-300 w-7 text-right tabular-nums">{value}</span>
    </div>
  );
}

// ── Summary ───────────────────────────────────────────────────────────────────

function SummaryCard({ text }: { text: string }) {
  return (
    <div className="bg-blue-900/20 border border-blue-800/30 rounded-xl p-5 space-y-2">
      <p className="text-xs text-blue-400 font-medium uppercase tracking-wider">Resumo do Professor</p>
      <p className="text-slate-200 text-sm leading-relaxed">{text}</p>
    </div>
  );
}

// ── Corrected text ────────────────────────────────────────────────────────────

function CorrectedTextCard({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <div className="bg-slate-800 rounded-xl p-5 space-y-3">
      <div className="flex justify-between items-center">
        <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Texto Corrigido</p>
        <button onClick={copy} className="text-xs text-blue-400 hover:text-blue-300 transition-colors">
          {copied ? '✓ Copiado' : 'Copiar'}
        </button>
      </div>
      <p className="text-slate-200 text-sm leading-relaxed whitespace-pre-wrap">{text}</p>
    </div>
  );
}

// ── Main mistakes ─────────────────────────────────────────────────────────────

function MainMistakesCard({ items }: { items: MainMistake[] }) {
  return (
    <div className="bg-slate-800 rounded-xl p-5 space-y-4">
      <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Principais Erros</p>
      {items.map((item, i) => (
        <div key={i} className="space-y-1.5 border-b border-slate-700 last:border-0 pb-4 last:pb-0">
          <div className="flex gap-2 text-xs">
            <span className="text-slate-500 shrink-0 w-24">Você escreveu:</span>
            <span className="text-red-400 italic">"{item.original}"</span>
          </div>
          <div className="flex gap-2 text-xs">
            <span className="text-slate-500 shrink-0 w-24">Correção:</span>
            <span className="text-green-400 italic">"{item.correct}"</span>
          </div>
          <div className="flex gap-2 text-xs">
            <span className="text-slate-500 shrink-0 w-24">Explicação:</span>
            <span className="text-slate-300 leading-relaxed">{item.explanation}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Vocabulary ────────────────────────────────────────────────────────────────

function VocabularyCard({ items }: { items: VocabularyItem[] }) {
  return (
    <div className="bg-slate-800 rounded-xl p-5 space-y-3">
      <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Vocabulário Novo</p>
      <div className="space-y-3">
        {items.map((item, i) => (
          <div key={i} className="border-b border-slate-700 last:border-0 pb-3 last:pb-0">
            <div className="flex items-baseline gap-2 mb-0.5">
              <span className="text-blue-400 font-semibold text-sm">{item.word}</span>
              <span className="text-slate-500 text-xs">{item.meaningPtBr}</span>
            </div>
            <p className="text-slate-400 text-xs italic">"{item.example}"</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Objective feedback ────────────────────────────────────────────────────────

function ObjectiveFeedbackCard({ text, objective }: { text: string; objective: string }) {
  const achieved = /cumpr|atingi|usou|utilizou|sim|yes/i.test(text);
  return (
    <div className={`rounded-xl p-4 space-y-2 ${
      achieved
        ? 'bg-green-900/20 border border-green-800/30'
        : 'bg-amber-900/20 border border-amber-800/30'
    }`}>
      <div className="flex items-center gap-2">
        {achieved
          ? <CheckCircle2 className="w-4 h-4 shrink-0 text-green-400" strokeWidth={2} aria-hidden="true" />
          : <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" strokeWidth={2} aria-hidden="true" />
        }
        <p className={`text-xs font-medium uppercase tracking-wider ${achieved ? 'text-green-400' : 'text-amber-400'}`}>
          Feedback do Objetivo
        </p>
      </div>
      {objective && <p className="text-xs text-slate-500 italic">{objective}</p>}
      <p className="text-sm text-slate-200 leading-relaxed">{text}</p>
    </div>
  );
}

// ── Next practice ─────────────────────────────────────────────────────────────

function NextPracticeCard({ text }: { text: string }) {
  return (
    <div className="bg-purple-900/20 border border-purple-800/30 rounded-xl p-5 space-y-2">
      <div className="flex items-center gap-2">
        <Target className="w-4 h-4 shrink-0 text-purple-400" strokeWidth={2} aria-hidden="true" />
        <p className="text-xs text-purple-400 font-medium uppercase tracking-wider">Próxima Prática</p>
      </div>
      <p className="text-slate-300 text-sm leading-relaxed">{text}</p>
    </div>
  );
}

// ── Schedule result card ──────────────────────────────────────────────────────

function ScheduleResultCard({ schedule }: { schedule: ReviewScheduleResult }) {
  const isMastered = schedule.newStatus === 'mastered';
  const isPassed = schedule.overallResult === 'passed';

  const { bg, text, message } = isMastered
    ? {
        bg: 'bg-green-900/20 border border-green-800/30',
        text: 'text-green-300',
        message: 'Muito bem! Você dominou este grupo de palavras.',
      }
    : isPassed
    ? {
        bg: 'bg-blue-900/20 border border-blue-800/30',
        text: 'text-blue-300',
        message: `✓ Revisão concluída. Essas palavras voltarão em ${schedule.intervalDays} dias.`,
      }
    : {
        bg: 'bg-amber-900/20 border border-amber-800/30',
        text: 'text-amber-300',
        message: '⚠ Algumas palavras ainda precisam de prática. Elas voltarão em 2 dias.',
      };

  return (
    <div className={`rounded-xl p-4 ${bg}`}>
      <p className={`text-sm font-medium ${text}`}>{message}</p>
    </div>
  );
}

// ── Required word evaluation card ────────────────────────────────────────────

function RequiredWordEvaluationCard({ items }: { items: RequiredWordEvaluation[] }) {
  return (
    <div className="bg-slate-800 rounded-xl p-5 space-y-4">
      <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Palavras Obrigatórias</p>
      <div className="space-y-4">
        {items.map((item, i) => {
          const isCorrect = item.status === 'correct';
          return (
            <div key={i} className="space-y-1.5 border-b border-slate-700 last:border-0 pb-4 last:pb-0">
              <div className="flex items-center gap-2">
                <span className={`text-base leading-none ${isCorrect ? 'text-green-400' : 'text-red-400'}`}>
                  {isCorrect ? '✓' : '✕'}
                </span>
                <span className="font-mono text-sm font-semibold text-slate-100">{item.requiredWord}</span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed pl-5">{item.explanation}</p>
              {item.usedExcerpt && (
                <p className="text-xs text-slate-500 italic pl-5">"{item.usedExcerpt}"</p>
              )}
              {item.suggestedCorrection && (
                <p className="text-xs text-green-400 italic pl-5">Sugestão: "{item.suggestedCorrection}"</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Required words tracker ────────────────────────────────────────────────────

function RequiredWordsTracker({ validation }: { validation: ValidationResult }) {
  return (
    <div className="bg-slate-800 rounded-xl p-4 space-y-3">
      <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">
        Palavras obrigatórias
      </p>
      <div className="space-y-1.5">
        {validation.words.map((item, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className={`text-sm leading-none ${item.status === 'found' ? 'text-green-400' : 'text-slate-600'}`}>
              {item.status === 'found' ? '✓' : '○'}
            </span>
            <span className={`text-sm font-mono ${item.status === 'found' ? 'text-green-300' : 'text-slate-400'}`}>
              {item.word}
            </span>
          </div>
        ))}
      </div>
      {!validation.allFound && (
        <div className="pt-2 border-t border-slate-700">
          <p className="text-xs text-amber-400 mb-1">Você ainda precisa utilizar:</p>
          <ul className="space-y-0.5">
            {validation.missingWords.map((word, i) => (
              <li key={i} className="text-xs text-amber-300 font-mono">• {word}</li>
            ))}
          </ul>
        </div>
      )}
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
          {isWeekend ? schedule?.theme : 'Dia inativo'}
        </p>
        <p className="text-sm text-slate-400 mt-1">
          {isWeekend
            ? schedule?.grammarObjective
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

function StatusBadgePill({ status }: { status: Status }) {
  const map: Record<Status, string> = {
    'nao-iniciado': 'bg-slate-700 text-slate-400',
    'escrito': 'bg-blue-700 text-blue-200',
    'corrigido': 'bg-amber-700 text-amber-200',
    'revisado': 'bg-green-700 text-green-200',
  };
  const labels: Record<Status, string> = {
    'nao-iniciado': 'Não iniciado',
    'escrito': 'Escrito',
    'corrigido': 'Corrigido',
    'revisado': 'Revisado',
  };
  return (
    <span className={`px-2 py-1 rounded-md text-xs font-medium ${map[status]}`}>
      {labels[status]}
    </span>
  );
}
