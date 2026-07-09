import { EnglishReviewSaved } from '../types';

export interface LearningContext {
  currentLevel: string;
  averageScore: number;
  weakestSkill: 'grammar' | 'vocabulary' | 'naturalness' | 'fluency' | null;
  recentMistakes: string[];
  recentVocabulary: string[];
  lastObjectives: string[];
  lastNextPractices: string[];
}

export function buildLearningContextForTheme(reviews: EnglishReviewSaved[]): LearningContext {
  if (reviews.length === 0) {
    return {
      currentLevel: 'A1',
      averageScore: 0,
      weakestSkill: null,
      recentMistakes: [],
      recentVocabulary: [],
      lastObjectives: [],
      lastNextPractices: [],
    };
  }

  const sorted = [...reviews]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 10);

  const currentLevel = String(sorted[0].level || 'A1');
  const averageScore = Math.round(
    sorted.reduce((sum, r) => sum + (r.score || 0), 0) / sorted.length
  );

  const skillAvg = (key: 'grammar' | 'vocabulary' | 'naturalness' | 'fluency') =>
    sorted.reduce((sum, r) => sum + (r[key] || 0), 0) / sorted.length;

  const skills = ['grammar', 'vocabulary', 'naturalness', 'fluency'] as const;
  const weakest = skills
    .map((s) => ({ skill: s, avg: skillAvg(s) }))
    .reduce((min, cur) => (cur.avg < min.avg ? cur : min));

  const seenMistakes = new Set<string>();
  const recentMistakes: string[] = [];
  outer1: for (const r of sorted) {
    for (const m of r.mainMistakes ?? []) {
      const key = (m.original ?? '').trim().toLowerCase();
      if (!key || seenMistakes.has(key)) continue;
      seenMistakes.add(key);
      recentMistakes.push(m.explanation || `${m.original} → ${m.correct}`);
      if (recentMistakes.length >= 5) break outer1;
    }
  }

  const seenVocab = new Set<string>();
  const recentVocabulary: string[] = [];
  outer2: for (const r of sorted) {
    for (const v of r.newVocabulary ?? []) {
      const key = (v.word ?? '').trim().toLowerCase();
      if (!key || seenVocab.has(key)) continue;
      seenVocab.add(key);
      recentVocabulary.push(v.word);
      if (recentVocabulary.length >= 8) break outer2;
    }
  }

  const lastObjectives: string[] = [];
  for (const r of sorted) {
    const obj = r.objective?.trim();
    if (obj && !lastObjectives.includes(obj)) {
      lastObjectives.push(obj);
      if (lastObjectives.length >= 3) break;
    }
  }

  const lastNextPractices: string[] = [];
  for (const r of sorted) {
    const np = r.nextPractice?.trim();
    if (np && !lastNextPractices.includes(np)) {
      lastNextPractices.push(np);
      if (lastNextPractices.length >= 3) break;
    }
  }

  return {
    currentLevel,
    averageScore,
    weakestSkill: weakest.skill,
    recentMistakes,
    recentVocabulary,
    lastObjectives,
    lastNextPractices,
  };
}
