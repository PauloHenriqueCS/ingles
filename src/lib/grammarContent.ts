export interface GrammarExample {
  english: string;
  portuguese: string;
}

export interface GrammarMistake {
  wrong: string;
  correct: string;
  explanationPt: string;
}

export interface GrammarStructure {
  affirmative: string;
  negative: string;
  question: string;
}

export interface GrammarContent {
  name: string;
  summaryPt: string;
  whenToUse: string[];
  structure: GrammarStructure;
  examples: GrammarExample[];
  commonMistakes: GrammarMistake[];
}

const DB: Record<string, GrammarContent> = {
  'present simple': {
    name: 'Present Simple',
    summaryPt: 'Usado para fatos, hábitos e rotinas. É o tempo verbal mais básico do inglês.',
    whenToUse: [
      'Hábitos e rotinas ("I go to the gym every day.")',
      'Fatos e verdades gerais ("Water boils at 100°C.")',
      'Sentimentos e estados permanentes ("I love coffee.")',
      'Programações fixas no futuro ("The train leaves at 8.")',
    ],
    structure: {
      affirmative: 'Subject + verb (+ s/es para he/she/it)',
      negative: 'Subject + do/does not + verb base',
      question: 'Do/Does + subject + verb base?',
    },
    examples: [
      { english: 'I work from home every day.', portuguese: 'Eu trabalho em casa todos os dias.' },
      { english: 'She doesn\'t eat meat.', portuguese: 'Ela não come carne.' },
      { english: 'Do you speak English?', portuguese: 'Você fala inglês?' },
    ],
    commonMistakes: [
      {
        wrong: 'She work in São Paulo.',
        correct: 'She works in São Paulo.',
        explanationPt: 'Com he/she/it, o verbo recebe -s ou -es.',
      },
      {
        wrong: 'He don\'t like coffee.',
        correct: 'He doesn\'t like coffee.',
        explanationPt: 'Com he/she/it, use "doesn\'t" na negativa.',
      },
    ],
  },

  'present continuous': {
    name: 'Present Continuous',
    summaryPt: 'Descreve ações em progresso agora ou planos já confirmados para o futuro próximo.',
    whenToUse: [
      'O que está acontecendo neste momento ("I\'m reading.")',
      'Ações temporárias ("She\'s working from London this week.")',
      'Planos futuros já combinados ("We\'re meeting tomorrow at 3.")',
      'Mudanças e tendências ("Prices are rising.")',
    ],
    structure: {
      affirmative: 'Subject + am/is/are + verb-ing',
      negative: 'Subject + am/is/are + not + verb-ing',
      question: 'Am/Is/Are + subject + verb-ing?',
    },
    examples: [
      { english: 'I\'m working on a new project.', portuguese: 'Estou trabalhando em um novo projeto.' },
      { english: 'They aren\'t coming tonight.', portuguese: 'Eles não estão vindo hoje à noite.' },
      { english: 'Are you listening?', portuguese: 'Você está ouvindo?' },
    ],
    commonMistakes: [
      {
        wrong: 'I am knowing the answer.',
        correct: 'I know the answer.',
        explanationPt: 'Verbos de estado (know, believe, want, love) não usam -ing. Use o Present Simple.',
      },
    ],
  },

  'simple past': {
    name: 'Simple Past',
    summaryPt: 'Para ações concluídas em um momento específico do passado.',
    whenToUse: [
      'Ações finalizadas no passado ("I visited Paris in 2022.")',
      'Sequências de eventos passados ("She arrived, sat down, and opened her laptop.")',
      'Hábitos do passado (junto com "used to")',
      'Histórias e narrativas',
    ],
    structure: {
      affirmative: 'Subject + verb (past form / -ed)',
      negative: 'Subject + did not + verb base',
      question: 'Did + subject + verb base?',
    },
    examples: [
      { english: 'I sent the email this morning.', portuguese: 'Eu enviei o e-mail esta manhã.' },
      { english: 'She didn\'t finish the report.', portuguese: 'Ela não terminou o relatório.' },
      { english: 'Did you see that movie?', portuguese: 'Você viu aquele filme?' },
    ],
    commonMistakes: [
      {
        wrong: 'I goed to the market.',
        correct: 'I went to the market.',
        explanationPt: '"Go" é um verbo irregular: go → went. Aprenda as formas irregulares principais.',
      },
      {
        wrong: 'Did you went there?',
        correct: 'Did you go there?',
        explanationPt: 'Depois de "did", use sempre o verbo na forma base.',
      },
    ],
  },

  'past continuous': {
    name: 'Past Continuous',
    summaryPt: 'Descreve uma ação em progresso em um momento específico do passado, ou uma ação interrompida por outra.',
    whenToUse: [
      'Ação em andamento quando outra aconteceu ("I was cooking when she called.")',
      'Duas ações simultâneas no passado ("He was reading while she was sleeping.")',
      'Descrever o cenário de uma história',
    ],
    structure: {
      affirmative: 'Subject + was/were + verb-ing',
      negative: 'Subject + was/were + not + verb-ing',
      question: 'Was/Were + subject + verb-ing?',
    },
    examples: [
      { english: 'I was writing the report when the power went out.', portuguese: 'Eu estava escrevendo o relatório quando a luz acabou.' },
      { english: 'They were talking about the project all morning.', portuguese: 'Eles estavam falando sobre o projeto a manhã toda.' },
    ],
    commonMistakes: [
      {
        wrong: 'I was understand everything.',
        correct: 'I understood everything.',
        explanationPt: '"Understand" é um verbo de estado e não usa a forma -ing.',
      },
    ],
  },

  'present perfect': {
    name: 'Present Perfect',
    summaryPt: 'Conecta uma ação passada ao presente. O momento exato não importa — o resultado ou experiência é o foco.',
    whenToUse: [
      'Experiências de vida ("I have visited 10 countries.")',
      'Mudanças ao longo do tempo ("My English has improved a lot.")',
      'Ações recentes com efeito no presente ("I\'ve just finished the report.")',
      'Ações que começaram no passado e continuam ("I\'ve worked here for 5 years.")',
    ],
    structure: {
      affirmative: 'Subject + have/has + past participle',
      negative: 'Subject + have not / has not + past participle',
      question: 'Have/Has + subject + past participle?',
    },
    examples: [
      { english: 'I have changed a lot in recent years.', portuguese: 'Eu mudei muito nos últimos anos.' },
      { english: 'She hasn\'t replied to my email yet.', portuguese: 'Ela ainda não respondeu meu e-mail.' },
      { english: 'Have you ever worked abroad?', portuguese: 'Você já trabalhou no exterior?' },
    ],
    commonMistakes: [
      {
        wrong: 'I have gone to London in 2022.',
        correct: 'I went to London in 2022.',
        explanationPt: 'Com uma data ou momento específico no passado, use o Simple Past.',
      },
      {
        wrong: 'She has ate the pizza.',
        correct: 'She has eaten the pizza.',
        explanationPt: 'Use o past participle correto. "Eat" → eaten (não "ate").',
      },
    ],
  },

  'present perfect continuous': {
    name: 'Present Perfect Continuous',
    summaryPt: 'Enfatiza a duração de uma ação que começou no passado e ainda continua (ou acabou de terminar).',
    whenToUse: [
      'Ação que durou muito e ainda está em andamento ("I\'ve been waiting for 2 hours.")',
      'Ação recente que deixou resultado visível ("I\'ve been running — I\'m exhausted.")',
      'Progresso de algo em desenvolvimento ("She\'s been learning Spanish.")',
    ],
    structure: {
      affirmative: 'Subject + have/has + been + verb-ing',
      negative: 'Subject + have/has + not + been + verb-ing',
      question: 'Have/Has + subject + been + verb-ing?',
    },
    examples: [
      { english: 'I\'ve been working on this project for weeks.', portuguese: 'Eu tenho trabalhado neste projeto por semanas.' },
      { english: 'She hasn\'t been sleeping well lately.', portuguese: 'Ela não tem dormido bem ultimamente.' },
    ],
    commonMistakes: [
      {
        wrong: 'I have been know him for years.',
        correct: 'I have known him for years.',
        explanationPt: 'Verbos de estado (know, believe, own) não usam -ing. Use o Present Perfect simples.',
      },
    ],
  },

  'past perfect': {
    name: 'Past Perfect',
    summaryPt: 'O "passado do passado". Usado para mostrar que uma ação aconteceu ANTES de outra ação passada.',
    whenToUse: [
      'Para deixar claro qual ação veio primeiro ("I had already eaten when she arrived.")',
      'Em histórias para explicar o contexto antes de um evento',
      'Depois de "before", "after", "when", "by the time"',
    ],
    structure: {
      affirmative: 'Subject + had + past participle',
      negative: 'Subject + had not + past participle',
      question: 'Had + subject + past participle?',
    },
    examples: [
      { english: 'When I arrived, the meeting had already started.', portuguese: 'Quando cheguei, a reunião já tinha começado.' },
      { english: 'She had never seen snow before moving to Canada.', portuguese: 'Ela nunca tinha visto neve antes de se mudar para o Canadá.' },
    ],
    commonMistakes: [
      {
        wrong: 'When I arrived, the meeting already started.',
        correct: 'When I arrived, the meeting had already started.',
        explanationPt: 'Para mostrar que algo aconteceu antes de outro evento passado, use "had + past participle".',
      },
    ],
  },

  'future simple': {
    name: 'Future Simple (will)',
    summaryPt: 'Decisões tomadas no momento, previsões e promessas sobre o futuro.',
    whenToUse: [
      'Decisões espontâneas ("I\'ll call you back.")',
      'Previsões e opiniões sobre o futuro ("I think it will rain tomorrow.")',
      'Promessas e ofertas ("I\'ll help you with that.")',
      'Fatos sobre o futuro ("The event will start at 8 PM.")',
    ],
    structure: {
      affirmative: 'Subject + will + verb base',
      negative: 'Subject + will not (won\'t) + verb base',
      question: 'Will + subject + verb base?',
    },
    examples: [
      { english: 'I\'ll send you the report tomorrow.', portuguese: 'Vou te enviar o relatório amanhã.' },
      { english: 'She won\'t be at the meeting.', portuguese: 'Ela não estará na reunião.' },
      { english: 'Will you be there?', portuguese: 'Você vai estar lá?' },
    ],
    commonMistakes: [
      {
        wrong: 'I will to call you later.',
        correct: 'I will call you later.',
        explanationPt: 'Depois de "will", use o verbo base sem "to".',
      },
    ],
  },

  'future going to': {
    name: 'Future with Going To',
    summaryPt: 'Planos e intenções decididos com antecedência, ou previsões baseadas em evidências visíveis.',
    whenToUse: [
      'Planos e intenções já decididas ("I\'m going to apply for that job.")',
      'Previsões com evidência presente ("Look at those clouds — it\'s going to rain.")',
    ],
    structure: {
      affirmative: 'Subject + am/is/are + going to + verb base',
      negative: 'Subject + am/is/are + not + going to + verb base',
      question: 'Am/Is/Are + subject + going to + verb base?',
    },
    examples: [
      { english: 'I\'m going to change careers next year.', portuguese: 'Vou mudar de carreira no ano que vem.' },
      { english: 'They\'re not going to renew the contract.', portuguese: 'Eles não vão renovar o contrato.' },
    ],
    commonMistakes: [
      {
        wrong: 'I am going to called him.',
        correct: 'I am going to call him.',
        explanationPt: 'Depois de "going to", use sempre o verbo na forma base.',
      },
    ],
  },

  'first conditional': {
    name: 'First Conditional',
    summaryPt: 'Para situações reais e possíveis no presente ou futuro: se isso acontecer, aquilo também acontecerá.',
    whenToUse: [
      'Situações reais e prováveis ("If it rains, I\'ll stay home.")',
      'Avisos e consequências ("If you don\'t finish, you\'ll miss the deadline.")',
      'Negociações e propostas',
    ],
    structure: {
      affirmative: 'If + Present Simple, will + verb base',
      negative: 'If + don\'t/doesn\'t + verb, won\'t + verb base',
      question: 'Will + subject + verb if + condition?',
    },
    examples: [
      { english: 'If I get the promotion, I\'ll move to a new apartment.', portuguese: 'Se eu conseguir a promoção, vou me mudar para um apartamento novo.' },
      { english: 'If you send it now, they\'ll receive it today.', portuguese: 'Se você enviar agora, eles receberão hoje.' },
    ],
    commonMistakes: [
      {
        wrong: 'If I will see him, I\'ll tell him.',
        correct: 'If I see him, I\'ll tell him.',
        explanationPt: 'Na cláusula "if", use o Present Simple — nunca "will".',
      },
    ],
  },

  'second conditional': {
    name: 'Second Conditional',
    summaryPt: 'Para situações hipotéticas ou imaginárias no presente/futuro que são improváveis ou impossíveis.',
    whenToUse: [
      'Situações hipotéticas ("If I were rich, I\'d travel the world.")',
      'Conselhos ("If I were you, I\'d apply for that job.")',
      'Sonhos e desejos improváveis',
    ],
    structure: {
      affirmative: 'If + Past Simple, would + verb base',
      negative: 'If + didn\'t + verb, wouldn\'t + verb base',
      question: 'Would + subject + verb if + past condition?',
    },
    examples: [
      { english: 'If I had more time, I would learn a new language.', portuguese: 'Se eu tivesse mais tempo, aprenderia um novo idioma.' },
      { english: 'If I were the manager, I would change this process.', portuguese: 'Se eu fosse o gerente, mudaria este processo.' },
    ],
    commonMistakes: [
      {
        wrong: 'If I would have the money, I would buy it.',
        correct: 'If I had the money, I would buy it.',
        explanationPt: 'Na cláusula "if" do Second Conditional, não se usa "would". Use o Simple Past.',
      },
    ],
  },

  'third conditional': {
    name: 'Third Conditional',
    summaryPt: 'Para refletir sobre situações do passado que não aconteceram — o "e se" do passado.',
    whenToUse: [
      'Situações que não aconteceram no passado ("If I had studied harder, I would have passed.")',
      'Arrependimentos ("If I had known, I would have come.")',
      'Análise de decisões passadas',
    ],
    structure: {
      affirmative: 'If + Past Perfect (had + past participle), would have + past participle',
      negative: 'If + hadn\'t + past participle, wouldn\'t have + past participle',
      question: 'Would + subject + have + past participle if + past perfect?',
    },
    examples: [
      { english: 'If I had seen the email, I would have replied immediately.', portuguese: 'Se eu tivesse visto o e-mail, teria respondido imediatamente.' },
      { english: 'She wouldn\'t have missed the flight if she had left earlier.', portuguese: 'Ela não teria perdido o voo se tivesse saído mais cedo.' },
    ],
    commonMistakes: [
      {
        wrong: 'If I would have known, I would called you.',
        correct: 'If I had known, I would have called you.',
        explanationPt: 'Use "had + past participle" no "if" e "would have + past participle" no resultado.',
      },
    ],
  },

  'modal verbs': {
    name: 'Modal Verbs',
    summaryPt: 'Verbos auxiliares que expressam possibilidade, obrigação, permissão ou capacidade.',
    whenToUse: [
      'can — capacidade presente ("I can help.")',
      'could — capacidade passada ou pedido educado ("Could you send it?")',
      'should — conselho ("You should apologize.")',
      'must — obrigação forte ("You must submit today.")',
      'would — hipóteses e educação ("I would appreciate it.")',
      'might/may — possibilidade ("It might be delayed.")',
    ],
    structure: {
      affirmative: 'Subject + modal + verb base',
      negative: 'Subject + modal + not + verb base',
      question: 'Modal + subject + verb base?',
    },
    examples: [
      { english: 'You should talk to your manager about this.', portuguese: 'Você deveria falar com seu gerente sobre isso.' },
      { english: 'Could you send me the file by Friday?', portuguese: 'Você poderia me enviar o arquivo até sexta?' },
      { english: 'It might take longer than expected.', portuguese: 'Pode demorar mais do que o esperado.' },
    ],
    commonMistakes: [
      {
        wrong: 'She should to call him.',
        correct: 'She should call him.',
        explanationPt: 'Depois de qualquer modal, use o verbo base sem "to".',
      },
      {
        wrong: 'You must to finish today.',
        correct: 'You must finish today.',
        explanationPt: '"Must" não usa "to" antes do verbo.',
      },
    ],
  },

  'passive voice': {
    name: 'Passive Voice',
    summaryPt: 'Muda o foco da ação para o objeto/resultado em vez de quem faz a ação.',
    whenToUse: [
      'Quando quem faz a ação é desconhecido ou não importante ("The report was submitted.")',
      'Em contextos formais, técnicos e científicos',
      'Para dar ênfase ao resultado ("The project was completed on time.")',
    ],
    structure: {
      affirmative: 'Subject + be (conjugado) + past participle',
      negative: 'Subject + be + not + past participle',
      question: 'Be + subject + past participle?',
    },
    examples: [
      { english: 'The email was sent yesterday.', portuguese: 'O e-mail foi enviado ontem.' },
      { english: 'The meeting has been rescheduled.', portuguese: 'A reunião foi reagendada.' },
      { english: 'Was the bug fixed?', portuguese: 'O bug foi corrigido?' },
    ],
    commonMistakes: [
      {
        wrong: 'The report was wrote by the team.',
        correct: 'The report was written by the team.',
        explanationPt: 'Use o past participle correto. "Write" → written (não "wrote").',
      },
    ],
  },

  'reported speech': {
    name: 'Reported Speech',
    summaryPt: 'Usado para relatar o que alguém disse, sem usar as palavras exatas. Os tempos verbais "recuam" um passo.',
    whenToUse: [
      'Para contar o que alguém disse ("He said he was tired.")',
      'Em e-mails e relatórios formais',
      'Para resumir conversas e reuniões',
    ],
    structure: {
      affirmative: 'Subject + said (that) + clause (com tempo verbal recuado)',
      negative: 'Subject + said (that) + subject + didn\'t/wasn\'t...',
      question: 'Subject + asked if/whether + clause / Subject + asked + wh-word + clause',
    },
    examples: [
      { english: '"I\'m working on it." → She said she was working on it.', portuguese: '"Estou trabalhando nisso." → Ela disse que estava trabalhando nisso.' },
      { english: '"Did you finish?" → He asked if I had finished.', portuguese: '"Você terminou?" → Ele perguntou se eu tinha terminado.' },
    ],
    commonMistakes: [
      {
        wrong: 'She said me that she was late.',
        correct: 'She told me that she was late.',
        explanationPt: '"Say" não precisa de objeto. "Tell" precisa: "tell someone".',
      },
      {
        wrong: 'He said that he will come.',
        correct: 'He said that he would come.',
        explanationPt: 'O tempo verbal recua: "will" vira "would" no reported speech.',
      },
    ],
  },
};

