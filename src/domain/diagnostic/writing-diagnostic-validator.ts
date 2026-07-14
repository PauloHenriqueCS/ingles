import type { WritingDiagnosticMissionPlan, DiagnosticValidationResult } from './writing-diagnostic-types';
import {
  DIAGNOSTIC_DISCLOSURE_PATTERNS,
  EXPLICIT_GRAMMAR_PATTERNS,
  GENERIC_TOPIC_PATTERNS,
} from './writing-diagnostic-rejection-codes';

// ── Versão do validador ───────────────────────────────────────────────────────

export const DIAGNOSTIC_VALIDATOR_VERSION = 'v1' as const;

// ── Tipos internos ────────────────────────────────────────────────────────────

interface MissionCandidate {
  title?: unknown;
  missionSetup?: unknown;
  missionTask?: unknown;
  mission?: unknown;
  conflict?: unknown;
  format?: unknown;
  semanticSummary?: unknown;
  internalCoverage?: unknown;
}

interface RecentThemeForDedup {
  title: string | null;
  semantic_summary: string | null;
}

// ── Validação estrutural ──────────────────────────────────────────────────────

function validateSchema(candidate: MissionCandidate): DiagnosticValidationResult {
  const title = String(candidate.title ?? '').trim();
  const setup = String(candidate.missionSetup ?? '').trim();
  const task = String(candidate.missionTask ?? '').trim();

  if (!title) {
    return { valid: false, rejectionCode: 'INVALID_RESPONSE_SCHEMA', rejectionDetail: 'title vazio' };
  }
  if (!setup) {
    return { valid: false, rejectionCode: 'INVALID_RESPONSE_SCHEMA', rejectionDetail: 'missionSetup vazio' };
  }
  if (!task) {
    return { valid: false, rejectionCode: 'INVALID_RESPONSE_SCHEMA', rejectionDetail: 'missionTask vazio' };
  }
  if (title.length > 120) {
    return { valid: false, rejectionCode: 'INVALID_RESPONSE_SCHEMA', rejectionDetail: 'title excede 120 caracteres' };
  }
  if (setup.length > 600) {
    return { valid: false, rejectionCode: 'INVALID_RESPONSE_SCHEMA', rejectionDetail: 'missionSetup excede 600 caracteres' };
  }

  return { valid: true, rejectionCode: null, rejectionDetail: null };
}

// ── Verificações determinísticas ──────────────────────────────────────────────

function checkDiagnosticDisclosure(text: string): DiagnosticValidationResult {
  for (const pattern of DIAGNOSTIC_DISCLOSURE_PATTERNS) {
    if (pattern.test(text)) {
      return {
        valid: false,
        rejectionCode: 'DIAGNOSTIC_DISCLOSED',
        rejectionDetail: `Padrão detectado: ${pattern.source}`,
      };
    }
  }
  return { valid: true, rejectionCode: null, rejectionDetail: null };
}

function checkExplicitGrammarInstruction(text: string): DiagnosticValidationResult {
  for (const pattern of EXPLICIT_GRAMMAR_PATTERNS) {
    if (pattern.test(text)) {
      return {
        valid: false,
        rejectionCode: 'EXPLICIT_GRAMMAR_REQUEST',
        rejectionDetail: `Instrução explícita detectada: ${pattern.source}`,
      };
    }
  }
  return { valid: true, rejectionCode: null, rejectionDetail: null };
}

function checkGenericTopic(missionSetup: string, missionTask: string): DiagnosticValidationResult {
  const combined = `${missionSetup} ${missionTask}`;
  for (const pattern of GENERIC_TOPIC_PATTERNS) {
    if (pattern.test(combined)) {
      return {
        valid: false,
        rejectionCode: 'GENERIC_TOPIC',
        rejectionDetail: `Padrão genérico detectado: ${pattern.source}`,
      };
    }
  }
  return { valid: true, rejectionCode: null, rejectionDetail: null };
}

function checkConflictOrDecision(
  missionSetup: string,
  conflict: string,
  semanticSummary: string,
): DiagnosticValidationResult {
  const hasConflict = Boolean(conflict && conflict.trim() && conflict !== '—');
  const hasConflictSignal =
    /\b(mudou|cancelou|atrasou|perdeu|errou|esqueceu|reclamou|recusou|imprevisto|inesperado|problema|decidiu|decisão|escolheu|conflito|dificuldade|consequência)\b/i.test(
      missionSetup + semanticSummary
    );

  if (!hasConflict && !hasConflictSignal) {
    return {
      valid: false,
      rejectionCode: 'NO_CONFLICT_OR_DECISION',
      rejectionDetail: 'Ausência de conflito, decisão, imprevisto ou consequência detectável',
    };
  }
  return { valid: true, rejectionCode: null, rejectionDetail: null };
}

function checkConcreteSituation(missionSetup: string): DiagnosticValidationResult {
  if (missionSetup.length < 30) {
    return {
      valid: false,
      rejectionCode: 'NO_CONCRETE_SITUATION',
      rejectionDetail: 'missionSetup muito curto para conter situação concreta',
    };
  }

  const hasConcreteness =
    /\b(você|seu|sua|amigo|colega|cliente|chefe|gerente|produto|pedido|reunião|viagem|plano|compra|mensagem|encontrou|recebeu|precisou|chegou|saiu|voltou)\b/i.test(
      missionSetup
    );

  if (!hasConcreteness) {
    return {
      valid: false,
      rejectionCode: 'NO_CONCRETE_SITUATION',
      rejectionDetail: 'missionSetup parece abstrato demais — ausência de personagem, ação ou contexto concreto',
    };
  }
  return { valid: true, rejectionCode: null, rejectionDetail: null };
}

