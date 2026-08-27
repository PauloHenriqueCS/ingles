/**
 * Interface-language localization for the WRITING activity chrome — following
 * the exact pattern of homeUiStrings/curriculumUiStrings: ONE typed module keyed
 * by interface_language, never strings scattered across components. The
 * interface language comes from the same server-resolved source Home uses
 * (curriculum progress payload → useCurriculumFocus().data.interfaceLanguage),
 * so a future interface=en learner gets a coherent Writing flow with no
 * component change. Falls back to pt-BR.
 *
 * Scope: presentation chrome only (stepper labels, section titles, button copy,
 * short guidance). Pedagogical CONTENT — the mission text, grammar, vocabulary,
 * the AI feedback — comes from the API/DB and is never authored here. Real
 * numbers/quotas come from the entitlements API and are only interpolated.
 */
export interface WritingUiStrings {
  // Stepper slot labels
  stepMission: string;
  stepWrite: string;
  stepFeedback: string;
  stepImprove: string; // shown on the central slot while the user is improving
  stepDone: string;
  stepperAria: string; // "Progresso da atividade de escrita"

  // Header / exit guard
  exitConfirmTitle: string;
  exitConfirmBody: string;
  exitConfirmLeave: string;
  exitConfirmStay: string;

  // Mission step
  startWriting: string;          // primary CTA → go to Escrever

  // Write step
  missionSummaryAction: string;  // "Ver missão e dicas"
  titleLabel: string;
  titleOptional: string;
  titlePlaceholder: string;
  ptIdeaTitle: string;           // "Ideia em português"
  optional: string;              // "opcional"
  ptIdeaHint: string;
  ptIdeaPlaceholder: string;
  ptIdeaClear: string;
  yourTextLabel: string;
  yourTextPlaceholder: string;
  wordsChars: (words: number, chars: number) => string;
  charsOfMax: (chars: number, max: number) => string;
  difficultyLabel: string;
  diffEasy: string;
  diffMedium: string;
  diffHard: string;
  saveDraft: string;
  saving: string;
  savedShort: string;
  saveError: string;
  reviewWithAi: string;
  analyzing: string;

  // Mission sheet (bottom sheet)
  sheetTitle: string;            // "Missão e dicas"
  sheetClose: string;
  sheetObjective: string;
  sheetHowTo: string;
  sheetGrammar: string;
  sheetVocabulary: string;       // "Vocabulário útil para esta missão"
  sheetExample: string;
  sheetSuccess: string;          // "Missão cumprida quando..."
  sheetChallenge: string;        // "Desafio extra"

  // Feedback step
  feedbackSummaryTitle: string;  // "Resumo do feedback"
  scoreLabel: string;            // "Nota"
  writingLevelLabel: string;     // "Nível da escrita"
  mainCorrectionTitle: string;   // "Principal correção"
  youWrote: string;              // "Você escreveu:"
  corrected: string;             // "Correto:"
  showFullReport: string;
  hideFullReport: string;
  // Adaptive recommendation
  praiseTitle: string;           // Caso A "Ótimo trabalho"
  praiseBody: string;
  improveTitle: (n: number) => string; // Caso B "Você tem N ponto(s) para melhorar"
  improveBody: string;
  concludeWriting: string;       // primary in Caso A
  improveMyText: string;         // primary in Caso B / secondary in Caso A
  concludeAnyway: string;        // secondary in Caso B

  // Improve step
  improveHeaderTitle: string;    // "Melhore sua escrita"
  improveHeaderSubtitle: string; // "Use o feedback para corrigir os pontos encontrados."
  pointsToReview: string;        // "Pontos para revisar"
  noMainMistakes: string;
  newVersionLabel: string;       // "Sua nova versão"
  newVersionPlaceholder: string;
  analyzeImprovement: string;    // "Analisar melhoria"
  analyzingImprovement: string;
  backToFeedback: string;        // "Ver feedback"
  alreadyAnalyzed: string;       // "Você já analisou esta versão. Cada missão permite uma análise."
  improveEmptyWarning: string;

  // V2 result
  v2ResultTitle: string;         // "Resultado da melhoria"
  v2ScoreLabel: string;          // "Nota da versão 2" (NOT "Melhora" — it is a score)
  v2Fixed: string;               // "corrigidos"
  v2Remaining: string;           // "restantes"
  v2WhatYouFixed: string;
  v2StillToFix: string;
  v2NewIssues: string;
  v2NoNewIssues: string;
  v2NextAction: string;
  v2Original: string;
  v2Version: string;             // "Versão 2:"
  v2CorrectLabel: string;

