/**
 * Every user-facing string on the subscription screen lives here — never
 * inline this text in a component. Mirrors the convention in
 * ../entitlements/entitlement-messages.ts. Simple, honest, non-technical
 * language: never claim a purchase, restore, or cancellation happened.
 */
export const SUBSCRIPTION_MESSAGES = {
  // trialing
  trialingTitle: 'Seu teste gratuito está ativo',
  trialLimitsIntro: 'Durante o teste, você tem acesso a:',
  trialDurationNote: 'O teste gratuito dura 7 dias.',
  trialDataPreservedNote: 'Seus dados e progresso não serão apagados quando o teste terminar.',
  trialBlockedActivitiesNote:
    'Ao final do teste, apenas escrita, pronúncia, listening e conversação ficam bloqueados. Seu perfil, histórico e configurações continuam disponíveis normalmente.',

  // expired
  expiredTitle: 'Seu período gratuito terminou',
  expiredSubtitle: 'Escolha um plano para continuar praticando.',

  // active (commercial)
  activeStatusLabel: 'Assinatura ativa',

  // active (internal — hand-assigned, non-commercial unlimited plan)
  internalTitle: 'Acesso interno ilimitado',
  internalStatusLabel: 'Acesso ativo',
  internalComplementaryNote: 'Sem cobrança ou renovação.',

  // canceled
  canceledTitle: 'Assinatura cancelada',
  canceledAccessEndedNote: 'Seu acesso a este plano já foi encerrado.',
  canceledChooseAgainNote: 'Escolha novamente um plano para continuar praticando.',

  // billing_issue
  billingIssueTitle: 'Houve um problema com seu pagamento',
  billingIssueSubtitle: 'Atualize sua forma de pagamento para continuar com o acesso ao plano.',
  billingIssueAccessUntilNote: 'Seu acesso continua disponível até:',

  // plans
  recommendedBadge: 'Recomendado',
  extraMinutePackagesNote: 'Possibilidade futura de comprar pacotes adicionais de minutos.',
  /** Shown only when import.meta.env.DEV — never in a production build. */
  conversationMinutesTbdDev: 'Franquia de conversação a definir (texto de desenvolvimento — não exibido em produção)',

  // loading/error (real fetch)
  statusLoading: 'Carregando status da assinatura...',
  statusLoadError: 'Não foi possível carregar o status da sua assinatura agora. Tente novamente.',

  // buttons
  subscribeEssential: 'Assinar Essencial',
  subscribePlus: 'Assinar Plus',
  restorePurchases: 'Restaurar compras',
  manageSubscription: 'Gerenciar assinatura',
  backToHome: 'Voltar para o início',

  // placeholder handler feedback — kept for the (currently always-hidden,
  // backend-capability-gated) legacy manage/restore buttons; see
  // SubscriptionView.tsx. Must never claim success.
  devPurchasePlaceholder: (planName: string) =>
    `Ainda em desenvolvimento: a compra do plano ${planName} não está disponível nesta versão. Nenhuma cobrança foi feita e nenhum plano foi alterado.`,
  devRestorePlaceholder:
    'Ainda em desenvolvimento: a restauração de compras não está disponível nesta versão. Nenhuma alteração foi feita.',
  devManageSubscriptionPlaceholder:
    'Ainda em desenvolvimento: o gerenciamento de assinatura não está disponível nesta versão.',

  // Native (iOS) real purchase flow — RevenueCat integration
  webPurchaseUnavailableNote: 'Assinaturas são feitas pelo aplicativo Orodim. Baixe o app para assinar um plano.',
  purchasingLabel: 'Processando...',
  restoringLabel: 'Restaurando...',
  restoreNoneFoundNote: 'Nenhuma compra encontrada para restaurar.',
} as const;

export const TRIAL_LIMIT_LABELS = {
  writingPerDay: (n: number) => `${n} escrita por dia`,
  pronunciationPerDay: (n: number) => `${n} pronúncia por dia`,
  listeningPerDay: (n: number) => `${n} listening por dia`,
  conversationMinutesTotal: (n: number) => `${n} minutos totais de conversação`,
} as const;

export const PLAN_BENEFIT_LABELS = {
  writingPerDay: (n: number) => (n === 1 ? '1 escrita por dia' : `${n} escritas por dia`),
  pronunciationPerDay: (n: number) => (n === 1 ? '1 pronúncia por dia' : `${n} pronúncias por dia`),
  listeningPerDay: (n: number) => (n === 1 ? '1 listening por dia' : `${n} listenings por dia`),
  conversationMinutesMonthly: (n: number) => `${n} minutos de conversação por mês`,
} as const;
