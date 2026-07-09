import { supabase } from './supabase';
import { EnglishReviewSaved, EnglishLearningMemory, RecurringMistake, VocabularyItem } from '../types';
import { fetchEnglishReviews } from './reviewsHistory';
import { getUniquePracticeDays, calculateCurrentStreak } from './evolutionStats';

// ── Row mapper ────────────────────────────────────────────────────────────────

function rowToMemory(row: Record<string, unknown>): EnglishLearningMemory {
  return {
    id: String(row.id ?? ''),
    userId: row.user_id != null ? String(row.user_id) : null,
    currentLevel: String(row.current_level ?? 'A1'),
    averageScore: Number(row.average_score ?? 0),
    weakestSkill: row.weakest_skill != null ? String(row.weakest_skill) : null,
    strongestSkill: row.strongest_skill != null ? String(row.strongest_skill) : null,
    recurringMistakes: Array.isArray(row.recurring_mistakes) ? (row.recurring_mistakes as RecurringMistake[]) : [],
    grammarFocus: Array.isArray(row.grammar_focus) ? (row.grammar_focus as string[]) : [],
    vocabularyLearned: Array.isArray(row.vocabulary_learned) ? (row.vocabulary_learned as VocabularyItem[]) : [],
    vocabularyToReview: Array.isArray(row.vocabulary_to_review) ? (row.vocabulary_to_review as VocabularyItem[]) : [],
    recommendedNextFocus: row.recommended_next_focus != null ? String(row.recommended_next_focus) : null,
    recommendedNextTheme: row.recommended_next_theme != null ? String(row.recommended_next_theme) : null,
    teacherSummary: row.teacher_summary != null ? String(row.teacher_summary) : null,
    totalReviews: Number(row.total_reviews ?? 0),
    practicedDays: Number(row.practiced_days ?? 0),
    currentStreak: Number(row.current_streak ?? 0),
    lastReviewAt: row.last_review_at != null ? String(row.last_review_at) : null,
    updatedAt: String(row.updated_at ?? ''),
    createdAt: String(row.created_at ?? ''),
  };
}

// ── Grammar topic extraction ──────────────────────────────────────────────────

function extractGrammarFocus(reviews: EnglishReviewSaved[]): string[] {
  const topics = new Set<string>();
  for (const r of reviews) {
    for (const m of r.mainMistakes ?? []) {
      const text = `${m.explanation} ${m.original} ${m.correct}`.toLowerCase();
      if (/passado|past tense|simple past|went|yesterday|was |were /.test(text)) topics.add('Simple Past');
      if (/preposição|preposition|in\/on|on the|in the|at the/.test(text)) topics.add('Prepositions');
      if (/artigo|article|\ba\/an\b|use the|use a\b/.test(text)) topics.add('Articles');
      if (/word order|ordem das palavras/.test(text)) topics.add('Word Order');
      if (/plural|plurais/.test(text)) topics.add('Plural');
      if (/sentence structure|estrutura da frase/.test(text)) topics.add('Sentence Structure');
      if (/continuous|is doing|is going|estar fazendo/.test(text)) topics.add('Present Continuous');
      if (/\bwill\b|future|futuro/.test(text)) topics.add('Future');
      if (/comparativ|more.*than|er than/.test(text)) topics.add('Comparatives');
    }
  }
  return Array.from(topics).slice(0, 5);
}

// ── Local text generators ─────────────────────────────────────────────────────

const skillPtBr: Record<string, string> = {
  grammar: 'gramática',
  vocabulary: 'vocabulário',
  naturalness: 'naturalidade',
  fluency: 'fluência',
};

function generateRecommendedNextFocus(weakest: string | null): string {
  if (!weakest) return 'Faça mais algumas revisões para o app identificar seu foco principal.';
  const map: Record<string, string> = {
    grammar: 'Seu foco principal agora deve ser gramática, especialmente construção de frases e uso correto dos tempos verbais.',
    vocabulary: 'Seu foco principal agora deve ser vocabulário. Tente usar palavras novas e expressões mais naturais nos próximos textos.',
    naturalness: 'Seu foco principal agora deve ser naturalidade. Tente escrever frases menos traduzidas do português e mais parecidas com inglês real.',
    fluency: 'Seu foco principal agora deve ser fluência. Tente escrever textos um pouco mais longos, conectando melhor as ideias.',
  };
  return map[weakest] ?? map.grammar;
}

