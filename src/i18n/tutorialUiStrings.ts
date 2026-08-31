/**
 * Interface-language localization for the FIRST-RUN HOME TUTORIAL (walkthrough) —
 * following the exact pattern of homeUiStrings / curriculumUiStrings: ONE place
 * keyed by interface_language, never strings scattered across the component. The
 * interface language comes from the same server-resolved source the Home uses
 * (curriculum progress payload → interfaceLanguage). Falls back to pt-BR.
 *
 * The pt-BR copy is the semantic intent defined by the product spec; the English
 * copy is a natural translation of that intent.
 */

interface ModalityCopy {
  name: string;
  desc: string;
}
interface MenuItemCopy {
  label: string;
  desc: string;
}

export interface TutorialUiStrings {
  // Accessible dialog label + persistent controls (present on EVERY step).
  dialogLabel: string;
  skip: string; // "Pular tutorial" — permanently accessible in every step (§4)
  next: string;
  back: string;
  progress: (current: number, total: number) => string; // "2 de 7"

  // Step 1 — Bem-vindo (centered)
  step1: { title: string; body: string; cta: string };
  // Step 2 — Seu foco atual (spotlight: current-focus) + discreet streak note (§6)
  step2: { title: string; body: string; streakNote: string };
  // Step 3 — Próxima prática recomendada (spotlight: recommended-practice)
  step3: { title: string; body: string };
  // Step 4 — Pratique de várias formas (spotlight: practice-list)
  step4: {
    title: string;
    body: string;
    writing: ModalityCopy;
    pronunciation: ModalityCopy;
    listening: ModalityCopy;
    conversation: ModalityCopy;
  };
  // Step 5 — Seus erros viram treino (spotlight: error-review)
  step5: { title: string; body: string };
  // Step 6 — Acompanhe seu progresso (spotlight: main-menu)
  step6: {
    title: string;
    body: string;
    plan: MenuItemCopy;
    calendar: MenuItemCopy;
    history: MenuItemCopy;
    evolution: MenuItemCopy;
    reminder: MenuItemCopy;
  };
  // Step 7 — Pronto para começar (centered)
  step7: { title: string; body: string; cta: string };
}

const PT_BR: TutorialUiStrings = {
  dialogLabel: 'Tutorial do Orodim',
  skip: 'Pular tutorial',
  next: 'Próximo',
  back: 'Voltar',
  progress: (current, total) => `${current} de ${total}`,

  step1: {
    title: 'Seu inglês, na prática',
    body: 'O Orodim organiza o que você precisa estudar e transforma isso em prática de escrita, pronúncia, listening e conversação.',
    cta: 'Conhecer o Orodim',
  },
  step2: {
    title: 'Saiba o que estudar',
    body: 'Aqui você vê o ponto do inglês em que está trabalhando agora. O conteúdo evolui junto com o seu progresso.',
    streakNote: 'Praticar nos dias planejados mantém a sua sequência viva.',
  },
  step3: {
    title: 'Sempre saiba o que fazer',
    body: 'O Orodim recomenda a próxima prática para você continuar avançando sem precisar escolher o que estudar toda vez.',
  },
  step4: {
    title: 'Pratique inglês de verdade',
    body: 'Quatro formas de praticar, sempre ligadas ao seu foco atual:',
    writing: { name: 'Escrita', desc: 'Escreva e receba uma análise do seu texto.' },
    pronunciation: {
      name: 'Pronúncia',
      desc: 'Grave sua voz e veja, palavra por palavra, o que pronunciou bem e o que melhorar.',
    },
    listening: { name: 'Listening', desc: 'Ouça inglês e responda sobre o que entendeu.' },
    conversation: { name: 'Conversação', desc: 'Converse com a IA e pratique em situações reais.' },
  },
  step5: {
    title: 'Aprenda com seus erros',
    body: 'Os erros das suas práticas podem voltar como revisão, para você reforçar exatamente o que precisa melhorar.',
  },
  step6: {
    title: 'Seu progresso fica registrado',
    body: 'Use o menu para acompanhar sua jornada:',
    plan: { label: 'Plano de ensino', desc: 'veja o que vem pela frente.' },
    calendar: { label: 'Calendário', desc: 'acompanhe seus dias de prática.' },
    history: { label: 'Histórico', desc: 'reveja suas atividades.' },
    evolution: { label: 'Evolução', desc: 'acompanhe seu desenvolvimento.' },
    reminder: { label: 'Lembrete', desc: 'escolha quando praticar.' },
  },
  step7: {
    title: 'Tudo pronto',
    body: 'Agora é só praticar. O Orodim cuida do caminho e mostra onde você pode melhorar.',
    cta: 'Começar a praticar',
  },
};

const EN: TutorialUiStrings = {
  dialogLabel: 'Orodim tutorial',
  skip: 'Skip tutorial',
  next: 'Next',
  back: 'Back',
  progress: (current, total) => `${current} of ${total}`,

  step1: {
    title: 'Your English, in practice',
    body: 'Orodim organizes what you need to study and turns it into writing, pronunciation, listening and conversation practice.',
    cta: 'Take the tour',
  },
  step2: {
    title: 'Know what to study',
    body: "This shows the exact point in your English you're working on right now. The content evolves as you progress.",
    streakNote: 'Practicing on your planned days keeps your streak alive.',
  },
  step3: {
    title: 'Always know what to do next',
    body: 'Orodim recommends your next practice so you keep moving forward without having to choose what to study every time.',
  },
  step4: {
    title: 'Practice real English',
    body: 'Four ways to practice, always tied to your current focus:',
    writing: { name: 'Writing', desc: 'Write and get an analysis of your text.' },
    pronunciation: {
      name: 'Pronunciation',
      desc: 'Record your voice and see, word by word, what you got right and what to improve.',
    },
    listening: { name: 'Listening', desc: 'Listen to English and answer about what you understood.' },
    conversation: { name: 'Conversation', desc: 'Chat with the AI and practice in real situations.' },
  },
  step5: {
    title: 'Learn from your mistakes',
    body: 'Mistakes from your practices can come back as review, so you reinforce exactly what you need to improve.',
  },
  step6: {
    title: 'Your progress is saved',
    body: 'Use the menu to follow your journey:',
    plan: { label: 'Teaching plan', desc: "see what's coming up next." },
    calendar: { label: 'Calendar', desc: 'track your practice days.' },
    history: { label: 'History', desc: 'revisit your activities.' },
    evolution: { label: 'Progress', desc: 'follow your development.' },
    reminder: { label: 'Reminder', desc: 'choose when to practice.' },
  },
  step7: {
    title: "You're all set",
    body: 'Now just practice. Orodim handles the path and shows you where to improve.',
    cta: 'Start practicing',
  },
};

const STRINGS: Record<string, TutorialUiStrings> = { 'pt-BR': PT_BR, en: EN };

/** Resolves tutorial UI strings for an interface language (falls back to pt-BR). */
export function tutorialUiStrings(interfaceLanguage: string | null | undefined): TutorialUiStrings {
  const code = (interfaceLanguage ?? '').trim();
  return STRINGS[code] ?? STRINGS[code.split('-')[0]] ?? PT_BR;
}
