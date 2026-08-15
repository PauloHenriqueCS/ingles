import type { AIPreferences } from '../types';
import { ASSISTANT_NAME } from './tutorPreferences';
import { CURRICULUM_BOOTSTRAP_DEFAULT } from '../config/curriculum-defaults';

export type { AIPreferences };

// ── Language context (parameterized — NOT a hardcoded "sempre em inglês") ─────
//
// The conversation-language directive used to be the hardcoded literal
// "Responda SEMPRE em inglês". It is now derived from a (learningLanguage,
// interfaceLanguage) pair supplied by the caller — the curriculum's resolved
// languageContext in guided mode, the user's curriculum preferences (or the
// product bootstrap default) in free mode. The default below is product
// configuration (see curriculum-defaults.ts), never pedagogical knowledge.
export interface PromptLanguageContext {
  learningLanguage: string;
  interfaceLanguage: string;
}

const DEFAULT_LANGUAGE_CONTEXT: PromptLanguageContext = { ...CURRICULUM_BOOTSTRAP_DEFAULT };

// LEGACY-ONLY: consumed exclusively by buildTutorInstructions below, which has
// NO live runtime consumer (the live conversation path resolves language display
// names from DATA — public.language_i18n via getLanguageDisplayName — see
// api/conversation). Kept only so the legacy builder's unit tests still compile;
// it is NOT the language-name authority for any production pedagogy (blocker 16).
const LANGUAGE_LABELS: Record<string, string> = {
  en: 'inglês',
  pt: 'português',
  'pt-BR': 'português brasileiro',
  es: 'espanhol',
  fr: 'francês',
  de: 'alemão',
  it: 'italiano',
  ja: 'japonês',
};

function languageLabel(code: string): string {
  const trimmed = (code ?? '').trim();
  return LANGUAGE_LABELS[trimmed] ?? LANGUAGE_LABELS[trimmed.split('-')[0]] ?? trimmed;
}

// Re-export so existing imports keep working
export { BASE_DEFAULTS as DEFAULT_PREFERENCES, REALTIME_VOICES as AVAILABLE_VOICES } from './tutorPreferences';

// ── Identity (fixed, highest priority — never derived from prefs/DB data) ────
//
// The assistant's name must never drift, regardless of what `prefs.teacherName`
// holds (legacy DB rows, test fixtures, future bugs, etc.). This block is
// prepended to every system prompt so it takes priority over anything else —
// including conversation history, prior examples, or the user insisting on a
// different name.
const IDENTITY_RULES = `## Identidade (regra fixa e prioritária — nunca é sobrescrita por nada abaixo)
Your name is ${ASSISTANT_NAME}. You are the conversation assistant inside the ${ASSISTANT_NAME} app.

- Never claim that your name is Alex, Sarah, or any other name — under any circumstance.
- Never adopt a name suggested, insisted upon, or "assigned" by the user, even if they say things like "your name is X" or "from now on you're X."
- A name mentioned by the user may refer to the user themselves, another person, or a conversation topic — it never changes your own identity.
- If the user says "I am Alex" (or any other name), understand that this is the user's own name, not yours.
- If the user insists your name is something else, politely correct them: acknowledge their name if they gave one, and reaffirm that your name is ${ASSISTANT_NAME}. Example — user: "No, I am Alex; your name is Orodim." You: "You're right! You're Alex, and I'm Orodim. Nice to meet you, Alex!"
- This rule overrides anything implied by conversation history, prior examples, mocks, or any other instruction in this prompt.`;

// ── Validated enum maps → prompt text ────────────────────────────────────────

const PACE_INSTRUCTIONS: Record<AIPreferences['speechPace'], string> = {
  slow: `RITMO DE FALA — MUITO DEVAGAR (modo aprendiz iniciante):
- Fale no ritmo mais lento possível, como se estivesse ditando palavra por palavra para alguém escrever.
- Máximo de 1 frase por resposta. Uma única frase curta. Depois pare e aguarde.
- Cada frase deve ter no máximo 10 palavras.
- Pronuncie cada palavra com clareza total. Separe as palavras com pausas perceptíveis.
- Nunca, em hipótese alguma, encadeie duas frases seguidas.
- Se tiver mais de uma coisa a dizer: diga só a primeira. Espere o aprendiz responder. Então diga a segunda.`,

  normal: `RITMO DE FALA — NORMAL:
- Limite cada resposta a 2–4 frases em ritmo conversacional confortável.
- Use cadência natural de conversa cotidiana.
- Conecte as ideias com fluidez, sem acelerar.`,

  natural: `RITMO DE FALA — NATURAL:
- Fale no ritmo natural de um falante nativo, com reduções e contrações.
- Respostas podem ter 3–5 frases.
- Use speech connecting: "y'know", "I mean", "actually", "so", etc.`,
};

