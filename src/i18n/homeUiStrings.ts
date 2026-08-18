/**
 * Interface-language localization for the HOME screen chrome — following the
 * exact pattern of curriculumUiStrings: ONE place keyed by interface_language,
 * never strings scattered across components. The interface language comes from
 * the same server-resolved source the "Foco atual" block uses
 * (curriculum progress payload), so a future interface=en user gets a coherent
 * Home with NO component change. Falls back to pt-BR.
 *
 * Scope: presentation chrome only (titles, section labels, activity names,
 * short descriptions, availability badge words). Real numbers/quotas come from
 * the entitlements + streak + review APIs — never hardcoded here.
 */
export interface HomeUiStrings {
  title: string;
  subtitle: string;

  // Streak card
  streakLabel: string;                 // "Sequência atual"
  streakUnit: (n: number) => string;   // "dia" / "dias"
  streakEncouragement: string;         // "Continue assim!" (streak > 0)
  streakZeroHint: string;              // "Comece hoje!" (streak == 0)
  streakAria: (n: number) => string;   // accessible label

  // Sections
  nextRecommendation: string;          // "Próxima recomendação"
  otherPractices: string;              // "Outras práticas"

  // Recommended hero
  recommendedBadge: string;            // honest badge — this IS the recommended practice
  startPractice: string;               // "Começar prática"

  // Activity names + short (compact-row) descriptions
  writingTitle: string;
  writingDesc: string;
  conversationTitle: string;
  conversationDesc: string;
  listeningTitle: string;
  listeningDesc: string;
  pronunciationTitle: string;
  pronunciationDesc: string;
  errorReviewTitle: string;
  errorReviewDesc: string;             // shown when there are pending cards
  errorReviewEmptyDesc: string;        // "Tudo em dia. Novos erros…"

  // Availability badges (words only — numbers injected)
  minutesRemaining: (min: number) => string;   // "42 min"
  unlimited: string;                            // "Ilimitado"
  limitReached: string;                         // "Limite de hoje"
  notInPlan: string;                            // "Ver planos"
  featureUnavailable: string;                   // globally disabled
  reviewsToDo: (n: number) => string;           // "4 para revisar"
  remainingCount: (n: number) => string;        // "2 restantes"
  allCaughtUp: string;                          // "Tudo em dia"
  loadingShort: string;                         // "…"
}

const PT_BR: HomeUiStrings = {
  title: 'O que você quer praticar hoje?',
  subtitle: 'Escolha uma atividade e continue sua evolução no inglês.',

  streakLabel: 'Sequência atual',
  streakUnit: (n) => (n === 1 ? 'dia' : 'dias'),
  streakEncouragement: 'Continue assim!',
  streakZeroHint: 'Comece hoje!',
  streakAria: (n) => `Sequência atual de ${n} ${n === 1 ? 'dia' : 'dias'} consecutivos de prática`,

  nextRecommendation: 'Próxima recomendação',
  otherPractices: 'Outras práticas',

  recommendedBadge: 'Recomendado',
  startPractice: 'Começar prática',

  writingTitle: 'Praticar escrita e voz',
  writingDesc: 'Receba uma missão, escreva seu texto, revise com a IA e treine sua pronúncia.',
  conversationTitle: 'Conversar com IA',
  conversationDesc: 'Pratique inglês falado em uma conversa natural com seu tutor virtual.',
  listeningTitle: 'Praticar listening',
  listeningDesc: 'Ouça histórias em inglês, responda perguntas e treine sua compreensão.',
  pronunciationTitle: 'Treinar pronúncia',
  pronunciationDesc: 'Leia um texto, descubra as palavras que precisam de atenção e pratique uma por uma.',
  errorReviewTitle: 'Revisar meus erros',
  errorReviewDesc: 'Reforce os erros importantes que você já cometeu na escrita.',
  errorReviewEmptyDesc: 'Tudo em dia. Novos erros importantes aparecerão aqui para revisão.',

  minutesRemaining: (min) => `${min} min`,
  unlimited: 'Ilimitado',
  limitReached: 'Limite de hoje',
  notInPlan: 'Ver planos',
  featureUnavailable: 'Indisponível',
  reviewsToDo: (n) => `${n} para revisar`,
  remainingCount: (n) => `${n} ${n === 1 ? 'restante' : 'restantes'}`,
  allCaughtUp: 'Tudo em dia',
  loadingShort: '…',
};

const EN: HomeUiStrings = {
  title: 'What do you want to practise today?',
  subtitle: 'Pick an activity and keep improving your English.',

  streakLabel: 'Current streak',
  streakUnit: (n) => (n === 1 ? 'day' : 'days'),
  streakEncouragement: 'Keep it up!',
  streakZeroHint: 'Start today!',
  streakAria: (n) => `Current streak of ${n} consecutive ${n === 1 ? 'day' : 'days'} of practice`,

  nextRecommendation: 'Next recommendation',
  otherPractices: 'Other practices',

  recommendedBadge: 'Recommended',
  startPractice: 'Start practice',

  writingTitle: 'Practise writing & voice',
  writingDesc: 'Get a mission, write your text, review it with AI and train your pronunciation.',
  conversationTitle: 'Talk with AI',
  conversationDesc: 'Practise spoken English in a natural conversation with your virtual tutor.',
  listeningTitle: 'Practise listening',
  listeningDesc: 'Listen to stories in English, answer questions and train your comprehension.',
  pronunciationTitle: 'Train pronunciation',
  pronunciationDesc: 'Read a text, find the words that need attention and practise them one by one.',
  errorReviewTitle: 'Review my mistakes',
  errorReviewDesc: 'Reinforce the important mistakes you already made in your writing.',
  errorReviewEmptyDesc: "All caught up. New important mistakes will show up here for review.",

  minutesRemaining: (min) => `${min} min`,
  unlimited: 'Unlimited',
  limitReached: "Today's limit",
  notInPlan: 'See plans',
  featureUnavailable: 'Unavailable',
  reviewsToDo: (n) => `${n} to review`,
  remainingCount: (n) => `${n} left`,
  allCaughtUp: 'All caught up',
  loadingShort: '…',
};

const STRINGS: Record<string, HomeUiStrings> = { 'pt-BR': PT_BR, en: EN };

/** Resolves Home UI strings for an interface language (falls back to pt-BR). */
export function homeUiStrings(interfaceLanguage: string | null | undefined): HomeUiStrings {
  const code = (interfaceLanguage ?? '').trim();
  return STRINGS[code] ?? STRINGS[code.split('-')[0]] ?? PT_BR;
}