  // Final corrected version
  finalVersionTitle: string;     // "Versão final corrigida"
  copy: string;
  copied: string;
  listenText: string;            // "Ouvir texto"
  generatingFinal: string;

  // Done step
  doneTitle: string;             // "Escrita concluída"
  doneSubtitle: string;          // "Ótimo trabalho, você completou a atividade!"
  finalSummaryTitle: string;     // "Resumo final"
  finalScoreLabel: string;       // "Nota final"
  errorsCorrectedLabel: string;  // "Erros corrigidos"
  mainPracticePointLabel: string;// "Principal ponto para praticar"

  // Pronunciation (optional extra on the Concluído screen — NOT a stepper step)
  pronTitle: string;             // "Treine sua pronúncia"
  pronCardHint: string;          // "Use o texto que acabou de escrever."
  pronTrain: string;             // "Treinar pronúncia"
  pronExpandedTitle: string;     // "Treino de pronúncia"
  pronQuotaUnlimited: string;    // "Prática de pronúncia: ilimitada no seu plano"
  pronQuotaRemaining: (n: number) => string;

  // Next
  nextActivity: string;          // "Nova missão"
  remainingWritings: (n: number) => string;
}

const PT_BR: WritingUiStrings = {
  stepMission: 'Missão',
  stepWrite: 'Escrever',
  stepFeedback: 'Feedback',
  stepImprove: 'Melhorar',
  stepDone: 'Concluir',
  stepperAria: 'Progresso da atividade de escrita',

  exitConfirmTitle: 'Sair da atividade?',
  exitConfirmBody: 'Seu texto ainda não foi enviado. Se sair agora, você pode perder o que escreveu.',
  exitConfirmLeave: 'Sair mesmo assim',
  exitConfirmStay: 'Continuar escrevendo',

  startWriting: 'Começar escrita',

  missionSummaryAction: 'Ver missão e dicas',
  titleLabel: 'Título',
  titleOptional: 'opcional',
  titlePlaceholder: 'Ex: My Morning Routine',
  ptIdeaTitle: 'Ideia em português',
  optional: 'opcional',
  ptIdeaHint: 'Esse rascunho é só para você. A IA vai avaliar apenas o texto em inglês.',
  ptIdeaPlaceholder: 'Escreva aqui sua ideia em português. Esse texto não será corrigido nem salvo.',
  ptIdeaClear: 'Limpar rascunho',
  yourTextLabel: 'Seu texto',
  yourTextPlaceholder: 'Escreva seu texto em inglês aqui...',
  wordsChars: (w, c) => `${w.toLocaleString('pt-BR')} palavras · ${c.toLocaleString('pt-BR')} caracteres`,
  charsOfMax: (c, m) => `${c.toLocaleString('pt-BR')} / ${m.toLocaleString('pt-BR')} caracteres`,
  difficultyLabel: 'Dificuldade',
  diffEasy: 'Fácil',
  diffMedium: 'Médio',
  diffHard: 'Difícil',
  saveDraft: 'Salvar rascunho',
  saving: 'Salvando...',
  savedShort: '✓ Salvo!',
  saveError: 'Erro',
  reviewWithAi: 'Revisar com IA',
  analyzing: 'Analisando...',

  sheetTitle: 'Missão e dicas',
  sheetClose: 'Fechar',
  sheetObjective: 'Objetivo',
  sheetHowTo: 'Como fazer',
  sheetGrammar: 'Gramática',
  sheetVocabulary: 'Vocabulário útil para esta missão',
  sheetExample: 'Exemplo',
  sheetSuccess: 'Missão cumprida quando...',
  sheetChallenge: 'Desafio extra',

  feedbackSummaryTitle: 'Resumo do feedback',
  scoreLabel: 'Nota',
  writingLevelLabel: 'Nível da escrita',
  mainCorrectionTitle: 'Principal correção',
  youWrote: 'Você escreveu:',
  corrected: 'Correto:',
  showFullReport: 'Ver relatório completo',
  hideFullReport: 'Ocultar relatório completo',
  praiseTitle: 'Ótimo trabalho',
  praiseBody: 'Sua escrita já está muito boa. Você pode concluir ou tentar melhorá-la ainda mais.',
  improveTitle: (n) => `Você tem ${n} ${n === 1 ? 'ponto' : 'pontos'} para melhorar`,
  improveBody: 'Que tal corrigir seu texto antes de concluir?',
  concludeWriting: 'Concluir escrita',
  improveMyText: 'Melhorar meu texto',
  concludeAnyway: 'Concluir mesmo assim',

  improveHeaderTitle: 'Melhore sua escrita',
  improveHeaderSubtitle: 'Use o feedback para corrigir os pontos encontrados.',
  pointsToReview: 'Pontos para revisar',
  noMainMistakes: 'Não encontramos erros principais suficientes, mas você ainda pode tentar melhorar sua versão.',
  newVersionLabel: 'Sua nova versão',
  newVersionPlaceholder: 'Reescreva seu texto aqui corrigindo os pontos apontados — sem copiar o texto corrigido inteiro.',
  analyzeImprovement: 'Analisar melhoria',
  analyzingImprovement: 'Analisando sua melhoria...',
  backToFeedback: 'Ver feedback',
  alreadyAnalyzed: 'Você já analisou esta versão. Cada missão permite uma análise da melhoria.',
  improveEmptyWarning: 'Escreva sua nova versão antes de analisar.',

  v2ResultTitle: 'Resultado da melhoria',
  v2ScoreLabel: 'Nota da versão 2',
  v2Fixed: 'corrigidos',
  v2Remaining: 'restantes',
  v2WhatYouFixed: 'O que você corrigiu ✓',
  v2StillToFix: 'O que ainda falta corrigir',
  v2NewIssues: 'Novos pontos de atenção',
  v2NoNewIssues: 'Nenhum novo problema importante encontrado.',
  v2NextAction: 'Próxima ação',
  v2Original: 'Original:',
  v2Version: 'Versão 2:',
  v2CorrectLabel: 'Correto:',

  finalVersionTitle: 'Versão final corrigida',
  copy: 'Copiar',
  copied: '✓ Copiado',
  listenText: 'Ouvir texto',
  generatingFinal: 'Gerando versão final corrigida...',

  doneTitle: 'Escrita concluída',
  doneSubtitle: 'Ótimo trabalho, você completou a atividade!',
  finalSummaryTitle: 'Resumo final',
  finalScoreLabel: 'Nota final',
  errorsCorrectedLabel: 'Erros corrigidos',
  mainPracticePointLabel: 'Principal ponto para praticar',

  pronTitle: 'Treine sua pronúncia',
  pronCardHint: 'Use o texto que acabou de escrever.',
  pronTrain: 'Treinar pronúncia',
  pronExpandedTitle: 'Treino de pronúncia',
  pronQuotaUnlimited: 'Prática de pronúncia: ilimitada no seu plano',
  pronQuotaRemaining: (n) =>
    `Prática de pronúncia: ${n} ${n === 1 ? 'avaliação restante' : 'avaliações restantes'} hoje`,

  nextActivity: 'Nova missão',
  remainingWritings: (n) => `${n} ${n === 1 ? 'escrita restante' : 'escritas restantes'} hoje`,
};

