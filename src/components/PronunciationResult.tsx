import { useMemo } from 'react';
import type { PronunciationNormalizedResult } from '../types';
import { buildWordAlignment } from '../lib/pronunciationWordParser';
import PronunciationWordGrid from './PronunciationWordGrid';
import PronunciationScoreSummary from './PronunciationScoreSummary';

interface Props {
  result: PronunciationNormalizedResult;
  referenceText: string;
  /** english_reviews.id (text version) — anchors the per-word attempt limit. */
  reviewId: string | null;
}

export default function PronunciationResult({ result, referenceText, reviewId }: Props) {
  // Compute alignment once — only recomputes when rawSegments or referenceText changes
  const { aligned, insertions, hasWordDetail } = useMemo(() => {
    if (!Array.isArray(result.rawSegments) || result.rawSegments.length === 0) {
      return { aligned: [], insertions: [], hasWordDetail: false };
    }
    const alignment = buildWordAlignment(referenceText, result.rawSegments);
    return { ...alignment, hasWordDetail: true };
  }, [referenceText, result.rawSegments]);

  return (
    <div className="space-y-4">
      {/* ── Summary card (shared with the standalone pronunciation activity) ─── */}
      <PronunciationScoreSummary result={result} />

      {/* ── Word detail section ──────────────────────────────────────────────── */}
      <div className="bg-slate-800 rounded-xl p-4">
        {hasWordDetail ? (
          <PronunciationWordGrid aligned={aligned} insertions={insertions} reviewId={reviewId} />
        ) : (
          <div className="space-y-1">
            <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">
              Resultado por palavra
            </p>
            <p className="text-xs text-slate-600 leading-relaxed">
              Os detalhes por palavra não estão disponíveis para esta avaliação.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