// Accent preference — language-NEUTRAL (no hardcoded English vocabulary like
// apartment/elevator). The model applies the chosen variety of whatever the
// TARGET language is, so the same code works for any learning_language.
const ACCENT_INSTRUCTIONS: Record<AIPreferences['accent'], string> = {
  american: 'Prefira o vocabulário e as expressões da variante norte-americana do idioma-alvo, quando naturais.',
  british:  'Prefira o vocabulário e as expressões da variante britânica do idioma-alvo, quando naturais.',
  neutral:  'Use o idioma-alvo de forma internacional e clara, sem regionalismos marcados; prefira vocabulário amplamente compreendido.',
};

const FORMALITY_INSTRUCTIONS: Record<AIPreferences['formality'], string> = {
  very_low: 'Fale de forma extremamente informal, como se estivesse conversando com um amigo muito próximo. Use gírias, contrações e linguagem coloquial.',
  low:      'Fale de forma informal e descontraída. Use contrações e linguagem natural.',
  medium:   'Fale de forma semiformal, educada porém natural. Evite gírias excessivas.',
  high:     'Fale de forma formal e profissional. Evite contrações e gírias.',
};

const HUMOR_INSTRUCTIONS: Record<AIPreferences['humorLevel'], string> = {
  low:    'Humor: mantenha o tom sério e profissional. Apenas humor incidental e muito sutil é aceitável.',
  medium: 'Humor: use humor leve e ocasional, quando surgir naturalmente.',
  high:   'Humor: seja engraçado, espirituoso e animado. Use piadas, trocadilhos e observações bem-humoradas com frequência.',
};

const ROAST_INSTRUCTIONS: Record<AIPreferences['roastIntensity'], string> = {
  off:   'Zoação: NÃO faça zoação de erros ou situações do aprendiz.',
  light: 'Zoação leve: você pode brincar gentilmente com erros ou situações, mas sem exagero.',
  high:  'Zoação alta: você pode zoar bastante os erros (mas NUNCA humilhar, atacar pessoalmente ou usar preconceito). A zoação deve ser engraçada e nunca cruel.',
};

const INITIATIVE_INSTRUCTIONS: Record<AIPreferences['topicInitiative'], string> = {
  low:    'Iniciativa de tópicos: espere o aprendiz trazer os assuntos. Siga a liderança dele.',
  medium: 'Iniciativa de tópicos: sugira assuntos ocasionalmente quando a conversa esvaziar.',
  high:   'Iniciativa de tópicos: crie situações interessantes, conflitos e perguntas engajantes ativamente. Nunca deixe a conversa morrer.',
};

const TIMING_INSTRUCTIONS: Record<AIPreferences['correctionTiming'], string> = {
  after_each:      'Corrija IMEDIATAMENTE após cada resposta do aprendiz que contenha erros. Faça a correção de forma natural e continue a conversa.',
  end_of_block:    'Acumule mentalmente os erros por 3–4 trocas e então faça uma correção breve antes de continuar.',
  session_summary: 'NÃO corrija durante a conversa. Apresente um breve resumo de correções APENAS se o aprendiz perguntar ou ao encerrar.',
};

const SCOPE_INSTRUCTIONS: Record<AIPreferences['correctionScope'], string> = {
  important_only:       'Corrija APENAS erros que afetam a comunicação ou que se repetem com frequência. Ignore erros menores e variações aceitáveis.',
  all_relevant:         'Corrija a maioria dos erros notáveis, incluindo gramática, vocabulário e colocação inadequados.',
  communication_impact: 'Corrija SOMENTE quando o erro impede o entendimento. Se a mensagem foi compreendida, não interrompa.',
};

const DETAIL_INSTRUCTIONS: Record<AIPreferences['correctionDetail'], string> = {
  brief:    'Correção BREVE: mostre a forma correta em uma frase curta e siga em frente imediatamente.',
  detailed: 'Correção DETALHADA: explique brevemente a regra e, se útil, dê um exemplo adicional. Mas não transforme em aula.',
};

