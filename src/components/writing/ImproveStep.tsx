import { PenLine, ArrowLeft } from 'lucide-react';
import { AIFeedback, RewriteComparisonResult } from '../../types';
import type { WritingUiStrings } from '../../i18n/writingUiStrings';
import RewriteSection from '../RewriteSection';

interface Props {
  originalText: string;
  aiReview: AIFeedback;
  reviewId?: string;
  initialV2Text?: string;
  initialV2Comparison?: RewriteComparisonResult;
  initialV2FinalText?: string;
  /** True once a V2 comparison exists (persisted or just produced). */
  analyzed: boolean;
  onSaveV2: (v2Text: string, v2Comparison: RewriteComparisonResult) => void;
  onV2FinalText: (finalText: string, alreadyPersisted: boolean) => void | Promise<void>;
  onAnalyzed: () => void;
  onBackToFeedback: () => void;
  onConclude: () => void;
  t: WritingUiStrings;
}

/**
 * "Melhorar meu texto" — a focused screen (not the old stacked report): a short
 * header, the points to review, the editor, and one "Analisar melhoria" action.
 * The final corrected version + audio are deliberately hidden here (they belong
 * to the Concluído screen); generation still runs and persists in the
 * background. Once analyzed, the primary action becomes "Concluir escrita".
 */
export default function ImproveStep({
  originalText,
  aiReview,
  reviewId,
  initialV2Text,
  initialV2Comparison,
  initialV2FinalText,
  analyzed,
  onSaveV2,
  onV2FinalText,
  onAnalyzed,
  onBackToFeedback,
  onConclude,
  t,
}: Props) {
  return (
    <div className="space-y-4">
      <div className="bg-slate-800 rounded-xl p-5 space-y-1.5">
        <div className="flex items-center gap-2">
          <PenLine className="w-4 h-4 shrink-0 text-blue-400" strokeWidth={2} aria-hidden="true" />
          <p className="text-sm font-semibold text-slate-100">{t.improveHeaderTitle}</p>
        </div>
        <p className="text-sm text-slate-400 leading-relaxed">{t.improveHeaderSubtitle}</p>
      </div>

      <RewriteSection
        originalText={originalText}
        aiReview={aiReview}
        reviewId={reviewId}
        initialV2Text={initialV2Text}
        initialV2Comparison={initialV2Comparison}
        initialV2FinalText={initialV2FinalText}
        showFinalVersion={false}
        t={t}
        onSaveV2={onSaveV2}
        onV2FinalText={onV2FinalText}
        onAnalyzed={onAnalyzed}
      />

      <div className="space-y-2 pt-1">
        {analyzed && (
          <button
            onClick={onConclude}
            className="w-full py-3 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            {t.concludeWriting}
          </button>
        )}
        <button
          onClick={onBackToFeedback}
          className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-700/60 transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
          {t.backToFeedback}
        </button>
      </div>
    </div>
  );
}