// Aliases allow flexible matching for what AI might output
const ALIASES: Record<string, string> = {
  'simple present': 'present simple',
  'present tense': 'present simple',
  'present progressive': 'present continuous',
  'present participle': 'present continuous',
  'past simple': 'simple past',
  'simple past tense': 'simple past',
  'past tense': 'simple past',
  'past progressive': 'past continuous',
  'present perfect tense': 'present perfect',
  'present perfect simple': 'present perfect',
  'past perfect tense': 'past perfect',
  'pluperfect': 'past perfect',
  'will future': 'future simple',
  'simple future': 'future simple',
  'future with will': 'future simple',
  'be going to': 'future going to',
  'going to': 'future going to',
  'future with going to': 'future going to',
  'conditional type 1': 'first conditional',
  'type 1 conditional': 'first conditional',
  'real conditional': 'first conditional',
  'conditional type 2': 'second conditional',
  'type 2 conditional': 'second conditional',
  'unreal conditional': 'second conditional',
  'conditional type 3': 'third conditional',
  'type 3 conditional': 'third conditional',
  'mixed conditional': 'third conditional',
  'modais': 'modal verbs',
  'modals': 'modal verbs',
  'modal auxiliaries': 'modal verbs',
  'can / could': 'modal verbs',
  'should / would': 'modal verbs',
  'passive': 'passive voice',
  'voz passiva': 'passive voice',
  'indirect speech': 'reported speech',
  'discurso indireto': 'reported speech',
  'direct and indirect speech': 'reported speech',
};

export function findGrammarContent(name: string): GrammarContent | null {
  const normalized = name.toLowerCase().trim();
  // Direct match
  if (DB[normalized]) return DB[normalized];
  // Alias match
  const aliasKey = ALIASES[normalized];
  if (aliasKey && DB[aliasKey]) return DB[aliasKey];
  // Partial match — find first key that the normalized name contains or vice versa
  for (const key of Object.keys(DB)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return DB[key];
    }
  }
  return null;
}