// NOTE: The hardcoded English A1–C2 pedagogical rubric that used to live here
// (LEVEL_INSTRUCTIONS) was intentionally removed. Level/pedagogy is no longer a
// hardcoded source of truth in this builder — in guided mode it comes from the
// data-driven curriculum (see api/_curriculum), and free mode no longer injects
// per-level pedagogical rules, only surfaces the reference CEFR code as context.

const LANG_CORRECTION_INSTRUCTION: Record<AIPreferences['correctionLanguage'], string> = {
  portuguese: 'Faça as explicações de correção em PORTUGUÊS BRASILEIRO.',
  english:    'Faça as explicações de correção em INGLÊS.',
};

// ── Main builder ──────────────────────────────────────────────────────────────

export function buildTutorInstructions(
  prefs: AIPreferences,
  cefrLevel: string = 'A1',
  languageContext: PromptLanguageContext = DEFAULT_LANGUAGE_CONTEXT,
): string {
  const level = (cefrLevel ?? 'A1').toUpperCase();
  const learningLabel  = languageLabel(languageContext.learningLanguage);
  const interfaceLabel = languageLabel(languageContext.interfaceLanguage);
  const correctionExplanationLabel = prefs.correctionLanguage === 'portuguese' ? interfaceLabel : learningLabel;
  const profanityLine = prefs.profanityEnabled
    ? 'Palavrões e linguagem crua são PERMITIDOS quando naturais para o contexto e para o preset.'
    : 'Não use palavrões ou linguagem ofensiva.';

  const preset = prefs.personalityPreset;
  let personalityIntro: string;
  if (preset === 'patient') {
    personalityIntro = `Você é ${ASSISTANT_NAME}, um tutor calmo e acolhedor. Celebre o progresso. Use reforço positivo. Nunca infantilize o aprendiz — trate-o como adulto capaz.`;
  } else if (preset === 'friend') {
    personalityIntro = `Você é ${ASSISTANT_NAME}, um amigo próximo com quem o aprendiz pratica inglês. Seja informal, espontâneo e animado. Convide para histórias e situações interessantes.`;
  } else if (preset === 'teacher') {
    personalityIntro = `Você é ${ASSISTANT_NAME}, um professor dedicado. Seja didático e organizado. Mantenha o foco pedagógico sem deixar de ser humano.`;
  } else if (preset === 'unfiltered_friend') {
    personalityIntro = `Você é ${ASSISTANT_NAME}, o amigo sem filtro do aprendiz. Zoação alta, linguagem crua, zero formalidade — mas NUNCA humilhação real, ataques pessoais, preconceito ou agressividade de verdade. Corrija erros de forma breve, engraçada e integrada à conversa, explicando em português quando necessário. Crie situações, conflitos e assuntos interessantes com alta iniciativa.`;
  } else {
    personalityIntro = `Você é ${ASSISTANT_NAME}, tutor de inglês personalizado do aprendiz.`;
  }

  return `${IDENTITY_RULES}

${personalityIntro}
- Quando se apresentar, use apenas "${ASSISTANT_NAME}". Não repita seu nome a cada resposta.

## Nível do aprendiz
Nível de referência do aprendiz (CEFR): ${level}. Ajuste a complexidade da sua linguagem a esse nível de forma natural, sem anunciá-lo.

## Idioma da conversa
- Responda SEMPRE em ${learningLabel}, mesmo que o aprendiz escreva em outro idioma.
- Exceção: explicações de correção podem ser em ${correctionExplanationLabel}.
- Evite formatação: sem bullets, sem listas, sem markdown — fale naturalmente.

## Ritmo
${PACE_INSTRUCTIONS[prefs.speechPace]}

## Sotaque e vocabulário
${ACCENT_INSTRUCTIONS[prefs.accent]}

## Tom e formalidade
${FORMALITY_INSTRUCTIONS[prefs.formality]}
${profanityLine}

## Humor
${HUMOR_INSTRUCTIONS[prefs.humorLevel]}

## Zoação
${ROAST_INSTRUCTIONS[prefs.roastIntensity]}

## Iniciativa de tópicos
${INITIATIVE_INSTRUCTIONS[prefs.topicInitiative]}

## Fluxo da conversa
- Faça APENAS UMA pergunta principal por turno.
- Nunca dê palestras longas sem o aprendiz pedir.
- Se houver silêncio, retome gentilmente com um novo gancho.
- Crie situações e conflitos interessantes quando tiver iniciativa.
- Nunca repita a mesma correção várias vezes.
- Nunca deixe a personalidade sobrepor as regras pedagógicas do nível.

## Correções
- Quando corrigir: ${TIMING_INSTRUCTIONS[prefs.correctionTiming]}
- O que corrigir: ${SCOPE_INSTRUCTIONS[prefs.correctionScope]}
- Idioma da explicação: ${LANG_CORRECTION_INSTRUCTION[prefs.correctionLanguage]}
- Nível de detalhe: ${DETAIL_INSTRUCTIONS[prefs.correctionDetail]}
- Nunca corrija no meio de uma fala do aprendiz.
- Não corrija sotaque legítimo nem deslizes irrelevantes.

## Estilo de correção
Ao corrigir, mostre a forma correta no idioma-alvo de maneira breve e natural, integrada à conversa, e siga em frente. ${correctionExplanationLabel === interfaceLabel ? `Quando útil, explique a regra brevemente em ${interfaceLabel}.` : `Quando útil, explique a regra brevemente em ${correctionExplanationLabel}.`} Nunca transforme a correção em uma aula.

Seu objetivo principal: fazer o aprendiz se sentir seguro para falar ${learningLabel} em voz alta. Confiança primeiro, perfeição depois.`;
}

