// Tipos brutos (resposta da IA, camelCase conforme JSON retornado)

import type { ListeningQuestionType, ListeningQuestionDifficulty } from '../../domain/listening/listening-types';

export interface RawGeneratedQuestion {
  questionOrder: number;
  blockOrder: number;
  questionType: string;
  prompt: string;
  options: string[];
  correctOption: number;
  explanationPt: string;
  evidenceSentenceKeys: string[];
  difficulty: string;
}

export interface RawQuestionsResponse {
  schemaVersion: string;
  episodeId: string;
  cefrLevel: string;
  questions: RawGeneratedQuestion[];
}

// Tipo validado: após validação determinística

export interface ValidatedGeneratedQuestion {
  questionOrder: 1 | 2;
  blockOrder: 1 | 2;
  questionType: ListeningQuestionType;
  prompt: string;
  options: string[];
  correctOption: number;
  explanationPt: string;
  evidenceSentenceKeys: string[];
  difficulty: ListeningQuestionDifficulty;
}

// Resultado da validação por IA

export interface QuestionAIValidationChecks {
  answerSupported: boolean;
  singleCorrectOption: boolean;
  distractorsPlausible: boolean;
  levelAppropriate: boolean;
  evidenceValid: boolean;
  noExternalKnowledge: boolean;
  notAmbiguous: boolean;
}

export interface QuestionAIValidationResult {
  schemaVersion: string;
  valid: boolean;
  confidence: number;
  checks: QuestionAIValidationChecks;
  issues: string[];
  suggestedCorrection: unknown | null;
}

// Resumo da validação de um conjunto de perguntas

export interface QuestionValidationSummary {
  questionOrder: 1 | 2;
  result: QuestionAIValidationResult;
}
