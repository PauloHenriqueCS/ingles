/**
 * Every user-facing plan/limit message lives here — never inline this text
 * in a component. Simple, positive, non-technical language (per product spec).
 */
export const ENTITLEMENT_MESSAGES = {
  featureUnavailable: 'Este recurso não está disponível no seu plano atual.',
  conversationUnavailable: 'A conversação por voz não está disponível no seu plano atual.',

  writingGenerationsExhausted:
    'Você já usou todas as gerações de missão de hoje. Continue com a missão atual ou volte amanhã para gerar uma nova.',
  writingReviewsExhausted:
    'Você atingiu o limite de revisões de hoje. Seu texto foi preservado e você poderá revisá-lo amanhã.',
  listeningStoriesExhausted:
    'Você concluiu as histórias disponíveis para hoje. Amanhã novas atividades estarão liberadas.',
  pronunciationEvaluationsExhausted:
    'Você atingiu o limite de avaliações de pronúncia de hoje. Continue praticando com os resultados já disponíveis e volte amanhã para novas avaliações.',
  conversationMinutesExhausted:
    'Seus minutos de conversação deste mês acabaram. Sua conversa foi preservada.',
  conversationExtraPurchaseAvailable:
    'Seus minutos deste mês acabaram. Você pode adicionar mais minutos para continuar praticando.',
  conversationRecordingStoppedByBalance:
    'A gravação foi encerrada porque seus minutos disponíveis chegaram ao fim.',

  dailyLimitGeneric:
    'Você já usou todas as atividades disponíveis para hoje. Seu limite será renovado amanhã.',
  technicalFailure:
    'Não foi possível concluir esta atividade. Nenhum uso foi descontado. Tente novamente.',

  characterLimitReached: (limit: number) =>
    `Você atingiu o máximo de ${limit.toLocaleString('pt-BR')} caracteres permitido pelo seu plano.`,
  characterOverLimitAfterPlanChange: (overBy: number) =>
    `Seu texto possui ${overBy.toLocaleString('pt-BR')} caracteres acima do limite atual. Reduza o texto para solicitar a revisão.`,
  recordingLimitReached: (seconds: number) =>
    `A gravação foi encerrada ao atingir o limite de ${seconds} segundos do seu plano.`,

  unlimitedLabel: 'Ilimitado',
  conversationUnlimitedLabel: 'Tempo de conversação ilimitado',
  notIncludedInPlanBadge: 'Não incluído no plano',
  dailyLimitReachedBadge: 'Limite de hoje atingido',
  minutesExhaustedBadge: 'Minutos esgotados',
} as const;
