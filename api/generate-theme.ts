import OpenAI from 'openai';
import { requireAuth } from './_auth';

const AI_MODEL = 'gpt-4o-mini';

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
  ]
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
  Nunca use o mesmo personagem, empresa, situação ou cidade da missão original.`;

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
  retryAttempt: number
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
  lines.push('Siga os 6 passos obrigatórios e crie uma missão envolvente que seja genuinamente diferente de tudo no histórico.');

  return lines.join('\n');
}

// ── Semantic deduplication ────────────────────────────────────────────────────

function jaccardSimilarity(a: string, b: string): number {
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

function isTooSimilar(
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

function normalizeTheme(parsed: any): Record<string, unknown> {
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
  };
}

function parseRawContent(raw: string): any | null {
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

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).end();

  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId, supabase } = auth;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY não configurada.' });

  const { mode: _mode, reviewGroup: _reviewGroup, learningContext, previousThemeId, excludedTheme } = req.body ?? {};

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

  const openai = new OpenAI({ apiKey });
  const MAX_ATTEMPTS = 3;
  let theme: Record<string, unknown> | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let raw: string;
    try {
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        temperature: 0.88 + (attempt - 1) * 0.06,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: buildUserMessage(learningContext ?? {}, recentThemes, excludedTheme ?? null, attempt),
          },
        ],
      });
      raw = completion.choices[0]?.message?.content ?? '';
    } catch (err: any) {
      console.error(`Attempt ${attempt} OpenAI error:`, err);
      if (attempt >= MAX_ATTEMPTS) {
        return res.status(500).json({ error: err?.message ?? 'Erro ao gerar missão.' });
      }
      continue;
    }

    const parsed = parseRawContent(raw);
    if (!parsed) {
      console.error(`Attempt ${attempt}: invalid JSON`);
      continue;
    }

    const candidate = normalizeTheme(parsed);

    // Skip similarity check on last attempt to guarantee a response
    if (attempt < MAX_ATTEMPTS && isTooSimilar(candidate, recentThemes)) {
      console.log(`Attempt ${attempt}: too similar to history, retrying…`);
      continue;
    }

    theme = candidate;
    break;
  }

  if (!theme) {
    return res.status(500).json({
      error: 'Não foi possível gerar uma missão diferente. Tente novamente.',
    });
  }

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

  return res.json({ theme, themeId });
}
