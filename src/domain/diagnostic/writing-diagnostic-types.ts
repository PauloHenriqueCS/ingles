import type { CEFRLevel } from '../curriculum/cefr';

// ── Objective types ───────────────────────────────────────────────────────────

export type DiagnosticObjectiveType =
  | 'basic_sentence_control'
  | 'present_reference'
  | 'past_reference'
  | 'future_reference'
  | 'description'
  | 'narration'
  | 'reason_explanation'
  | 'comparison'
  | 'opinion'
  | 'hypothesis'
  | 'question_formation'
  | 'negation'
  | 'cohesion'
  | 'vocabulary_range'
  | 'independent_production';

export interface DiagnosticObjective {
  id: string;
  type: DiagnosticObjectiveType;
  /** IDs canônicos do catálogo gramatical (grammar.xxx) */
  grammarTopicIds: string[];
  required: boolean;
  evidencePriority: 'low' | 'medium' | 'high';
  /** Como a situação narrativa deve elicitar este objetivo. */
  elicitationStrategy: string;
  /** Nível máximo esperado para este objetivo. Undefined = qualquer nível. */
  maximumExpectedLevel?: CEFRLevel;
  /** Instruções internas para o gerador. NUNCA chegam ao usuário. */
  notesForGenerator: string[];
  /** Critérios internos para o validador. NUNCA chegam ao usuário. */
  notesForValidator: string[];
}

// ── Diagnostic plan ───────────────────────────────────────────────────────────

export interface DiagnosticContentConstraints {
  requireEverydaySituation: boolean;
  requireConflictOrDecision: boolean;
  avoidGenericSelfIntroduction: boolean;
  avoidGrammarTestLanguage: boolean;
}

export interface WritingDiagnosticMissionPlan {
  diagnosticSequence: 1 | 2;
  catalogVersion: number;
  objectives: DiagnosticObjective[];
  /** Funções comunicativas que a situação deve permitir. */
  requiredCommunicativeFunctions: string[];
  /** Sinais de produção avançada que podem aparecer espontaneamente. */
  optionalStretchSignals: string[];
  /** Instruções que nunca devem aparecer na missão pública. */
  forbiddenExplicitInstructions: string[];
  contentConstraints: DiagnosticContentConstraints;
}

// ── Generated diagnostic mission (internal, with coverage) ───────────────────

export interface InternalCoverageItem {
  objectiveId: string;
  coverageExplanation: string;
}

/**
 * Resultado da geração diagnóstica com campos internos.
 * internalCoverage NUNCA é enviado ao browser.
 */
export interface GeneratedDiagnosticMission {
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
  difficulty: 'easy' | 'medium' | 'hard';
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
  /** Mapeamento interno entre objetivos e como a missão os cobre. NUNCA ao browser. */
  internalCoverage: InternalCoverageItem[];
}

// ── Database record ───────────────────────────────────────────────────────────

export type WritingDiagnosticMissionStatus = 'generated' | 'superseded' | 'completed';

export interface DiagnosticRejectionLogEntry {
  attempt: number;
  rejectionCode: string;
  rejectionDetail: string;
  timestamp: string;
}

export interface WritingDiagnosticMissionRecord {
  id: string;
  userId: string;
  themeId: string | null;
  diagnosticSequence: 1 | 2;
  catalogVersion: number;
  diagnosticPlan: WritingDiagnosticMissionPlan;
  objectiveIds: string[];
  status: WritingDiagnosticMissionStatus;
  regenerationCount: number;
  rejectionLog: DiagnosticRejectionLogEntry[];
  promptVersion: string;
  validatorVersion: string;
  acceptedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Validation result ─────────────────────────────────────────────────────────

export interface DiagnosticValidationResult {
  valid: boolean;
  rejectionCode: string | null;
  rejectionDetail: string | null;
}
