/**
 * Every user-facing string on the "Minutos adicionais" screen. Never inline
 * this text in the component (mirrors subscription-copy.ts). Honest language:
 * never claims a purchase happened, never invents an expiry policy.
 */
export const MINUTE_PACKAGES_MESSAGES = {
  title: 'Minutos adicionais',
  entryCtaTitle: 'Comprar minutos adicionais',
  entrySubtitle: 'Adicione 300, 600 ou 900 minutos de conversação.',

  // balance
  balanceTitle: 'Seu saldo de conversação',
  planIncludedLabel: 'Incluídos no plano',
  extraLabel: 'Minutos adicionais comprados',
  totalLabel: 'Total disponível',
  unlimitedLabel: 'Conversação ilimitada no seu plano',
  minutesUnit: (n: number) => `${n} min`,

  // cards
  buyCta: (minutes: number) => `Comprar ${minutes} minutos`,
  purchasingLabel: 'Processando...',
  // Only stated because it is how the backend actually works (plan first,
  // purchased credits second — see compute-feature-state.ts / the debit RPC).
  consumptionNote:
    'Os minutos comprados são adicionados ao seu saldo de conversação e consumidos além dos minutos incluídos no seu plano. Primeiro usamos os minutos do plano e depois os adicionais.',

  // eligibility
  trialBlockedTitle: 'Assine um plano para comprar minutos',
  trialBlockedSubtitle: 'A compra de minutos adicionais está disponível nos planos Essencial e Plus.',
  trialBlockedCta: 'Ver planos',
  internalNote: 'Seu acesso já inclui conversação ilimitada — não é necessário comprar minutos.',

  // loading / error
  loading: 'Carregando pacotes...',
  loadError: 'Não foi possível carregar os pacotes agora. Tente novamente.',

  // purchase feedback
  purchaseSuccess: (minutes: number) => `${minutes} minutos adicionados ao seu saldo.`,
  // The credit lands via the store webhook — if the balance hasn't caught up
  // yet, we say so honestly instead of claiming a number that isn't there.
  purchaseSuccessPending: (minutes: number) =>
    `Compra concluída. ${minutes} minutos serão adicionados ao seu saldo em instantes.`,
  webPurchaseUnavailable: 'A compra de minutos é feita pelo aplicativo Orodim. Baixe o app para comprar.',
  cancelledNote: 'Compra cancelada.',
  genericError: 'Não foi possível concluir a compra. Tente novamente.',

  back: 'Voltar',
} as const;
