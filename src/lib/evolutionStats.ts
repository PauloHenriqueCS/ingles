import { EnglishReviewSaved, MainMistake, VocabularyItem, CefrLevel } from '../types';
import { getTodaySP, getYesterdaySP } from './timezone';

// ── Types ─────────────────────────────────────────────────────────────────────

export type Period = '7d' | '30d' | '3m' | 'all';

export interface ChartDataPoint {
  date: string;
  shortDate: string;
  score: number;
  grammar: number | null;
  vocabulary: number | null;
  naturalness: number | null;
  fluency: number | null;
  level: CefrLevel;
  missionTitle: string | null;
  movingAvg: number | null;
}

export interface PeriodComparison {
  currentAvgScore: number;
  previousAvgScore: number | null;
  scoreVariation: number | null;
  currentAvgGrammar: number;
  previousAvgGrammar: number | null;
  grammarVariation: number | null;
  currentAvgVocabulary: number;
  previousAvgVocabulary: number | null;
  vocabularyVariation: number | null;
  currentAvgNaturalness: number;
  previousAvgNaturalness: number | null;
  naturalnessVariation: number | null;
  currentAvgFluency: number;
  previousAvgFluency: number | null;
  fluencyVariation: number | null;
  currentCount: number;
  previousCount: number | null;
  countVariation: number | null;
  isAllTime: boolean;
  firstHalfAvgScore: number | null;
  secondHalfAvgScore: number | null;
}

export interface DayActivity {
  date: string;
  count: number;
}

export interface RecurringMistakeData {
  original: string;
  correct: string;
  explanation: string;
  count: number;
  lastSeen: string;
  status: 'recurring' | 'recent';
}

export interface RecommendedFocusData {
  skill: 'grammar' | 'vocabulary' | 'naturalness' | 'fluency';
  skillLabel: string;
  avgScore: number;
  variation: number | null;
  message: string;
  frequentTopics: string[];
  navigateTo: 'dashboard';
}

// ── Legacy helpers (mantidos para compatibilidade) ────────────────────────────

export function calculateAverage(nums: number[]): number {
  if (nums.length === 0) return 0;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

export function getUniquePracticeDays(reviews: EnglishReviewSaved[]): string[] {
  const days = new Set(reviews.map((r) => r.createdAt.slice(0, 10)));
  return Array.from(days).sort();
}

export function calculateCurrentStreak(reviews: EnglishReviewSaved[]): number {
  const days = getUniquePracticeDays(reviews);
  if (days.length === 0) return 0;
  const today = getTodaySP();
  const yesterday = getYesterdaySP();
  const latest = days[days.length - 1];
  if (latest !== today && latest !== yesterday) return 0;
  let streak = 1;
  for (let i = days.length - 2; i >= 0; i--) {
    const diffMs = new Date(days[i + 1]).getTime() - new Date(days[i]).getTime();
    if (Math.round(diffMs / 86_400_000) === 1) streak++;
    else break;
  }
  return streak;
}

export function getRecentReviews(reviews: EnglishReviewSaved[], n: number): EnglishReviewSaved[] {
  const asc = [...reviews].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return asc.slice(-n);
}

export function countLast7Days(reviews: EnglishReviewSaved[]): number {
  const today = getTodaySP();
  const d = new Date(today + 'T03:00:00Z');
  d.setUTCDate(d.getUTCDate() - 7);
  return reviews.filter((r) => r.createdAt >= d.toISOString()).length;
}

export function countLast30Days(reviews: EnglishReviewSaved[]): number {
  const today = getTodaySP();
  const d = new Date(today + 'T03:00:00Z');
  d.setUTCDate(d.getUTCDate() - 30);
  return reviews.filter((r) => r.createdAt >= d.toISOString()).length;
}

export function getRecommendedFocus(reviews: EnglishReviewSaved[]): string {
  if (reviews.length < 3) return 'Faça mais algumas revisões para o app identificar seu foco principal.';
  const g = calculateAverage(reviews.map((r) => r.grammar));
  const v = calculateAverage(reviews.map((r) => r.vocabulary));
  const n = calculateAverage(reviews.map((r) => r.naturalness));
  const f = calculateAverage(reviews.map((r) => r.fluency));
  const min = Math.min(g, v, n, f);
  if (min === g) return 'Seu foco agora deve ser gramática. Treine principalmente tempos verbais, ordem das palavras e construção de frases.';
  if (min === v) return 'Seu foco agora deve ser vocabulário. Tente usar palavras novas e expressões mais naturais nos próximos textos.';
  if (min === n) return 'Seu foco agora deve ser naturalidade. Tente escrever frases mais parecidas com a forma como nativos falariam.';
  return 'Seu foco agora deve ser fluência. Tente escrever textos um pouco mais longos e conectados.';
}

export function getRecentMistakes(reviews: EnglishReviewSaved[], limit = 5): MainMistake[] {
  const seen = new Set<string>();
  const result: MainMistake[] = [];
  const desc = [...reviews].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const r of desc) {
    for (const m of r.mainMistakes) {
      const key = m.original.trim().toLowerCase();
      if (!seen.has(key)) { seen.add(key); result.push(m); if (result.length >= limit) return result; }
    }
  }
  return result;
}

