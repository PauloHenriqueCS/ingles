export type Status = 'nao-iniciado' | 'escrito' | 'corrigido' | 'revisado';
export type Difficulty = 'facil' | 'medio' | 'dificil' | null;
export type View = 'dashboard' | 'month' | 'year' | 'filters' | 'day';

export interface VocabularyItem {
  word: string;
  meaning: string;
  example: string;
}

export interface AIFeedback {
  overallScore: number;
  estimatedLevel: string;
  grammarGoalMet: boolean;
  scores: {
    grammar: number;
    vocabulary: number;
    naturalness: number;
    fluency: number;
  };
  correctedText: string;
  mainErrors: string[];
  errorExplanations: string;
  newVocabulary: VocabularyItem[];
  nativeSuggestion: string;
  teacherSummary: string;
  optionalChallenge: string;
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
}

export type EntriesStore = Record<string, DayEntry>;

export interface MonthStats {
  month: number;
  year: number;
  written: number;
  total: number;
  totalWords: number;
}

export interface DashboardStats {
  textsThisMonth: number;
  textsThisYear: number;
  currentStreak: number;
  bestStreak: number;
  totalWords: number;
  avgWords: number;
  monthlyStats: MonthStats[];
}
