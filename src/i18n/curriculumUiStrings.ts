/**
 * Centralized interface-language localization for the CURRICULUM UI chrome
 * (blockers 13 & 20). ONE place, keyed by interface_language — never strings
 * scattered across components. The interface language comes from the API
 * (curriculum tree / preferences), so a future interface=en + learning=es user
 * gets coherent UI with NO component change.
 *
 * Scope: only presentation chrome (titles, status words, buttons). Pedagogical
 * CONTENT (module titles, band labels, language names) is data from the API, not
 * here. Adding a new interface language = one more entry below.
 *
 * The conversation description is a TEMPLATE parameterized by the learning
 * language display name (data from the API), so it is never "praticar inglês".
 */
export interface CurriculumUiStrings {
  planTitle: string;
  planIntro: string;
  loadingPlan: string;
  loadError: string;
  retry: string;
  curriculumCompletedTitle: string;
  curriculumCompletedBody: string;
  // Level/module status (text, never color-only)
  statusCompleted: string;   // level + module
  statusYourLevel: string;   // level: current
  statusYouAreHere: string;  // module: current
  statusFuture: string;
  // Level detail
  backToLevels: string;
  modulesComingSoon: string;
  // Module steps (etapas) — the recorte granularity, shown with friendly words
  // only (never "recorte"/"subtopic"/semantic keys).
  stepsLabel: string;                                    // "Etapas"
  stepsProgress: (done: number, total: number) => string;        // "2 de 4 etapas"
  stepsCompletedCount: (done: number, total: number) => string;  // "2 de 4 etapas concluídas"
  stepCompleted: string;                                 // "Concluída"
  stepCurrent: string;                                   // "Atual"
  stepFuture: string;                                    // "Futuro"
  backToModules: string;                                 // back from module detail
  // Modality preferences
  modalitiesTitle: string;
  modalitiesIntro: (emphasis: string) => string;
  modalitiesIntroEmphasis: string;
  loadingPrefs: string;
  prefsLoadError: string;
  atLeastOne: string;
  saving: string;
  saved: string;
  saveError: string;
  modalityWriting: string;
  modalityListening: string;
  modalityPronunciation: string;
  modalityConversation: string;
  descWriting: string;
  descListening: string;
  descPronunciation: string;
  /** Parameterized by the learning-language display name (data-driven). */
  descConversation: (language: string) => string;
  warnConversation: string;
  includeInPlan: string;   // aria: include
  removeFromPlan: string;  // aria: remove
  // Home "Foco atual" block (current curriculum recorte)
  focusEyebrow: string;        // "Foco atual"
  focusInitializing: string;   // curriculum still bootstrapping
  focusCompleted: string;      // curriculum fully completed
  focusUnavailable: string;    // legitimate absence / config issue
  // Conversation mode chooser (guided vs free)
  conversationChooserTitle: string; // "Como você quer conversar?"
  conversationGuidedTitle: string;
  conversationFreeTitle: string;
  conversationGuidedDesc: string;
  conversationFreeDesc: string;
  /** "Foco: <recorte>" — parameterized by the localized recorte title (data). */
  conversationFocusLabel: (focus: string) => string;
  conversationRecommended: string;   // badge on the recommended (guided) option
  // Conversation LANGUAGE chooser (English-only vs Bilingual PT+EN) — shown
  // before every new session, orthogonal to guided/free.
  conversationLanguageChooserTitle: string;
  conversationLanguageEnglishTitle: string;
  conversationLanguageEnglishDesc: string;
  conversationLanguageBilingualTitle: string;
  conversationLanguageBilingualDesc: string;
}

const PT_BR: CurriculumUiStrings = {
  planTitle: 'Plano de ensino',
  planIntro: 'Toque em um nível para ver os módulos que ele contém. Você pode visualizar níveis futuros livremente — isso não altera o seu progresso.',
  loadingPlan: 'Carregando seu plano…',
  loadError: 'Não foi possível carregar seu plano de ensino.',
  retry: 'Tentar novamente',
  curriculumCompletedTitle: 'Currículo concluído',
  curriculumCompletedBody: 'Você percorreu todos os níveis do plano de ensino. Continue praticando para refinar o seu domínio.',
  statusCompleted: 'Concluído',
  statusYourLevel: 'SEU NÍVEL',
  statusYouAreHere: 'Você está aqui',
  statusFuture: 'Futuro',
  backToLevels: 'Voltar aos níveis',
  modulesComingSoon: 'Os módulos deste nível ainda serão disponibilizados.',
  stepsLabel: 'Etapas',
  stepsProgress: (done, total) => `${done} de ${total} etapas`,
  stepsCompletedCount: (done, total) => `${done} de ${total} etapas concluídas`,
  stepCompleted: 'Concluída',
  stepCurrent: 'Atual',
  stepFuture: 'Futuro',
  backToModules: 'Voltar aos módulos',
  modalitiesTitle: 'Práticas do seu plano',
  modalitiesIntro: (emphasis) => `O menu é a regra: cada prática que você selecionar aqui passa a ser ${emphasis} do seu plano de ensino.`,
  modalitiesIntroEmphasis: 'obrigatória para avançar em cada etapa',
  loadingPrefs: 'Carregando preferências…',
  prefsLoadError: 'Não foi possível carregar suas preferências.',
  atLeastOne: 'Selecione ao menos uma prática para o seu plano de ensino.',
  saving: 'Salvando…',
  saved: 'Preferências salvas.',
  saveError: 'Não foi possível salvar. Tente novamente.',
  modalityWriting: 'Escrita',
  modalityListening: 'Listening',
  modalityPronunciation: 'Pronúncia',
  modalityConversation: 'Conversação IA',
  descWriting: 'Escrever um texto e revisá-lo com a IA fará parte das práticas necessárias para avançar em cada etapa.',
  descListening: 'Ouvir uma história e responder às perguntas fará parte das práticas necessárias para avançar em cada etapa.',
  descPronunciation: 'Treinar a pronúncia das palavras fará parte das práticas necessárias para avançar em cada etapa.',
  descConversation: (language) => `Converse com o tutor virtual para praticar ${language} falado.`,
  warnConversation: 'Ao incluir Conversação IA no seu plano de ensino, uma conversa guiada fará parte das práticas necessárias para avançar em cada etapa e utilizará seus minutos disponíveis.',
  includeInPlan: 'Incluir',
  removeFromPlan: 'Remover',
  focusEyebrow: 'Foco atual',
  focusInitializing: 'Preparando seu plano de ensino…',
  focusCompleted: 'Currículo concluído — continue praticando para refinar seu domínio.',
  focusUnavailable: 'Seu foco de estudo aparecerá aqui.',
  conversationChooserTitle: 'Como você quer conversar?',
  conversationGuidedTitle: 'Conversa guiada',
  conversationFreeTitle: 'Conversa livre',
  conversationGuidedDesc: 'Pratique o foco atual do seu plano.',
  conversationFreeDesc: 'Converse livremente sobre qualquer assunto.',
  conversationFocusLabel: (focus) => `Foco: ${focus}`,
  conversationRecommended: 'Recomendado',
  conversationLanguageChooserTitle: 'Idioma da conversa',
  conversationLanguageEnglishTitle: 'Inglês',
  conversationLanguageEnglishDesc: 'Conversa totalmente em inglês.',
  conversationLanguageBilingualTitle: 'Português + Inglês',
  conversationLanguageBilingualDesc: 'Receba explicações em português enquanto pratica inglês.',
};