export function getRecentVocabulary(reviews: EnglishReviewSaved[], limit = 10): VocabularyItem[] {
  const seen = new Set<string>();
  const result: VocabularyItem[] = [];
  const desc = [...reviews].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const r of desc) {
    for (const v of r.newVocabulary) {
      const key = v.word.trim().toLowerCase();
      if (!seen.has(key)) { seen.add(key); result.push(v); if (result.length >= limit) return result; }
    }
  }
  return result;
}

// ── Período ───────────────────────────────────────────────────────────────────

export function filterByPeriod(reviews: EnglishReviewSaved[], period: Period): EnglishReviewSaved[] {
  if (period === 'all') return reviews;
  const now = new Date();
  const cutoff = new Date(now);
  if (period === '7d') cutoff.setDate(now.getDate() - 7);
  else if (period === '30d') cutoff.setDate(now.getDate() - 30);
  else if (period === '3m') cutoff.setMonth(now.getMonth() - 3);
  return reviews.filter((r) => new Date(r.createdAt) >= cutoff);
}

export function getPreviousPeriodReviews(reviews: EnglishReviewSaved[], period: Period): EnglishReviewSaved[] {
  if (period === 'all') return [];
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);
  if (period === '7d') { start.setDate(now.getDate() - 14); end.setDate(now.getDate() - 7); }
  else if (period === '30d') { start.setDate(now.getDate() - 60); end.setDate(now.getDate() - 30); }
  else { start.setMonth(now.getMonth() - 6); end.setMonth(now.getMonth() - 3); }
  return reviews.filter((r) => {
    const d = new Date(r.createdAt);
    return d >= start && d < end;
  });
}

// ── Gráfico ───────────────────────────────────────────────────────────────────

function shortDateLabel(iso: string): string {
  try {
    const d = new Date(iso);
    return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  } catch { return ''; }
}

function buildMovingAverages(scores: number[]): (number | null)[] {
  const window = scores.length > 7 ? 5 : scores.length;
  return scores.map((_, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = scores.slice(start, i + 1);
    return Math.round(slice.reduce((a, b) => a + b, 0) / slice.length);
  });
}

export function buildChartData(reviews: EnglishReviewSaved[]): ChartDataPoint[] {
  const asc = [...reviews].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const scores = asc.map((r) => r.score);
  const movingAvgs = asc.length >= 2 ? buildMovingAverages(scores) : scores.map(() => null);
  return asc.map((r, i) => ({
    date: r.createdAt,
    shortDate: shortDateLabel(r.createdAt),
    score: r.score,
    grammar: typeof r.grammar === 'number' ? r.grammar : null,
    vocabulary: typeof r.vocabulary === 'number' ? r.vocabulary : null,
    naturalness: typeof r.naturalness === 'number' ? r.naturalness : null,
    fluency: typeof r.fluency === 'number' ? r.fluency : null,
    level: r.level,
    missionTitle: r.missionSnapshot?.missionTitle ?? null,
    movingAvg: movingAvgs[i],
  }));
}

