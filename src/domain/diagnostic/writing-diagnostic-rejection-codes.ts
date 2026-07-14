/**
 * Códigos estáveis de rejeição de missões diagnósticas.
 *
 * Usados em testes, observabilidade e rejection_log no banco.
 * NUNCA expostos ao usuário final.
 */
export type DiagnosticMissionRejectionCode =
  | 'GENERIC_TOPIC'                   // Tema genérico demais (fale sobre você, descreva sua rotina)
  | 'NO_CONCRETE_SITUATION'           // Ausência de situação concreta
  | 'NO_CONFLICT_OR_DECISION'         // Ausência de conflito, decisão, imprevisto ou consequência
  | 'DIAGNOSTIC_DISCLOSED'            // A missão revela que há um diagnóstico em andamento
  | 'EXPLICIT_GRAMMAR_REQUEST'        // Cita explicitamente tempos verbais ou estruturas gramaticais
  | 'ADVANCED_STRUCTURE_REQUIRED'     // Exige gramática incompatível com iniciante (present perfect, etc.)
  | 'INSUFFICIENT_OBJECTIVE_COVERAGE' // Não cobre os objetivos diagnósticos mínimos obrigatórios
  | 'SEMANTIC_DUPLICATION'            // Semanticamente igual ou muito próximo de tema recente
  | 'INVALID_RESPONSE_SCHEMA'         // JSON inválido ou campos obrigatórios ausentes
  | 'UNSAFE_CONTENT';                 // Conteúdo inadequado, ofensivo ou inapropriado

export const DIAGNOSTIC_REJECTION_CODES: Record<DiagnosticMissionRejectionCode, string> = {
  GENERIC_TOPIC: 'Tema genérico demais para diagnóstico',
  NO_CONCRETE_SITUATION: 'Ausência de situação concreta',
  NO_CONFLICT_OR_DECISION: 'Ausência de conflito, decisão, imprevisto ou consequência',
  DIAGNOSTIC_DISCLOSED: 'Missão revela o diagnóstico ao usuário',
  EXPLICIT_GRAMMAR_REQUEST: 'Instrução explícita de tempo verbal ou estrutura gramatical',
  ADVANCED_STRUCTURE_REQUIRED: 'Exige gramática avançada incompatível com iniciante',
  INSUFFICIENT_OBJECTIVE_COVERAGE: 'Objetivos diagnósticos mínimos não cobertos',
  SEMANTIC_DUPLICATION: 'Muito similar a tema recente do histórico',
  INVALID_RESPONSE_SCHEMA: 'Resposta da IA inválida ou incompleta',
  UNSAFE_CONTENT: 'Conteúdo inadequado ou inapropriado',
};

/**
 * Padrões que indicam divulgação do diagnóstico ao usuário.
 * Se qualquer um destes aparecer na missão pública, ela é rejeitada.
 */
export const DIAGNOSTIC_DISCLOSURE_PATTERNS: RegExp[] = [
  /\bnível\b.*\b(A1|A2|B1|B2|C1|C2)\b/i,
  /\b(A1|A2|B1|B2|C1|C2)\b.*\bnível\b/i,
  /\bCEFR\b/i,
  /\bdiagnóstic[oa]\b/i,
  /\bavalia[çc][aã]o\b/i,
  /\bteste de inglês\b/i,
  /\bmedindo seu nível\b/i,
  /\bclassificação\b/i,
  /\bpontuação\b/i,
];

/**
 * Padrões que indicam instrução explícita de gramática.
 * Incluem nomes de tempos verbais e estruturas.
 */
export const EXPLICIT_GRAMMAR_PATTERNS: RegExp[] = [
  /\bpresent perfect\b/i,
  /\bpast perfect\b/i,
  /\bpast continuous\b/i,
  /\bpresent continuous\b/i,
  /\bfuture perfect\b/i,
  /\bconditional\b/i,
  /\bpassive voice\b/i,
  /\breported speech\b/i,
  /\bsubjunctive\b/i,
  /\bgerund\b/i,
  /\binfinitive\b/i,
  /\btempos verbais\b/i,
  /\buse o (present|past|future|simple|perfect|continuous)\b/i,
  /\butilize.*tempo verbal\b/i,
  /\bvoz passiva\b/i,
  /\buse pelo menos .* tempo/i,
  /\bcondicional\b/i,
];

/**
 * Padrões de temas genéricos que devem ser rejeitados quando isolados.
 */
export const GENERIC_TOPIC_PATTERNS: RegExp[] = [
  /^(escreva|conte|descreva|fale)\s+(sobre\s+)?(você|sua?\s+rotina|sua?\s+família|sua?\s+vida|suas?\s+preferências|seu\s+dia)/i,
  /\bapresente[- ]se\b/i,
  /\bfale sobre você\b/i,
  /\bse apresent/i,
];
