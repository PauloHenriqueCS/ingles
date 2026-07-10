import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

const AI_MODEL = 'gpt-4o-mini';

// ── Catalogs ──────────────────────────────────────────────────────────────────

const ACTIVITY_TYPES = [
  'narrative', 'story_continuation', 'dialogue', 'debate', 'opinion_essay',
  'email_formal', 'email_informal', 'whatsapp_chat', 'job_interview',
  'meeting_notes', 'bug_report', 'customer_support', 'travel_diary',
  'restaurant_scene', 'hotel_checkin', 'airport_situation', 'shopping',
  'process_explanation', 'instructions', 'comparison', 'image_description',
  'movie_review', 'book_review', 'product_review', 'recommendation',
  'persuasion', 'problem_solving', 'future_planning', 'creative_writing',
  'decision_making',
];

const CONTEXTS = [
  'trabalho', 'tecnologia', 'software', 'inteligencia_artificial', 'startup',
  'viagens', 'restaurante', 'academia', 'familia', 'amigos', 'filmes',
  'series', 'musica', 'saude', 'compras', 'eventos', 'financas', 'rotina',
  'estudos', 'ferias', 'natureza', 'culinaria', 'esportes', 'arte', 'jogos',
];

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Você é um professor particular de inglês para brasileiros adultos.

Sua tarefa é criar uma MISSÃO de escrita única, diferente e pedagogicamente relevante.

═══ CATÁLOGO DE TIPOS DE ATIVIDADE ═══

${ACTIVITY_TYPES.join(' | ')}

═══ CATÁLOGO DE CONTEXTOS ═══

${CONTEXTS.join(' | ')}

═══ PROCESSO OBRIGATÓRIO — SIGA ESTA ORDEM ═══

PASSO 1 — ANALISAR O HISTÓRICO
Leia todos os temas do histórico com atenção. Identifique: quais tipos de atividade foram usados, quais contextos foram usados, quais conteúdos semânticos foram abordados. Preste atenção especial aos últimos 5 temas.

PASSO 2 — IDENTIFICAR PADRÕES REPETIDOS
Liste mentalmente o que NÃO deve ser repetido. Se os últimos temas foram sobre rotina pessoal ou narrar o dia, você DEVE escolher algo completamente diferente como email_formal, job_interview, movie_review, debate, etc.

PASSO 3 — ESCOLHER TIPO DE ATIVIDADE DIFERENTE
Escolha um activityType do catálogo que NÃO apareceu nos últimos 5 temas. Se todos foram usados recentemente, escolha o que foi usado há mais tempo.

PASSO 4 — ESCOLHER CONTEXTO DIFERENTE
Escolha um contexto do catálogo que não foi usado nos últimos 5 temas.

PASSO 5 — VERIFICAR UNICIDADE SEMÂNTICA
Antes de escrever, confirme: se alguém lesse seu tema e os temas anteriores, ficaria imediatamente claro que são exercícios completamente distintos em propósito, formato e conteúdo?

PASSO 6 — GERAR A MISSÃO
Somente após confirmar a unicidade, crie a missão completa.

═══ REGRAS ABSOLUTAS ═══

1. NUNCA repita atividades semanticamente equivalentes.
2. Mudar apenas o título NÃO cria um novo tema — é o mesmo exercício.
3. Mudar apenas algumas palavras NÃO cria um novo tema.
4. Estes são todos o MESMO tema e são PROIBIDOS se já aparecerem no histórico:
   "Meu dia", "O que aconteceu ontem", "O que você fez ontem", "Sua rotina", "Conte sobre seu dia", "Minha manhã", "O que fiz hoje", "Daily journal sobre ontem".
5. "daily_journal" e "narrative" NÃO devem aparecer mais de 1 vez nos últimos 5 temas.
6. Cada novo tema deve ter: tipo de texto diferente + contexto diferente + propósito comunicativo diferente.
7. Se o histórico recente tiver narrativas pessoais, vá para: email, diálogo, review, debate, instruções, comparação ou creative_writing.

═══ FORMATO DE RESPOSTA ═══

Retorne somente JSON válido. Sem markdown. Sem texto antes ou depois do JSON.

{
  "title": string,
  "mission": string,
  "themePtBr": string,
  "themeEn": string,
  "context": string,
  "activityType": string,
  "semanticSummary": string,
  "whyThisActivity": string,
  "objective": string,
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
  "category": string
}