// ── Nível estimado ────────────────────────────────────────────────────────────

const CEFR_ORDER: CefrLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

function cefrToNum(level: CefrLevel): number {
  return CEFR_ORDER.indexOf(level);
}

function numToCefr(n: number): CefrLevel {
  return CEFR_ORDER[Math.max(0, Math.min(5, Math.round(n)))];
}

export function estimateCurrentLevel(reviews: EnglishReviewSaved[]): CefrLevel {
  if (reviews.length === 0) return 'A1';
  const recent = [...reviews]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.min(10, reviews.length));
  const nums = recent.map((r) => cefrToNum(r.level));
  nums.sort((a, b) => a - b);
  const mid = Math.floor(nums.length / 2);
  const median = nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid];
  return numToCefr(median);
}

// ── Comparação de períodos ────────────────────────────────────────────────────

function avgOf(reviews: EnglishReviewSaved[], key: 'score' | 'grammar' | 'vocabulary' | 'naturalness' | 'fluency'): number {
  if (reviews.length === 0) return 0;
  return Math.round(reviews.reduce((s, r) => s + r[key], 0) / reviews.length);
}

function variation(cur: number, prev: number | null): number | null {
  if (prev === null) return null;
  return cur - prev;
}

export function buildPeriodComparison(reviews: EnglishReviewSaved[], period: Period): PeriodComparison {
  const current = filterByPeriod(reviews, period);
  const previous = period === 'all' ? [] : getPreviousPeriodReviews(reviews, period);
  const prevOrNull = (v: number) => previous.length > 0 ? v : null;

  const cScore = avgOf(current, 'score');
  const pScore = previous.length > 0 ? avgOf(previous, 'score') : null;

  // Para 'all': comparar primeira metade vs segunda metade
  let firstHalf: number | null = null;
  let secondHalf: number | null = null;
  if (period === 'all' && reviews.length >= 4) {
    const asc = [...reviews].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const half = Math.floor(asc.length / 2);
    firstHalf = avgOf(asc.slice(0, half), 'score');
    secondHalf = avgOf(asc.slice(half), 'score');
  }

  return {
    currentAvgScore: cScore,
    previousAvgScore: pScore,
    scoreVariation: variation(cScore, pScore),
    currentAvgGrammar: avgOf(current, 'grammar'),
    previousAvgGrammar: prevOrNull(avgOf(previous, 'grammar')),
    grammarVariation: variation(avgOf(current, 'grammar'), prevOrNull(avgOf(previous, 'grammar'))),
    currentAvgVocabulary: avgOf(current, 'vocabulary'),
    previousAvgVocabulary: prevOrNull(avgOf(previous, 'vocabulary')),
    vocabularyVariation: variation(avgOf(current, 'vocabulary'), prevOrNull(avgOf(previous, 'vocabulary'))),
    currentAvgNaturalness: avgOf(current, 'naturalness'),
    previousAvgNaturalness: prevOrNull(avgOf(previous, 'naturalness')),
    naturalnessVariation: variation(avgOf(current, 'naturalness'), prevOrNull(avgOf(previous, 'naturalness'))),
    currentAvgFluency: avgOf(current, 'fluency'),
    previousAvgFluency: prevOrNull(avgOf(previous, 'fluency')),
    fluencyVariation: variation(avgOf(current, 'fluency'), prevOrNull(avgOf(previous, 'fluency'))),
    currentCount: current.length,
    previousCount: previous.length > 0 ? previous.length : null,
    countVariation: previous.length > 0 ? current.length - previous.length : null,
    isAllTime: period === 'all',
    firstHalfAvgScore: firstHalf,
    secondHalfAvgScore: secondHalf,
  };
}

