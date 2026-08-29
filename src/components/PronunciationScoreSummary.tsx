import type { PronunciationNormalizedResult } from '../types';
import {
  pronunciationMetricStrings,
  type MetricExplanation,
  type PronunciationMetricStrings,
} from '../i18n/pronunciationMetricStrings';
import MetricInfoTip from './MetricInfoTip';

/**
 * Shared "Resultado da análise" summary card: overall score + the four
 * sub-scores (Precisão / Fluência / Completude / Prosódia) + recognized text.
 * Used by BOTH the writing-flow result (PronunciationResult) and the standalone
 * "Treinar pronúncia" activity (PronunciationTrainingView), so the two surfaces
 * present the same metrics — and, via the shared MetricInfoTip below, the same
 * plain-language "?" explanations.
 *
 * This is presentation only: scores, colours and the recognized text are
 * unchanged; the metric names now carry a "?" that opens a short explanation.
 */

function ScoreRow({
  metric, value, understandPrefix, regionLabel,
}: {
  metric: MetricExplanation;
  value: number | null;
  understandPrefix: string;
  regionLabel: string;
}) {
  const label = (
    <span className="inline-flex items-center text-sm text-slate-300">
      {metric.title}
      <MetricInfoTip
        title={metric.title}
        description={metric.description}
        buttonLabel={`${understandPrefix} ${metric.title}`}
        regionLabel={regionLabel}
      />
    </span>
  );

  if (value === null) {
    return (
      <div className="flex justify-between items-center">
        {label}
        <span className="text-xs text-slate-600">Não disponível</span>
      </div>
    );
  }
  const color =
    value >= 80 ? 'text-green-400' :
    value >= 60 ? 'text-yellow-400' :
                  'text-red-400';
  return (
    <div className="flex justify-between items-center gap-3">
      {label}
      <span className={`text-sm font-semibold tabular-nums ${color}`}>{value.toFixed(0)}</span>
    </div>
  );
}

export default function PronunciationScoreSummary({
  result,
  interfaceLanguage,
}: {
  result: PronunciationNormalizedResult;
  /** Optional — the pronunciation area is currently pt-BR; when the interface
   *  language is threaded in, metric names + explanations localize together. */
  interfaceLanguage?: string | null;
}) {
  const m: PronunciationMetricStrings = pronunciationMetricStrings(interfaceLanguage);
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
        <ScoreRow metric={m.accuracy}     value={result.accuracyScore}     understandPrefix={m.understandPrefix} regionLabel={m.explanationLabel} />
        <ScoreRow metric={m.fluency}      value={result.fluencyScore}      understandPrefix={m.understandPrefix} regionLabel={m.explanationLabel} />
        <ScoreRow metric={m.completeness} value={result.completenessScore} understandPrefix={m.understandPrefix} regionLabel={m.explanationLabel} />
        <ScoreRow metric={m.prosody}      value={result.prosodyScore}      understandPrefix={m.understandPrefix} regionLabel={m.explanationLabel} />
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