Regras de formato:
- title: curto e específico ao formato (ex: "E-mail de desculpas ao cliente", "Review do filme Oppenheimer", "Entrevista para vaga de dev")
- mission: a tarefa concreta em português, 2-3 frases claras dizendo o que o aluno deve escrever
- themePtBr: contexto e motivação do tema em português
- themeEn: o comando principal em inglês
- context: escolha do catálogo de contextos
- activityType: escolha do catálogo de tipos de atividade
- semanticSummary: 1 frase descrevendo o CONTEÚDO ÚNICO desta atividade (ex: "Escrever email formal pedindo desculpas por entrega atrasada no contexto de trabalho")
- whyThisActivity: 1-2 frases em português explicando por que esta atividade é pedagógica agora
- estimatedTimeMinutes: entre 10 e 20
- instructions: 3-5 itens práticos
- requiredGrammar: 1-3 estruturas gramaticais
- suggestedVocabulary: 3-6 itens
- useTheseWords: 4-8 palavras úteis
- successCriteria: 3-5 critérios mensuráveis
- extraChallenge: 1 desafio opcional avançado (pode ser string vazia se não houver)
- category: categoria ampla (work/travel/entertainment/opinion/personal/technical/social)`;

// ── Build user message ────────────────────────────────────────────────────────

interface RecentThemeRow {
  title: string;
  activity_type: string | null;
  context: string | null;
  semantic_summary: string | null;
}

interface ExcludedTheme {
  title: string;
  activityType?: string;
  context?: string;
  semanticSummary?: string;
}

function buildUserMessage(
  ctx: Record<string, unknown>,
  recentThemes: RecentThemeRow[],
  excludedTheme: ExcludedTheme | null,
  retryAttempt: number
): string {
  const lines: string[] = [];

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

  lines.push('');
  lines.push('═══ HISTÓRICO DE TEMAS GERADOS (mais recente primeiro) ═══');

  if (recentThemes.length === 0) {
    lines.push('Nenhum tema gerado anteriormente. Gere um tema inicial variado.');
  } else {
    recentThemes.forEach((t, i) => {
      lines.push(
        `[${i + 1}] Tipo: ${t.activity_type || '—'} | Contexto: ${t.context || '—'} | Título: "${t.title}" | Resumo: ${t.semantic_summary || '—'}`
      );
    });
  }

  if (excludedTheme) {
    lines.push('');
    lines.push('═══ TEMA RECUSADO PELO USUÁRIO — PROIBIDO REPETIR ═══');
    lines.push(`Título: "${excludedTheme.title}"`);
    lines.push(`Tipo: ${excludedTheme.activityType || '—'}`);
    lines.push(`Contexto: ${excludedTheme.context || '—'}`);
    lines.push(`Resumo: ${excludedTheme.semanticSummary || '—'}`);
    lines.push('Este tema e qualquer variação semântica dele estão PROIBIDOS.');
  }

  if (retryAttempt > 1) {
    lines.push('');
    lines.push(`⚠️ AVISO: Esta é a tentativa ${retryAttempt}. As tentativas anteriores foram rejeitadas por semelhança semântica.`);
    lines.push('Você DEVE escolher um tipo de atividade e contexto COMPLETAMENTE DIFERENTES de tudo no histórico.');
    lines.push('Se o histórico tem narrativas/diários, escolha: email_formal, job_interview, movie_review, debate, comparison, bug_report ou process_explanation.');
  }

  lines.push('');
  lines.push('Siga os 6 passos obrigatórios e gere uma missão genuinamente diferente de todas as listadas acima.');

  return lines.join('\n');
}

// ── Semantic deduplication ────────────────────────────────────────────────────

function jaccardSimilarity(a: string, b: string): number {
  const stopwords = new Set([
    'de', 'a', 'o', 'que', 'e', 'do', 'da', 'em', 'um', 'para', 'com',
    'os', 'no', 'se', 'na', 'por', 'mais', 'as', 'dos', 'como', 'sua',
    'seu', 'sobre', 'the', 'a', 'an', 'to', 'of', 'in', 'on', 'at',
    'and', 'or', 'is', 'was', 'are', 'were',
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

function isTooSimilar(candidate: Record<string, unknown>, recentThemes: RecentThemeRow[], threshold = 0.35): boolean {
  const candidateText = [
    candidate.title,
    candidate.semanticSummary,
    candidate.activityType,
    candidate.context,
    candidate.mission,
  ]
    .filter(Boolean)
    .join(' ');

  for (const t of recentThemes.slice(0, 10)) {
    const existingText = [t.title, t.semantic_summary, t.activity_type, t.context]
      .filter(Boolean)
      .join(' ');
    if (jaccardSimilarity(candidateText, existingText) > threshold) {
      return true;
    }
  }
  return false;
}

// ── Validate and normalize AI output ─────────────────────────────────────────

const VALID_LEVELS = new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
const VALID_DIFFS = new Set(['easy', 'medium', 'hard']);

function normalizeTheme(parsed: any): Record<string, unknown> {
  return {
    title: String(parsed.title || 'Missão do dia'),
    mission: String(parsed.mission || ''),
    themePtBr: String(parsed.themePtBr || parsed.mission || ''),
    themeEn: String(parsed.themeEn || ''),
    context: String(parsed.context || 'geral'),
    activityType: String(parsed.activityType || 'narrative'),
    semanticSummary: String(parsed.semanticSummary || ''),
    whyThisActivity: String(parsed.whyThisActivity || ''),
    objective: String(parsed.objective || ''),
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

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY não configurada.' });

  const { learningContext, previousThemeId, excludedTheme } = req.body ?? {};

  const supabase = createClient(
    process.env.VITE_SUPABASE_URL ?? '',
    process.env.VITE_SUPABASE_ANON_KEY ?? ''
  );

  // Mark previous theme as regenerated
  if (previousThemeId) {
    try {
      await supabase
        .from('generated_themes')
        .update({ status: 'regenerated' })
        .eq('id', previousThemeId);
    } catch (e) {
      console.error('Failed to update previous theme status:', e);
    }
  }

  // Fetch recent theme history for context and deduplication
  let recentThemes: RecentThemeRow[] = [];
  try {
    const { data } = await supabase
      .from('generated_themes')
      .select('title, activity_type, context, semantic_summary')
      .is('user_id', null)
      .order('created_at', { ascending: false })
      .limit(30);
    recentThemes = (data ?? []) as RecentThemeRow[];
  } catch (e) {
    console.error('Failed to fetch recent themes:', e);
  }

  // Also inject the excluded theme into the recent list for deduplication
  // so the similarity check catches it even if it wasn't saved yet
  if (excludedTheme) {
    const alreadyInHistory = recentThemes.some(
      (t) => t.title === excludedTheme.title
    );
    if (!alreadyInHistory) {
      recentThemes = [
        {
          title: excludedTheme.title ?? '',
          activity_type: excludedTheme.activityType ?? null,
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
        temperature: 0.85 + (attempt - 1) * 0.05,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: buildUserMessage(
              learningContext ?? {},
              recentThemes,
              excludedTheme ?? null,
              attempt
            ),
          },
        ],
      });
      raw = completion.choices[0]?.message?.content ?? '';
    } catch (err: any) {
      console.error(`Attempt ${attempt} OpenAI error:`, err);
      if (attempt >= MAX_ATTEMPTS) {
        return res.status(500).json({ error: err?.message ?? 'Erro ao gerar tema.' });
      }
      continue;
    }

    const parsed = parseRawContent(raw);
    if (!parsed) {
      console.error(`Attempt ${attempt}: invalid JSON response`);
      continue;
    }

    const candidate = normalizeTheme(parsed);

    // On the last attempt, skip similarity check to guarantee a response
    if (attempt < MAX_ATTEMPTS && isTooSimilar(candidate, recentThemes)) {
      console.log(`Attempt ${attempt}: semantically too similar, retrying…`);
      continue;
    }

    theme = candidate;
    break;
  }

  if (!theme) {
    return res.status(500).json({
      error: 'Não foi possível gerar um tema diferente. Tente novamente.',
    });
  }

  // Persist to database
  let themeId: string | null = null;
  try {
    const { data, error } = await supabase
      .from('generated_themes')
      .insert({
        user_id: null,
        title: theme.title,
        description: theme.mission,
        grammar_focus: theme.requiredGrammar,
        activity_type: theme.activityType,
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
