export type Status = 'nao-iniciado' | 'escrito' | 'corrigido' | 'revisado';
export type Difficulty = 'facil' | 'medio' | 'dificil' | null;
export type View = 'dashboard' | 'month' | 'year' | 'filters' | 'day' | 'history' | 'evolution';
export type CefrLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';

export interface MainMistake {
  original: string;
  correct: string;
  explanation: string;
}

export interface VocabularyItem {
  word: string;
  meaningPtBr: string;
  example: string;
}

export interface AIFeedback {
  score: number;
  level: CefrLevel;
  grammar: number;
  vocabulary: number;
  naturalness: number;
  fluency: number;
  summary: string;
  correctedText: string;
  mainMistakes: MainMistake[];
  newVocabulary: VocabularyItem[];
  objectiveFeedback: string;
  nextPractice: string;
}

export interface EnglishReviewSaved {
  id: string;
  originalText: string;
  correctedText: string | null;
  score: number;
  level: CefrLevel;
  grammar: number;
  vocabulary: number;
  naturalness: number;
  fluency: number;
  summary: string | null;
  mainMistakes: MainMistake[];
  newVocabulary: VocabularyItem[];
  objectiveFeedback: string | null;
  nextPractice: string | null;
  category: string | null;
  difficulty: string | null;
  objective: string | null;
  createdAt: string;
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
  avgGrammar: number;
  avgVocabulary: number;
  avgNaturalness: number;
  avgFluency: number;
  latestLevel: string | null;
  monthlyAvgScores: { month: number; avgScore: number; count: number }[];
}

export interface EnglishDailyTheme {
  title: string;
  themePtBr: string;
  themeEn: string;
  objective: string;
  level: CefrLevel;
  estimatedTimeMinutes: number;
  instructions: string[];
  requiredGrammar: string[];
  suggestedVocabulary: VocabularyItem[];
  useTheseWords: string[];
  exampleSentence: string;
  successCriteria: string[];
  difficulty: 'easy' | 'medium' | 'hard';
  category: string;
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
