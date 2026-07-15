import { useState, useEffect, useMemo } from 'react';
import { Sprout, Target, ChevronDown, X } from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';
import { EnglishReviewSaved, CefrLevel, View } from '../types';
import { fetchEnglishReviews } from '../lib/reviewsHistory';
import {
  Period,
  filterByPeriod,
  getPreviousPeriodReviews,
  buildChartData,
  buildPeriodComparison,
  buildActivityCalendar,
  buildRecurringMistakes,
  buildAllMistakes,
  buildRecommendedFocus,
  estimateCurrentLevel,
  calculateCurrentStreak,
  getUniquePracticeDays,
} from '../lib/evolutionStats';

type LoadState = 'loading' | 'done' | 'error';

interface Props { onNavigate: (v: View) => void; }

const CEFR_RANGES: Record<CefrLevel, { min: number; max: number; next: CefrLevel | null }> = {
  A1: { min: 0, max: 16, next: 'A2' },
  A2: { min: 17, max: 32, next: 'B1' },
  B1: { min: 33, max: 49, next: 'B2' },
  B2: { min: 50, max: 66, next: 'C1' },
  C1: { min: 67, max: 82, next: 'C2' },
  C2: { min: 83, max: 100, next: null },
};

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

const PERIOD_LABELS: Record<Period, string> = {
  '7d': '7 dias',
  '30d': '30 dias',
  '3m': '3 meses',
  'all': 'Tudo',
};

const SKILL_COLORS = {
  grammar: '#4ade80',
  vocabulary: '#60a5fa',
  naturalness: '#f59e0b',
  fluency: '#c084fc',
};

const SKILL_LABELS = {
  grammar: 'Gramática',
  vocabulary: 'Vocabulário',
  naturalness: 'Naturalidade',
  fluency: 'Fluência',
};

// ── Tooltip do gráfico de score ───────────────────────────────────────────────

interface ScorePayloadItem {
  payload: {
    date: string;
    score: number;
    level: CefrLevel;
    missionTitle: string | null;
  };
}

function ScoreTooltip({ active, payload }: { active?: boolean; payload?: ScorePayloadItem[] }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-slate-800 border border-slate-600 rounded-lg p-3 text-xs space-y-1 shadow-xl max-w-48">
      <p className="text-slate-300 font-medium">{shortDate(d.date)}</p>
      <p className="text-blue-400">Nota: <span className="font-bold">{d.score}</span></p>
      <p className="text-slate-400">Atividade avaliada como {d.level}</p>
      {d.missionTitle && <p className="text-slate-500 truncate">{d.missionTitle}</p>}
    </div>
  );
}

// ── Tooltip das habilidades ───────────────────────────────────────────────────

interface SkillPayloadItem {
  name: string;
  value: number;
  color: string;
  dataKey: string;
  payload: { date: string };
}

