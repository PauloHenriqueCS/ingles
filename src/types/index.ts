export type Status = 'nao-iniciado' | 'escrito' | 'corrigido' | 'revisado';
export type Difficulty = 'facil' | 'medio' | 'dificil' | null;
export type View = 'dashboard' | 'month' | 'year' | 'filters' | 'day';

export interface GrammarFeedbackItem {
  title: string;
  explanationPt: string;
  wrongExample: string;
  correctExample: string;
}

export interface VocabularyItem {
  word: string;
  meaningPt: string;
  example: string;
}

export interface NaturalExpression {
  original: string;
  better: string;
  explanationPt: string;
}

export interface AIFeedback {
  score: number;
  cefrLevel: string;
  grammarScore: number;
  vocabularyScore: number;
  naturalnessScore: number;
  fluencyScore: number;
  correctedText: string;
  summary: string;
  grammarFeedback: GrammarFeedbackItem[];
  mainErrors: string[];
  newVocabulary: VocabularyItem[];
  naturalExpressions: NaturalExpression[];
  grammarGoalAchieved: boolean;
  rewriteChallenge: string;
}

export interface DaySchedule {
  date: string;
  theme: string;
  grammarObjective: string;
  verbTense: string;
  isWeekend: boolean;
  weekendActivity?: 'revisao' | 'descanso';
  level?: string;
  estimatedTime?: number;
}

export interface DayEntry {
  date: string;
  title: string;
  originalText: string;
  correctedText: string;
  observations: string;
  mainErrors: string;
  difficulty: Difficulty;
  status: Status;
  wordCount: number;
  updatedAt: string;
  aiReview: AIFeedback | null;
  reviewedAt: string | null;
}

export type EntriesStore = Record<string, DayEntry>;

export interface MonthStats {
  month: number;
  year: number;
  written: number;
  total: number;
  totalWords: number;
}

export interface AIStats {
  reviewedCount: number;
  avgScore: number;
  avgGrammarScore: number;
  avgVocabularyScore: number;
  avgNaturalnessScore: number;
  avgFluencyScore: number;
  latestCefrLevel: string | null;
  monthlyAvgScores: { month: number; avgScore: number; count: number }[];
}

export interface DashboardStats {
  textsThisMonth: number;
  textsThisYear: number;
  currentStreak: number;
  bestStreak: number;
  totalWords: number;
  avgWords: number;
  monthlyStats: MonthStats[];
  aiStats: AIStats;
}
