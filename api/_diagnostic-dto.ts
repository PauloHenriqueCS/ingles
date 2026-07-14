/**
 * SERVER-ONLY: DTOs para o sistema de diagnóstico de escrita.
 *
 * Garante que campos internos (plano diagnóstico, objetivos, cobertura)
 * nunca cheguem ao browser mesmo que o objeto interno seja grande.
 */

// ── Campos internos que NUNCA devem ir ao browser ─────────────────────────────

const INTERNAL_FIELDS: ReadonlySet<string> = new Set([
  'diagnosticPlan',
  'diagnostic_plan',
  'objectiveIds',
  'objective_ids',
  'internalCoverage',
  'internal_coverage',
  'rejectionLog',
  'rejection_log',
  'coverageExplanation',
  'coverage_explanation',
  'diagnosticSequence',    // Exposto apenas como dado de debug admin, não ao aluno
  'promptVersion',
  'prompt_version',
  'validatorVersion',
  'validator_version',
  'maximumExpectedLevel',
  'notesForGenerator',
  'notesForValidator',
  'elicitationStrategy',
  'evidencePriority',
]);

// ── DTO público da missão ─────────────────────────────────────────────────────

export interface PublicMissionDTO {
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
  mode?: 'normal' | 'review';
}

/**
 * Converte uma missão interna (com campos diagnósticos) para o DTO público.
 *
 * Remove TODOS os campos internos antes de retornar ao cliente.
 * Esta função é a única barreira entre os dados internos e o browser.
 */
export function toPublicMissionDTO(internalMission: Record<string, unknown>): PublicMissionDTO {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(internalMission)) {
    if (!INTERNAL_FIELDS.has(key)) {
      result[key] = value;
    }
  }

  return result as PublicMissionDTO;
}

/**
 * Verifica se o objeto público de missão contém algum campo interno.
 * Usado em testes para garantir que o DTO está correto.
 */
export function containsInternalFields(publicDTO: Record<string, unknown>): boolean {
  return Object.keys(publicDTO).some(key => INTERNAL_FIELDS.has(key));
}

/**
 * Lista os campos internos encontrados em um objeto (para debug/testes).
 */
export function findInternalFieldsIn(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).filter(key => INTERNAL_FIELDS.has(key));
}