function SkillTooltip({ active, payload }: { active?: boolean; payload?: SkillPayloadItem[] }) {
  if (!active || !payload?.length) return null;
  const date = payload[0]?.payload?.date;
  return (
    <div className="bg-slate-800 border border-slate-600 rounded-lg p-3 text-xs space-y-1 shadow-xl">
      {date && <p className="text-slate-300 font-medium">{shortDate(date)}</p>}
      {payload.map((p) => (
        <p key={p.name} style={{ color: p.color }}>{p.name}: <span className="font-bold">{p.value ?? '—'}</span></p>
      ))}
    </div>
  );
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function EvolutionView({ onNavigate }: Props) {
  const [reviews, setReviews] = useState<EnglishReviewSaved[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [period, setPeriod] = useState<Period>('30d');
  const [hiddenSkills, setHiddenSkills] = useState<Set<string>>(new Set());
  const [showAllMistakes, setShowAllMistakes] = useState(false);

  function load() {
    setLoadState('loading');
    fetchEnglishReviews()
      .then((data) => { setReviews(data); setLoadState('done'); })
      .catch(() => setLoadState('error'));
  }

  useEffect(() => { load(); }, []);

  const filteredReviews = useMemo(() => filterByPeriod(reviews, period), [reviews, period]);
  const previousReviews = useMemo(() => getPreviousPeriodReviews(reviews, period), [reviews, period]);
  const chartData = useMemo(() => buildChartData(filteredReviews), [filteredReviews]);
  const comparison = useMemo(() => buildPeriodComparison(reviews, period), [reviews, period]);
  const activityCalendar = useMemo(() => buildActivityCalendar(reviews), [reviews]);
  const topMistakes = useMemo(() => buildRecurringMistakes(filteredReviews, 5), [filteredReviews]);
  const allMistakes = useMemo(() => buildAllMistakes(filteredReviews), [filteredReviews]);
  const focus = useMemo(() => buildRecommendedFocus(filteredReviews, previousReviews), [filteredReviews, previousReviews]);
  const estimatedLevel = useMemo(() => estimateCurrentLevel(reviews), [reviews]);
  const currentStreak = useMemo(() => calculateCurrentStreak(reviews), [reviews]);
  const practicedDays = useMemo(() => getUniquePracticeDays(reviews).length, [reviews]);

  const avgScore = useMemo(() => {
    if (filteredReviews.length === 0) return 0;
    return Math.round(filteredReviews.reduce((s, r) => s + r.score, 0) / filteredReviews.length);
  }, [filteredReviews]);

  const canShowMovingAvg = filteredReviews.length >= 5;

  function toggleSkill(dataKey: string) {
    setHiddenSkills(prev => {
      const next = new Set(prev);
      if (next.has(dataKey)) next.delete(dataKey);
      else next.add(dataKey);
      return next;
    });
  }

  const cefrInfo = CEFR_RANGES[estimatedLevel];
  const levelProgress = cefrProgress(estimatedLevel, avgScore);

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      <header className="sticky top-0 bg-slate-800 border-b border-slate-700 px-4 py-3 z-10">
        <h1 className="text-base font-semibold text-slate-100">Minha evolução</h1>
        <p className="text-xs text-slate-400 mt-0.5">Acompanhe seu progresso no writing em inglês.</p>
      </header>

      <div className="flex-1 overflow-auto p-4 max-w-lg mx-auto w-full space-y-5 pb-20">

        {loadState === 'loading' && (
          <div className="flex flex-col items-center justify-center py-20 space-y-3">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-slate-400 text-sm">Carregando sua evolução...</p>
          </div>
        )}

        {loadState === 'error' && (
          <div className="bg-red-900/30 border border-red-800 rounded-xl p-6 text-center space-y-3">
            <p className="text-red-300 text-sm">Não foi possível carregar sua evolução agora.</p>
            <button onClick={load} className="text-xs text-slate-400 hover:text-slate-200 transition-colors">
              Tentar novamente
            </button>
          </div>
        )}

        {loadState === 'done' && reviews.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center space-y-3">
            <Sprout className="w-12 h-12 text-slate-500 shrink-0" strokeWidth={1.5} />
            <p className="text-slate-300 font-medium">Sem revisões ainda.</p>
            <p className="text-slate-500 text-sm">Conclua sua primeira revisão para começar a acompanhar sua evolução.</p>
            <button onClick={() => onNavigate('dashboard')} className="mt-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors">
              Fazer uma revisão
            </button>
          </div>
        )}

        {loadState === 'done' && reviews.length > 0 && (
          <>
            {/* ── Seletor de período ── */}
            <div className="flex gap-2">
              {(['7d', '30d', '3m', 'all'] as Period[]).map(p => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    period === p ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {PERIOD_LABELS[p]}
                </button>
              ))}
            </div>

            {filteredReviews.length === 0 && (
              <div className="bg-slate-800 rounded-xl p-5 text-center">
                <p className="text-slate-400 text-sm">Nenhuma avaliação no período selecionado.</p>
                <button onClick={() => setPeriod('all')} className="text-xs text-blue-400 mt-2">
                  Ver todo o histórico
                </button>
              </div>
            )}

            {filteredReviews.length > 0 && (
              <>
                {/* ── Card de nível estimado ── */}
                <div className="bg-slate-800 rounded-xl p-5 space-y-4">
                  <div>
                    <p className="text-xs text-slate-400 uppercase tracking-wider font-medium">Nível estimado de escrita</p>
                    <p className="text-slate-500 text-xs mt-0.5">Baseado nas avaliações recentes — não é a promoção oficial.</p>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-5xl font-black text-blue-400 tabular-nums">{estimatedLevel}</div>
                    <div className="flex-1 space-y-2">
                      <div className="flex justify-between text-xs text-slate-400">
                        <span>{estimatedLevel}</span>
                        {cefrInfo.next && <span>{cefrInfo.next}</span>}
                        {!cefrInfo.next && <span className="text-green-400">Nível máximo</span>}
                      </div>
                      <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-500 rounded-full transition-all duration-500"
                          style={{ width: `${levelProgress}%` }}
                        />
                      </div>
                      <p className="text-xs text-slate-400">
                        {cefrInfo.next
                          ? `${100 - levelProgress}% para chegar ao ${cefrInfo.next}`
                          : 'Parabéns! Nível máximo atingido.'}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-3 pt-1 border-t border-slate-700">
                    <div className="flex-1 text-center">
                      <p className={`text-xl font-bold tabular-nums ${scoreColor(avgScore)}`}>{avgScore}</p>
                      <p className="text-xs text-slate-500 mt-0.5">Média do período</p>
                    </div>
                    <div className="w-px bg-slate-700" />
                    <div className="flex-1 text-center">
                      <p className="text-xl font-bold text-slate-100 tabular-nums">{currentStreak}</p>
                      <p className="text-xs text-slate-500 mt-0.5">dias seguidos</p>
                    </div>
                    <div className="w-px bg-slate-700" />
                    <div className="flex-1 text-center">
                      <p className="text-xl font-bold text-slate-100 tabular-nums">{practicedDays}</p>
                      <p className="text-xs text-slate-500 mt-0.5">dias praticados</p>
                    </div>
                  </div>
                </div>

                {/* ── Gráfico de evolução geral ── */}
                <section className="bg-slate-800 rounded-xl p-5 space-y-4">
                  <div>
                    <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Evolução da nota geral</p>
                    <div className="flex gap-4 mt-2">
                      <div>
                        <p className={`text-lg font-bold tabular-nums ${scoreColor(comparison.currentAvgScore)}`}>{comparison.currentAvgScore}</p>
                        <p className="text-xs text-slate-500">Média</p>
                      </div>
                      {comparison.scoreVariation !== null && (
                        <div>
                          <p className={`text-lg font-bold tabular-nums ${variationColor(comparison.scoreVariation)}`}>
                            {variationLabel(comparison.scoreVariation)}
                          </p>
                          <p className="text-xs text-slate-500">vs período anterior</p>
                        </div>
                      )}
                      <div>
                        <p className={`text-lg font-bold tabular-nums ${scoreColor(Math.max(...filteredReviews.map(r => r.score)))}`}>
                          {Math.max(...filteredReviews.map(r => r.score))}
                        </p>
                        <p className="text-xs text-slate-500">Melhor nota</p>
                      </div>
                    </div>
                  </div>

                  {filteredReviews.length === 1 && (
                    <div className="py-4 text-center">
                      <p className="text-3xl font-black text-blue-400">{filteredReviews[0].score}</p>
                      <p className="text-xs text-slate-500 mt-1">Sua primeira avaliação no período</p>
                      <p className="text-xs text-slate-600 mt-1">Faça mais avaliações para ver a evolução.</p>
                    </div>
                  )}

                  {filteredReviews.length >= 2 && (
                    <ResponsiveContainer width="100%" height={200}>
                      <LineChart data={chartData} margin={{ top: 5, right: 5, left: -25, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                        <XAxis dataKey="shortDate" tick={{ fill: '#94a3b8', fontSize: 10 }} tickLine={false} axisLine={{ stroke: '#475569' }} interval="preserveStartEnd" />
                        <YAxis domain={[0, 100]} tick={{ fill: '#94a3b8', fontSize: 10 }} tickLine={false} axisLine={false} />
                        <Tooltip content={(props) => <ScoreTooltip active={props.active} payload={props.payload as unknown as ScorePayloadItem[] | undefined} />} />
                        <Line type="monotone" dataKey="score" stroke="#60a5fa" strokeWidth={2} dot={{ fill: '#60a5fa', r: 3 }} activeDot={{ r: 5 }} name="Nota" connectNulls />
                        {canShowMovingAvg && (
                          <Line type="monotone" dataKey="movingAvg" stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="4 2" dot={false} name="Média móvel" connectNulls />
                        )}
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </section>

                {/* ── Gráfico de habilidades ── */}
                <section className="bg-slate-800 rounded-xl p-5 space-y-4">
                  <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Evolução por habilidade</p>

                  {filteredReviews.length >= 2 && (
                    <>
                      <ResponsiveContainer width="100%" height={220}>
                        <LineChart data={chartData} margin={{ top: 5, right: 5, left: -25, bottom: 5 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                          <XAxis dataKey="shortDate" tick={{ fill: '#94a3b8', fontSize: 10 }} tickLine={false} axisLine={{ stroke: '#475569' }} interval="preserveStartEnd" />
                          <YAxis domain={[0, 100]} tick={{ fill: '#94a3b8', fontSize: 10 }} tickLine={false} axisLine={false} />
                          <Tooltip content={(props) => <SkillTooltip active={props.active} payload={props.payload as unknown as SkillPayloadItem[] | undefined} />} />
                          <Legend
                            onClick={(e: unknown) => {
                              const ev = e as { dataKey?: unknown };
                              if (typeof ev.dataKey === 'string') toggleSkill(ev.dataKey);
                            }}
                            wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }}
                            formatter={(value: string, entry: unknown) => {
                              const ent = entry as { dataKey?: unknown };
                              return <span style={{ color: hiddenSkills.has(String(ent.dataKey ?? '')) ? '#475569' : '#cbd5e1' }}>{value}</span>;
                            }}
                          />
                          {!hiddenSkills.has('grammar') && (
                            <Line type="monotone" dataKey="grammar" stroke={SKILL_COLORS.grammar} strokeWidth={1.5} dot={false} name={SKILL_LABELS.grammar} connectNulls />
                          )}
                          {!hiddenSkills.has('vocabulary') && (
                            <Line type="monotone" dataKey="vocabulary" stroke={SKILL_COLORS.vocabulary} strokeWidth={1.5} dot={false} name={SKILL_LABELS.vocabulary} connectNulls />
                          )}
                          {!hiddenSkills.has('naturalness') && (
                            <Line type="monotone" dataKey="naturalness" stroke={SKILL_COLORS.naturalness} strokeWidth={1.5} dot={false} name={SKILL_LABELS.naturalness} connectNulls />
                          )}
                          {!hiddenSkills.has('fluency') && (
                            <Line type="monotone" dataKey="fluency" stroke={SKILL_COLORS.fluency} strokeWidth={1.5} dot={false} name={SKILL_LABELS.fluency} connectNulls />
                          )}
                        </LineChart>
                      </ResponsiveContainer>
                    </>
                  )}

                  {filteredReviews.length === 1 && (
                    <p className="text-xs text-slate-500 text-center py-4">Faça mais avaliações para ver a evolução por habilidade.</p>
                  )}

                  {/* Cards de habilidades */}
                  <div className="grid grid-cols-2 gap-2">
                    {(Object.keys(SKILL_LABELS) as Array<keyof typeof SKILL_LABELS>).map(key => {
                      const capKey = (key.charAt(0).toUpperCase() + key.slice(1)) as 'Grammar' | 'Vocabulary' | 'Naturalness' | 'Fluency';
                      const curAvg = comparison[`currentAvg${capKey}`] as number;
                      const varValue = comparison[`${key}Variation`] as number | null;
                      return (
                        <div key={key} className="bg-slate-700/50 rounded-lg p-3">
                          <p className="text-xs text-slate-400">{SKILL_LABELS[key]}</p>
                          <p className={`text-xl font-bold tabular-nums mt-0.5 ${scoreColor(curAvg)}`}>{curAvg}<span className="text-xs text-slate-500">/100</span></p>
                          {varValue !== null && (
                            <p className={`text-xs mt-0.5 ${variationColor(varValue)}`}>{variationLabel(varValue)} no período</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>

                {/* ── Comparação de períodos ── */}
                {filteredReviews.length >= 2 && (
                  <section className="bg-slate-800 rounded-xl p-5 space-y-3">
                    <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Comparação de desempenho</p>
                    {comparison.isAllTime ? (
                      <>
                        <p className="text-xs text-slate-400">Evolução desde o início</p>
                        {comparison.firstHalfAvgScore !== null && comparison.secondHalfAvgScore !== null && (
                          <div className="flex gap-4">
                            <div className="flex-1 text-center bg-slate-700/50 rounded-lg p-3">
                              <p className="text-slate-500 text-xs">Primeiras avaliações</p>
                              <p className={`text-2xl font-bold tabular-nums mt-1 ${scoreColor(comparison.firstHalfAvgScore)}`}>{comparison.firstHalfAvgScore}</p>
                            </div>
                            <div className="flex-1 text-center bg-slate-700/50 rounded-lg p-3">
                              <p className="text-slate-500 text-xs">Avaliações recentes</p>
                              <p className={`text-2xl font-bold tabular-nums mt-1 ${scoreColor(comparison.secondHalfAvgScore)}`}>{comparison.secondHalfAvgScore}</p>
                            </div>
                          </div>
                        )}
                        {(comparison.firstHalfAvgScore === null || comparison.secondHalfAvgScore === null) && (
                          <p className="text-xs text-slate-500">São necessárias ao menos 4 avaliações para comparar períodos.</p>
                        )}
                      </>
                    ) : (
                      <>
                        <p className="text-xs text-slate-400">{PERIOD_LABELS[period]} vs. período anterior</p>
                        <div className="space-y-2">
                          {[
                            { label: 'Nota geral', value: comparison.scoreVariation },
                            { label: 'Gramática', value: comparison.grammarVariation },
                            { label: 'Vocabulário', value: comparison.vocabularyVariation },
                            { label: 'Naturalidade', value: comparison.naturalnessVariation },
                            { label: 'Fluência', value: comparison.fluencyVariation },
                          ].map(({ label, value }) => (
                            <div key={label} className="flex items-center justify-between">
                              <span className="text-xs text-slate-400">{label}</span>
                              <span className={`text-sm font-bold tabular-nums ${variationColor(value)}`}>{variationLabel(value)}</span>
                            </div>
                          ))}
                          {comparison.countVariation !== null && (
                            <div className="flex items-center justify-between border-t border-slate-700 pt-2">
                              <span className="text-xs text-slate-400">Atividades</span>
                              <span className={`text-sm font-bold tabular-nums ${variationColor(comparison.countVariation)}`}>{variationLabel(comparison.countVariation)}</span>
                            </div>
                          )}
                          {comparison.previousAvgScore === null && (
                            <p className="text-xs text-slate-600">Sem dados no período anterior para comparar.</p>
                          )}
                        </div>
                      </>
                    )}
                  </section>
                )}

                {/* ── Calendário de frequência ── */}
                <section className="bg-slate-800 rounded-xl p-5 space-y-3">
                  <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Frequência — últimos 35 dias</p>
                  <div className="grid grid-cols-7 gap-1">
                    {['D', 'S', 'T', 'Q', 'Q', 'S', 'S'].map((d, i) => (
                      <div key={i} className="text-center text-xs text-slate-600">{d}</div>
                    ))}
                    {activityCalendar.map((day) => (
                      <div
                        key={day.date}
                        title={`${day.date}: ${day.count} avaliação${day.count !== 1 ? 'ões' : ''}`}
                        className={`aspect-square rounded-sm transition-colors ${
                          day.count > 1 ? 'bg-blue-400' :
                          day.count === 1 ? 'bg-blue-600' :
                          'bg-slate-700'
                        }`}
                      />
                    ))}
                  </div>
                  <div className="flex gap-3 text-xs text-slate-500">
                    <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-slate-700 inline-block" /> Sem atividade</span>
                    <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-blue-600 inline-block" /> 1 avaliação</span>
                    <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-blue-400 inline-block" /> 2+</span>
                  </div>
                </section>

                {/* ── Foco recomendado ── */}
                <section className="bg-amber-900/20 border border-amber-800/30 rounded-xl p-5 space-y-3">
                  <div className="flex items-center gap-2">
                    <Target className="w-4 h-4 shrink-0 text-amber-400" strokeWidth={2} />
                    <p className="text-xs text-amber-400 font-medium uppercase tracking-wider">Foco recomendado</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-2xl font-black" style={{ color: SKILL_COLORS[focus.skill] }}>{focus.skillLabel}</div>
                    <div className={`text-lg font-bold tabular-nums ${scoreColor(focus.avgScore)}`}>{focus.avgScore}/100</div>
                    {focus.variation !== null && (
                      <div className={`text-sm font-bold ${variationColor(focus.variation)}`}>{variationLabel(focus.variation)}</div>
                    )}
                  </div>
                  <p className="text-slate-300 text-sm leading-relaxed">{focus.message}</p>
                  {focus.frequentTopics.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs text-slate-500">Tópicos frequentes nos erros:</p>
                      {focus.frequentTopics.map((t, i) => (
                        <p key={i} className="text-xs text-slate-400">• {t}</p>
                      ))}
                    </div>
                  )}
                  <button
                    onClick={() => onNavigate('dashboard')}
                    className="w-full mt-1 px-4 py-2 rounded-xl bg-amber-700/30 hover:bg-amber-700/50 border border-amber-700/40 text-amber-300 text-sm font-medium transition-colors"
                  >
                    Treinar esta habilidade
                  </button>
                </section>

                {/* ── Erros para revisar ── */}
                <section className="bg-slate-800 rounded-xl p-5 space-y-4">
                  <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Erros para revisar</p>
                  {topMistakes.length === 0 && (
                    <p className="text-xs text-slate-500">Nenhum erro registrado no período.</p>
                  )}
                  <div className="space-y-3">
                    {topMistakes.map((m, i) => (
                      <div key={i} className="space-y-1 border-b border-slate-700 last:border-0 pb-3 last:pb-0">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                            m.status === 'recurring' ? 'bg-red-900/40 text-red-400' : 'bg-slate-700 text-slate-400'
                          }`}>
                            {m.status === 'recurring' ? `Recorrente (${m.count}×)` : 'Recente'}
                          </span>
                          <span className="text-xs text-slate-500">{shortDate(m.lastSeen)}</span>
                        </div>
                        <div className="flex gap-2 text-xs">
                          <span className="text-slate-500 shrink-0">Escrito:</span>
                          <span className="text-red-400 italic">"{m.original}"</span>
                        </div>
                        <div className="flex gap-2 text-xs">
                          <span className="text-slate-500 shrink-0">Correto:</span>
                          <span className="text-green-400 italic">"{m.correct}"</span>
                        </div>
                        <p className="text-xs text-slate-400 leading-relaxed">{m.explanation}</p>
                      </div>
                    ))}
                  </div>
                  {allMistakes.length > 5 && (
                    <button
                      onClick={() => setShowAllMistakes(true)}
                      className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                    >
                      <ChevronDown className="w-3 h-3" /> Ver todos os erros ({allMistakes.length})
                    </button>
                  )}
                </section>
              </>
            )}
          </>
        )}
      </div>

      {/* ── Modal: todos os erros ── */}
      {showAllMistakes && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70" onClick={() => setShowAllMistakes(false)}>
          <div
            className="bg-slate-800 w-full sm:max-w-lg max-h-[80vh] rounded-t-2xl sm:rounded-2xl flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700">
              <p className="text-sm font-semibold text-slate-100">Todos os erros ({allMistakes.length})</p>
              <button onClick={() => setShowAllMistakes(false)} className="text-slate-400 hover:text-slate-200">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="overflow-auto p-5 space-y-3">
              {allMistakes.map((m, i) => (
                <div key={i} className="space-y-1 border-b border-slate-700 last:border-0 pb-3 last:pb-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                      m.status === 'recurring' ? 'bg-red-900/40 text-red-400' : 'bg-slate-700 text-slate-400'
                    }`}>
                      {m.status === 'recurring' ? `${m.count}×` : 'Recente'}
                    </span>
                  </div>
                  <div className="flex gap-2 text-xs">
                    <span className="text-red-400 italic">"{m.original}"</span>
                    <span className="text-slate-500">→</span>
                    <span className="text-green-400 italic">"{m.correct}"</span>
                  </div>
                  <p className="text-xs text-slate-400">{m.explanation}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