const EN: WritingUiStrings = {
  stepMission: 'Mission',
  stepWrite: 'Write',
  stepFeedback: 'Feedback',
  stepImprove: 'Improve',
  stepDone: 'Finish',
  stepperAria: 'Writing activity progress',

  exitConfirmTitle: 'Leave the activity?',
  exitConfirmBody: 'Your text has not been submitted yet. If you leave now, you may lose what you wrote.',
  exitConfirmLeave: 'Leave anyway',
  exitConfirmStay: 'Keep writing',

  startWriting: 'Start writing',

  missionSummaryAction: 'View mission & tips',
  titleLabel: 'Title',
  titleOptional: 'optional',
  titlePlaceholder: 'e.g. My Morning Routine',
  ptIdeaTitle: 'Idea in your language',
  optional: 'optional',
  ptIdeaHint: 'This draft is just for you. The AI only evaluates the English text.',
  ptIdeaPlaceholder: 'Jot your idea here. This text is never corrected or saved.',
  ptIdeaClear: 'Clear draft',
  yourTextLabel: 'Your text',
  yourTextPlaceholder: 'Write your text in English here...',
  wordsChars: (w, c) => `${w.toLocaleString('en')} words · ${c.toLocaleString('en')} characters`,
  charsOfMax: (c, m) => `${c.toLocaleString('en')} / ${m.toLocaleString('en')} characters`,
  difficultyLabel: 'Difficulty',
  diffEasy: 'Easy',
  diffMedium: 'Medium',
  diffHard: 'Hard',
  saveDraft: 'Save draft',
  saving: 'Saving...',
  savedShort: '✓ Saved!',
  saveError: 'Error',
  reviewWithAi: 'Review with AI',
  analyzing: 'Analyzing...',

  sheetTitle: 'Mission & tips',
  sheetClose: 'Close',
  sheetObjective: 'Objective',
  sheetHowTo: 'How to do it',
  sheetGrammar: 'Grammar',
  sheetVocabulary: 'Useful vocabulary for this mission',
  sheetExample: 'Example',
  sheetSuccess: 'Mission complete when...',
  sheetChallenge: 'Extra challenge',

  feedbackSummaryTitle: 'Feedback summary',
  scoreLabel: 'Score',
  writingLevelLabel: 'Writing level',
  mainCorrectionTitle: 'Main correction',
  youWrote: 'You wrote:',
  corrected: 'Correct:',
  showFullReport: 'See full report',
  hideFullReport: 'Hide full report',
  praiseTitle: 'Great work',
  praiseBody: 'Your writing is already very good. You can finish or try to improve it even more.',
  improveTitle: (n) => `You have ${n} ${n === 1 ? 'point' : 'points'} to improve`,
  improveBody: 'How about fixing your text before you finish?',
  concludeWriting: 'Finish writing',
  improveMyText: 'Improve my text',
  concludeAnyway: 'Finish anyway',

  improveHeaderTitle: 'Improve your writing',
  improveHeaderSubtitle: 'Use the feedback to fix the points found.',
  pointsToReview: 'Points to review',
  noMainMistakes: "We didn't find enough main mistakes, but you can still try to improve your version.",
  newVersionLabel: 'Your new version',
  newVersionPlaceholder: 'Rewrite your text here, fixing the points raised — without copying the whole corrected text.',
  analyzeImprovement: 'Analyze improvement',
  analyzingImprovement: 'Analyzing your improvement...',
  backToFeedback: 'See feedback',
  alreadyAnalyzed: 'You already analyzed this version. Each mission allows one improvement analysis.',
  improveEmptyWarning: 'Write your new version before analyzing.',

  v2ResultTitle: 'Improvement result',
  v2ScoreLabel: 'Version 2 score',
  v2Fixed: 'fixed',
  v2Remaining: 'remaining',
  v2WhatYouFixed: 'What you fixed ✓',
  v2StillToFix: 'Still to fix',
  v2NewIssues: 'New points of attention',
  v2NoNewIssues: 'No important new problems found.',
  v2NextAction: 'Next action',
  v2Original: 'Original:',
  v2Version: 'Version 2:',
  v2CorrectLabel: 'Correct:',

  finalVersionTitle: 'Final corrected version',
  copy: 'Copy',
  copied: '✓ Copied',
  listenText: 'Listen',
  generatingFinal: 'Generating final corrected version...',

  doneTitle: 'Writing complete',
  doneSubtitle: 'Great work — you completed the activity!',
  finalSummaryTitle: 'Final summary',
  finalScoreLabel: 'Final score',
  errorsCorrectedLabel: 'Errors corrected',
  mainPracticePointLabel: 'Main point to practice',

  pronTitle: 'Train your pronunciation',
  pronCardHint: 'Use the text you just wrote.',
  pronTrain: 'Train pronunciation',
  pronExpandedTitle: 'Pronunciation training',
  pronQuotaUnlimited: 'Pronunciation practice: unlimited on your plan',
  pronQuotaRemaining: (n) =>
    `Pronunciation practice: ${n} ${n === 1 ? 'assessment left' : 'assessments left'} today`,

  nextActivity: 'New mission',
  remainingWritings: (n) => `${n} ${n === 1 ? 'writing left' : 'writings left'} today`,
};

const STRINGS: Record<string, WritingUiStrings> = { 'pt-BR': PT_BR, en: EN };

/** Resolves Writing UI strings for an interface language (falls back to pt-BR). */
export function writingUiStrings(interfaceLanguage: string | null | undefined): WritingUiStrings {
  const code = (interfaceLanguage ?? '').trim();
  return STRINGS[code] ?? STRINGS[code.split('-')[0]] ?? PT_BR;
}