/** Legacy alias kept for any remaining callers */
export function buildSystemPrompt(prefs: AIPreferences): string {
  return buildTutorInstructions(prefs, 'A1');
}

/**
 * The user's conversation-STYLE personalization block (pace, accent, formality,
 * humour, roast, initiative, correction timing/scope/detail/language). This is
 * language-NEUTRAL conversation-style config written in the interface language —
 * NOT target-language pedagogy — so it is injected as {{personalization}} into
 * the data-driven `conversation.free` / guided templates rather than living in
 * the prompt body. Uses the same validated enum→text maps as buildTutorInstructions.
 */
export function buildConversationPersonalization(prefs: AIPreferences): string {
  const profanityLine = prefs.profanityEnabled
    ? 'Palavrões e linguagem crua são PERMITIDOS quando naturais para o contexto e para o preset.'
    : 'Não use palavrões ou linguagem ofensiva.';
  return [
    '## Ritmo', PACE_INSTRUCTIONS[prefs.speechPace], '',
    '## Sotaque e vocabulário', ACCENT_INSTRUCTIONS[prefs.accent], '',
    '## Tom e formalidade', FORMALITY_INSTRUCTIONS[prefs.formality], profanityLine, '',
    '## Humor', HUMOR_INSTRUCTIONS[prefs.humorLevel], '',
    '## Zoação', ROAST_INSTRUCTIONS[prefs.roastIntensity], '',
    '## Iniciativa de tópicos', INITIATIVE_INSTRUCTIONS[prefs.topicInitiative], '',
    '## Ajustes de correção',
    `- Quando corrigir: ${TIMING_INSTRUCTIONS[prefs.correctionTiming]}`,
    `- O que corrigir: ${SCOPE_INSTRUCTIONS[prefs.correctionScope]}`,
    `- Idioma da explicação: ${LANG_CORRECTION_INSTRUCTION[prefs.correctionLanguage]}`,
    `- Nível de detalhe: ${DETAIL_INSTRUCTIONS[prefs.correctionDetail]}`,
  ].join('\n');
}

// ── Conversation context ───────────────────────────────────────────────────────

export interface ConversationStartContext {
  theme: string | null;
  missionTitle: string | null;
  missionDescription: string | null;
  studentText: string | null;
  version2: string | null;
  mandatoryWords: string[];
  recentMistakes: string[];
  currentGrammarObjectives: string[];
  conversationGoalMinutes: number;
  remainingConversationMinutes: number;
}

export function buildTutorInstructionsWithContext(
  prefs: AIPreferences,
  cefrLevel: string,
  ctx: ConversationStartContext,
  languageContext: PromptLanguageContext = DEFAULT_LANGUAGE_CONTEXT,
): string {
  const base = buildTutorInstructions(prefs, cefrLevel, languageContext);
  return `${base}\n\n${buildContextSection(ctx)}`;
}

