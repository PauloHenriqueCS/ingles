import type { PronunciationNormalizedResult } from '../types';

/**
 * Shared "Resultado da análise" summary card: overall score + the four
 * sub-scores (Precisão / Fluência / Completude / Prosódia) + recognized text.
 * Used by BOTH the writing-flow result (PronunciationResult) and the standalone
 * "Treinar pronúncia" activity (PronunciationTrainingView), so the two surfaces
 * present the same metrics.
 */

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

export default function PronunciationScoreSummary({ result }: { result: PronunciationNormalizedResult }) {
  return (
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
  );
}
