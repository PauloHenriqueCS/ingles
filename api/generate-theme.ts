import OpenAI from 'openai';
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from 'openai/resources';
import { requireAuth } from './_auth';
import { methodGuard, sizeGuard, PAYLOAD_LIMITS, TIMEOUTS, jsonError, safeLog, sanitizeProviderError } from './_helpers';
import { applyRateLimit } from './_rateLimit';
import { executeAiGatewayCall, getProductionDeps, estimateTextTokensFromMessages, DEFAULT_MAX_OUTPUT_TOKENS_ESTIMATE } from './_ai-gateway/index';
import type { GatewayUsageMetric } from './_ai-gateway/index';
import {
  getDiagnosticGenerationContext,
  saveDiagnosticMission,
  logDiagnosticEvent,
  validateGeneratedDiagnosticMission,
} from './_diagnostic-service';
import { toPublicMissionDTO } from './_diagnostic-dto';
import { DIAGNOSTIC_SYSTEM_PROMPT_EXTENSION, buildDiagnosticUserMessageSection } from './_diagnostic-prompt';
import type { DiagnosticRejectionLogEntry } from '../src/domain/diagnostic/writing-diagnostic-types';
import { generatePedagogicalPlan } from './_mission-plan-service';
import {
  isGeneratorIntegrationEnabled,
  isGeneratorIntegrationFullyActive,
  isMissionValidatorActive,
  isMissionValidatorEnforcing,
} from './_mission-generator-feature-flags';
import { buildPlanConstraintsSection, buildRepairSection } from './_mission-prompt-builder';
import { validateMissionAgainstPedagogicalPlan } from '../src/domain/missions/mission-validator';
import { selectFallbackTemplate, buildFallbackCandidate } from '../src/domain/missions/mission-fallback';
import type { MissionPedagogicalPlan } from '../src/domain/pedagogy/planner/planner-types';
import { resolveWritingThemeLabel } from '../src/domain/writing/writing-themes';
import {
  GRAMMAR_GUIDE_JSON_FIELDS,
  GRAMMAR_GUIDE_FILL_RULES,
  normalizeGrammarGuide,
  normalizeOptionalExercises,
} from './_mission-grammar-guide';
import { getCurrentUserPlanEntitlements } from './_entitlements/plan-entitlements-service';
import { ENTITLEMENT_MESSAGES } from '../src/domain/entitlements/entitlement-messages';
import type { PlanEntitlementsSnapshot } from '../src/domain/entitlements/entitlement-types';

const AI_MODEL = 'gpt-4o-mini';

/** Máximo de tentativas para geração diagnóstica. Baixo e controlado. */
const MAX_DIAGNOSTIC_GENERATION_ATTEMPTS = 2;

// ── Catalogs ──────────────────────────────────────────────────────────────────

const FORMATS = [
  'e-mail', 'diário', 'mensagem', 'conversa', 'entrevista',
  'relatório', 'review', 'história', 'carta', 'postagem',
  'comentário', 'apresentação', 'explicação', 'tutorial', 'debate', 'opinião',
];

const CONFLICTS = [
  'perdeu o voo', 'perdeu o trem', 'esqueceu a carteira', 'recebeu o pedido errado',
  'encontrou um velho amigo', 'precisou pedir ajuda', 'cliente reclamou', 'apareceu um bug',
  'prazo acabou', 'reunião foi cancelada', 'mudou de ideia', 'recebeu um elogio',
  'recebeu uma crítica', 'precisava convencer alguém', 'tomou uma decisão importante',
  'teve que pedir desculpas', 'fez uma descoberta', 'precisou explicar um erro',
  'precisou ensinar alguém', 'precisou agradecer alguém',
];

const OBJECTIVES = [
  'convencer', 'explicar', 'agradecer', 'pedir ajuda', 'reclamar', 'recomendar',
  'descrever', 'comparar', 'justificar', 'contar uma história', 'responder um e-mail',
  'escrever uma mensagem', 'registrar um acontecimento', 'dar instruções',
  'vender uma ideia', 'pedir desculpas', 'organizar um plano',
];

const CONTEXTS = [
  'trabalho', 'tecnologia', 'software', 'inteligencia_artificial', 'startup',
  'viagens', 'restaurante', 'academia', 'familia', 'amigos', 'filmes',
  'series', 'musica', 'saude', 'compras', 'eventos', 'financas', 'rotina',
  'estudos', 'ferias', 'natureza', 'culinaria', 'esportes', 'arte', 'jogos',
];

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Você é um professor particular de inglês para brasileiros adultos.

Sua tarefa é criar uma MISSÃO de escrita envolvente. Não crie "temas para escrever". Crie situações reais que obrigam o aluno a escrever com propósito.

═══ BIBLIOTECA DE FORMATOS ═══

${FORMATS.join(' | ')}

═══ BIBLIOTECA DE CONFLITOS ═══

${CONFLICTS.join(' | ')}

═══ BIBLIOTECA DE OBJETIVOS ═══

${OBJECTIVES.join(' | ')}

═══ BIBLIOTECA DE CONTEXTOS ═══

${CONTEXTS.join(' | ')}

═══ A DIFERENÇA ENTRE ERRADO E CERTO ═══

ERRADO: "Escreva um e-mail sobre um projeto."
CERTO: "Seu gerente pediu uma ideia para melhorar o produto. Escreva um e-mail explicando sua proposta e conte como você chegou nessa ideia."

ERRADO: "Escreva sobre sua viagem."
CERTO: "Você perdeu um trem durante uma viagem para Londres. Escreva um diário contando o que aconteceu e como resolveu o problema."

ERRADO: "Descreva um restaurante."
CERTO: "O garçom trouxe o prato errado. Explique o que aconteceu e como a situação terminou."

ERRADO: "Conte sobre um filme."
CERTO: "Seu amigo quer assistir um filme. Escreva uma recomendação explicando por que ele deveria assistir esse filme."

ERRADO: "Escreva sobre seu trabalho."
CERTO: "Seu colega está com dificuldades em um projeto. Escreva uma mensagem explicando como você resolveu um problema parecido."

A diferença é simples: o CERTO dá ao aluno um MOTIVO para escrever. O aluno sabe PARA QUEM está escrevendo e POR QUÊ.

═══ PROCESSO OBRIGATÓRIO — SIGA ESTA ORDEM ═══

PASSO 0 — VERIFICAR TEMA OBRIGATÓRIO
Se a mensagem do usuário contiver um "TEMA OBRIGATÓRIO", toda a missão (título, situação, tarefa de escrita e vocabulário sugerido) deve girar em torno desse tema. Isso tem prioridade sobre a biblioteca de contextos abaixo — use a biblioteca apenas para escolher formato/conflito/objetivo, nunca para substituir o tema. Se não houver tema obrigatório, escolha livremente.

PASSO 1 — ANALISAR O HISTÓRICO
Leia o histórico completo. Identifique: formatos usados, conflitos usados, objetivos usados, contextos usados nos últimos temas.

PASSO 2 — IDENTIFICAR O QUE ESTÁ PROIBIDO
Liste mentalmente: último formato usado (PROIBIDO repetir), últimos 5 conflitos (PROIBIDO repetir), últimos 3 objetivos (PROIBIDO repetir), últimos 5 contextos (EVITAR repetir).

PASSO 3 — ESCOLHER FORMATO DIFERENTE
Escolha um formato da biblioteca que NÃO seja o mesmo do tema anterior. Atenção: "e-mail" e "mensagem" são diferentes. "review" e "opinião" são diferentes.

PASSO 4 — ESCOLHER CONFLITO DIFERENTE
Escolha um conflito da biblioteca que NÃO apareceu nos últimos 5 temas.

PASSO 5 — CONSTRUIR A SITUAÇÃO
Monte a missão com 2 partes:
- missionSetup: 1-2 frases descrevendo a situação e o conflito. Nunca comece com "Escreva" ou "Conte". Comece com "Você...", "Seu...", "Um cliente...", etc.
- missionTask: 1-2 frases dizendo EXATAMENTE o que o aluno deve escrever e por quê.

