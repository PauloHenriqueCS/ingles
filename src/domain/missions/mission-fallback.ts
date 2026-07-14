import type { CEFRLevel, MissionDifficulty } from '../pedagogy/planner/planner-types';

export interface FallbackMissionTemplate {
  readonly id: string;
  readonly contextFamily: string;
  readonly title: string;
  readonly missionSetup: string;
  readonly missionTask: string;
  readonly format: string;
  readonly context: string;
  readonly conflict: string;
  readonly objective: string;
  readonly requiredGrammar: Readonly<Record<CEFRLevel, readonly string[]>>;
  readonly suggestedVocabulary: ReadonlyArray<{ word: string; meaningPtBr: string; example: string }>;
  readonly instructions: readonly string[];
  readonly successCriteria: readonly string[];
}

export const FALLBACK_TEMPLATES: readonly FallbackMissionTemplate[] = [
  {
    id: 'fallback.work_message',
    contextFamily: 'workplace_issue',
    title: 'Mensagem para o colega',
    missionSetup: 'Seu colega está com dificuldades em um projeto de trabalho e pediu sua ajuda.',
    missionTask: 'Escreva uma mensagem explicando como você resolveu um problema parecido antes.',
    format: 'mensagem',
    context: 'trabalho',
    conflict: 'precisou pedir ajuda',
    objective: 'explicar',
    requiredGrammar: {
      A1: ['present simple', 'to be'],
      A2: ['simple past', 'present simple'],
      B1: ['past simple', 'present perfect'],
      B2: ['past perfect', 'passive voice'],
      C1: ['conditional sentences', 'reported speech'],
      C2: ['complex conditionals', 'advanced discourse markers'],
    },
    suggestedVocabulary: [
      { word: 'deadline', meaningPtBr: 'prazo', example: 'The project deadline is Friday.' },
      { word: 'challenge', meaningPtBr: 'desafio', example: 'This was a real challenge.' },
      { word: 'solution', meaningPtBr: 'solução', example: 'I found a simple solution.' },
    ],
    instructions: [
      'Explain what the problem was',
      'Describe how you solved it',
      'Offer to help if needed',
    ],
    successCriteria: [
      'Clearly described the problem',
      'Explained the solution with past tense',
      'Used appropriate vocabulary',
    ],
  },
  {
    id: 'fallback.travel_email',
    contextFamily: 'travel_disruption',
    title: 'E-mail sobre o atraso',
    missionSetup: 'Você perdeu sua conexão de voo durante uma viagem importante e vai se atrasar.',
    missionTask: 'Escreva um e-mail para o seu destino explicando o atraso e seu novo plano de chegada.',
    format: 'e-mail',
    context: 'viagens',
    conflict: 'perdeu o voo',
    objective: 'explicar',
    requiredGrammar: {
      A1: ['to be', 'present simple'],
      A2: ['simple past', 'future with will'],
      B1: ['past continuous', 'future plans'],
      B2: ['passive voice', 'reported speech'],
      C1: ['advanced tenses', 'formal register'],
      C2: ['complex formal writing', 'advanced cohesion'],
    },
    suggestedVocabulary: [
      { word: 'connection', meaningPtBr: 'conexão', example: 'I missed my connection.' },
      { word: 'delay', meaningPtBr: 'atraso', example: 'There was an unexpected delay.' },
      { word: 'reschedule', meaningPtBr: 'reagendar', example: 'I need to reschedule my arrival.' },
    ],
    instructions: [
      'Explain what happened',
      'Give your new estimated arrival time',
      'Ask if any adjustments are needed',
    ],
    successCriteria: [
      'Clearly explained the situation',
      'Provided alternative plan',
      'Maintained appropriate email tone',
    ],
  },
  {
    id: 'fallback.restaurant_review',
    contextFamily: 'service_complaint',
    title: 'Review do restaurante',
    missionSetup: 'Você foi a um restaurante e o garçom trouxe o prato errado. Depois ainda tentaram cobrar pelo erro.',
    missionTask: 'Escreva um review online contando o que aconteceu e dando sua avaliação geral.',
    format: 'review',
    context: 'restaurante',
    conflict: 'recebeu o pedido errado',
    objective: 'reclamar',
    requiredGrammar: {
      A1: ['to be', 'simple past'],
      A2: ['simple past', 'adjectives'],
      B1: ['simple past', 'present perfect'],
      B2: ['passive voice', 'complex sentences'],
      C1: ['sophisticated vocabulary', 'complex discourse'],
      C2: ['advanced critical register', 'nuanced review'],
    },
    suggestedVocabulary: [
      { word: 'disappointing', meaningPtBr: 'decepcionante', example: 'The experience was disappointing.' },
      { word: 'complaint', meaningPtBr: 'reclamação', example: 'I made a complaint to the manager.' },
      { word: 'experience', meaningPtBr: 'experiência', example: 'The overall experience was poor.' },
    ],
    instructions: [
      'Describe what happened step by step',
      'Explain how it made you feel',
      'Give your overall rating',
    ],
    successCriteria: [
      'Described the incident clearly',
      'Used past tense correctly',
      'Expressed opinion appropriately',
    ],
  },
  {
    id: 'fallback.movie_recommendation',
    contextFamily: 'social_interaction',
    title: 'Recomendação de filme',
    missionSetup: 'Seu amigo quer assistir um filme esta semana mas não sabe o que escolher.',
    missionTask: 'Escreva uma mensagem recomendando um filme e explicando por que ele vai gostar.',
    format: 'mensagem',
    context: 'filmes',
    conflict: 'precisava convencer alguém',
    objective: 'recomendar',
    requiredGrammar: {
      A1: ['to be', 'like', 'adjectives'],
      A2: ['adjectives', 'connectors', 'should'],
      B1: ['present perfect', 'relative clauses'],
      B2: ['complex sentences', 'advanced vocabulary'],
      C1: ['sophisticated register', 'nuanced opinions'],
      C2: ['complex argumentation', 'advanced cohesion'],
    },
    suggestedVocabulary: [
      { word: 'plot', meaningPtBr: 'enredo', example: 'The plot is really interesting.' },
      { word: 'recommend', meaningPtBr: 'recomendar', example: 'I highly recommend this film.' },
      { word: 'performance', meaningPtBr: 'atuação', example: 'The main actor\'s performance is amazing.' },
    ],
    instructions: [
      'Name the film and its genre',
      'Describe what makes it special',
      'Explain why your friend will enjoy it',
    ],
    successCriteria: [
      'Gave clear recommendation',
      'Used descriptive vocabulary',
      'Addressed friend directly',
    ],
  },
  {
    id: 'fallback.apology_email',
    contextFamily: 'misunderstanding',
    title: 'Pedido de desculpas',
    missionSetup: 'Você cometeu um erro em um projeto do trabalho e seu colega foi diretamente prejudicado.',
    missionTask: 'Escreva um e-mail pedindo desculpas e explicando o que vai fazer para resolver a situação.',
    format: 'e-mail',
    context: 'trabalho',
    conflict: 'precisou pedir desculpas',
    objective: 'pedir desculpas',
    requiredGrammar: {
      A1: ['to be', 'simple past'],
      A2: ['simple past', 'future with will'],
      B1: ['past simple', 'conditional type 1'],
      B2: ['mixed conditionals', 'passive voice'],
      C1: ['advanced conditionals', 'complex apology register'],
      C2: ['sophisticated formal register', 'complex discourse'],
    },
    suggestedVocabulary: [
      { word: 'apologize', meaningPtBr: 'pedir desculpas', example: 'I want to apologize for the mistake.' },
      { word: 'responsibility', meaningPtBr: 'responsabilidade', example: 'I take full responsibility.' },
      { word: 'prevent', meaningPtBr: 'prevenir', example: 'I will prevent this from happening again.' },
    ],
    instructions: [
      'Acknowledge the mistake clearly and directly',
      'Explain briefly what happened',
      'Describe how you will fix it',
    ],
    successCriteria: [
      'Took responsibility clearly',
      'Proposed a concrete solution',
      'Used appropriate professional tone',
    ],
  },
  {
    id: 'fallback.tech_tutorial',
    contextFamily: 'knowledge_transfer',
    title: 'Tutorial para o colega',
    missionSetup: 'Um colega novo não sabe como usar uma ferramenta essencial do trabalho.',
    missionTask: 'Escreva um tutorial simples explicando o processo principal passo a passo.',
    format: 'tutorial',
    context: 'tecnologia',
    conflict: 'precisou ensinar alguém',
    objective: 'dar instruções',
    requiredGrammar: {
      A1: ['imperative', 'present simple'],
      A2: ['imperative', 'sequential connectors'],
      B1: ['passive voice', 'complex instructions'],
      B2: ['passive voice advanced', 'technical vocabulary'],
      C1: ['sophisticated technical writing', 'complex procedures'],
      C2: ['advanced technical register', 'expert discourse'],
    },
    suggestedVocabulary: [
      { word: 'step', meaningPtBr: 'passo', example: 'The first step is to open the app.' },
      { word: 'click', meaningPtBr: 'clicar', example: 'Click on the settings icon.' },
      { word: 'process', meaningPtBr: 'processo', example: 'This process takes about five minutes.' },
    ],
    instructions: [
      'Start with a brief overview of the tool',
      'Break the process into numbered steps',
      'Add a tip for the most common problem',
    ],
    successCriteria: [
      'Instructions are clear and sequential',
      'Used imperative correctly',
      'Covered the main steps completely',
    ],
  },
  {
    id: 'fallback.event_change',
    contextFamily: 'plan_change',
    title: 'Mudança de planos',
    missionSetup: 'Você estava organizando um evento mas surgiu um problema de última hora e precisa mudar a data.',
    missionTask: 'Escreva uma mensagem para os convidados explicando a mudança e o novo plano.',
    format: 'mensagem',
    context: 'eventos',
    conflict: 'mudou de ideia',
    objective: 'organizar um plano',
    requiredGrammar: {
      A1: ['future going to', 'present simple'],
      A2: ['future plans', 'simple past'],
      B1: ['future perfect', 'conditional type 1'],
      B2: ['mixed tenses', 'complex future'],
      C1: ['sophisticated planning language', 'advanced conditionals'],
      C2: ['complex event management discourse', 'advanced cohesion'],
    },
    suggestedVocabulary: [
      { word: 'unfortunately', meaningPtBr: 'infelizmente', example: 'Unfortunately, we need to reschedule.' },
      { word: 'alternative', meaningPtBr: 'alternativa', example: 'We have an alternative venue.' },
      { word: 'confirm', meaningPtBr: 'confirmar', example: 'Please confirm your attendance.' },
    ],
    instructions: [
      'Explain the problem briefly',
      'Give complete details of the new plan',
      'Ask guests to confirm availability',
    ],
    successCriteria: [
      'Explained the change clearly',
      'Provided all necessary new information',
      'Maintained friendly professional tone',
    ],
  },
  {
    id: 'fallback.complaint_message',
    contextFamily: 'service_complaint',
    title: 'Reclamação ao suporte',
    missionSetup: 'Você comprou um produto online, ele chegou danificado e o suporte não respondeu seus dois primeiros contatos.',
    missionTask: 'Escreva uma mensagem formal de reclamação pedindo uma solução específica.',
    format: 'e-mail',
    context: 'compras',
    conflict: 'cliente reclamou',
    objective: 'reclamar',
    requiredGrammar: {
      A1: ['simple past', 'to be'],
      A2: ['simple past', 'present perfect'],
      B1: ['present perfect', 'passive voice'],
      B2: ['passive advanced', 'formal register'],
      C1: ['sophisticated formal complaints', 'complex discourse'],
      C2: ['advanced formal register', 'complex argumentation'],
    },
    suggestedVocabulary: [
      { word: 'damaged', meaningPtBr: 'danificado', example: 'The product arrived damaged.' },
      { word: 'refund', meaningPtBr: 'reembolso', example: 'I would like a full refund.' },
      { word: 'urgent', meaningPtBr: 'urgente', example: 'This matter requires urgent attention.' },
    ],
    instructions: [
      'State the problem clearly at the start',
      'Mention the previous contact attempts',
      'Make a specific, actionable request',
    ],
    successCriteria: [
      'Described the problem clearly',
      'Made a specific and clear request',
      'Used appropriate formal tone',
    ],
  },
  {
    id: 'fallback.decision_diary',
    contextFamily: 'difficult_choice',
    title: 'Diário da decisão',
    missionSetup: 'Você recebeu duas ofertas de emprego ao mesmo tempo e precisa decidir em 24 horas.',
    missionTask: 'Escreva um diário pessoal analisando as duas opções e explicando sua decisão final.',
    format: 'diário',
    context: 'trabalho',
    conflict: 'tomou uma decisão importante',
    objective: 'justificar',
    requiredGrammar: {
      A1: ['present simple', 'adjectives'],
      A2: ['comparison adjectives', 'future with will'],
      B1: ['conditional type 2', 'complex comparison'],
      B2: ['conditional type 2 advanced', 'nuanced expression'],
      C1: ['sophisticated discourse', 'complex evaluation'],
      C2: ['advanced analytical writing', 'complex argumentation'],
    },
    suggestedVocabulary: [
      { word: 'opportunity', meaningPtBr: 'oportunidade', example: 'This is a great opportunity.' },
      { word: 'consider', meaningPtBr: 'considerar', example: 'I need to consider all options.' },
      { word: 'pros and cons', meaningPtBr: 'prós e contras', example: 'Let me list the pros and cons.' },
    ],
    instructions: [
      'Describe both options briefly',
      'List the main advantages and disadvantages of each',
      'Explain your final decision and why',
    ],
    successCriteria: [
      'Compared both options clearly',
      'Gave specific reasons for the decision',
      'Used first person naturally',
    ],
  },
  {
    id: 'fallback.feedback_message',
    contextFamily: 'feedback_exchange',
    title: 'Feedback para o colega',
    missionSetup: 'Seu colega apresentou um projeto de trabalho e pediu sua opinião honesta sobre o resultado.',
    missionTask: 'Escreva uma mensagem dando feedback construtivo sobre os pontos fortes e o que pode melhorar.',
    format: 'mensagem',
    context: 'trabalho',
    conflict: 'recebeu um elogio',
    objective: 'justificar',
    requiredGrammar: {
      A1: ['adjectives', 'present simple'],
      A2: ['adjectives', 'modal could/should'],
      B1: ['modal verbs', 'conditional type 1'],
      B2: ['advanced modals', 'complex conditionals'],
      C1: ['sophisticated diplomatic language', 'complex suggestions'],
      C2: ['advanced professional discourse', 'nuanced critique'],
    },
    suggestedVocabulary: [
      { word: 'strength', meaningPtBr: 'ponto forte', example: 'One major strength is your introduction.' },
      { word: 'improve', meaningPtBr: 'melhorar', example: 'You could improve the conclusion.' },
      { word: 'suggest', meaningPtBr: 'sugerir', example: 'I would suggest adding more examples.' },
    ],
    instructions: [
      'Start with something genuinely positive',
      'Give at least one specific suggestion for improvement',
      'End with encouragement',
    ],
    successCriteria: [
      'Identified at least one specific strength',
      'Gave actionable improvement suggestions',
      'Maintained supportive and respectful tone',
    ],
  },
];