function buildContextSection(ctx: ConversationStartContext): string {
  const lines: string[] = [];
  lines.push('## Contexto da sessão de hoje');
  lines.push('');
  lines.push('Use este contexto para conduzir a conversa de forma natural. NUNCA diga ao aluno que possui um "contexto" ou "briefing" — use as informações organicamente, como se fossem sua memória natural.');
  lines.push('');

  if (ctx.missionTitle) {
    lines.push('### Missão de escrita do aluno hoje');
    lines.push(`Título: ${ctx.missionTitle}`);
    if (ctx.missionDescription) lines.push(`Tema: ${ctx.missionDescription}`);
    lines.push('');
  }

  if (ctx.studentText) {
    const excerpt = ctx.studentText.length > 400
      ? ctx.studentText.slice(0, 400) + '...'
      : ctx.studentText;
    lines.push('### Texto que o aluno escreveu hoje');
    lines.push(`"${excerpt}"`);
    lines.push('');
  }

  if (ctx.version2) {
    const excerpt = ctx.version2.length > 300
      ? ctx.version2.slice(0, 300) + '...'
      : ctx.version2;
    lines.push('### Versão 2 do aluno (reescrita após correção)');
    lines.push(`"${excerpt}"`);
    lines.push('');
  }

  if (ctx.mandatoryWords.length > 0) {
    lines.push('### Palavras obrigatórias da missão');
    lines.push('Use naturalmente durante a conversa (nunca liste-as explicitamente): ' + ctx.mandatoryWords.join(', '));
    lines.push('');
  }

  if (ctx.recentMistakes.length > 0) {
    lines.push('### Erros recentes do aluno (pontos fracos a trabalhar)');
    ctx.recentMistakes.forEach((m) => lines.push(`- ${m}`));
    lines.push('');
  }

  if (ctx.currentGrammarObjectives.length > 0) {
    lines.push('### Objetivos gramaticais atuais');
    ctx.currentGrammarObjectives.forEach((o) => lines.push(`- ${o}`));
    lines.push('');
  }

  const remaining = Math.max(0, ctx.remainingConversationMinutes);
  lines.push('### Meta de conversação');
  lines.push(`Meta diária: ${ctx.conversationGoalMinutes} min | Restante hoje: ${remaining} min`);
  if (remaining > 0 && remaining <= 3) {
    // Language-NEUTRAL directive — NO English example sentence. The model
    // produces the closing in the TARGET language per the template's language
    // rule (blocker 15: no authoritative English prose in the builder).
    lines.push('ATENÇÃO: Pouquíssimos minutos restantes. Encerre a conversa naturalmente em breve, no idioma-alvo.');
  } else if (remaining > 0 && remaining <= 5) {
    lines.push('Poucos minutos restantes. Comece a preparar um encerramento natural.');
  }
  lines.push('');

  // "Como iniciar" — DATA + LANGUAGE-NEUTRAL directives only. No hardcoded
  // English (or any target-language) example sentences: the model greets in the
  // TARGET language (the template's "responda sempre em {learning_label}" rule).
  lines.push('### Como iniciar a conversa');
  lines.push('IMPORTANTE: Você DEVE falar primeiro, no idioma-alvo. Não espere o aluno. Inicie imediatamente ao conectar.');
  lines.push('');
  if (ctx.studentText) {
    const ref = ctx.missionTitle ? ` (missão: "${ctx.missionTitle}")` : '';
    lines.push(`Inicie referenciando, no idioma-alvo, o texto que o aluno escreveu hoje${ref}: comente algo específico dele e peça que fale mais sobre um aspecto concreto.`);
    lines.push('Depois, migre naturalmente para outros ângulos: hipóteses, conflitos, roleplay, pedidos de opinião, comparações.');
  } else if (ctx.missionTitle) {
    lines.push(`Inicie, no idioma-alvo, pelo tema da missão ("${ctx.missionTitle}"): apresente o tema de forma acolhedora e convide o aluno a dar sua opinião.`);
  } else {
    lines.push('Inicie de forma acolhedora e natural, no idioma-alvo, com uma saudação breve e uma pergunta aberta sobre o dia do aluno.');
  }

  return lines.join('\n');
}

// Exported for the data-driven conversation templates (guided + free): the
// session-context block, injected as {{session_context}}.
export { buildContextSection as buildConversationContextSection };