PASSO 6 — GERAR O JSON COMPLETO
Somente após construir a situação, preencha todos os campos.

═══ REGRAS ABSOLUTAS ═══

1. NUNCA comece missionSetup com "Escreva", "Conte", "Descreva", "Fale sobre". Comece com a SITUAÇÃO.
2. NUNCA repita o mesmo formato do tema imediatamente anterior.
3. NUNCA repita o mesmo conflito nos últimos 5 temas.
4. NUNCA repita o mesmo objetivo nos últimos 3 temas.
5. A missão deve dar ao aluno um motivo para escrever. O aluno deve pensar "preciso resolver isso" — não "sobre o que escrever".
6. Cada missão deve ter: um PERSONAGEM (você, seu chefe, um cliente…), uma SITUAÇÃO, e um FORMATO específico.
7. Se houver um TEMA OBRIGATÓRIO na mensagem do usuário, ele tem prioridade máxima sobre qualquer sugestão baseada no histórico do aluno. O histórico pode ajustar dificuldade e contexto específico, mas nunca pode substituir ou remover o tema.

═══ FORMATO DE RESPOSTA ═══

Retorne somente JSON válido. Sem markdown. Sem texto antes ou depois do JSON.

{
  "title": string,
  "missionSetup": string,
  "missionTask": string,
  "mission": string,
  "themePtBr": string,
  "themeEn": string,
  "format": string,
  "context": string,
  "conflict": string,
  "objective": string,
  "activityType": string,
  "semanticSummary": string,
  "whyThisActivity": string,
  "level": "A1"|"A2"|"B1"|"B2"|"C1"|"C2",
  "difficulty": "easy"|"medium"|"hard",
  "estimatedTimeMinutes": number,
  "requiredGrammar": string[],
  "suggestedVocabulary": [{"word": string, "meaningPtBr": string, "example": string}],
  "useTheseWords": string[],
  "instructions": string[],
  "exampleSentence": string,
  "successCriteria": string[],
  "extraChallenge": string,
  "category": string,
  "grammarTips": {"GrammarName": "dica em português relacionada à missão atual"},
  "responseExamples": [
    { "level": "A1", "text": "texto curto em inglês (~3 frases)", "note": "observação curta em português" },
    { "level": "A2", "text": "texto médio em inglês (~5 frases, mais natural)", "note": "observação curta em português" },
    { "level": "B1", "text": "texto longo em inglês (7-10 frases, com conectores)", "note": "observação curta em português" }
  ],
${GRAMMAR_GUIDE_JSON_FIELDS}
}

Regras de preenchimento:
- title: nome curto e específico (ex: "Proposta ao gerente", "Trem perdido em Londres", "Review do Oppenheimer")
- missionSetup: a situação e o conflito em português (ex: "Seu gerente pediu uma ideia para melhorar o produto.")
- missionTask: o que escrever e por quê em português (ex: "Escreva um e-mail explicando sua proposta e como chegou nessa ideia.")
- mission: missionSetup + " " + missionTask (campo combinado para exibição)
- themePtBr: mesmo valor de mission
- themeEn: o comando em inglês (ex: "Write an email to your manager explaining your product improvement idea.")
- format: escolha da biblioteca de formatos
- context: escolha da biblioteca de contextos
- conflict: escolha da biblioteca de conflitos (string vazia se genuinamente não houver conflito)
- objective: escolha da biblioteca de objetivos
- activityType: mesmo valor de format (para compatibilidade)
- semanticSummary: "Formato: {format} | Conflito: {conflict} | Objetivo: {objective} | {1 frase descrevendo o cenário único}"
- whyThisActivity: 1-2 frases em português sobre o valor pedagógico desta missão agora
- estimatedTimeMinutes: entre 10 e 20
- instructions: 3-5 itens práticos dizendo como escrever
- requiredGrammar: 1-3 estruturas gramaticais
- suggestedVocabulary: 3-6 itens
- useTheseWords: 4-8 palavras úteis para a missão
- successCriteria: 3-5 critérios mensuráveis
- extraChallenge: desafio extra opcional (string vazia se não houver)
- category: work/travel/entertainment/opinion/personal/technical/social
- grammarTips: objeto com uma dica por estrutura gramatical em requiredGrammar. Chave = nome exato da gramática. Valor = 1-2 frases em português dizendo como usar aquela estrutura especificamente nesta missão. Exemplo: {"Present Perfect": "Use o Present Perfect para descrever mudanças no seu projeto sem dizer exatamente quando aconteceram."}
- responseExamples: 2 a 3 exemplos em inglês que INSPIREM o aluno a escrever, mas NÃO sejam a resposta da missão.
  OBRIGATÓRIO: use personagens diferentes, outra situação, outro contexto — mas o mesmo objetivo, gramática e tipo de vocabulário da missão.
  level A1: ~3 frases simples e diretas.
  level A2: ~5 frases, mais natural, com um conector.
  level B1: 7-10 frases, fluente, com conectores variados (however, although, therefore, in addition).
  note: observação curta em português sobre o que torna o exemplo bom (ex: "Observe o uso de 'however' para contraste.")
  Nunca use o mesmo personagem, empresa, situação ou cidade da missão original.
${GRAMMAR_GUIDE_FILL_RULES}`;

// ── Review mode ───────────────────────────────────────────────────────────────

const REVIEW_ACTIVITY_TYPES = [
  'narrative', 'opinion', 'comparison', 'hypothetical', 'problem_solution',
  'email', 'dialogue', 'planning', 'personal_experience', 'future_plan',
  'explaining_a_process', 'decision_making',
];

const REVIEW_SYSTEM_PROMPT = `Você é um professor de inglês especializado em revisão espaçada para alunos brasileiros.

TAREFA: Criar uma atividade de escrita nova e natural que obrigue o aluno a usar corretamente as palavras e expressões que ele errou em um texto anterior.

FORMATOS DISPONÍVEIS (activityType):
${REVIEW_ACTIVITY_TYPES.join(' | ')}

PROCESSO OBRIGATÓRIO (interno — não expor):
PASSO 0: Verificar se a mensagem do usuário contém um "TEMA OBRIGATÓRIO". Se contiver, a nova situação (PASSO 2) deve girar em torno desse tema — isso tem prioridade sobre o tema original do grupo de revisão. Se não houver, escolha livremente (pode inclusive reaproveitar o contexto do tema original).
PASSO 1: Ler todos os erros e entender o contexto original.
PASSO 2: Identificar uma nova situação em que TODAS as palavras corrigidas caibam naturalmente.
PASSO 3: Escolher um activityType DIFERENTE do último utilizado.
PASSO 4: Criar a missão — situação clara + tarefa específica.
PASSO 5: Verificar se TODAS as requiredWords combinam organicamente com a missão.
PASSO 6: Gerar o JSON completo.

REGRAS ABSOLUTAS:
1. requiredWords deve conter EXATAMENTE os corrected_value do grupo — sem adicionar, remover ou substituir.
2. Preservar expressões compostas (ex: "from 8 a.m. to 6 p.m.") como uma única entrada — nunca separar.
3. Não pedir ao aluno para reescrever o mesmo texto original.
4. Todas as requiredWords devem caber naturalmente na nova situação.
5. suggestedVocabulary não deve repetir nenhuma palavra já presente em requiredWords.
6. Não expor raciocínio — apenas o JSON final.
7. activityType deve ser da lista de formatos disponíveis.
8. O campo reviewGroupId deve ser copiado exatamente como recebido.
9. Se houver um TEMA OBRIGATÓRIO na mensagem do usuário, ele tem prioridade máxima sobre o tema original do grupo de revisão — a situação e a missão devem girar em torno do tema obrigatório, nunca do tema original. Isso NUNCA afeta requiredWords, que continua vindo exclusivamente dos erros do aluno.