// ── Verificação de cobertura de objetivos ─────────────────────────────────────

function checkObjectiveCoverage(
  plan: WritingDiagnosticMissionPlan,
  internalCoverage: unknown,
): DiagnosticValidationResult {
  if (!Array.isArray(internalCoverage)) {
    return {
      valid: false,
      rejectionCode: 'INSUFFICIENT_OBJECTIVE_COVERAGE',
      rejectionDetail: 'internalCoverage ausente ou não é array',
    };
  }

  const coveredIds = new Set(
    (internalCoverage as Array<{ objectiveId?: unknown }>)
      .map(item => String(item.objectiveId ?? ''))
      .filter(Boolean)
  );

  const requiredObjectives = plan.objectives.filter(o => o.required);
  const missingRequired = requiredObjectives.filter(o => !coveredIds.has(o.id));

  if (missingRequired.length > 0) {
    return {
      valid: false,
      rejectionCode: 'INSUFFICIENT_OBJECTIVE_COVERAGE',
      rejectionDetail: `Objetivos obrigatórios não cobertos: ${missingRequired.map(o => o.id).join(', ')}`,
    };
  }
  return { valid: true, rejectionCode: null, rejectionDetail: null };
}

// ── Verificação de duplicação semântica ───────────────────────────────────────

function jaccardSimilarity(a: string, b: string): number {
  const stopwords = new Set([
    'de', 'a', 'o', 'que', 'e', 'do', 'da', 'em', 'um', 'para', 'com',
    'os', 'no', 'se', 'na', 'por', 'mais', 'as', 'dos', 'como', 'sua',
    'seu', 'sobre', 'você', 'voce', 'precisa', 'deve', 'pode',
  ]);
  const tokenize = (s: string): Set<string> => {
    const words = s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopwords.has(w));
    return new Set(words);
  };
  const setA = tokenize(a);
  const setB = tokenize(b);
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

function checkSemanticDuplication(
  candidate: MissionCandidate,
  recentThemes: RecentThemeForDedup[],
  threshold = 0.38,
): DiagnosticValidationResult {
  const candidateText = [
    String(candidate.title ?? ''),
    String(candidate.missionSetup ?? ''),
    String(candidate.semanticSummary ?? ''),
  ]
    .filter(Boolean)
    .join(' ');

  for (const t of recentThemes.slice(0, 15)) {
    const existingText = [t.title ?? '', t.semantic_summary ?? ''].filter(Boolean).join(' ');
    if (existingText.length < 10) continue;

    const similarity = jaccardSimilarity(candidateText, existingText);
    if (similarity > threshold) {
      return {
        valid: false,
        rejectionCode: 'SEMANTIC_DUPLICATION',
        rejectionDetail: `Similaridade Jaccard ${similarity.toFixed(2)} > ${threshold} com tema recente: "${t.title}"`,
      };
    }
  }
  return { valid: true, rejectionCode: null, rejectionDetail: null };
}

// ── Validador principal ───────────────────────────────────────────────────────

/**
 * Valida uma missão diagnóstica gerada pela IA.
 *
 * Combina validações determinísticas. Não chama a IA para validar.
 * Segue a ordem: schema → segurança pedagógica → situação → conteúdo → cobertura → deduplicação.
 */
export function validateDiagnosticMission(
  plan: WritingDiagnosticMissionPlan,
  candidate: MissionCandidate,
  recentThemes: RecentThemeForDedup[],
): DiagnosticValidationResult {
  // 1. Schema
  const schemaResult = validateSchema(candidate);
  if (!schemaResult.valid) return schemaResult;

  const missionSetup = String(candidate.missionSetup ?? '');
  const missionTask = String(candidate.missionTask ?? '');
  const publicText = `${missionSetup} ${missionTask}`;

  // 2. Não revela diagnóstico
  const disclosureResult = checkDiagnosticDisclosure(publicText);
  if (!disclosureResult.valid) return disclosureResult;

  // 3. Não cita gramática explicitamente
  const grammarResult = checkExplicitGrammarInstruction(publicText);
  if (!grammarResult.valid) return grammarResult;

  // 4. Não é tema genérico isolado
  const genericResult = checkGenericTopic(missionSetup, missionTask);
  if (!genericResult.valid) return genericResult;

  // 5. Contém situação concreta
  const concreteResult = checkConcreteSituation(missionSetup);
  if (!concreteResult.valid) return concreteResult;

  // 6. Contém conflito, decisão ou imprevisto
  const conflictResult = checkConflictOrDecision(
    missionSetup,
    String(candidate.conflict ?? ''),
    String(candidate.semanticSummary ?? ''),
  );
  if (!conflictResult.valid) return conflictResult;

  // 7. Cobre objetivos mínimos obrigatórios
  const coverageResult = checkObjectiveCoverage(plan, candidate.internalCoverage);
  if (!coverageResult.valid) return coverageResult;

  // 8. Não é semanticamente duplicado
  const dedupResult = checkSemanticDuplication(candidate, recentThemes);
  if (!dedupResult.valid) return dedupResult;

  return { valid: true, rejectionCode: null, rejectionDetail: null };
}
