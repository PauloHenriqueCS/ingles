import { useState } from 'react';
import { Sparkles, CheckCircle2, AlertTriangle, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { AIFeedback } from '../../types';
import { recommendImprovement } from '../../domain/writing/writing-recommendation';
import type { WritingUiStrings } from '../../i18n/writingUiStrings';
import TeacherReport from './TeacherReport';

interface Props {
  review: AIFeedback;
  grammarObjective: string;
  onConclude: () => void;
  onImprove: () => void;
  concluding: boolean;
  t: WritingUiStrings;
}

/**
 * Feedback step — summary FIRST. Leads with a compact, genuinely useful summary
 * (score, level, short feedback, the main correction, corrected text) and only
 * then reveals the full detailed report on demand. After the summary the
 * activity ALWAYS lets the user conclude; the CTA emphasis adapts to whether the
 * AI reported concrete points to fix (see recommendImprovement).
 */
export default function FeedbackStep({ review, grammarObjective, onConclude, onImprove, concluding, t }: Props) {
  const [showFull, setShowFull] = useState(false);
  const rec = recommendImprovement(review.mainMistakes.length);
  const mainCorrection = review.mainMistakes[0] ?? null;
  const scoreColor =
    review.score >= 75 ? 'text-green-400' : review.score >= 50 ? 'text-amber-400' : 'text-red-400';

  return (
    <div className="space-y-4">
      {/* Summary-first card */}
      <div className="bg-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 shrink-0 text-blue-400" strokeWidth={2} aria-hidden="true" />
          <p className="text-sm font-semibold text-slate-100">{t.feedbackSummaryTitle}</p>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">{t.scoreLabel}</p>
            <span className={`text-5xl font-bold tabular-nums ${scoreColor}`}>{review.score}</span>
            <span className="text-slate-500 text-lg">/100</span>
          </div>
          <div className="text-right space-y-1">
            <p className="text-xs text-slate-400 uppercase tracking-wider">{t.writingLevelLabel}</p>
            <span className="block px-3 py-1.5 rounded-lg bg-blue-900 text-blue-300 text-lg font-bold">
              {review.level}
            </span>
          </div>
        </div>

        {review.summary && (
          <p className="text-sm text-slate-200 leading-relaxed border-t border-slate-700 pt-3">
            {review.summary}
          </p>
        )}
      </div>

      {/* Main correction */}
      {mainCorrection && (
        <div className="bg-slate-800 rounded-xl p-5 space-y-2">
          <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">{t.mainCorrectionTitle}</p>
          <div className="flex gap-2 text-sm">
            <span className="text-slate-500 shrink-0 w-28">{t.youWrote}</span>
            <span className="text-red-400 italic">"{mainCorrection.original}"</span>
          </div>
          <div className="flex gap-2 text-sm">
            <span className="text-slate-500 shrink-0 w-28">{t.corrected}</span>
            <span className="text-green-400 italic">"{mainCorrection.correct}"</span>
          </div>
          {mainCorrection.explanation && (
            <p className="text-xs text-slate-400 leading-relaxed pt-0.5">{mainCorrection.explanation}</p>
          )}
        </div>
      )}

      {/* Corrected text (compact) */}
      <div className="bg-slate-800 rounded-xl p-5 space-y-2">
        <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">{t.corrected}</p>
        <p className="text-slate-200 text-sm leading-relaxed whitespace-pre-wrap">{review.correctedText}</p>
      </div>

      {/* Adaptive recommendation + primary actions */}
      {rec.recommend ? (
        <div className="bg-amber-900/20 border border-amber-800/30 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" strokeWidth={2} aria-hidden="true" />
            <p className="text-sm font-semibold text-slate-100">{t.improveTitle(rec.pointsToImprove)}</p>
          </div>
          <p className="text-sm text-slate-300 leading-relaxed">{t.improveBody}</p>
          <div className="space-y-2 pt-1">
            <button
              onClick={onImprove}
              className="w-full py-3 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            >
              {t.improveMyText}
            </button>
            <button
              onClick={onConclude}
              disabled={concluding}
              className="w-full py-2.5 rounded-xl text-sm font-medium text-slate-300 hover:text-white hover:bg-slate-700/60 disabled:opacity-40 transition-colors"
            >
              {concluding ? <InlineSpinner /> : t.concludeAnyway}
            </button>
          </div>
        </div>
      ) : (
        <div className="bg-green-900/20 border border-green-800/30 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0 text-green-400" strokeWidth={2} aria-hidden="true" />
            <p className="text-sm font-semibold text-slate-100">{t.praiseTitle}</p>
          </div>
          <p className="text-sm text-slate-300 leading-relaxed">{t.praiseBody}</p>
          <div className="space-y-2 pt-1">
            <button
              onClick={onConclude}
              disabled={concluding}
              className="w-full py-3 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 transition-colors"
            >
              {concluding ? <InlineSpinner /> : t.concludeWriting}
            </button>
            <button
              onClick={onImprove}
              className="w-full py-2.5 rounded-xl text-sm font-medium text-slate-300 hover:text-white hover:bg-slate-700/60 transition-colors"
            >
              {t.improveMyText}
            </button>
          </div>
        </div>
      )}

      {/* Full report (secondary, collapsed) */}
      <div className="border border-slate-700 rounded-xl overflow-hidden">
        <button
          type="button"
          onClick={() => setShowFull((v) => !v)}
          aria-expanded={showFull}
          className="w-full flex items-center justify-between px-4 py-3 text-left bg-slate-800 transition-colors"
        >
          <span className="text-sm text-slate-300 font-medium">
            {showFull ? t.hideFullReport : t.showFullReport}
          </span>
          {showFull
            ? <ChevronUp className="w-4 h-4 shrink-0 text-slate-500" strokeWidth={2} aria-hidden="true" />
            : <ChevronDown className="w-4 h-4 shrink-0 text-slate-500" strokeWidth={2} aria-hidden="true" />}
        </button>
        {showFull && (
          <div className="bg-slate-800/60 px-4 pb-4 pt-2">
            <TeacherReport review={review} grammarObjective={grammarObjective} />
          </div>
        )}
      </div>
    </div>
  );
}

function InlineSpinner() {
  return (
    <span className="flex items-center justify-center gap-2">
      <Loader2 className="w-4 h-4 shrink-0 animate-spin" strokeWidth={2} />
    </span>
  );
}