FORMATO DE RESPOSTA — somente JSON válido, sem markdown:

{
  "title": "string (nome curto e específico)",
  "missionSetup": "string (a situação em português — comece com 'Você...', 'Seu...', etc.)",
  "missionTask": "string (o que escrever e por quê em português)",
  "mission": "string (missionSetup + ' ' + missionTask)",
  "themePtBr": "string (mesmo valor de mission)",
  "themeEn": "string (comando em inglês)",
  "objective": "string",
  "pedagogicalReason": "string (1-2 frases sobre por que esta atividade reforça esses erros)",
  "activityType": "string (da lista de formatos)",
  "format": "string (mesmo valor de activityType)",
  "context": "string",
  "conflict": "",
  "semanticSummary": "string (Formato: X | Objetivo: Y | 1 frase do cenário)",
  "level": "A1|A2|B1|B2|C1|C2",
  "difficulty": "easy|medium|hard",
  "estimatedTimeMinutes": 15,
  "requiredGrammar": ["string"],
  "requiredWords": ["string"],
  "suggestedVocabulary": [{"word": "string", "meaningPtBr": "string", "example": "string"}],
  "useTheseWords": [],
  "instructions": ["string"],
  "exampleSentence": "string",
  "successCriteria": ["string"],
  "extraChallenge": "",
  "category": "string",
  "grammarTips": {},
  "responseExamples": [],
  "mode": "review",
  "reviewGroupId": "string",
${GRAMMAR_GUIDE_JSON_FIELDS}
}

