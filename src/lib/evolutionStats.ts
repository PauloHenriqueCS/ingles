import { EnglishReviewSaved, MainMistake, VocabularyItem } from '../types';
import { getTodaySP, getYesterdaySP } from './timezone';

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
    if (Math.round(diffMs / 86_400_000) === 1) {
      streak++;
    } else {
      break;
    }
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
  const cutoff = d.toISOString();
  return reviews.filter((r) => r.createdAt >= cutoff).length;
}

export function countLast30Days(reviews: EnglishReviewSaved[]): number {
  const today = getTodaySP();
  const d = new Date(today + 'T03:00:00Z');
  d.setUTCDate(d.getUTCDate() - 30);
  const cutoff = d.toISOString();
  return reviews.filter((r) => r.createdAt >= cutoff).length;
}

export function getRecommendedFocus(reviews: EnglishReviewSaved[]): string {
  if (reviews.length < 3) {
    return 'Faça mais algumas revisões para o app identificar seu foco principal.';
  }
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
      if (!seen.has(key)) {
        seen.add(key);
        result.push(m);
        if (result.length >= limit) return result;
      }
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
      if (!seen.has(key)) {
        seen.add(key);
        result.push(v);
        if (result.length >= limit) return result;
      }
    }
  }
  return result;
}
