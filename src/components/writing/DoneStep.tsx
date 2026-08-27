import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { AIFeedback, RewriteComparisonResult } from '../../types';
import type { PronunciationEntitlements } from '../../domain/entitlements/entitlement-types';
import type { WritingUiStrings } from '../../i18n/writingUiStrings';
import V2AudioPlayer from '../V2AudioPlayer';
import PronunciationCard from './PronunciationCard';

interface Props {
  review: AIFeedback;
  /** The text to practice/copy/listen — the V2 final corrected version when it
   *  exists, otherwise the V1 corrected text. */
  finalText: string;
  /** Present only when the learner did a V2. */
  v2Comparison: RewriteComparisonResult | null;
  reviewId: string | null;
  pronunciation: PronunciationEntitlements | null;
  canStartNewWriting: boolean;
  remainingWritings: number | null;
  onNewMission: () => void;
  t: WritingUiStrings;
}

/**
 * Concluído — an unambiguous "the activity is done" screen. It leads with a
 * clear "✓ Escrita concluída" banner, then a compact final summary (never
 * another giant report), the final corrected version (copy + listen), and the
 * OPTIONAL pronunciation card. Pronúncia is not part of the stepper — the
 * stepper already reads Concluído here.
 */
export default function DoneStep({
  review,
  finalText,
  v2Comparison,
  reviewId,
  pronunciation,
  canStartNewWriting,
  remainingWritings,
  onNewMission,
  t,
}: Props) {
  const mainPractice = review.nextPractice?.trim() || review.mainMistakes[0]?.correct || null;

  return (
    <div className="space-y-4">
      {/* Completion banner */}
      <div className="bg-green-900/25 border border-green-800/40 rounded-xl p-5 flex items-start gap-3">
        <CheckCircle2 className="w-6 h-6 shrink-0 text-green-400 mt-0.5" strokeWidth={2} aria-hidden="true" />
        <div>
          <p className="text-base font-bold text-slate-100">{t.doneTitle}</p>
          <p className="text-sm text-slate-400 mt-0.5">{t.doneSubtitle}</p>
        </div>
      </div>

      {/* Compact final summary */}
      <div className="bg-slate-800 rounded-xl p-5 space-y-4">
        <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">{t.finalSummaryTitle}</p>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs text-slate-500 mb-1">{t.finalScoreLabel}</p>
            <span className="text-4xl font-bold tabular-nums text-slate-100">{review.score}</span>
            <span className="text-slate-500 text-sm">/100</span>
          </div>
          {v2Comparison && (
            <div className="text-center">
              <p className="text-xs text-slate-500 mb-1">{t.errorsCorrectedLabel}</p>
              <span className="text-3xl font-bold tabular-nums text-green-400">{v2Comparison.fixedMistakesCount}</span>
            </div>
          )}
        </div>
        {mainPractice && (
          <div className="border-t border-slate-700 pt-3">
            <p className="text-xs text-slate-500 mb-1">{t.mainPracticePointLabel}</p>
            <p className="text-sm text-slate-200 leading-relaxed">{mainPractice}</p>
          </div>
        )}
      </div>

      {/* Final corrected version */}
      {finalText && <FinalVersionCard text={finalText} t={t} />}

      {/* Optional pronunciation — an extra, not a step */}
      {finalText && (
        <PronunciationCard
          referenceText={finalText}
          reviewId={reviewId}
          pronunciation={pronunciation}
          t={t}
        />
      )}

      {/* Next writing */}
      {canStartNewWriting && (
        <div className="pt-1 space-y-1.5">
          <button
            onClick={onNewMission}
            className="w-full py-3 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            {t.nextActivity}
          </button>
          {remainingWritings !== null && (
            <p className="text-xs text-slate-500 text-center">{t.remainingWritings(remainingWritings)}</p>
          )}
        </div>
      )}
    </div>
  );
}

function FinalVersionCard({ text, t }: { text: string; t: WritingUiStrings }) {
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
        <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">{t.finalVersionTitle}</p>
        <button onClick={copy} className="text-xs text-blue-400 hover:text-blue-300 transition-colors">
          {copied ? t.copied : t.copy}
        </button>
      </div>
      <p className="text-slate-200 text-sm leading-relaxed whitespace-pre-wrap">{text}</p>
      <div className="border-t border-slate-700 pt-3">
        <p className="text-xs text-slate-500 mb-2">{t.listenText}</p>
        <V2AudioPlayer text={text} />
      </div>
    </div>
  );
}