export function getFallbackTemplate(
  templateId: string,
): FallbackMissionTemplate | undefined {
  return FALLBACK_TEMPLATES.find(t => t.id === templateId);
}

export function selectFallbackTemplate(
  level: CEFRLevel,
  difficulty: MissionDifficulty,
  previousTemplateId?: string,
): FallbackMissionTemplate {
  const candidates = previousTemplateId
    ? FALLBACK_TEMPLATES.filter(t => t.id !== previousTemplateId)
    : FALLBACK_TEMPLATES;

  const pool = candidates.length > 0 ? candidates : FALLBACK_TEMPLATES;

  const levelOrder: Record<CEFRLevel, number> = { A1: 0, A2: 1, B1: 2, B2: 3, C1: 4, C2: 5 };
  const diffOrder: Record<MissionDifficulty, number> = { easy: 0, medium: 1, hard: 2 };
  const idx = (levelOrder[level] * 3 + diffOrder[difficulty]) % pool.length;

  return pool[idx];
}

export function buildFallbackCandidate(
  template: FallbackMissionTemplate,
  level: CEFRLevel,
): Record<string, unknown> {
  const grammar = [...(template.requiredGrammar[level] ?? template.requiredGrammar.A1)];
  const mission = `${template.missionSetup} ${template.missionTask}`;

  return {
    title: template.title,
    missionSetup: template.missionSetup,
    missionTask: template.missionTask,
    mission,
    themePtBr: mission,
    themeEn: template.missionTask,
    format: template.format,
    context: template.context,
    conflict: template.conflict,
    objective: template.objective,
    activityType: template.format,
    semanticSummary: `Formato: ${template.format} | Conflito: ${template.conflict} | Objetivo: ${template.objective}`,
    whyThisActivity: 'Missão de fallback gerada deterministicamente para garantir uma experiência de aprendizagem.',
    level,
    difficulty: 'easy' as const,
    estimatedTimeMinutes: 15,
    requiredGrammar: grammar,
    suggestedVocabulary: [...template.suggestedVocabulary],
    useTheseWords: [] as string[],
    instructions: [...template.instructions],
    exampleSentence: '',
    successCriteria: [...template.successCriteria],
    extraChallenge: '',
    category: 'daily-life',
    grammarTips: {} as Record<string, string>,
    responseExamples: [] as unknown[],
  };
}