function generateRecommendedNextTheme(weakest: string | null, grammarFocus: string[]): string {
  if (!weakest) return 'Escreva sobre sua rotina de hoje em pelo menos 4 frases.';
  if (weakest === 'grammar') {
    if (grammarFocus.includes('Simple Past')) return 'Escreva sobre algo que aconteceu ontem usando simple past.';
    if (grammarFocus.includes('Prepositions')) return 'Descreva um lugar que você conhece bem usando preposições de lugar.';
    return 'Escreva 5 frases sobre seu dia usando tempos verbais corretos.';
  }
  if (weakest === 'vocabulary') return 'Escreva sobre seu dia usando pelo menos 5 palavras novas.';
  if (weakest === 'naturalness') return 'Reescreva sua rotina matinal usando frases curtas e naturais em inglês.';
  return 'Conte uma pequena história com começo, meio e fim em pelo menos 8 frases.';
}

function generateTeacherSummary(weakest: string | null, strongest: string | null, score: number): string {
  const w = weakest ? (skillPtBr[weakest] ?? weakest) : null;
  const s = strongest ? (skillPtBr[strongest] ?? strongest) : null;
  if (!w || score === 0) return 'Faça mais algumas revisões para o app conhecer melhor seu perfil.';
  if (score >= 75) {
    return s
      ? `Você está indo bem! Seu ponto forte é ${s}. Continue praticando ${w} para evoluir ainda mais.`
      : 'Você está indo bem! Continue praticando para consolidar seu progresso.';
  }
  if (score >= 50) {
    return s
      ? `Você está evoluindo. Seu ponto forte é ${s}, mas precisa reforçar ${w} nos próximos treinos.`
      : `Você está evoluindo, mas ainda precisa reforçar ${w} nos próximos treinos.`;
  }
  return `Você está começando. O foco principal agora é ${w} — com prática regular você vai melhorar rapidamente.`;
}

// ── Core builder ──────────────────────────────────────────────────────────────

