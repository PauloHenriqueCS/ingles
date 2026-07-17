import { useState, useEffect, useMemo } from 'react';
import { Sprout } from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { EnglishReviewSaved, CefrLevel, View } from '../types';
import { fetchEnglishReviews } from '../lib/reviewsHistory';
import {
  Period,
  filterByPeriod,
  buildChartData,
  buildPeriodComparison,
  estimateCurrentLevel,
  deduplicateReviews,
} from '../lib/evolutionStats';

// ── Types ─────────────────────────────────────────────────────────────────────

type MetricKey = 'score' | 'grammar' | 'vocabulary' | 'naturalness' | 'fluency';

interface MetricOption {
  key: MetricKey;
  label: string;
  color: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CEFR_RANGES: Record<CefrLevel, { min: number; max: number; next: CefrLevel | null }> = {
  A1: { min: 0,  max: 16,  next: 'A2' },
  A2: { min: 17, max: 32,  next: 'B1' },
  B1: { min: 33, max: 49,  next: 'B2' },
  B2: { min: 50, max: 66,  next: 'C1' },
  C1: { min: 67, max: 82,  next: 'C2' },
  C2: { min: 83, max: 100, next: null },
};

const PERIOD_LABELS: Record<Period, string> = {
  '7d':  '7 dias',
  '30d': '30 dias',
  '3m':  '3 meses',
  'all': 'Tudo',
};

const SKILL_DEFS = [
  { key: 'grammar'     as const, label: 'Gramática',   color: '#4ade80' },
  { key: 'vocabulary'  as const, label: 'Vocabulário', color: '#38bdf8' },
  { key: 'naturalness' as const, label: 'Naturalidade',color: '#f59e0b' },
  { key: 'fluency'     as const, label: 'Fluência',    color: '#c084fc' },
];

const METRIC_OPTIONS: MetricOption[] = [
  { key: 'score',       label: 'Nota geral',  color: '#60a5fa' },
  { key: 'grammar',     label: 'Gramática',   color: '#4ade80' },
  { key: 'vocabulary',  label: 'Vocabulário', color: '#38bdf8' },
  { key: 'naturalness', label: 'Naturalidade',color: '#f59e0b' },
  { key: 'fluency',     label: 'Fluência',    color: '#c084fc' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function cefrProgress(level: CefrLevel, avgScore: number): number {
  const { min, max } = CEFR_RANGES[level];
  return Math.min(100, Math.max(0, Math.round(((avgScore - min) / (max - min)) * 100)));
}

function scoreColor(v: number) {
  return v >= 75 ? 'text-green-400' : v >= 50 ? 'text-amber-400' : 'text-red-400';
}

function variationColor(v: number | null) {
  if (v === null) return 'text-slate-500';
  return v > 0 ? 'text-green-400' : v < 0 ? 'text-red-400' : 'text-slate-400';
}

function variationLabel(v: number | null) {
  if (v === null) return '—';
  if (v > 0) return `+${v}`;
  return String(v);
}

function shortDate(iso: string): string {
  try {
    const d = new Date(iso);
    return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  } catch { return '—'; }
}

// ── Tooltip ───────────────────────────────────────────────────────────────────

interface TooltipPayloadItem {
  value: number | null;
  payload: { date: string };
}

function MetricTooltip({
  active,
  payload,
  metricLabel,
  metricColor,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  metricLabel: string;
  metricColor: string;
}) {
  if (!active || !payload?.length) return null;
  const value = payload[0]?.value;
  const date = payload[0]?.payload?.date;
  if (value == null) return null;
  return (
    <div className="bg-slate-800 border border-slate-600 rounded-lg p-3 text-xs space-y-1 shadow-xl">
      {date && <p className="text-slate-300 font-medium">{shortDate(date)}</p>}
      <p style={{ color: metricColor }}>{metricLabel}: <span className="font-bold">{value}</span></p>
    </div>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  onNavigate: (v: View) => void;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function EvolutionView({ onNavigate: _onNavigate }: Props) {
  const [reviews, setReviews] = useState<EnglishReviewSaved[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'done' | 'error'>('loading');
  const [period, setPeriod] = useState<Period>('30d');
  const [selectedMetric, setSelectedMetric] = useState<MetricKey>('score');

  function load() {
    setLoadState('loading');
    fetchEnglishReviews()
      .then((data) => { setReviews(data); setLoadState('done'); })
      .catch(() => setLoadState('error'));
  }

  useEffect(() => { load(); }, []);

  const deduplicatedReviews = useMemo(() => deduplicateReviews(reviews), [reviews]);
  const filteredReviews = useMemo(() => filterByPeriod(deduplicatedReviews, period), [deduplicatedReviews, period]);
  const chartData = useMemo(() => buildChartData(filteredReviews), [filteredReviews]);
  const comparison = useMemo(() => buildPeriodComparison(deduplicatedReviews, period), [deduplicatedReviews, period]);
  const estimatedLevel = useMemo(() => estimateCurrentLevel(deduplicatedReviews), [deduplicatedReviews]);

  const allTimeAvgScore = useMemo(() => {
    if (deduplicatedReviews.length === 0) return 0;
    return Math.round(deduplicatedReviews.reduce((s, r) => s + r.score, 0) / deduplicatedReviews.length);
  }, [deduplicatedReviews]);

  const levelProgress = cefrProgress(estimatedLevel, allTimeAvgScore);
  const showLevelProgress = deduplicatedReviews.length >= 3 && levelProgress > 0;
  const cefrInfo = CEFR_RANGES[estimatedLevel];

  const hasPrevious = useMemo(() => {
    if (comparison.isAllTime) {
      return comparison.firstHalfAvgScore !== null && comparison.secondHalfAvgScore !== null;
    }
    return comparison.previousAvgScore !== null;
  }, [comparison]);

  const selectedMetricOption = METRIC_OPTIONS.find((m) => m.key === selectedMetric) ?? METRIC_OPTIONS[0];

  const periodSingleValue = useMemo(() => {
    if (filteredReviews.length === 0) return 0;
    if (selectedMetric === 'score') return comparison.currentAvgScore;
    if (selectedMetric === 'grammar') return comparison.currentAvgGrammar;
    if (selectedMetric === 'vocabulary') return comparison.currentAvgVocabulary;
    if (selectedMetric === 'naturalness') return comparison.currentAvgNaturalness;
    return comparison.currentAvgFluency;
  }, [filteredReviews, selectedMetric, comparison]);

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      <header className="sticky top-0 bg-slate-800 border-b border-slate-700 px-4 py-3 z-10">
        <h1 className="text-base font-semibold text-slate-100">Evolução</h1>
      </header>

      <div className="flex-1 overflow-auto p-4 max-w-lg mx-auto w-full space-y-4 pb-20">

        {loadState === 'loading' && (
          <div className="flex flex-col items-center justify-center py-20 space-y-3">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-slate-400 text-sm">Carregando evolução…</p>
          </div>
        )}

        {loadState === 'error' && (
          <div className="bg-red-900/30 border border-red-800 rounded-xl p-6 text-center space-y-3">
            <p className="text-red-300 text-sm">Não foi possível carregar sua evolução.</p>
            <button onClick={load} className="text-xs text-slate-400 hover:text-slate-200 transition-colors">
              Tentar novamente
            </button>
          </div>
        )}

        {loadState === 'done' && reviews.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center space-y-3">
            <Sprout className="w-12 h-12 text-slate-500 shrink-0" strokeWidth={1.5} aria-hidden="true" />
            <p className="text-slate-300 font-medium">Sem avaliações ainda.</p>
            <p className="text-slate-500 text-sm">Conclua sua primeira revisão para começar a acompanhar sua evolução.</p>
          </div>
        )}

        {loadState === 'done' && reviews.length > 0 && (
          <>
            {/* 1 — Seletor de período */}
            <div className="flex gap-2">
              {(['7d', '30d', '3m', 'all'] as Period[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    period === p
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {PERIOD_LABELS[p]}
                </button>
              ))}
            </div>

            {/* 2 — Nível estimado */}
            <div className="bg-slate-800 rounded-xl p-5 space-y-3">
              <p className="text-xs text-slate-400 uppercase tracking-wider font-medium">Nível estimado de escrita</p>
              <div className="flex items-center gap-4">
                <div className="text-5xl font-black text-blue-400 tabular-nums">{estimatedLevel}</div>
                {showLevelProgress && (
                  <div className="flex-1 space-y-1.5">
                    <div className="flex justify-between text-xs text-slate-400">
                      <span>{estimatedLevel}</span>
                      {cefrInfo.next
                        ? <span>{cefrInfo.next}</span>
                        : <span className="text-green-400">Nível máximo</span>
                      }
                    </div>
                    <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-500 rounded-full transition-all duration-500"
                        style={{ width: `${levelProgress}%` }}
                      />
                    </div>
                    <p className="text-xs text-slate-500">
                      {cefrInfo.next
                        ? `${100 - levelProgress}% para ${cefrInfo.next}`
                        : 'Parabéns! Nível máximo atingido.'
                      }
                    </p>
                  </div>
                )}
                {!showLevelProgress && (
                  <p className="text-xs text-slate-500 flex-1">
                    {deduplicatedReviews.length < 3
                      ? 'Faça mais avaliações para ver o progresso de nível.'
                      : cefrInfo.next
                        ? `Evoluindo para ${cefrInfo.next}`
                        : 'Nível máximo atingido.'
                    }
                  </p>
                )}
              </div>
            </div>

            {filteredReviews.length === 0 && (
              <div className="bg-slate-800 rounded-xl p-5 text-center">
                <p className="text-slate-400 text-sm">Nenhuma avaliação no período selecionado.</p>
                <button
                  onClick={() => setPeriod('all')}
                  className="text-xs text-blue-400 mt-2"
                >
                  Ver todo o histórico
                </button>
              </div>
            )}

            {filteredReviews.length > 0 && (
              <>
                {/* 3 — Resumo do período */}
                <div className="bg-slate-800 rounded-xl p-4">
                  <p className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-3">
                    Resumo — {PERIOD_LABELS[period]}
                  </p>
                  <div className="flex gap-0">
                    <div className="flex-1 text-center">
                      <p className={`text-2xl font-bold tabular-nums ${scoreColor(comparison.currentAvgScore)}`}>
                        {comparison.currentAvgScore}
                      </p>
                      <p className="text-xs text-slate-500 mt-0.5">Média</p>
                    </div>
                    <div className="w-px bg-slate-700 mx-2" />
                    <div className="flex-1 text-center">
                      <p className="text-2xl font-bold text-slate-100 tabular-nums">{filteredReviews.length}</p>
                      <p className="text-xs text-slate-500 mt-0.5">Avaliados</p>
                    </div>
                    {comparison.scoreVariation !== null && (
                      <>
                        <div className="w-px bg-slate-700 mx-2" />
                        <div className="flex-1 text-center">
                          <p className={`text-2xl font-bold tabular-nums ${variationColor(comparison.scoreVariation)}`}>
                            {variationLabel(comparison.scoreVariation)}
                          </p>
                          <p className="text-xs text-slate-500 mt-0.5">vs anterior</p>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                {/* 4 — Desempenho por habilidade */}
                <section className="bg-slate-800 rounded-xl p-4 space-y-3">
                  <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Desempenho por habilidade</p>
                  <div className="grid grid-cols-2 gap-2">
                    {SKILL_DEFS.map(({ key, label, color }) => {
                      const capKey = (key.charAt(0).toUpperCase() + key.slice(1)) as 'Grammar' | 'Vocabulary' | 'Naturalness' | 'Fluency';
                      const value = comparison[`currentAvg${capKey}`] as number;
                      return (
                        <div key={key} className="bg-slate-700/50 rounded-lg p-3">
                          <p className="text-xs font-medium mb-0.5" style={{ color }}>{label}</p>
                          <p className={`text-xl font-bold tabular-nums ${scoreColor(value)}`}>
                            {value}
                            <span className="text-xs text-slate-500 font-normal">/100</span>
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </section>

                {/* 5 — Gráfico com seletor de habilidade */}
                <section className="bg-slate-800 rounded-xl p-4 space-y-3">
                  <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Evolução das notas</p>

                  <div
                    className="flex gap-2 overflow-x-auto pb-0.5"
                    style={{ scrollbarWidth: 'none' }}
                  >
                    {METRIC_OPTIONS.map(({ key, label }) => (
                      <button
                        key={key}
                        onClick={() => setSelectedMetric(key)}
                        className={`px-2.5 py-1 rounded-full text-xs whitespace-nowrap shrink-0 transition-colors ${
                          selectedMetric === key
                            ? 'bg-blue-600 text-white'
                            : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {filteredReviews.length === 1 && (
                    <div className="py-6 text-center">
                      <p className={`text-4xl font-black tabular-nums ${scoreColor(periodSingleValue)}`}>
                        {periodSingleValue}
                      </p>
                      <p className="text-xs text-slate-500 mt-2">
                        {selectedMetricOption.label} — faça mais avaliações para ver a evolução.
                      </p>
                    </div>
                  )}

                  {filteredReviews.length >= 2 && (
                    <ResponsiveContainer width="100%" height={200}>
                      <LineChart data={chartData} margin={{ top: 5, right: 5, left: -25, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                        <XAxis
                          dataKey="shortDate"
                          tick={{ fill: '#94a3b8', fontSize: 10 }}
                          tickLine={false}
                          axisLine={{ stroke: '#475569' }}
                          interval="preserveStartEnd"
                        />
                        <YAxis
                          domain={[0, 100]}
                          tick={{ fill: '#94a3b8', fontSize: 10 }}
                          tickLine={false}
                          axisLine={false}
                        />
                        <Tooltip
                          content={(props: { active?: boolean; payload?: readonly unknown[] }) => (
                            <MetricTooltip
                              active={props.active}
                              payload={props.payload as unknown as TooltipPayloadItem[] | undefined}
                              metricLabel={selectedMetricOption.label}
                              metricColor={selectedMetricOption.color}
                            />
                          )}
                        />
                        <Line
                          type="monotone"
                          dataKey={selectedMetric}
                          stroke={selectedMetricOption.color}
                          strokeWidth={2}
                          dot={{ fill: selectedMetricOption.color, r: 3 }}
                          activeDot={{ r: 5 }}
                          connectNulls
                        />
                        {selectedMetric === 'score' && filteredReviews.length >= 5 && (
                          <Line
                            type="monotone"
                            dataKey="movingAvg"
                            stroke="#94a3b8"
                            strokeWidth={1.5}
                            strokeDasharray="4 2"
                            dot={false}
                            name="Média móvel"
                            connectNulls
                          />
                        )}
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </section>

                {/* 6 — Comparação com período anterior */}
                {hasPrevious && (
                  <section className="bg-slate-800 rounded-xl p-4 space-y-3">
                    <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Comparação de desempenho</p>

                    {comparison.isAllTime ? (
                      <div className="flex gap-3">
                        <div className="flex-1 text-center bg-slate-700/50 rounded-lg p-3">
                          <p className="text-xs text-slate-500">Primeiras avaliações</p>
                          <p className={`text-2xl font-bold tabular-nums mt-1 ${scoreColor(comparison.firstHalfAvgScore!)}`}>
                            {comparison.firstHalfAvgScore}
                          </p>
                        </div>
                        <div className="flex-1 text-center bg-slate-700/50 rounded-lg p-3">
                          <p className="text-xs text-slate-500">Avaliações recentes</p>
                          <p className={`text-2xl font-bold tabular-nums mt-1 ${scoreColor(comparison.secondHalfAvgScore!)}`}>
                            {comparison.secondHalfAvgScore}
                          </p>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <p className="text-xs text-slate-500">{PERIOD_LABELS[period]} vs. período anterior</p>
                        {[
                          { label: 'Nota geral',  value: comparison.scoreVariation },
                          { label: 'Gramática',   value: comparison.grammarVariation },
                          { label: 'Vocabulário', value: comparison.vocabularyVariation },
                          { label: 'Naturalidade',value: comparison.naturalnessVariation },
                          { label: 'Fluência',    value: comparison.fluencyVariation },
                        ].map(({ label, value }) => value !== null ? (
                          <div key={label} className="flex items-center justify-between">
                            <span className="text-xs text-slate-400">{label}</span>
                            <span className={`text-sm font-bold tabular-nums ${variationColor(value)}`}>
                              {variationLabel(value)}
                            </span>
                          </div>
                        ) : null)}
                      </div>
                    )}
                  </section>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
