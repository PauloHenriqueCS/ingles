import { useMemo } from 'react';
import type { PronunciationNormalizedResult } from '../types';
import { buildWordAlignment } from '../lib/pronunciationWordParser';
import PronunciationWordGrid from './PronunciationWordGrid';

interface Props {
  result: PronunciationNormalizedResult;
  referenceText: string;
}

function ScoreRow({ label, value }: { label: string; value: number | null }) {
  if (value === null) {
    return (
      <div className="flex justify-between items-center">
        <span className="text-sm text-slate-400">{label}</span>
        <span className="text-xs text-slate-600">Não disponível</span>
      </div>
    );
  }
  const color =
    value >= 80 ? 'text-green-400' :
    value >= 60 ? 'text-yellow-400' :
                  'text-red-400';
  return (
    <div className="flex justify-between items-center">
      <span className="text-sm text-slate-300">{label}</span>
      <span className={`text-sm font-semibold tabular-nums ${color}`}>{value.toFixed(0)}</span>
    </div>
  );
}

export default function PronunciationResult({ result, referenceText }: Props) {
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
      {/* ── Summary card ────────────────────────────────────────────────────── */}
      <div className="bg-slate-800 rounded-xl p-4 space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500 font-medium uppercase tracking-wider">
            Resultado da análise
          </span>
          <span
            className="ml-auto text-2xl font-bold tabular-nums"
            style={{
              color:
                result.pronunciationScore >= 80 ? '#4ade80' :
                result.pronunciationScore >= 60 ? '#facc15' :
                                                  '#f87171',
            }}
            aria-label={`Nota geral: ${result.pronunciationScore.toFixed(0)}`}
          >
            {result.pronunciationScore.toFixed(0)}
          </span>
          <span className="text-xs text-slate-500 self-end mb-0.5">/ 100</span>
        </div>

        <div className="border-t border-slate-700 pt-3 space-y-2">
          <ScoreRow label="Precisão"   value={result.accuracyScore} />
          <ScoreRow label="Fluência"   value={result.fluencyScore} />
          <ScoreRow label="Completude" value={result.completenessScore} />
          <ScoreRow label="Prosódia"   value={result.prosodyScore} />
        </div>

        {result.recognizedText && (
          <div className="border-t border-slate-700 pt-3 space-y-1">
            <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">
              Texto reconhecido
            </p>
            <p className="text-xs text-slate-400 leading-relaxed">{result.recognizedText}</p>
          </div>
        )}
      </div>

      {/* ── Word detail section ──────────────────────────────────────────────── */}
      <div className="bg-slate-800 rounded-xl p-4">
        {hasWordDetail ? (
          <PronunciationWordGrid aligned={aligned} insertions={insertions} />
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