export function buildLearningMemoryFromReviews(
  reviews: EnglishReviewSaved[]
): Omit<EnglishLearningMemory, 'id' | 'createdAt' | 'updatedAt'> {
  if (reviews.length === 0) {
    return {
      userId: null,
      currentLevel: 'A1',
      averageScore: 0,
      weakestSkill: null,
      strongestSkill: null,
      recurringMistakes: [],
      grammarFocus: [],
      vocabularyLearned: [],
      vocabularyToReview: [],
      recommendedNextFocus: 'Faça mais algumas revisões para o app identificar seu foco principal.',
      recommendedNextTheme: 'Escreva sobre sua rotina de hoje em pelo menos 4 frases.',
      teacherSummary: 'Faça mais algumas revisões para o app conhecer melhor seu perfil.',
      totalReviews: 0,
      practicedDays: 0,
      currentStreak: 0,
      lastReviewAt: null,
    };
  }

  const sorted = [...reviews].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const currentLevel = String(sorted[0].level || 'A1');
  const averageScore = Math.round(sorted.reduce((s, r) => s + (r.score || 0), 0) / sorted.length);

  const skillAvg = (key: 'grammar' | 'vocabulary' | 'naturalness' | 'fluency') =>
    sorted.reduce((s, r) => s + (r[key] || 0), 0) / sorted.length;

  const skills = ['grammar', 'vocabulary', 'naturalness', 'fluency'] as const;
  const skillValues = skills.map((sk) => ({ skill: sk, avg: skillAvg(sk) }));
  const weakest = skillValues.reduce((min, cur) => (cur.avg < min.avg ? cur : min));
  const strongest = skillValues.reduce((max, cur) => (cur.avg > max.avg ? cur : max));

  // Recurring mistakes: count duplicates by original+correct, sort by frequency
  const mistakeMap = new Map<string, RecurringMistake>();
  for (const r of sorted) {
    for (const m of r.mainMistakes ?? []) {
      const key = `${(m.original ?? '').trim().toLowerCase()}||${(m.correct ?? '').trim().toLowerCase()}`;
      if (!key || key === '||') continue;
      if (mistakeMap.has(key)) {
        mistakeMap.get(key)!.count++;
      } else {
        mistakeMap.set(key, { original: m.original, correct: m.correct, explanation: m.explanation, count: 1 });
      }
    }
  }
  const recurringMistakes = Array.from(mistakeMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const grammarFocus = extractGrammarFocus(sorted);

  // Vocabulary learned: unique by word, up to 20 most recent
  const seenVocab = new Set<string>();
  const vocabularyLearned: VocabularyItem[] = [];
  outer: for (const r of sorted) {
    for (const v of r.newVocabulary ?? []) {
      const key = (v.word ?? '').trim().toLowerCase();
      if (!key || seenVocab.has(key)) continue;
      seenVocab.add(key);
      vocabularyLearned.push({ word: v.word, meaningPtBr: v.meaningPtBr, example: v.example });
      if (vocabularyLearned.length >= 20) break outer;
    }
  }

  const vocabularyToReview = vocabularyLearned.slice(0, 10);

  const recommendedNextFocus = generateRecommendedNextFocus(weakest.skill);
  const recommendedNextTheme = generateRecommendedNextTheme(weakest.skill, grammarFocus);
  const teacherSummary = generateTeacherSummary(weakest.skill, strongest.skill, averageScore);

  return {
    userId: null,
    currentLevel,
    averageScore,
    weakestSkill: weakest.skill,
    strongestSkill: strongest.skill,
    recurringMistakes,
    grammarFocus,
    vocabularyLearned,
    vocabularyToReview,
    recommendedNextFocus,
    recommendedNextTheme,
    teacherSummary,
    totalReviews: reviews.length,
    practicedDays: getUniquePracticeDays(reviews).length,
    currentStreak: calculateCurrentStreak(reviews),
    lastReviewAt: sorted[0]?.createdAt ?? null,
  };
}

// ── Supabase operations ───────────────────────────────────────────────────────

export async function fetchLearningMemory(): Promise<EnglishLearningMemory | null> {
  try {
    const { data: { user } } = await supabase.auth.getUser();

    let query = supabase
      .from('english_learning_memory')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(1);

    if (user) {
      query = query.eq('user_id', user.id);
    } else {
      query = query.is('user_id', null);
    }

    const { data, error } = await query;
    if (error || !data || data.length === 0) return null;
    return rowToMemory(data[0] as Record<string, unknown>);
  } catch {
    return null;
  }
}

export async function updateLearningMemory(): Promise<EnglishLearningMemory> {
  const { data: { user } } = await supabase.auth.getUser();
  const reviews = await fetchEnglishReviews(50);
  const memory = buildLearningMemoryFromReviews(reviews);

  const existing = await fetchLearningMemory();

  const dbPayload = {
    current_level: memory.currentLevel,
    average_score: memory.averageScore,
    weakest_skill: memory.weakestSkill,
    strongest_skill: memory.strongestSkill,
    recurring_mistakes: memory.recurringMistakes,
    grammar_focus: memory.grammarFocus,
    vocabulary_learned: memory.vocabularyLearned,
    vocabulary_to_review: memory.vocabularyToReview,
    recommended_next_focus: memory.recommendedNextFocus,
    recommended_next_theme: memory.recommendedNextTheme,
    teacher_summary: memory.teacherSummary,
    total_reviews: memory.totalReviews,
    practiced_days: memory.practicedDays,
    current_streak: memory.currentStreak,
    last_review_at: memory.lastReviewAt,
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    const { data, error } = await supabase
      .from('english_learning_memory')
      .update(dbPayload)
      .eq('id', existing.id)
      .select();

    if (error) throw new Error(error.message);
    return rowToMemory((data?.[0] ?? {}) as Record<string, unknown>);
  } else {
    const { data, error } = await supabase
      .from('english_learning_memory')
      .insert([{ user_id: user?.id ?? null, ...dbPayload }])
      .select();

    if (error) throw new Error(error.message);
    return rowToMemory((data?.[0] ?? {}) as Record<string, unknown>);
  }
}
