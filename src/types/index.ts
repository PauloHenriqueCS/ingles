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

export type RequiredWordEvaluationStatus =
  | 'correct'
  | 'incorrect_spelling'
  | 'incorrect_usage'
  | 'missing'
  | 'forced_usage';

export interface RequiredWordEvaluation {
  requiredWord: string;
  status: RequiredWordEvaluationStatus;
  usedExcerpt: string | null;
  explanation: string;
  suggestedCorrection: string | null;
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
  requiredWordEvaluation?: RequiredWordEvaluation[];
}

export interface MissionSnapshot {
  missionTitle: string;
  missionSetup: string | null;
  missionTask: string | null;
  missionPromptPt: string | null;
  missionPromptEn: string | null;
  missionConflict: string | null;
  missionGoal: string | null;
  missionInstructions: string[];
  missionGrammarTopics: string[];
  missionUsefulVocabulary: VocabularyItem[];
  missionRequiredWords: string[];
  missionExampleAnswers: ResponseExample[];
  missionCompletionCriteria: string[];
  missionExtraChallenge: string | null;
  missionDifficulty: 'easy' | 'medium' | 'hard' | null;
  missionLevel: CefrLevel | null;
  missionFormat: string | null;
  missionContext: string | null;
  missionGeneratedAt: string;
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
  entryDate: string | null;
  missionSnapshot: MissionSnapshot | null;
  version2Text: string | null;
  version2Comparison: RewriteComparisonResult | null;
  version2ImprovementScore: number | null;
}

export interface DaySchedule {
  date: string;
  theme: string;
  grammarObjective: string;
  verbTense: string;
  isWeekend: boolean;
  isPracticeDay: boolean;
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

export interface ResponseExample {
  level: string;
  text: string;
  note?: string;
}

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
  missionSetup?: string;
  missionTask?: string;
  format?: string;
  conflict?: string;
  activityType?: string;
  context?: string;
  semanticSummary?: string;
  whyThisActivity?: string;
  extraChallenge?: string;
  grammarTips?: Record<string, string>;
  responseExamples?: ResponseExample[];
  // review mode fields
  mode?: 'normal' | 'review';
  reviewGroupId?: string;
  requiredWords?: string[];
  pedagogicalReason?: string;
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

export interface ReviewGroupItem {
  id: string;
  reviewGroupId: string;
  originalValue: string;
  correctedValue: string;
  explanation: string | null;
  originalSentence: string | null;
  createdAt: string;
}

export interface ReviewGroup {
  id: string;
  userId: string;
  sourceReviewId: string;
  sourceEntryDate: string | null;
  originalTheme: string | null;
  status: 'scheduled' | 'active' | 'mastered';
  reviewLevel: number;
  nextReviewAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface PendingReviewGroup {
  group: ReviewGroup;
  items: ReviewGroupItem[];
}

export interface ReviewScheduleResult {
  applied?: boolean;
  skipped?: boolean;
  reason?: string;
  newLevel?: number;
  newStatus?: 'scheduled' | 'mastered';
  intervalDays?: number | null;
  overallResult?: 'passed' | 'failed';
}

export type RequiredWordStatus = 'found' | 'missing';

export interface RequiredWordValidation {
  word: string;
  status: RequiredWordStatus;
}

export interface ValidationResult {
  words: RequiredWordValidation[];
  allFound: boolean;
  missingWords: string[];
}

export type PronunciationAssessmentStatus = 'processing' | 'completed' | 'failed_retryable' | 'failed_final';

export interface PronunciationAssessment {
  id: string;
  userId: string;
  textVersionId: string;
  status: PronunciationAssessmentStatus;
  referenceText: string;
  languageCode: string;
  azureRegion: string;
  pronunciationScore: number | null;
  accuracyScore: number | null;
  fluencyScore: number | null;
  completenessScore: number | null;
  prosodyScore: number | null;
  recognizedText: string | null;
  wordsJson: unknown | null;
  rawResultJson: unknown | null;
  audioPath: string | null;
  audioDurationSeconds: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PronunciationStatusResponse {
  status: PronunciationAssessmentStatus | 'available';
  canAnalyze: boolean;
  assessmentId: string | null;
}
