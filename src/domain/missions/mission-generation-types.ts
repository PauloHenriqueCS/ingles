import type { CEFRLevel, MissionDifficulty, MissionSupportLevel } from '../pedagogy/planner/planner-types';
import type { MissionRejectionCode } from './mission-rejection-codes';

export type WritingMissionMode =
  | 'diagnostic'
  | 'calibration'
  | 'normal'
  | 'review'
  | 'recovery'
  | 'maintenance'
  | 'checkpoint';

export interface GeneratedMissionCandidate {
  title: string;
  missionSetup: string;
  missionTask: string;
  mission: string;
  themePtBr: string;
  themeEn: string;
  format: string;
  context: string;
  conflict: string;
  objective: string;
  activityType: string;
  semanticSummary: string;
  whyThisActivity: string;
  level: CEFRLevel;
  difficulty: MissionDifficulty;
  estimatedTimeMinutes: number;
  requiredGrammar: string[];
  suggestedVocabulary: Array<{ word: string; meaningPtBr: string; example: string }>;
  useTheseWords: string[];
  instructions: string[];
  exampleSentence: string;
  successCriteria: string[];
  extraChallenge: string;
  category: string;
  grammarTips: Record<string, string>;
  responseExamples: Array<{ level: string; text: string; note?: string }>;
  // Internal fields — stripped by toPublicWritingMissionDTO
  pedagogicalPlanId?: string;
  validationPassed?: boolean;
  validationWarnings?: string[];
}

export interface MissionValidationWarning {
  code: MissionRejectionCode;
  detail: string;
  severity: 'error' | 'warning';
}

export interface MissionValidationResult {
  valid: boolean;
  rejectionCode: MissionRejectionCode | null;
  rejectionDetail: string | null;
  warnings: MissionValidationWarning[];
}

export interface MissionGenerationInput {
  userId: string;
  requestId: string;
  mode: WritingMissionMode;
  difficulty?: MissionDifficulty;
  seed: string;
  learningContext?: Record<string, unknown>;
  excludedThemeTitle?: string;
  previousThemeId?: string;
  regenerationNonce?: number;
}

export interface PublicWritingMissionDTO {
  title: string;
  missionSetup?: string;
  missionTask?: string;
  mission?: string;
  themePtBr?: string;
  themeEn?: string;
  format?: string;
  context?: string;
  conflict?: string;
  objective?: string;
  activityType?: string;
  semanticSummary?: string;
  whyThisActivity?: string;
  level?: string;
  difficulty?: string;
  estimatedTimeMinutes?: number;
  requiredGrammar?: string[];
  suggestedVocabulary?: Array<{ word: string; meaningPtBr: string; example: string }>;
  useTheseWords?: string[];
  instructions?: string[];
  exampleSentence?: string;
  successCriteria?: string[];
  extraChallenge?: string;
  category?: string;
  grammarTips?: Record<string, string>;
  responseExamples?: Array<{ level: string; text: string; note?: string }>;
  mode?: WritingMissionMode;
  supportLevel?: MissionSupportLevel;
}