const EN: CurriculumUiStrings = {
  planTitle: 'Teaching plan',
  planIntro: 'Tap a level to see the modules it contains. You can freely browse future levels — it does not change your progress.',
  loadingPlan: 'Loading your plan…',
  loadError: 'Could not load your teaching plan.',
  retry: 'Try again',
  curriculumCompletedTitle: 'Curriculum completed',
  curriculumCompletedBody: 'You have gone through every level of the teaching plan. Keep practising to refine your mastery.',
  statusCompleted: 'Completed',
  statusYourLevel: 'YOUR LEVEL',
  statusYouAreHere: 'You are here',
  statusFuture: 'Upcoming',
  backToLevels: 'Back to levels',
  modulesComingSoon: 'The modules for this level are not available yet.',
  stepsLabel: 'Steps',
  stepsProgress: (done, total) => `${done} of ${total} steps`,
  stepsCompletedCount: (done, total) => `${done} of ${total} steps completed`,
  stepCompleted: 'Completed',
  stepCurrent: 'Current',
  stepFuture: 'Upcoming',
  backToModules: 'Back to modules',
  modalitiesTitle: 'Practices in your plan',
  modalitiesIntro: (emphasis) => `The menu is the rule: every practice you select here becomes ${emphasis} of your teaching plan.`,
  modalitiesIntroEmphasis: 'required to advance at every step',
  loadingPrefs: 'Loading preferences…',
  prefsLoadError: 'Could not load your preferences.',
  atLeastOne: 'Select at least one practice for your teaching plan.',
  saving: 'Saving…',
  saved: 'Preferences saved.',
  saveError: 'Could not save. Try again.',
  modalityWriting: 'Writing',
  modalityListening: 'Listening',
  modalityPronunciation: 'Pronunciation',
  modalityConversation: 'AI Conversation',
  descWriting: 'Writing a text and reviewing it with the AI will be one of the practices required to advance at every step.',
  descListening: 'Listening to a story and answering the questions will be one of the practices required to advance at every step.',
  descPronunciation: 'Training word pronunciation will be one of the practices required to advance at every step.',
  descConversation: (language) => `Talk with the virtual tutor to practise spoken ${language}.`,
  warnConversation: 'Adding AI Conversation to your teaching plan makes a guided conversation one of the practices required to advance at every step, and it uses your available minutes.',
  includeInPlan: 'Include',
  removeFromPlan: 'Remove',
  focusEyebrow: 'Current focus',
  focusInitializing: 'Setting up your teaching plan…',
  focusCompleted: 'Curriculum completed — keep practising to refine your mastery.',
  focusUnavailable: 'Your study focus will appear here.',
  conversationChooserTitle: 'How do you want to talk?',
  conversationGuidedTitle: 'Guided conversation',
  conversationFreeTitle: 'Free conversation',
  conversationGuidedDesc: "Practise your plan's current focus.",
  conversationFreeDesc: 'Talk freely about any topic.',
  conversationFocusLabel: (focus) => `Focus: ${focus}`,
  conversationRecommended: 'Recommended',
  conversationLanguageChooserTitle: 'Conversation language',
  conversationLanguageEnglishTitle: 'English',
  conversationLanguageEnglishDesc: 'A conversation entirely in English.',
  conversationLanguageBilingualTitle: 'Portuguese + English',
  conversationLanguageBilingualDesc: 'Get explanations in Portuguese while you practise English.',
};

const STRINGS: Record<string, CurriculumUiStrings> = { 'pt-BR': PT_BR, en: EN };

/** Resolves the UI strings for an interface language (falls back to pt-BR). */
export function curriculumUiStrings(interfaceLanguage: string | null | undefined): CurriculumUiStrings {
  const code = (interfaceLanguage ?? '').trim();
  return STRINGS[code] ?? STRINGS[code.split('-')[0]] ?? PT_BR;
}