// ── Calendário de atividade ───────────────────────────────────────────────────

export function buildActivityCalendar(reviews: EnglishReviewSaved[]): DayActivity[] {
  const countByDay = new Map<string, number>();
  for (const r of reviews) {
    const day = r.createdAt.slice(0, 10);
    countByDay.set(day, (countByDay.get(day) ?? 0) + 1);
  }
  const result: DayActivity[] = [];
  for (let i = 34; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    result.push({ date: dateStr, count: countByDay.get(dateStr) ?? 0 });
  }
  return result;
}

// ── Erros recorrentes ─────────────────────────────────────────────────────────

export function buildRecurringMistakes(reviews: EnglishReviewSaved[], limit: number): RecurringMistakeData[] {
  const map = new Map<string, RecurringMistakeData>();
  const desc = [...reviews].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const r of desc) {
    for (const m of r.mainMistakes) {
      const key = m.original.trim().toLowerCase();
      if (map.has(key)) {
        const existing = map.get(key)!;
        existing.count++;
        if (r.createdAt > existing.lastSeen) existing.lastSeen = r.createdAt;
        existing.status = 'recurring';
      } else {
        map.set(key, {
          original: m.original,
          correct: m.correct,
          explanation: m.explanation,
          count: 1,
          lastSeen: r.createdAt,
          status: 'recent',
        });
      }
    }
  }
  return Array.from(map.values())
    .sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen))
    .slice(0, limit);
}

export function buildAllMistakes(reviews: EnglishReviewSaved[]): RecurringMistakeData[] {
  return buildRecurringMistakes(reviews, 999);
}

// ── Foco recomendado ─────────────────────────────────────────────────────────

export function buildRecommendedFocus(
  current: EnglishReviewSaved[],
  previous: EnglishReviewSaved[],
): RecommendedFocusData {
  if (current.length === 0) {
    return {
      skill: 'grammar',
      skillLabel: 'Gramática',
      avgScore: 0,
      variation: null,
      message: 'Faça mais algumas revisões para identificar seu foco principal.',
      frequentTopics: [],
      navigateTo: 'dashboard',
    };
  }

  const skills: Array<{ key: 'grammar' | 'vocabulary' | 'naturalness' | 'fluency'; label: string }> = [
    { key: 'grammar', label: 'Gramática' },
    { key: 'vocabulary', label: 'Vocabulário' },
    { key: 'naturalness', label: 'Naturalidade' },
    { key: 'fluency', label: 'Fluência' },
  ];

  const scores = skills.map(({ key }) => ({
    key,
    label: skills.find(s => s.key === key)!.label,
    avg: avgOf(current, key),
    prevAvg: previous.length > 0 ? avgOf(previous, key) : null,
  }));

  // Pondera: menor média tem mais peso; queda adiciona penalidade
  const ranked = scores.map(s => ({
    ...s,
    score: s.avg - (s.prevAvg !== null && s.avg < s.prevAvg ? 10 : 0),
  })).sort((a, b) => a.score - b.score);

  const worst = ranked[0];
  const variation = worst.prevAvg !== null ? worst.avg - worst.prevAvg : null;

  const mistakes = buildRecurringMistakes(current, 20);
  const frequentTopics = mistakes.slice(0, 3).map(m => m.explanation.split('.')[0]).filter(Boolean);

  let message = `Seu foco agora deve ser ${worst.label.toLowerCase()} — média de ${worst.avg}/100 no período.`;
  if (variation !== null) {
    if (variation < -3) message += ` Caiu ${Math.abs(variation)} pontos em relação ao período anterior.`;
    else if (variation > 3) message += ` Subiu ${variation} pontos, mas ainda é o ponto mais fraco.`;
    else message += ` Pouca evolução no período.`;
  }

  return {
    skill: worst.key,
    skillLabel: worst.label,
    avgScore: worst.avg,
    variation,
    message,
    frequentTopics,
    navigateTo: 'dashboard',
  };
}
