import type { DiagnosticObjective } from './writing-diagnostic-types';

/**
 * Objetivos diagnósticos da PRIMEIRA missão.
 *
 * Foco: estruturas acessíveis, presente, opinião e explicação de motivos.
 * Permite que iniciantes respondam com frases simples
 * e que alunos avançados revelem maior capacidade espontaneamente.
 */
export const DIAGNOSTIC_MISSION_1_OBJECTIVES: readonly DiagnosticObjective[] = [
  {
    id: 'dm1_basic_sentence_control',
    type: 'basic_sentence_control',
    grammarTopicIds: ['grammar.present_simple', 'grammar.pronouns.subject', 'grammar.verb_to_be.present'],
    required: true,
    evidencePriority: 'high',
    elicitationStrategy: 'Situação cotidiana com ação concreta que exige frases simples sobre o que acontece ou o que a pessoa faz.',
    notesForGenerator: [
      'A situação deve envolver ações concretas respondíveis com frases simples.',
      'Evitar contextos que exijam vocabulário muito técnico ou abstrato.',
      'O aluno deve poder dizer "I was/I did/I think" com poucas palavras.',
    ],
    notesForValidator: [
      'A missão deve ser respondível com 3 frases simples em inglês.',
      'Verificar que não há exigência de estruturas complexas para completar a tarefa básica.',
    ],
  },
  {
    id: 'dm1_present_reference',
    type: 'present_reference',
    grammarTopicIds: ['grammar.present_simple', 'grammar.present_continuous'],
    required: true,
    evidencePriority: 'high',
    elicitationStrategy: 'Conflito ou situação que exige descrever o que está acontecendo agora ou o que o aluno faz habitualmente.',
    notesForGenerator: [
      'O setup deve incluir uma situação de rotina interrompida ou algo acontecendo no momento.',
      'Permitir uso natural de present simple para hábitos e present continuous para o momento.',
    ],
    notesForValidator: [
      'A missão deve criar espaço natural para referência ao presente.',
      'Não deve exigir exclusivamente referência ao passado ou futuro.',
    ],
  },
  {
    id: 'dm1_opinion',
    type: 'opinion',
    grammarTopicIds: ['grammar.can', 'grammar.modals.should'],
    required: true,
    evidencePriority: 'medium',
    elicitationStrategy: 'Situação com decisão ou escolha que convida naturalmente à expressão de opinião ou preferência.',
    notesForGenerator: [
      'Incluir um elemento de decisão que crie espaço para o aluno expressar o que pensa.',
      'A situação pode envolver uma escolha entre opções, uma reclamação, ou uma recomendação.',
    ],
    notesForValidator: [
      'A missão deve naturalmente convidar à expressão de opinião, preferência ou avaliação.',
      'Verificar que o aluno não é forçado a ter uma opinião específica.',
    ],
  },
  {
    id: 'dm1_reason_explanation',
    type: 'reason_explanation',
    grammarTopicIds: ['grammar.connectors.cause_contrast'],
    required: true,
    evidencePriority: 'high',
    elicitationStrategy: 'Situação que exige justificar uma decisão, explicar um problema ou dar motivo para algo que aconteceu.',
    notesForGenerator: [
      'Criar uma situação onde o aluno naturalmente precise explicar "por que" algo aconteceu.',
      'Isso elicita uso de "because", "so", "but", "since" organicamente.',
      'Exemplo: o plano mudou na última hora — por que? qual foi o impacto?',
    ],
    notesForValidator: [
      'A missão deve criar espaço natural para explicação de motivos.',
      'Verificar que a situação não pode ser respondida sem mencionar causa ou justificativa.',
    ],
  },
  {
    id: 'dm1_vocabulary_range',
    type: 'vocabulary_range',
    grammarTopicIds: [],
    required: true,
    evidencePriority: 'medium',
    elicitationStrategy: 'Contexto cotidiano familiar que permite revelar amplitude de vocabulário sem exigir léxico técnico.',
    notesForGenerator: [
      'Escolher contexto que o aluno já conhece da vida real: amigos, trabalho, compras, lazer.',
      'Evitar contextos muito especializados (medicina, direito, engenharia).',
      'O tema deve permitir que alunos de diferentes vocabulários se expressem.',
    ],
    notesForValidator: [
      'A missão deve ser acessível a um iniciante com vocabulário básico.',
      'Verificar que o contexto não exige vocabulário especializado para ser respondido.',
    ],
  },
  {
    id: 'dm1_independent_production',
    type: 'independent_production',
    grammarTopicIds: [],
    required: true,
    evidencePriority: 'high',
    elicitationStrategy: 'A situação deve ser autoexplicativa, clara e respondível sem informações externas.',
    notesForGenerator: [
      'A missão deve ser compreensível sem contexto adicional.',
      'Não criar contextos que exijam conhecimento de eventos externos, filmes específicos, etc.',
      'O aluno deve poder começar a escrever imediatamente após ler a missão.',
    ],
    notesForValidator: [
      'Verificar que a missão não depende de conhecimento externo não fornecido.',
      'A missão deve ser autocontida e clara em português.',
    ],
  },
  {
    id: 'dm1_negation',
    type: 'negation',
    grammarTopicIds: ['grammar.negation.basic'],
    required: false,
    evidencePriority: 'medium',
    elicitationStrategy: 'Situação que naturalmente convida a expressar o que não aconteceu, o que não gostou, ou o que não é possível.',
    notesForGenerator: [
      'O conflito pode envolver algo que não saiu como planejado, elicitando negação organicamente.',
    ],
    notesForValidator: [
      'A negação deve ser uma oportunidade natural, não obrigatória.',
    ],
  },
  {
    id: 'dm1_description',
    type: 'description',
    grammarTopicIds: ['grammar.present_simple', 'grammar.verb_to_be.present'],
    required: false,
    evidencePriority: 'medium',
    elicitationStrategy: 'Situação que envolva pessoa, lugar ou objeto que o aluno possa descrever como parte da narrativa.',
    notesForGenerator: [
      'A situação pode incluir alguém ou algo que seja relevante descrever, mas sem obrigar.',
    ],
    notesForValidator: [
      'Verificar que há espaço para descrição, mas que não é exigida para completar a missão.',
    ],
  },
] as const;

