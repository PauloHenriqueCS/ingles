import OpenAI from 'openai';

const AI_MODEL = 'gpt-4o-mini';

const SYSTEM_PROMPT = `Você é um professor de inglês para brasileiros adultos iniciantes.

Sua tarefa é criar um tema de escrita personalizado para o aluno praticar inglês hoje.

Você receberá um resumo do histórico do aluno:
- nível atual
- média de nota
- habilidade mais fraca
- erros recentes
- vocabulário recente
- últimos objetivos
- próximas práticas sugeridas

Crie um exercício curto, prático e adequado ao nível do aluno.

O exercício deve ajudar o aluno a melhorar o ponto mais fraco identificado.

Se a habilidade mais fraca for grammar:
- foque em construção de frases, tempos verbais, ordem das palavras ou preposições.

Se a habilidade mais fraca for vocabulary:
- foque em ampliar palavras e expressões úteis.

Se a habilidade mais fraca for naturalness:
- foque em frases mais naturais e menos traduzidas do português.

Se a habilidade mais fraca for fluency:
- foque em escrever textos mais conectados, com começo, meio e fim.

Para níveis A1 e A2:
- use instruções simples.
- não peça texto muito longo.
- prefira temas do cotidiano, trabalho, rotina, viagem, planos, experiências simples e opiniões fáceis.

Responda em português do Brasil, exceto:
- themeEn
- objective
- exampleSentence
- palavras e exemplos em inglês.

Retorne somente JSON válido.
Não use markdown.
Não escreva nada antes ou depois do JSON.

Formato obrigatório:

{
  "title": string,
  "themePtBr": string,
  "themeEn": string,
  "objective": string,
  "level": "A1" | "A2" | "B1" | "B2" | "C1" | "C2",
  "estimatedTimeMinutes": number,
  "instructions": string[],
  "requiredGrammar": string[],
  "suggestedVocabulary": [
    {
      "word": string,
      "meaningPtBr": string,
      "example": string
    }
  ],
  "useTheseWords": string[],
  "exampleSentence": string,
  "successCriteria": string[],
  "difficulty": "easy" | "medium" | "hard",
  "category": string
}

Regras:
- title deve ser curto.
- themePtBr deve explicar o tema em português.
- themeEn deve ser o comando em inglês.
- objective deve explicar o objetivo gramatical ou comunicativo em inglês.
- level deve respeitar o nível atual do aluno.
- estimatedTimeMinutes deve ficar entre 10 e 20.
- instructions deve ter de 3 a 5 itens.
- requiredGrammar deve ter de 1 a 3 itens.
- suggestedVocabulary deve ter de 3 a 6 itens.
- useTheseWords deve ter de 4 a 8 palavras úteis.
- exampleSentence deve ser uma frase exemplo em inglês.
- successCriteria deve ter de 3 a 5 critérios.
- difficulty deve ser easy, medium ou hard.
- category pode ser: work, routine, travel, opinion, past, future, personal, study ou daily-life.

Se não houver histórico suficiente:
- gere um tema simples de nível A1.
- foque em frases curtas sobre rotina, trabalho ou ontem.
- não mencione que faltam dados de forma negativa.`;

function buildUserMessage(ctx: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`Nível atual do aluno: ${ctx.currentLevel || 'A1'}`);
  lines.push(`Média de nota: ${ctx.averageScore ?? 0}/100`);
  lines.push(`Habilidade mais fraca: ${ctx.weakestSkill || 'desconhecida'}`);

  const mistakes = Array.isArray(ctx.recentMistakes) ? (ctx.recentMistakes as string[]) : [];
  if (mistakes.length > 0) {
    lines.push('Erros recentes:');
    mistakes.slice(0, 5).forEach((m) => lines.push(`- ${m}`));
  }

  const vocab = Array.isArray(ctx.recentVocabulary) ? (ctx.recentVocabulary as string[]) : [];
  if (vocab.length > 0) {
    lines.push(`Vocabulário recente: ${vocab.join(', ')}`);
  }

  const objectives = Array.isArray(ctx.lastObjectives) ? (ctx.lastObjectives as string[]) : [];
  if (objectives.length > 0) {
    lines.push('Últimos objetivos praticados:');
    objectives.forEach((o) => lines.push(`- ${o}`));
  }

  const practices = Array.isArray(ctx.lastNextPractices) ? (ctx.lastNextPractices as string[]) : [];
  if (practices.length > 0) {
    lines.push('Próximas práticas sugeridas anteriormente:');
    practices.forEach((p) => lines.push(`- ${p}`));
  }

  return lines.join('\n');
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).end();

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY não configurada.' });
  }

  const { learningContext } = req.body ?? {};

  try {
    const openai = new OpenAI({ apiKey });

    const completion = await openai.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserMessage(learningContext ?? {}) },
      ],
    });

    const rawContent = completion.choices[0]?.message?.content ?? '';

    let parsed: any;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      const match = rawContent.match(/\{[\s\S]*\}/);
      if (!match) {
        return res.status(500).json({ error: 'Resposta inválida da IA. Tente novamente.' });
      }
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        return res.status(500).json({ error: 'Resposta inválida da IA. Tente novamente.' });
      }
    }

    const validLevels = new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
    const validDiffs = new Set(['easy', 'medium', 'hard']);

    const theme = {
      title: String(parsed.title || 'Tema do dia'),
      themePtBr: String(parsed.themePtBr || ''),
      themeEn: String(parsed.themeEn || ''),
      objective: String(parsed.objective || ''),
      level: validLevels.has(parsed.level) ? parsed.level : 'A1',
      estimatedTimeMinutes: Number(parsed.estimatedTimeMinutes) || 15,
      instructions: Array.isArray(parsed.instructions) ? parsed.instructions : [],
      requiredGrammar: Array.isArray(parsed.requiredGrammar) ? parsed.requiredGrammar : [],
      suggestedVocabulary: Array.isArray(parsed.suggestedVocabulary) ? parsed.suggestedVocabulary : [],
      useTheseWords: Array.isArray(parsed.useTheseWords) ? parsed.useTheseWords : [],
      exampleSentence: String(parsed.exampleSentence || ''),
      successCriteria: Array.isArray(parsed.successCriteria) ? parsed.successCriteria : [],
      difficulty: validDiffs.has(parsed.difficulty) ? parsed.difficulty : 'easy',
      category: String(parsed.category || 'daily-life'),
    };

    return res.json({ theme });
  } catch (err: any) {
    console.error('generate-theme error:', err);
    return res.status(500).json({ error: err?.message ?? 'Erro interno ao gerar tema.' });
  }
}
