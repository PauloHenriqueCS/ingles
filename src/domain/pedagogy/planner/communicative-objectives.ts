import type { CEFRLevel } from '../../curriculum/cefr';

export interface CommunicativeObjective {
  readonly id: string;
  readonly levels: readonly CEFRLevel[];
  readonly functions: readonly string[];
  readonly compatibleContextFamilies: readonly string[];
  readonly compatibleGrammarTopicIds: readonly string[];
  readonly optionalGrammarTopicIds: readonly string[];
  readonly prerequisites: readonly string[];
  readonly restrictions: readonly string[];
  readonly narrativeDirectionExamples: readonly string[];
  readonly validationCriteria: readonly string[];
}

export const COMMUNICATIVE_OBJECTIVES: readonly CommunicativeObjective[] = [
  // ── A1 ────────────────────────────────────────────────────────────────────
  {
    id: 'obj.a1.personal_info_in_context',
    levels: ['A1'],
    functions: ['Apresentar informação pessoal em contexto situacional'],
    compatibleContextFamilies: ['social_interaction', 'help_someone'],
    compatibleGrammarTopicIds: [
      'grammar.verb_to_be.present',
      'grammar.pronouns.subject',
      'grammar.present_simple',
      'grammar.possessives.adjectives',
    ],
    optionalGrammarTopicIds: ['grammar.articles', 'grammar.demonstratives'],
    prerequisites: [],
    restrictions: ['avoid_generic_self_introduction'],
    narrativeDirectionExamples: [
      'Um novo colega pede informação básica numa situação real',
      'Alguém precisa explicar quem é durante um imprevisto cotidiano',
    ],
    validationCriteria: ['has_concrete_situation', 'has_real_reason_to_communicate'],
  },
  {
    id: 'obj.a1.describe_current_situation',
    levels: ['A1'],
    functions: ['Descrever uma situação atual'],
    compatibleContextFamilies: ['unexpected_consequence', 'conflict_priority', 'domestic_problem'],
    compatibleGrammarTopicIds: [
      'grammar.verb_to_be.present',
      'grammar.present_simple',
      'grammar.present_continuous',
      'grammar.there_is_are',
    ],
    optionalGrammarTopicIds: ['grammar.prepositions.place_basic', 'grammar.demonstratives'],
    prerequisites: ['grammar.pronouns.subject'],
    restrictions: [],
    narrativeDirectionExamples: [
      'Algo saiu errado e o aluno precisa explicar o que está acontecendo',
      'Uma situação inesperada exige descrição clara',
    ],
    validationCriteria: ['has_conflict_or_decision', 'has_concrete_situation'],
  },
  {
    id: 'obj.a1.simple_preference',
    levels: ['A1'],
    functions: ['Explicar uma preferência simples'],
    compatibleContextFamilies: ['difficult_choice', 'options_choice', 'social_interaction'],
    compatibleGrammarTopicIds: [
      'grammar.present_simple',
      'grammar.can',
      'grammar.negation.basic',
    ],
    optionalGrammarTopicIds: ['grammar.connectors.cause_contrast', 'grammar.adjectives.basic'],
    prerequisites: ['grammar.pronouns.subject'],
    restrictions: [],
    narrativeDirectionExamples: [
      'Aluno precisa recusar ou aceitar algo com justificativa básica',
      'Alguém pede opinião sobre opções simples',
    ],
    validationCriteria: ['has_preference_or_decision'],
  },
  {
    id: 'obj.a1.simple_decision',
    levels: ['A1'],
    functions: ['Explicar uma decisão simples'],
    compatibleContextFamilies: ['difficult_choice', 'options_choice', 'unexpected_consequence'],
    compatibleGrammarTopicIds: [
      'grammar.present_simple',
      'grammar.can',
      'grammar.connectors.cause_contrast',
    ],
    optionalGrammarTopicIds: ['grammar.future.going_to'],
    prerequisites: ['grammar.pronouns.subject'],
    restrictions: [],
    narrativeDirectionExamples: [
      'Uma situação exige que o aluno tome uma atitude e explique',
      'Uma escolha simples precisa ser comunicada',
    ],
    validationCriteria: ['has_conflict_or_decision', 'has_concrete_situation'],
  },
  {
    id: 'obj.a1.daily_routine_with_context',
    levels: ['A1'],
    functions: ['Falar de rotina quando houver situação concreta'],
    compatibleContextFamilies: ['misunderstood_message', 'plan_change', 'social_interaction'],
    compatibleGrammarTopicIds: [
      'grammar.present_simple',
      'grammar.adverbs.frequency',
      'grammar.prepositions.time_basic',
    ],
    optionalGrammarTopicIds: ['grammar.connectors.cause_contrast'],
    prerequisites: ['grammar.pronouns.subject', 'grammar.present_simple'],
    restrictions: ['requires_concrete_situation_not_generic'],
    narrativeDirectionExamples: [
      'Rotina é relevante para resolver um conflito de horário',
      'Diferença de rotina causa mal-entendido',
    ],
    validationCriteria: ['has_concrete_situation', 'routine_serves_narrative'],
  },
  {
    id: 'obj.a1.small_problem_response',
    levels: ['A1'],
    functions: ['Responder a um pequeno problema cotidiano'],
    compatibleContextFamilies: ['wrong_order', 'delay', 'domestic_problem', 'unexpected_consequence'],
    compatibleGrammarTopicIds: [
      'grammar.present_simple',
      'grammar.verb_to_be.present',
      'grammar.negation.basic',
      'grammar.can',
    ],
    optionalGrammarTopicIds: ['grammar.connectors.cause_contrast'],
    prerequisites: ['grammar.pronouns.subject'],
    restrictions: [],
    narrativeDirectionExamples: [
      'Algo deu errado e o aluno precisa comunicar o que fazer',
      'Um problema simples requer explicação e reação',
    ],
    validationCriteria: ['has_conflict_or_decision', 'has_concrete_situation'],
  },
  // ── A2 ────────────────────────────────────────────────────────────────────
  {
    id: 'obj.a2.narrate_simple_events',
    levels: ['A2'],
    functions: ['Narrar acontecimentos simples'],
    compatibleContextFamilies: ['plan_change', 'delay', 'wrong_order', 'missed_commitment'],
    compatibleGrammarTopicIds: [
      'grammar.past_simple',
      'grammar.adverbs.frequency',
      'grammar.connectors.cause_contrast',
    ],
    optionalGrammarTopicIds: ['grammar.past_continuous'],
    prerequisites: ['grammar.present_simple'],
    restrictions: [],
    narrativeDirectionExamples: [
      'Algo aconteceu e o aluno precisa contar a sequência',
      'Um evento passou e gerou uma consequência',
    ],
    validationCriteria: ['has_past_narrative', 'has_sequence_or_consequence'],
  },
  {
    id: 'obj.a2.cause_and_consequence',
    levels: ['A2'],
    functions: ['Explicar causa e consequência'],
    compatibleContextFamilies: ['unexpected_consequence', 'plan_change', 'work_problem'],
    compatibleGrammarTopicIds: [
      'grammar.past_simple',
      'grammar.connectors.cause_contrast',
      'grammar.present_simple',
    ],
    optionalGrammarTopicIds: ['grammar.future.going_to'],
    prerequisites: ['grammar.present_simple'],
    restrictions: [],
    narrativeDirectionExamples: [
      'Uma decisão levou a uma consequência inesperada',
      'Uma causa explica algo que aconteceu',
    ],
    validationCriteria: ['has_cause_effect', 'has_conflict_or_decision'],
  },
  {
    id: 'obj.a2.compare_options',
    levels: ['A2'],
    functions: ['Comparar duas opções'],
    compatibleContextFamilies: ['difficult_choice', 'options_choice'],
    compatibleGrammarTopicIds: [
      'grammar.comparatives',
      'grammar.superlatives',
      'grammar.present_simple',
    ],
    optionalGrammarTopicIds: ['grammar.connectors.cause_contrast', 'grammar.should'],
    prerequisites: ['grammar.adjectives.basic'],
    restrictions: [],
    narrativeDirectionExamples: [
      'O aluno precisa escolher entre duas alternativas reais',
      'Uma decisão envolve comparar vantagens concretas',
    ],
    validationCriteria: ['has_two_options', 'has_conflict_or_decision'],
  },
  {
    id: 'obj.a2.future_plans',
    levels: ['A2'],
    functions: ['Falar de planos'],
    compatibleContextFamilies: ['plan_change', 'unexpected_consequence', 'options_choice'],
    compatibleGrammarTopicIds: [
      'grammar.future.going_to',
      'grammar.future.will',
      'grammar.present_simple',
    ],
    optionalGrammarTopicIds: ['grammar.connectors.cause_contrast'],
    prerequisites: ['grammar.present_simple'],
    restrictions: [],
    narrativeDirectionExamples: [
      'Um plano mudou e o aluno precisa explicar o novo',
      'Uma situação força uma decisão de plano',
    ],
    validationCriteria: ['has_future_reference', 'has_concrete_situation'],
  },
  {
    id: 'obj.a2.explain_change_of_plans',
    levels: ['A2'],
    functions: ['Explicar mudança de planos'],
    compatibleContextFamilies: ['plan_change', 'missed_commitment', 'unexpected_consequence'],
    compatibleGrammarTopicIds: [
      'grammar.past_simple',
      'grammar.future.going_to',
      'grammar.connectors.cause_contrast',
    ],
    optionalGrammarTopicIds: ['grammar.past_continuous'],
    prerequisites: ['grammar.present_simple', 'grammar.past_simple'],
    restrictions: [],
    narrativeDirectionExamples: [
      'Um plano precisou mudar por algum motivo concreto',
      'Alguém cancelou algo e o aluno precisa explicar ou reagir',
    ],
    validationCriteria: ['has_past_narrative', 'has_future_reference', 'has_conflict_or_decision'],
  },
  {
    id: 'obj.a2.justify_choice',
    levels: ['A2'],
    functions: ['Justificar uma escolha'],
    compatibleContextFamilies: ['difficult_choice', 'uncomfortable_invitation', 'conflict_priority'],
    compatibleGrammarTopicIds: [
      'grammar.past_simple',
      'grammar.should',
      'grammar.connectors.cause_contrast',
    ],
    optionalGrammarTopicIds: ['grammar.comparatives'],
    prerequisites: ['grammar.present_simple'],
    restrictions: [],
    narrativeDirectionExamples: [
      'Uma decisão tomada precisa de explicação',
      'Uma escolha entre alternativas com impacto real',
    ],
    validationCriteria: ['has_justification', 'has_conflict_or_decision'],
  },
  // ── B1 ────────────────────────────────────────────────────────────────────
  {
    id: 'obj.b1.narrate_with_details',
    levels: ['B1'],
    functions: ['Narrar com mais detalhes'],
    compatibleContextFamilies: ['plan_change', 'work_problem', 'travel_problem', 'unexpected_consequence'],
    compatibleGrammarTopicIds: [
      'grammar.past_simple',
      'grammar.past_continuous',
      'grammar.connectors.sequence',
      'grammar.connectors.cause_contrast',
    ],
    optionalGrammarTopicIds: ['grammar.past_perfect', 'grammar.present_perfect'],
    prerequisites: ['grammar.past_simple'],
    restrictions: [],
    narrativeDirectionExamples: [
      'Uma situação complexa com múltiplos momentos',
      'Um evento que envolveu várias pessoas ou etapas',
    ],
    validationCriteria: ['has_sequence_or_consequence', 'has_conflict_or_decision'],
  },
  {
    id: 'obj.b1.relate_past_and_present',
    levels: ['B1'],
    functions: ['Relacionar passado e presente'],
    compatibleContextFamilies: ['unexpected_consequence', 'plan_change', 'work_problem'],
    compatibleGrammarTopicIds: [
      'grammar.present_perfect',
      'grammar.past_simple',
      'grammar.connectors.cause_contrast',
    ],
    optionalGrammarTopicIds: ['grammar.past_continuous'],
    prerequisites: ['grammar.past_simple', 'grammar.present_simple'],
    restrictions: [],
    narrativeDirectionExamples: [
      'Algo no passado ainda afeta o presente',
      'Uma experiência passada é relevante para decisão atual',
    ],
    validationCriteria: ['has_past_present_connection'],
  },
  {
    id: 'obj.b1.express_opinion_with_justification',
    levels: ['B1'],
    functions: ['Expressar opinião com justificativa'],
    compatibleContextFamilies: ['difficult_choice', 'conflict_priority', 'help_someone'],
    compatibleGrammarTopicIds: [
      'grammar.should',
      'grammar.connectors.cause_contrast',
      'grammar.modals.basic',
    ],
    optionalGrammarTopicIds: ['grammar.connectors.sequence', 'grammar.comparatives'],
    prerequisites: ['grammar.present_simple'],
    restrictions: [],
    narrativeDirectionExamples: [
      'Uma situação exige que o aluno tome posição e explique',
      'Alguém pede conselho sobre problema real',
    ],
    validationCriteria: ['has_opinion', 'has_justification'],
  },
  {
    id: 'obj.b1.simple_hypothesis',
    levels: ['B1'],
    functions: ['Lidar com hipótese simples'],
    compatibleContextFamilies: ['difficult_choice', 'unexpected_consequence', 'conflict_priority'],
    compatibleGrammarTopicIds: [
      'grammar.conditionals.first',
      'grammar.future.will',
      'grammar.connectors.cause_contrast',
    ],
    optionalGrammarTopicIds: ['grammar.conditionals.second'],
    prerequisites: ['grammar.present_simple', 'grammar.future.will'],
    restrictions: [],
    narrativeDirectionExamples: [
      'Uma decisão depende de um cenário possível',
      'Uma situação levanta a pergunta "e se...?"',
    ],
    validationCriteria: ['has_hypothetical', 'has_conflict_or_decision'],
  },
  {
    id: 'obj.b1.explain_problem_and_solution',
    levels: ['B1'],
    functions: ['Explicar problemas e soluções'],
    compatibleContextFamilies: ['work_problem', 'travel_problem', 'unexpected_consequence', 'wrong_order'],
    compatibleGrammarTopicIds: [
      'grammar.past_simple',
      'grammar.should',
      'grammar.connectors.cause_contrast',
      'grammar.modals.basic',
    ],
    optionalGrammarTopicIds: ['grammar.present_perfect', 'grammar.future.going_to'],
    prerequisites: ['grammar.past_simple'],
    restrictions: [],
    narrativeDirectionExamples: [
      'Um problema surgiu e o aluno precisa explicar e propor solução',
      'Uma situação difícil requer análise e ação',
    ],
    validationCriteria: ['has_problem', 'has_proposed_solution', 'has_conflict_or_decision'],
  },
  // ── B2 ────────────────────────────────────────────────────────────────────
  {
    id: 'obj.b2.argue',
    levels: ['B2'],
    functions: ['Argumentar'],
    compatibleContextFamilies: ['conflict_priority', 'difficult_choice', 'work_problem'],
    compatibleGrammarTopicIds: [
      'grammar.connectors.advanced',
      'grammar.modals.advanced',
      'grammar.present_perfect',
      'grammar.conditionals.second',
    ],
    optionalGrammarTopicIds: ['grammar.conditionals.third', 'grammar.passive.basic', 'grammar.hedging'],
    prerequisites: ['grammar.connectors.cause_contrast', 'grammar.modals.basic'],
    restrictions: [],
    narrativeDirectionExamples: [
      'Uma posição precisa ser defendida com evidências',
      'Uma decisão controversa precisa de argumentação sólida',
    ],
    validationCriteria: ['has_argument', 'has_counter_position'],
  },
  {
    id: 'obj.b2.complex_hypothesis',
    levels: ['B2'],
    functions: ['Discutir hipótese complexa'],
    compatibleContextFamilies: ['difficult_choice', 'unexpected_consequence', 'conflict_priority'],
    compatibleGrammarTopicIds: [
      'grammar.conditionals.second',
      'grammar.conditionals.third',
      'grammar.modals.advanced',
    ],
    optionalGrammarTopicIds: ['grammar.wish_regret', 'grammar.hedging'],
    prerequisites: ['grammar.conditionals.first', 'grammar.past_simple'],
    restrictions: [],
    narrativeDirectionExamples: [
      'Uma situação hipotética complexa com múltiplas variáveis',
      'Arrependimento ou reflexão sobre escolha passada',
    ],
    validationCriteria: ['has_hypothetical', 'has_complex_reasoning'],
  },
  {
    id: 'obj.b2.express_regret',
    levels: ['B2'],
    functions: ['Explicar arrependimento'],
    compatibleContextFamilies: ['missed_commitment', 'conflict_priority', 'work_problem'],
    compatibleGrammarTopicIds: [
      'grammar.conditionals.third',
      'grammar.wish_regret',
      'grammar.past_perfect',
    ],
    optionalGrammarTopicIds: ['grammar.modals.advanced', 'grammar.hedging'],
    prerequisites: ['grammar.past_simple', 'grammar.conditionals.first'],
    restrictions: [],
    narrativeDirectionExamples: [
      'Uma decisão passada com consequências que o aluno lamenta',
      'Uma oportunidade perdida gera reflexão',
    ],
    validationCriteria: ['has_past_narrative', 'has_regret_or_reflection'],
  },
  {
    id: 'obj.b2.defend_decision',
    levels: ['B2'],
    functions: ['Defender uma decisão'],
    compatibleContextFamilies: ['conflict_priority', 'work_problem', 'difficult_choice'],
    compatibleGrammarTopicIds: [
      'grammar.connectors.advanced',
      'grammar.modals.advanced',
      'grammar.reported_speech.basic',
    ],
    optionalGrammarTopicIds: ['grammar.passive.basic', 'grammar.hedging'],
    prerequisites: ['grammar.connectors.cause_contrast', 'grammar.modals.basic'],
    restrictions: [],
    narrativeDirectionExamples: [
      'Uma decisão contestada precisa ser defendida',
      'Uma escolha impopular exige justificativa estruturada',
    ],
    validationCriteria: ['has_argument', 'has_conflict_or_decision'],
  },
  // ── C1 ────────────────────────────────────────────────────────────────────
  {
    id: 'obj.c1.argue_with_nuance',
    levels: ['C1', 'C2'],
    functions: ['Argumentar com nuance', 'Defender posição com cautela'],
    compatibleContextFamilies: ['conflict_priority', 'work_problem', 'difficult_choice'],
    compatibleGrammarTopicIds: [
      'grammar.hedging',
      'grammar.connectors.advanced',
      'grammar.inversion',
      'grammar.cleft_sentences',
    ],
    optionalGrammarTopicIds: ['grammar.discourse_markers', 'grammar.participle_clauses'],
    prerequisites: ['grammar.connectors.advanced', 'grammar.modals.advanced'],
    restrictions: [],
    narrativeDirectionExamples: [
      'Uma questão com perspectivas válidas em ambos os lados',
      'Uma decisão que exige qualificação e matizes',
    ],
    validationCriteria: ['has_nuanced_argument', 'has_hedging_or_qualification'],
  },
  {
    id: 'obj.c1.adapt_register',
    levels: ['C1', 'C2'],
    functions: ['Adaptar registro'],
    compatibleContextFamilies: ['social_interaction', 'work_problem', 'help_someone'],
    compatibleGrammarTopicIds: [
      'grammar.discourse_markers',
      'grammar.advanced_passive',
      'grammar.hedging',
    ],
    optionalGrammarTopicIds: ['grammar.cleft_sentences', 'grammar.inversion'],
    prerequisites: ['grammar.connectors.advanced'],
    restrictions: [],
    narrativeDirectionExamples: [
      'A mesma informação precisa ser comunicada em registros diferentes',
      'Um contexto formal exige adaptação de linguagem',
    ],
    validationCriteria: ['has_register_awareness'],
  },
  {
    id: 'obj.c2.negotiate_meaning',
    levels: ['C2'],
    functions: ['Comunicar significado implícito', 'Negociar tom e intenção'],
    compatibleContextFamilies: ['social_interaction', 'work_problem', 'misunderstood_message'],
    compatibleGrammarTopicIds: [
      'grammar.discourse_markers',
      'grammar.hedging',
      'grammar.inversion',
    ],
    optionalGrammarTopicIds: ['grammar.cleft_sentences'],
    prerequisites: ['grammar.connectors.advanced', 'grammar.hedging'],
    restrictions: [],
    narrativeDirectionExamples: [
      'Uma mensagem ambígua precisa ser comunicada ou interpretada',
      'Um mal-entendido de tom ou intenção precisa ser resolvido',
    ],
    validationCriteria: ['has_implicit_meaning', 'has_conflict_or_decision'],
  },
] as const;

export function getObjectivesForLevel(level: CEFRLevel): CommunicativeObjective[] {
  return COMMUNICATIVE_OBJECTIVES.filter(obj => obj.levels.includes(level));
}

export function getObjectiveById(id: string): CommunicativeObjective | undefined {
  return COMMUNICATIVE_OBJECTIVES.find(obj => obj.id === id);
}

/** All context family identifiers used across objectives. */
export const CONTEXT_FAMILIES = [
  'plan_change',
  'misunderstood_message',
  'wrong_order',
  'delay',
  'difficult_choice',
  'uncomfortable_invitation',
  'work_problem',
  'travel_problem',
  'social_interaction',
  'missed_commitment',
  'options_choice',
  'conflict_priority',
  'unexpected_consequence',
  'domestic_problem',
  'help_someone',
  'expectation_vs_reality',
] as const;

export type ContextFamily = typeof CONTEXT_FAMILIES[number];