/**
 * Objetivos diagnósticos da SEGUNDA missão.
 *
 * Foco: passado, narração sequencial, consequência, intenção futura.
 * Complementa a missão 1 buscando evidências de referência temporal e coesão.
 */
export const DIAGNOSTIC_MISSION_2_OBJECTIVES: readonly DiagnosticObjective[] = [
  {
    id: 'dm2_past_reference',
    type: 'past_reference',
    grammarTopicIds: ['grammar.past_simple', 'grammar.past_continuous'],
    required: true,
    evidencePriority: 'high',
    elicitationStrategy: 'Setup que descreve algo que aconteceu antes da situação atual, exigindo narração no passado.',
    notesForGenerator: [
      'O missionSetup deve apresentar um evento passado como ponto de partida.',
      'A decisão ou situação deve ter ocorrido antes — o aluno narra o que aconteceu.',
      'Exemplo: "Você tomou uma decisão que parecia correta, mas depois algo inesperado aconteceu."',
    ],
    notesForValidator: [
      'A missão deve naturalmente convidar ao uso do passado.',
      'Verificar que o setup apresenta eventos anteriores para serem narrados.',
    ],
  },
  {
    id: 'dm2_narration',
    type: 'narration',
    grammarTopicIds: ['grammar.past_simple', 'grammar.adverbs.frequency'],
    required: true,
    evidencePriority: 'high',
    elicitationStrategy: 'Sequência de eventos que o aluno deve narrar em ordem: o que aconteceu, depois, então.',
    notesForGenerator: [
      'A situação deve ter múltiplos eventos encadeados.',
      'Isso elicita uso de "first", "then", "after that", "finally" organicamente.',
      'A tarefa deve pedir que o aluno conte o que aconteceu, criando sequência narrativa.',
    ],
    notesForValidator: [
      'A missão deve criar espaço natural para narração sequencial.',
      'Verificar que há mais de um evento a narrar, não apenas uma ação isolada.',
    ],
  },
  {
    id: 'dm2_future_reference',
    type: 'future_reference',
    grammarTopicIds: ['grammar.future.going_to', 'grammar.future.will'],
    required: true,
    evidencePriority: 'medium',
    elicitationStrategy: 'O conflito leva a uma decisão sobre o próximo passo, elicitando intenção ou plano futuro.',
    notesForGenerator: [
      'A missionTask deve perguntar o que o aluno pretende fazer agora ou como vai resolver a situação.',
      'Isso elicita "I\'m going to...", "I will...", "I plan to..." organicamente.',
    ],
    notesForValidator: [
      'A missão deve perguntar sobre intenção, plano ou próximo passo.',
      'Verificar que isso não é apenas um detalhe opcional, mas parte natural da tarefa.',
    ],
  },
  {
    id: 'dm2_consequence',
    type: 'reason_explanation',
    grammarTopicIds: ['grammar.connectors.cause_contrast'],
    required: true,
    evidencePriority: 'high',
    elicitationStrategy: 'A decisão passada gerou uma consequência que o aluno deve narrar e conectar causalmente.',
    notesForGenerator: [
      'A sequência causal deve estar clara: decisão → consequência → reação do aluno.',
      'Isso elicita "so", "because", "as a result", "that\'s why" organicamente.',
    ],
    notesForValidator: [
      'A missão deve ter uma cadeia de causa e consequência clara para o aluno expressar.',
    ],
  },
  {
    id: 'dm2_opinion_justification',
    type: 'opinion',
    grammarTopicIds: ['grammar.modals.should', 'grammar.connectors.cause_contrast'],
    required: true,
    evidencePriority: 'medium',
    elicitationStrategy: 'A situação convida a avaliar retrospectivamente a decisão e expressar opinião com justificativa.',
    notesForGenerator: [
      'A missionTask pode incluir: "O que você acha que deveria ter feito diferente?" ou "Foi a decisão certa?"',
      'Isso elicita opinião com razão e permite revelar uso de should/would espontaneamente.',
    ],
    notesForValidator: [
      'A missão deve criar espaço para avaliação da decisão tomada, não apenas narração de fatos.',
    ],
  },
  {
    id: 'dm2_cohesion',
    type: 'cohesion',
    grammarTopicIds: ['grammar.connectors.cause_contrast'],
    required: false,
    evidencePriority: 'medium',
    elicitationStrategy: 'Situação com múltiplos elementos que naturalmente requerem conectores para serem narrados.',
    notesForGenerator: [
      'A missão com múltiplos eventos (missão 2 por design) já cria espaço para conectores.',
      'Não é necessário forçar — a estrutura narrativa já elicita organicamente.',
    ],
    notesForValidator: [
      'A coesão é observada na resposta, não imposta pela missão.',
    ],
  },
  {
    id: 'dm2_hypothesis_stretch',
    type: 'hypothesis',
    grammarTopicIds: ['grammar.conditionals.first', 'grammar.conditionals.second'],
    required: false,
    evidencePriority: 'low',
    elicitationStrategy: 'Elemento reflexivo opcional que permite alunos avançados revelar uso de conditional espontaneamente.',
    notesForGenerator: [
      'Pode aparecer como pergunta adicional: "O que você faria diferente se pudesse?"',
      'NUNCA obrigar — é sinal de stretch para alunos acima do básico.',
      'Um iniciante pode ignorar esta parte e ainda completar a missão adequadamente.',
    ],
    notesForValidator: [
      'VERIFICAR QUE ESTE OBJETIVO É GENUINAMENTE OPCIONAL.',
      'A missão deve poder ser concluída sem responder à parte hipotética.',
    ],
  },
] as const;

/** IDs de todos os objetivos obrigatórios da missão 1 */
export const MISSION_1_REQUIRED_OBJECTIVE_IDS = DIAGNOSTIC_MISSION_1_OBJECTIVES
  .filter(o => o.required)
  .map(o => o.id);

/** IDs de todos os objetivos obrigatórios da missão 2 */
export const MISSION_2_REQUIRED_OBJECTIVE_IDS = DIAGNOSTIC_MISSION_2_OBJECTIVES
  .filter(o => o.required)
  .map(o => o.id);

/** IDs de todos os objetivos da missão 1 */
export const MISSION_1_ALL_OBJECTIVE_IDS = DIAGNOSTIC_MISSION_1_OBJECTIVES.map(o => o.id);

/** IDs de todos os objetivos da missão 2 */
export const MISSION_2_ALL_OBJECTIVE_IDS = DIAGNOSTIC_MISSION_2_OBJECTIVES.map(o => o.id);
