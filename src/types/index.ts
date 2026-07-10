export type Status = 'nao-iniciado' | 'escrito' | 'corrigido' | 'revisado';
export type Difficulty = 'facil' | 'medio' | 'dificil' | null;
export type View = 'dashboard' | 'month' | 'year' | 'filters' | 'day' | 'history' | 'evolution' | 'memory';
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

export type ThemeStatus = 'generated' | 'completed' | 'skipped' | 'regenerated';

export interface EnglishDailyTheme {
  // legacy fields (maintained for backward compat)
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
  // new fields from intelligent generation
  id?: string;
  mission?: string;
  activityType?: string;
  context?: string;
  semanticSummary?: string;
  whyThisActivity?: string;
  extraChallenge?: string;
}

export interface GeneratedTheme {
  id: string;
  userId: string | null;
  title: string;
  description: string | null;
  grammarFocus: string[];
  activityType: string | null;
  context: string | null;
  semanticSummary: string | null;
  difficulty: 'easy' | 'medium' | 'hard';
  vocabulary: string[];
  createdAt: string;
  status: ThemeStatus;
}

export interface RewriteComparisonResult {
  improvementScore: number;
  fixedMistakesCount: number;
  remainingMistakesCount: number;
  fixedMistakes: { mistake: string; original: string; rewrite: string; feedback: string }[];
  remainingMistakes: { mistake: string; rewrite: string; correct: string; feedback: string }[];
  newIssues: { issue: string; rewrite: string; suggestion: string }[];
  overallFeedback: string;
  nextAction: string;
}

export interface RecurringMistake {
  original: string;
  correct: string;
  explanation: string;
  count: number;
}

export interface EnglishLearningMemory {
  id: string;
  userId: string | null;
  currentLevel: string;
  averageScore: number;
  weakestSkill: string | null;
  strongestSkill: string | null;
  recurringMistakes: RecurringMistake[];
  grammarFocus: string[];
  vocabularyLearned: VocabularyItem[];
  vocabularyToReview: VocabularyItem[];
  recommendedNextFocus: string | null;
  recommendedNextTheme: string | null;
  teacherSummary: string | null;
  totalReviews: number;
  practicedDays: number;
  currentStreak: number;
  lastReviewAt: string | null;
  updatedAt: string;
  createdAt: string;
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