REGRAS PARA verbTense/grammarGuide/optionalExercises (mesmos campos da missão normal, sempre preenchidos):
${GRAMMAR_GUIDE_FILL_RULES}`;

interface ReviewItemPayload {
  originalValue: string;
  correctedValue: string;
  explanation: string | null;
  originalSentence: string | null;
}

interface ReviewGroupPayload {
  group: {
    id: string;
    originalTheme: string | null;
    sourceEntryDate: string | null;
    reviewLevel: number;
  };
  items: ReviewItemPayload[];
}

function buildReviewUserMessage(
  reviewGroup: ReviewGroupPayload,
  recentThemes: RecentThemeRow[],
  level: string,
  attempt: number,
  selectedTheme: string | null = null,
): string {
  const lines: string[] = [];

  lines.push('=== PERFIL DO ALUNO ===');
  lines.push(`Nível: ${level}`);

  // User-requested theme — same contract as normal mode: when present, it
  // overrides the review group's own originalTheme for the new scenario.
  // It never touches requiredWords, which stays bound exclusively to the
  // student's corrected errors regardless of theme.
  if (selectedTheme) {
    lines.push('');
    lines.push('=== TEMA OBRIGATÓRIO ===');
    lines.push(`TEMA OBRIGATÓRIO ESCOLHIDO PELO USUÁRIO: ${selectedTheme}.`);
    lines.push('A nova situação criada para esta revisão deve ser centralizada nesse assunto, mesmo que o tema original do grupo de revisão abaixo seja outro.');
    lines.push('Isso NUNCA afeta requiredWords: as palavras obrigatórias continuam sendo exatamente as corrigidas do aluno, apenas encaixadas numa situação sobre este tema.');
    lines.push('Este tema tem prioridade máxima sobre o "Tema original" do grupo de revisão listado abaixo.');
  }

  lines.push('');
  lines.push('=== GRUPO DE REVISÃO ===');
  lines.push(`ID do grupo: ${reviewGroup.group.id}`);
  if (reviewGroup.group.originalTheme) {
    lines.push(`Tema original: ${reviewGroup.group.originalTheme}`);
  }

  lines.push('');
  lines.push('Erros cometidos pelo aluno:');
  reviewGroup.items.forEach((item, i) => {
    lines.push(`[${i + 1}]`);
    lines.push(`  Errado:  "${item.originalValue}"`);
    lines.push(`  Correto: "${item.correctedValue}"`);
    if (item.explanation) lines.push(`  Explicação: ${item.explanation}`);
    if (item.originalSentence) lines.push(`  Frase original: "${item.originalSentence}"`);
  });

  const uniqueWords = [...new Set(reviewGroup.items.map((i) => i.correctedValue).filter(Boolean))];
  lines.push('');
  lines.push('=== PALAVRAS OBRIGATÓRIAS (copiar exatamente para requiredWords) ===');
  uniqueWords.forEach((w) => lines.push(`  - "${w}"`));

  if (recentThemes.length > 0) {
    lines.push('');
    lines.push('=== HISTÓRICO RECENTE (NÃO REPETIR FORMATO) ===');
    recentThemes.slice(0, 5).forEach((t, i) => {
      const fmt = extractField(t.semantic_summary, 'Formato') || t.activity_type || '—';
      lines.push(`[${i + 1}] Formato: ${fmt} | Contexto: ${t.context || '—'} | "${t.title}"`);
    });
  }

  if (attempt > 1) {
    lines.push('');
    lines.push(`⚠️ TENTATIVA ${attempt}: A resposta anterior foi inválida. Certifique-se de que:`);
    lines.push('  - requiredWords contém EXATAMENTE as palavras listadas acima (sem adicionar nem remover)');
    lines.push('  - reviewGroupId é copiado exatamente');
    lines.push('  - activityType é diferente do último formato utilizado');
  }

  lines.push('');
  lines.push(`IMPORTANTE: O campo reviewGroupId deve ser exatamente: "${reviewGroup.group.id}"`);
  if (selectedTheme) {
    lines.push(`Siga os 6 passos. O TEMA OBRIGATÓRIO acima não é negociável — a situação criada deve girar em torno dele, não do tema original do grupo.`);
  } else {
    lines.push('Siga os 6 passos e gere uma atividade de revisão natural e envolvente.');
  }

  return lines.join('\n');
}

export function normalizeReviewTheme(
  parsed: any,
  reviewGroupId: string,
  expectedWords: string[]
): Record<string, unknown> {
  const missionSetup = String(parsed.missionSetup || '');
  const missionTask = String(parsed.missionTask || '');
  const mission =
    String(parsed.mission || '') ||
    (missionSetup && missionTask ? `${missionSetup} ${missionTask}`.trim() : '');

  const rawRequired = Array.isArray(parsed.requiredWords)
    ? parsed.requiredWords.map((w: any) => String(w).trim()).filter(Boolean)
    : expectedWords;
  const requiredWords = [...new Set<string>(rawRequired)];

  const format = String(parsed.activityType || parsed.format || 'narrative');
  const objective = String(parsed.objective || '');
  const summaryParts: string[] = [];
  if (format) summaryParts.push(`Formato: ${format}`);
  if (objective) summaryParts.push(`Objetivo: ${objective}`);
  const semanticSummary =
    String(parsed.semanticSummary || '') || summaryParts.join(' | ');

  return {
    title: String(parsed.title || 'Revisão'),
    missionSetup,
    missionTask,
    mission,
    themePtBr: mission,
    themeEn: String(parsed.themeEn || ''),
    objective,
    pedagogicalReason: String(parsed.pedagogicalReason || ''),
    activityType: format,
    format,
    context: String(parsed.context || ''),
    conflict: '',
    semanticSummary,
    level: VALID_LEVELS.has(parsed.level) ? parsed.level : 'A1',
    difficulty: VALID_DIFFS.has(parsed.difficulty) ? parsed.difficulty : 'easy',
    estimatedTimeMinutes: Number(parsed.estimatedTimeMinutes) || 15,
    requiredGrammar: Array.isArray(parsed.requiredGrammar) ? parsed.requiredGrammar : [],
    requiredWords,
    suggestedVocabulary: Array.isArray(parsed.suggestedVocabulary)
      ? parsed.suggestedVocabulary
      : [],
    useTheseWords: [],
    instructions: Array.isArray(parsed.instructions) ? parsed.instructions : [],
    exampleSentence: String(parsed.exampleSentence || ''),
    successCriteria: Array.isArray(parsed.successCriteria) ? parsed.successCriteria : [],
    extraChallenge: '',
    category: String(parsed.category || 'review'),
    grammarTips: {},
    responseExamples: [],
    mode: 'review',
    reviewGroupId,
    verbTense: String(parsed.verbTense || ''),
    grammarGuide: normalizeGrammarGuide(parsed.grammarGuide),
    optionalExercises: normalizeOptionalExercises(parsed.optionalExercises),
  };
}

export function validateReviewTheme(
  theme: Record<string, unknown>,
  expectedWords: string[],
  reviewGroupId: string
): string | null {
  const rw = Array.isArray(theme.requiredWords) ? (theme.requiredWords as string[]) : [];

  const missing = expectedWords.filter((w) => !rw.includes(w));
  if (missing.length > 0) return `Palavras faltando em requiredWords: ${missing.join(', ')}`;

  const extra = rw.filter((w) => !expectedWords.includes(w));
  if (extra.length > 0) return `Palavras extras em requiredWords: ${extra.join(', ')}`;

  if (rw.some((w) => !w?.trim())) return 'requiredWord vazia encontrada';

  if (new Set(rw).size !== rw.length) return 'requiredWords contém duplicatas';

  if (!String(theme.title || '').trim()) return 'title vazio';
  if (!String(theme.mission || '').trim()) return 'mission vazia';

  if (theme.mode !== 'review') return 'mode !== review';
  if (theme.reviewGroupId !== reviewGroupId) return `reviewGroupId inválido: ${theme.reviewGroupId}`;

  const reqLower = rw.map((w) => w.toLowerCase());
  const suggested = Array.isArray(theme.suggestedVocabulary)
    ? (theme.suggestedVocabulary as any[]).map((v) =>
        String(typeof v === 'string' ? v : v?.word || '').toLowerCase()
      )
    : [];
  const overlap = suggested.filter((w) => w && reqLower.includes(w));
  if (overlap.length > 0) return `suggestedVocabulary repete requiredWords: ${overlap.join(', ')}`;

  return null;
}

// ── Build user message ────────────────────────────────────────────────────────

interface RecentThemeRow {
  title: string;
  activity_type: string | null;
  context: string | null;
  semantic_summary: string | null;
}

interface ExcludedTheme {
  title: string;
  format?: string;
  activityType?: string;
  conflict?: string;
  context?: string;
  semanticSummary?: string;
}

function extractField(summary: string | null, field: string): string {
  if (!summary) return '';
  const match = summary.match(new RegExp(`${field}:\\s*([^|\\n]+)`));
  return match ? match[1].trim() : '';
}

function buildUserMessage(
  ctx: Record<string, unknown>,
  recentThemes: RecentThemeRow[],
  excludedTheme: ExcludedTheme | null,
  retryAttempt: number,
  selectedTheme: string | null = null,
): string {
  const lines: string[] = [];

  // Student profile
  lines.push('═══ PERFIL DO ALUNO ═══');
  lines.push(`Nível atual: ${ctx.currentLevel || 'A1'}`);
  lines.push(`Média de nota: ${ctx.averageScore ?? 0}/100`);
  lines.push(`Habilidade mais fraca: ${ctx.weakestSkill || 'desconhecida'}`);

  const grammarFocus = Array.isArray(ctx.grammarFocus) ? (ctx.grammarFocus as string[]) : [];
  if (grammarFocus.length > 0) {
    lines.push(`Gramática para reforçar: ${grammarFocus.join(', ')}`);
  }

  const mistakes = Array.isArray(ctx.recentMistakes) ? (ctx.recentMistakes as string[]) : [];
  if (mistakes.length > 0) {
    lines.push('Erros recentes:');
    mistakes.slice(0, 5).forEach((m) => lines.push(`  - ${m}`));
  }

  const vocab = Array.isArray(ctx.recentVocabulary) ? (ctx.recentVocabulary as string[]) : [];
  if (vocab.length > 0) {
    lines.push(`Vocabulário estudado: ${vocab.slice(0, 8).join(', ')}`);
  }

  // User-requested theme — placed immediately after the student profile,
  // ahead of history/restrictions, so it reads as the highest-priority
  // constraint rather than a suggestion buried at the end of the prompt.
  if (selectedTheme) {
    lines.push('');
    lines.push('═══ TEMA OBRIGATÓRIO ═══');
    lines.push(`TEMA OBRIGATÓRIO ESCOLHIDO PELO USUÁRIO: ${selectedTheme}.`);
    lines.push('Crie a missão de escrita centralizada nesse assunto. O título, a situação e o que o usuário deve escrever precisam estar claramente relacionados ao tema.');
    lines.push('Se houver vocabulário sugerido (suggestedVocabulary), ele também deve estar relacionado ao tema.');
    lines.push('O histórico do usuário pode personalizar a dificuldade e o contexto, mas não pode substituir ou ignorar o tema escolhido.');
    lines.push('Este tema tem prioridade sobre a biblioteca de contextos e sobre qualquer sugestão baseada no histórico.');
  }

  // Theme history
  lines.push('');
  lines.push('═══ HISTÓRICO DE MISSÕES GERADAS (mais recente primeiro) ═══');

  if (recentThemes.length === 0) {
    lines.push('Nenhuma missão gerada ainda. Comece com algo variado e envolvente.');
  } else {
    recentThemes.forEach((t, i) => {
      const fmt = extractField(t.semantic_summary, 'Formato') || t.activity_type || '—';
      const cfl = extractField(t.semantic_summary, 'Conflito') || '—';
      const obj = extractField(t.semantic_summary, 'Objetivo') || '—';
      lines.push(
        `[${i + 1}] Formato: ${fmt} | Conflito: ${cfl} | Objetivo: ${obj} | Contexto: ${t.context || '—'} | "${t.title}"`
      );
    });

    // Quick reference — what's restricted
    const recentFormats = recentThemes.slice(0, 5)
      .map((t) => extractField(t.semantic_summary, 'Formato') || t.activity_type || '')
      .filter(Boolean);

    const recentConflicts = recentThemes.slice(0, 5)
      .map((t) => extractField(t.semantic_summary, 'Conflito'))
      .filter((c) => c && c !== '—');

    const recentObjectives = recentThemes.slice(0, 3)
      .map((t) => extractField(t.semantic_summary, 'Objetivo'))
      .filter((o) => o && o !== '—');

    lines.push('');
    lines.push('═══ RESTRIÇÕES ATIVAS ═══');
    if (recentFormats.length > 0) {
      lines.push(`❌ FORMATO PROIBIDO (último usado): ${recentFormats[0]}`);
      if (recentFormats.length > 1) {
        lines.push(`⚠️  Formatos recentes (evitar): ${recentFormats.slice(1).join(', ')}`);
      }
    }
    if (recentConflicts.length > 0) {
      lines.push(`❌ CONFLITOS PROIBIDOS (últimos 5): ${recentConflicts.join(', ')}`);
    }
    if (recentObjectives.length > 0) {
      lines.push(`❌ OBJETIVOS PROIBIDOS (últimos 3): ${recentObjectives.join(', ')}`);
    }
  }

  // Excluded theme (user clicked "Gerar outro tema")
  if (excludedTheme) {
    lines.push('');
    lines.push('═══ MISSÃO RECUSADA PELO USUÁRIO — COMPLETAMENTE PROIBIDA ═══');
    lines.push(`Título: "${excludedTheme.title}"`);
    lines.push(`Formato: ${excludedTheme.format || excludedTheme.activityType || '—'}`);
    lines.push(`Conflito: ${excludedTheme.conflict || '—'}`);
    lines.push(`Contexto: ${excludedTheme.context || '—'}`);
    lines.push(`Resumo: ${excludedTheme.semanticSummary || '—'}`);
    lines.push('Esta missão e qualquer variação semântica dela estão PROIBIDAS.');
  }

  // Retry warning
  if (retryAttempt > 1) {
    lines.push('');
    lines.push(`⚠️ TENTATIVA ${retryAttempt}: As tentativas anteriores foram rejeitadas por semelhança com o histórico.`);
    lines.push('Você DEVE escolher um formato, conflito e contexto completamente diferentes.');
    lines.push('Pense em algo inesperado: uma entrevista, uma carta de reclamação, um tutorial, um debate, um review.');
  }

  lines.push('');
  if (selectedTheme) {
    lines.push(`Siga os 6 passos obrigatórios. Mantenha a diversidade de formato/conflito/objetivo em relação ao histórico, mas o TEMA OBRIGATÓRIO acima não é negociável — a missão inteira deve girar em torno dele.`);
  } else {
    lines.push('Siga os 6 passos obrigatórios e crie uma missão envolvente que seja genuinamente diferente de tudo no histórico.');
  }

  return lines.join('\n');
}

// ── Semantic deduplication ────────────────────────────────────────────────────

export function jaccardSimilarity(a: string, b: string): number {
  const stopwords = new Set([
    'de', 'a', 'o', 'que', 'e', 'do', 'da', 'em', 'um', 'para', 'com',
    'os', 'no', 'se', 'na', 'por', 'mais', 'as', 'dos', 'como', 'sua',
    'seu', 'sobre', 'the', 'an', 'to', 'of', 'in', 'on', 'at', 'and',
    'or', 'is', 'was', 'are', 'were', 'you', 'your',
  ]);
  const tokenize = (s: string): Set<string> => {
    const words = s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopwords.has(w));
    return new Set(words);
  };
  const setA = tokenize(a);
  const setB = tokenize(b);
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

export function isTooSimilar(
  candidate: Record<string, unknown>,
  recentThemes: RecentThemeRow[],
  threshold = 0.32
): boolean {
  const candidateText = [
    candidate.title,
    candidate.semanticSummary,
    candidate.format,
    candidate.context,
    candidate.conflict,
    candidate.objective,
    candidate.missionSetup,
  ]
    .filter(Boolean)
    .join(' ');

  // Semantic similarity check
  for (const t of recentThemes.slice(0, 10)) {
    const existingText = [t.title, t.semantic_summary, t.activity_type, t.context]
      .filter(Boolean)
      .join(' ');
    if (jaccardSimilarity(candidateText, existingText) > threshold) {
      return true;
    }
  }

  // Hard rule: never same format as immediately previous theme
  const lastFormat = extractField(recentThemes[0]?.semantic_summary, 'Formato')
    || recentThemes[0]?.activity_type;
  if (candidate.format && lastFormat && candidate.format === lastFormat) {
    return true;
  }

  return false;
}

// ── Normalize AI output ───────────────────────────────────────────────────────

const VALID_LEVELS = new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
const VALID_DIFFS = new Set(['easy', 'medium', 'hard']);

export function normalizeTheme(parsed: any): Record<string, unknown> {
  const format = String(parsed.format || parsed.activityType || 'história');
  const conflict = String(parsed.conflict || '');
  const objective = String(parsed.objective || '');
  const missionSetup = String(parsed.missionSetup || '');
  const missionTask = String(parsed.missionTask || '');
  const mission =
    missionSetup && missionTask
      ? `${missionSetup} ${missionTask}`.trim()
      : String(parsed.mission || missionSetup || missionTask || '');

  // Build structured semantic_summary so history extraction works reliably
  const summaryParts: string[] = [];
  if (format) summaryParts.push(`Formato: ${format}`);
  if (conflict) summaryParts.push(`Conflito: ${conflict}`);
  if (objective) summaryParts.push(`Objetivo: ${objective}`);
  const aiSummary = String(parsed.semanticSummary || '');
  // Append the AI's natural description after the structured prefix
  const naturalPart = aiSummary.includes('Formato:') ? '' : aiSummary;
  if (naturalPart) summaryParts.push(naturalPart);
  const semanticSummary = summaryParts.join(' | ');

  return {
    title: String(parsed.title || 'Missão do dia'),
    missionSetup,
    missionTask,
    mission,
    themePtBr: mission,
    themeEn: String(parsed.themeEn || ''),
    format,
    context: String(parsed.context || 'geral'),
    conflict,
    objective,
    activityType: format,
    semanticSummary,
    whyThisActivity: String(parsed.whyThisActivity || ''),
    level: VALID_LEVELS.has(parsed.level) ? parsed.level : 'A1',
    difficulty: VALID_DIFFS.has(parsed.difficulty) ? parsed.difficulty : 'easy',
    estimatedTimeMinutes: Number(parsed.estimatedTimeMinutes) || 15,
    requiredGrammar: Array.isArray(parsed.requiredGrammar) ? parsed.requiredGrammar : [],
    suggestedVocabulary: Array.isArray(parsed.suggestedVocabulary) ? parsed.suggestedVocabulary : [],
    useTheseWords: Array.isArray(parsed.useTheseWords) ? parsed.useTheseWords : [],
    instructions: Array.isArray(parsed.instructions) ? parsed.instructions : [],
    exampleSentence: String(parsed.exampleSentence || ''),
    successCriteria: Array.isArray(parsed.successCriteria) ? parsed.successCriteria : [],
    extraChallenge: String(parsed.extraChallenge || ''),
    category: String(parsed.category || 'daily-life'),
    grammarTips:
      parsed.grammarTips && typeof parsed.grammarTips === 'object' && !Array.isArray(parsed.grammarTips)
        ? parsed.grammarTips
        : {},
    responseExamples: Array.isArray(parsed.responseExamples) ? parsed.responseExamples : [],
    verbTense: String(parsed.verbTense || ''),
    grammarGuide: normalizeGrammarGuide(parsed.grammarGuide),
    optionalExercises: normalizeOptionalExercises(parsed.optionalExercises),
  };
}

/**
 * When the user explicitly picked a theme, force the mission's displayed
 * context/tag to that theme's label. The AI's own `context` choice (or,
 * in review mode, a leftover from the review group's unrelated
 * originalTheme) must never override an explicit user selection — the tag
 * shown in the UI has to reflect what the user picked, not an internal
 * mission-structure code like "planning".
 */
export function applySelectedTopicOverride(
  candidate: Record<string, unknown>,
  selectedTheme: string | null,
): void {
  if (selectedTheme) {
    candidate.context = selectedTheme;
  }
}

export function parseRawContent(raw: string): any | null {
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

// ── Metric extractor — reads from SDK response, never invents values ──────────

function extractThemeMetrics(completion: ChatCompletion): GatewayUsageMetric[] {
  const metrics: GatewayUsageMetric[] = [];

  // Always record one request per provider call.
  metrics.push({
    metricKey: 'provider_requests',
    unitType: 'request',
    quantity: 1,
    isBillable: false,
    measurementSource: 'provider_response',
  });

  const usage = completion.usage;
  if (!usage) return metrics;

  if (usage.prompt_tokens != null) {
    metrics.push({
      metricKey: 'input_text_tokens',
      unitType: 'token',
      quantity: usage.prompt_tokens,
      isBillable: true,
      measurementSource: 'provider_response',
    });
  }

  if (usage.completion_tokens != null) {
    metrics.push({
      metricKey: 'output_text_tokens',
      unitType: 'token',
      quantity: usage.completion_tokens,
      isBillable: true,
      measurementSource: 'provider_response',
    });
  }

  // Only record when actually provided and non-zero — do not invent values.
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
  if (cachedTokens != null && cachedTokens > 0) {
    metrics.push({
      metricKey: 'cached_input_tokens',
      unitType: 'token',
      quantity: cachedTokens,
      // Cached tokens are billed at a discounted rate, not free — priced
      // separately from the non-cached share of input_text_tokens.
      isBillable: true,
      measurementSource: 'provider_response',
    });
  }

  return metrics;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, PAYLOAD_LIMITS.THEME)) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId, supabase } = auth;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return jsonError(res, 503, 'AI_UNAVAILABLE', 'O serviço de geração não está configurado.');

  if (!await applyRateLimit(res, userId, 'generate-theme')) return;

  // ── Plan entitlements ────────────────────────────────────────────────────────
  // writing.enabled gates the ENTIRE endpoint, including reusing an already-
  // generated mission — when the plan turns writing off, nothing comes back.
  // The per-day generation limit (themeGenerations) is checked separately,
  // right before each place a NEW AI call is about to happen, so it never
  // blocks reusing the diagnostic flow's already-generated mission.
  let entitlements: PlanEntitlementsSnapshot;
  try {
    entitlements = await getCurrentUserPlanEntitlements(userId);
  } catch (e) {
    safeLog('generate-theme', 'entitlements_resolve_failed', 500);
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível verificar seu plano. Tente novamente.');
  }
  if (!entitlements.writing.enabled) {
    return jsonError(res, 403, 'FEATURE_DISABLED', ENTITLEMENT_MESSAGES.featureUnavailable);
  }
  function blockedByGenerationLimit(): { code: string; message: string } | null {
    if (entitlements.writing.themeGenerations.canStart) return null;
    const code = entitlements.writing.themeGenerations.state === 'monthly_limit_reached'
      ? 'MONTHLY_LIMIT_REACHED' : 'DAILY_LIMIT_REACHED';
    return { code, message: ENTITLEMENT_MESSAGES.writingGenerationsExhausted };
  }

  const { mode, reviewGroup, learningContext, previousThemeId, excludedTheme, theme: rawTheme } = req.body ?? {};
  // The client sends the raw technical value from the theme select (e.g.
  // 'football_sports'), never a pre-translated label — the label used in the
  // AI prompt is resolved here from the same canonical catalog the select
  // is built from, so there is only ever one source of truth for theme
  // options. An unrecognized/empty value is treated exactly like "no theme
  // selected" (random) — never invented.
  const normalizedThemeValue = typeof rawTheme === 'string' && rawTheme.trim() ? rawTheme.trim() : null;
  const selectedTheme = resolveWritingThemeLabel(normalizedThemeValue);

  // Mark previous theme as regenerated (only if it belongs to this user)
  if (previousThemeId) {
    try {
      await supabase
        .from('generated_themes')
        .update({ status: 'regenerated' })
        .eq('id', previousThemeId)
        .eq('user_id', userId);
    } catch (e) {
      console.error('Failed to update previous theme status:', e);
    }
  }

  // Fetch recent theme history for THIS user only
  let recentThemes: RecentThemeRow[] = [];
  try {
    const { data } = await supabase
      .from('generated_themes')
      .select('title, activity_type, context, semantic_summary')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(30);
    recentThemes = (data ?? []) as RecentThemeRow[];
  } catch (e) {
    console.error('Failed to fetch recent themes:', e);
  }

  const openai = new OpenAI({ apiKey, timeout: TIMEOUTS.LONG, maxRetries: 0 });

  // ── Gateway context — one correlationId per HTTP request, one physical- ────
  // attempt counter shared across every phase (diagnostic/review/normal),
  // never reset when the request moves from one phase to another.
  const gatewayDeps = getProductionDeps();
  const correlationId = gatewayDeps.uuidGen();
  let physicalAttempt = 0;

  async function callTheme(
    phase: 'diagnostic' | 'review' | 'normal',
    phaseAttempt: number,
    maxPhysicalAttempts: number,
    params: ChatCompletionCreateParamsNonStreaming,
  ): Promise<ChatCompletion> {
    physicalAttempt += 1;
    return executeAiGatewayCall<ChatCompletion>(
      {
        featureKey: 'writing.generate_topic',
        provider: 'openai',
        service: 'chat.completions',
        model: AI_MODEL,
        userId,
        initiatedByUserId: userId,
        actorType: 'user',
        executionLocation: 'backend',
        correlationId,
        attemptNumber: physicalAttempt,
        callSequence: 1,
        resourceType: 'generated_theme',
        technicalMetadata: {
          endpoint: 'generate-theme',
          phase,
          phaseAttempt,
          physicalAttempt,
          maxPhysicalAttempts,
          flowType: mode === 'review' ? 'review' : 'normal',
        },
        estimatedMetrics: estimateTextTokensFromMessages(
          params.messages, typeof params.max_tokens === 'number' ? params.max_tokens : DEFAULT_MAX_OUTPUT_TOKENS_ESTIMATE,
        ),
      },
      () => openai.chat.completions.create(params),
      gatewayDeps,
      extractThemeMetrics,
    );
  }

  // ── DIAGNOSTIC MODE (auto-detection, invisible to user) ──────────────────────
  // Ativado automaticamente quando mode='normal', feature flag habilitada e
  // usuário elegível (writing status = unknown). Transparente para o frontend.

  if (mode !== 'review') {
    let diagnosticCtx: Awaited<ReturnType<typeof getDiagnosticGenerationContext>> | null = null;
    try {
      diagnosticCtx = await getDiagnosticGenerationContext(supabase, userId, previousThemeId ?? null);
    } catch (e) {
      console.error('Diagnostic context check failed, falling back to normal mode:', e);
    }

    if (diagnosticCtx?.shouldUseDiagnostic) {
      const diagnosticSequence = diagnosticCtx.diagnosticSequence!;

      // Idempotência: retornar missão existente se já foi gerada (double-click, refresh).
      // Só é seguro reutilizar quando nenhum tema foi solicitado nesta chamada —
      // a missão salva não tem como ser verificada contra um tema diferente do
      // que ela foi gerada com, então um novo tema sempre força geração fresca.
      if (diagnosticCtx.existingActiveMission && !selectedTheme) {
        const existing = diagnosticCtx.existingActiveMission;
        if (existing.theme_id) {
          try {
            const { data: themeData } = await supabase
              .from('generated_themes')
              .select('*')
              .eq('id', existing.theme_id)
              .eq('user_id', userId)
              .maybeSingle();

            if (themeData) {
              const existingThemeObj: Record<string, unknown> = {
                title: themeData.title,
                mission: themeData.description,
                missionSetup: themeData.description,
                missionTask: '',
                themePtBr: themeData.description,
                format: themeData.activity_type,
                activityType: themeData.activity_type,
                context: themeData.context,
                semanticSummary: themeData.semantic_summary,
                difficulty: themeData.difficulty,
                useTheseWords: themeData.vocabulary ?? [],
                requiredGrammar: themeData.grammar_focus ?? [],
                level: 'A1',
                estimatedTimeMinutes: 15,
                instructions: [],
                suggestedVocabulary: [],
                successCriteria: [],
                extraChallenge: '',
                category: 'daily-life',
                grammarTips: {},
                responseExamples: [],
              };

              logDiagnosticEvent('diagnostic_mission_returned_existing', userId, {
                diagnostic_sequence: diagnosticSequence,
                theme_id: existing.theme_id,
              });

              return res.json({
                theme: toPublicMissionDTO(existingThemeObj),
                themeId: existing.theme_id,
                mode: 'normal',
              });
            }
          } catch (e) {
            console.error('Failed to fetch existing diagnostic theme:', e);
          }
        }
      }

      // Gerar nova missão diagnóstica
      const diagnosticGenerationBlock = blockedByGenerationLimit();
      if (diagnosticGenerationBlock) {
        return jsonError(res, 403, diagnosticGenerationBlock.code, diagnosticGenerationBlock.message);
      }

      const diagnosticPlan = diagnosticCtx.diagnosticPlan!;
      const diagnosticSystemPrompt = SYSTEM_PROMPT + DIAGNOSTIC_SYSTEM_PROMPT_EXTENSION;
      const recentDiagnosticTitles = recentThemes.slice(0, 5)
        .map(t => t.title)
        .filter(Boolean) as string[];
      const diagnosticSection = buildDiagnosticUserMessageSection(diagnosticPlan, recentDiagnosticTitles);

      let diagnosticTheme: Record<string, unknown> | null = null;
      const diagnosticRejectionLog: DiagnosticRejectionLogEntry[] = [];

      logDiagnosticEvent('diagnostic_generation_started', userId, {
        diagnostic_sequence: diagnosticSequence,
      });

      for (let attempt = 1; attempt <= MAX_DIAGNOSTIC_GENERATION_ATTEMPTS; attempt++) {
        let raw: string;
        try {
          const completion = await callTheme('diagnostic', attempt, MAX_DIAGNOSTIC_GENERATION_ATTEMPTS, {
            model: AI_MODEL,
            temperature: 0.88 + (attempt - 1) * 0.07,
            messages: [
              { role: 'system', content: diagnosticSystemPrompt },
              {
                role: 'user',
                content: buildUserMessage(
                  learningContext ?? {},
                  recentThemes,
                  excludedTheme ?? null,
                  attempt,
                  selectedTheme,
                ) + diagnosticSection,
              },
            ],
          });
          raw = completion.choices[0]?.message?.content ?? '';
        } catch (err) {
          const { code, status } = sanitizeProviderError(err);
          if (code === 'AI_TIMEOUT' || code === 'AI_UNAVAILABLE') {
            safeLog('generate-theme', 'diagnostic_provider_error', status, { mode: 'diagnostic' });
            break; // Fall through to normal mode
          }
          if (attempt >= MAX_DIAGNOSTIC_GENERATION_ATTEMPTS) break;
          continue;
        }

        const parsed = parseRawContent(raw);
        if (!parsed) {
          diagnosticRejectionLog.push({
            attempt,
            rejectionCode: 'INVALID_RESPONSE_SCHEMA',
            rejectionDetail: 'JSON inválido ou ausente',
            timestamp: new Date().toISOString(),
          });
          if (attempt >= MAX_DIAGNOSTIC_GENERATION_ATTEMPTS) break;
          continue;
        }

        const candidate = normalizeTheme(parsed);
        candidate.internalCoverage = Array.isArray(parsed.internalCoverage)
          ? parsed.internalCoverage
          : [];

        const { valid, updatedLog } = validateGeneratedDiagnosticMission(
          diagnosticPlan,
          candidate,
          recentThemes.map(t => ({ title: t.title, semantic_summary: t.semantic_summary })),
          attempt,
          diagnosticRejectionLog,
        );

        // Sync rejection log
        if (updatedLog.length > diagnosticRejectionLog.length) {
          const newEntries = updatedLog.slice(diagnosticRejectionLog.length);
          diagnosticRejectionLog.push(...newEntries);
        }

        if (!valid) {
          const lastRej = diagnosticRejectionLog[diagnosticRejectionLog.length - 1];
          logDiagnosticEvent('diagnostic_generation_rejected', userId, {
            diagnostic_sequence: diagnosticSequence,
            attempt,
            rejection_code: lastRej?.rejectionCode ?? 'UNKNOWN',
          });

          if (attempt >= MAX_DIAGNOSTIC_GENERATION_ATTEMPTS) {
            // Último fallback: usar candidato mesmo com validação falha
            diagnosticTheme = candidate;
            logDiagnosticEvent('diagnostic_generation_fallback', userId, {
              diagnostic_sequence: diagnosticSequence,
            });
          }
          continue;
        }

        diagnosticTheme = candidate;
        logDiagnosticEvent('diagnostic_generation_succeeded', userId, {
          diagnostic_sequence: diagnosticSequence,
          attempt,
        });
        break;
      }

      if (diagnosticTheme) {
        applySelectedTopicOverride(diagnosticTheme, selectedTheme);
        // Salvar em generated_themes
        let diagnosticThemeId: string | null = null;
        try {
          const { data: themeData, error: themeError } = await supabase
            .from('generated_themes')
            .insert({
              user_id: userId,
              title: diagnosticTheme.title,
              description: diagnosticTheme.mission,
              grammar_focus: diagnosticTheme.requiredGrammar,
              activity_type: diagnosticTheme.format,
              context: diagnosticTheme.context,
              semantic_summary: diagnosticTheme.semanticSummary,
              difficulty: diagnosticTheme.difficulty,
              vocabulary: diagnosticTheme.useTheseWords,
              status: 'generated',
            })
            .select('id')
            .single();

          if (!themeError && themeData) {
            diagnosticThemeId = (themeData as { id: string }).id;
          }
        } catch (e) {
          console.error('Failed to save diagnostic theme:', e);
        }

        // Salvar em writing_diagnostic_missions (apenas se theme foi salvo)
        if (diagnosticThemeId) {
          try {
            await saveDiagnosticMission(
              {
                userId,
                themeId: diagnosticThemeId,
                diagnosticSequence,
                plan: diagnosticPlan,
                rejectionLog: diagnosticRejectionLog,
                objectiveIds: diagnosticPlan.objectives.map(o => o.id),
              },
              previousThemeId ?? null,
            );

            logDiagnosticEvent('diagnostic_mission_saved', userId, {
              diagnostic_sequence: diagnosticSequence,
              theme_id: diagnosticThemeId,
            });
          } catch (e) {
            console.error('Failed to save diagnostic mission record:', e);
          }
        }

        return res.json({
          theme: toPublicMissionDTO(diagnosticTheme),
          themeId: diagnosticThemeId,
          mode: 'normal',
        });
      }

      // Geração diagnóstica falhou completamente — continuar para modo normal
      logDiagnosticEvent('diagnostic_generation_failed_fallback_to_normal', userId, {
        diagnostic_sequence: diagnosticSequence,
      });
    }
  }

  // ── REVIEW MODE ──────────────────────────────────────────────────────────────
  if (mode === 'review' && reviewGroup) {
    const rg = reviewGroup as ReviewGroupPayload;
    const group = rg.group;
    const items = rg.items ?? [];

    if (!group?.id || items.length === 0) {
      return res.status(400).json({ error: 'Grupo de revisão inválido.', mode: 'review' });
    }

    const expectedWords = [...new Set<string>(items.map((i) => i.correctedValue).filter(Boolean))];
    const level = String((learningContext as any)?.currentLevel || 'A1');

    const reviewGenerationBlock = blockedByGenerationLimit();
    if (reviewGenerationBlock) {
      return jsonError(res, 403, reviewGenerationBlock.code, reviewGenerationBlock.message);
    }

    const MAX_REVIEW_ATTEMPTS = 3;
    let reviewTheme: Record<string, unknown> | null = null;
    let lastValidationError: string | null = null;

    for (let attempt = 1; attempt <= MAX_REVIEW_ATTEMPTS; attempt++) {
      let raw: string;
      try {
        const completion = await callTheme('review', attempt, MAX_REVIEW_ATTEMPTS, {
          model: AI_MODEL,
          temperature: 0.85 + (attempt - 1) * 0.08,
          messages: [
            { role: 'system', content: REVIEW_SYSTEM_PROMPT },
            {
              role: 'user',
              content: buildReviewUserMessage(
                { group, items },
                recentThemes,
                level,
                attempt,
                selectedTheme,
              ),
            },
          ],
        });
        raw = completion.choices[0]?.message?.content ?? '';
      } catch (err) {
        const { code, status } = sanitizeProviderError(err);
        if (code === 'AI_TIMEOUT') {
          safeLog('generate-theme', 'timeout', status, { mode: 'review' });
          return jsonError(res, status, code, 'O serviço demorou para responder. Tente novamente.');
        }
        if (code === 'AI_UNAVAILABLE') {
          safeLog('generate-theme', 'provider_unavailable', status, { mode: 'review' });
          return jsonError(res, status, code, 'O serviço está temporariamente indisponível. Tente novamente.');
        }
        if (attempt >= MAX_REVIEW_ATTEMPTS) {
          return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível gerar a atividade de revisão. Tente novamente.');
        }
        continue;
      }

      const parsed = parseRawContent(raw);
      if (!parsed) {
        console.error(`Review attempt ${attempt}: JSON inválido`);
        continue;
      }

      const candidate = normalizeReviewTheme(parsed, group.id, expectedWords);
      lastValidationError = validateReviewTheme(candidate, expectedWords, group.id);

      if (lastValidationError) {
        console.warn(`Review attempt ${attempt} falhou validação: ${lastValidationError}`);
        continue;
      }

      reviewTheme = candidate;
      break;
    }

    if (!reviewTheme) {
      safeLog('generate-theme', 'review_validation_failed', 500);
      return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível gerar uma atividade de revisão válida. Tente novamente.');
    }

    applySelectedTopicOverride(reviewTheme, selectedTheme);

    let themeId: string | null = null;
    try {
      const { data, error } = await supabase
        .from('generated_themes')
        .insert({
          user_id: userId,
          title: reviewTheme.title,
          description: reviewTheme.mission,
          grammar_focus: reviewTheme.requiredGrammar,
          activity_type: reviewTheme.activityType,
          context: reviewTheme.context,
          semantic_summary: reviewTheme.semanticSummary,
          difficulty: reviewTheme.difficulty,
          vocabulary: reviewTheme.requiredWords,
          status: 'generated',
        })
        .select('id')
        .single();
      if (!error && data) themeId = (data as { id: string }).id;
    } catch (e) {
      console.error('Failed to save review theme:', e);
    }

    return res.json({ theme: reviewTheme, themeId, mode: 'review' });
  }

  // ── NORMAL MODE ──────────────────────────────────────────────────────────────

  const normalGenerationBlock = blockedByGenerationLimit();
  if (normalGenerationBlock) {
    return jsonError(res, 403, normalGenerationBlock.code, normalGenerationBlock.message);
  }

  // Inject excluded theme at the top so deduplication catches it immediately
  if (excludedTheme) {
    const alreadyPresent = recentThemes.some((t) => t.title === excludedTheme.title);
    if (!alreadyPresent) {
      recentThemes = [
        {
          title: excludedTheme.title ?? '',
          activity_type: excludedTheme.format ?? excludedTheme.activityType ?? null,
          context: excludedTheme.context ?? null,
          semantic_summary: excludedTheme.semanticSummary ?? null,
        },
        ...recentThemes,
      ];
    }
  }

  // ── PEDAGOGICAL PLANNER INTEGRATION ─────────────────────────────────────────
  // Activated when PEDAGOGICAL_GENERATOR_INTEGRATION_V1=shadow|enabled.
  // shadow  → plan built + persisted; prompt unchanged; validator skipped.
  // enabled → plan constraints injected into prompt; output validated.
  // Graceful degradation: any failure here falls through to the normal generation.

  let activePlan: MissionPedagogicalPlan | null = null;
  let planConstraintsSection = '';
  let lastValidationRejection: string | null = null;

  if (isGeneratorIntegrationEnabled()) {
    try {
      const planSeed = `${userId.slice(0, 12)}-${Date.now()}`;
      const planResult = await generatePedagogicalPlan(supabase, {
        userId,
        mode: 'normal',
        seed: planSeed,
      });
      // Only set activePlan when generator integration is fully active (not shadow).
      // isGeneratorIntegrationFullyActive reads PEDAGOGICAL_GENERATOR_INTEGRATION_V1,
      // distinct from planResult.shadowMode which tracks PEDAGOGICAL_PLANNER_V1.
      if (planResult.plan && isGeneratorIntegrationFullyActive()) {
        activePlan = planResult.plan;
        planConstraintsSection = buildPlanConstraintsSection(planResult.plan);
      }
      safeLog('generate-theme', 'planner_integration_run', 200, {
        has_plan: !!planResult.plan,
        planner_shadow: planResult.shadowMode,
        integration_shadow: !isGeneratorIntegrationFullyActive(),
        skipped: planResult.skipped,
      });
    } catch (e) {
      safeLog('generate-theme', 'planner_integration_error', 500, {
        error: String(e).slice(0, 150),
      });
    }
  }

  const MAX_ATTEMPTS = 3;
  let theme: Record<string, unknown> | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let raw: string;

    // Build user message — append plan constraints when integration is fully active
    let userContent = buildUserMessage(learningContext ?? {}, recentThemes, excludedTheme ?? null, attempt, selectedTheme);
    if (activePlan) {
      userContent += lastValidationRejection
        ? buildRepairSection(activePlan, lastValidationRejection)
        : planConstraintsSection;
    }

    try {
      const completion = await callTheme('normal', attempt, MAX_ATTEMPTS, {
        model: AI_MODEL,
        temperature: 0.88 + (attempt - 1) * 0.06,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      });
      raw = completion.choices[0]?.message?.content ?? '';
    } catch (err) {
      const { code, status } = sanitizeProviderError(err);
      if (code === 'AI_TIMEOUT') {
        safeLog('generate-theme', 'timeout', status);
        return jsonError(res, status, code, 'O serviço demorou para responder. Tente novamente.');
      }
      if (code === 'AI_UNAVAILABLE') {
        safeLog('generate-theme', 'provider_unavailable', status);
        return jsonError(res, status, code, 'O serviço está temporariamente indisponível. Tente novamente.');
      }
      if (attempt >= MAX_ATTEMPTS) {
        return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível gerar a missão. Tente novamente.');
      }
      continue;
    }

    const parsed = parseRawContent(raw);
    if (!parsed) {
      console.error(`Attempt ${attempt}: invalid JSON`);
      continue;
    }

    const candidate = normalizeTheme(parsed);

    // Pedagogical validation — only when plan is active and validator is configured
    if (activePlan && isMissionValidatorActive()) {
      const validation = validateMissionAgainstPedagogicalPlan(
        candidate as unknown as Parameters<typeof validateMissionAgainstPedagogicalPlan>[0],
        activePlan,
      );
      if (!validation.valid && isMissionValidatorEnforcing() && attempt < MAX_ATTEMPTS) {
        lastValidationRejection = validation.rejectionDetail ?? validation.rejectionCode ?? 'UNKNOWN';
        safeLog('generate-theme', 'mission_validation_rejected', 200, {
          attempt,
          rejection_code: validation.rejectionCode ?? 'UNKNOWN',
        });
        continue;
      }
      lastValidationRejection = null;
    }

    // Skip similarity check on last attempt to guarantee a response
    if (attempt < MAX_ATTEMPTS && isTooSimilar(candidate, recentThemes)) {
      console.log(`Attempt ${attempt}: too similar to history, retrying…`);
      continue;
    }

    theme = candidate;
    break;
  }

  // Deterministic fallback: if all AI attempts failed and we have a plan, use a template
  if (!theme && activePlan) {
    try {
      const template = selectFallbackTemplate(activePlan.effectiveLevel, activePlan.difficulty);
      theme = buildFallbackCandidate(template, activePlan.effectiveLevel);
      safeLog('generate-theme', 'fallback_template_used', 200, { template_id: template.id });
    } catch (e) {
      safeLog('generate-theme', 'fallback_template_error', 500, {});
    }
  }

  if (!theme) {
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível gerar uma missão diferente. Tente novamente.');
  }

  applySelectedTopicOverride(theme, selectedTheme);

  // Persist to database
  let themeId: string | null = null;
  try {
    const { data, error } = await supabase
      .from('generated_themes')
      .insert({
        user_id: userId,
        title: theme.title,
        description: theme.mission,
        grammar_focus: theme.requiredGrammar,
        activity_type: theme.format,
        context: theme.context,
        semantic_summary: theme.semanticSummary,
        difficulty: theme.difficulty,
        vocabulary: theme.useTheseWords,
        status: 'generated',
      })
      .select('id')
      .single();
    if (!error && data) {
      themeId = (data as { id: string }).id;
    }
  } catch (e) {
    console.error('Failed to save generated theme:', e);
  }

  return res.json({ theme, themeId, mode: 'normal' });
}
