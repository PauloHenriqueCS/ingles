import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from './_auth';

const AI_MODEL = 'gpt-4o-mini';

function buildPrompt(grammarName: string): string {
  return `Explique o tópico gramatical "${grammarName}" para brasileiros adultos aprendendo inglês.

Retorne SOMENTE JSON válido. Sem markdown, sem texto antes ou depois.

{
  "name": "${grammarName}",
  "summaryPt": "o que é e por que importa — 2 a 3 frases em português",
  "whenToUse": [
    "situação específica com exemplo entre parênteses",
    "outra situação com exemplo"
  ],
  "structure": {
    "affirmative": "Subject + ...",
    "negative": "Subject + do/does not + ...",
    "question": "Do/Does + Subject + ...?"
  },
  "examples": [
    { "english": "frase completa em inglês", "portuguese": "tradução natural em português" }
  ],
  "commonMistakes": [
    { "wrong": "frase incorreta", "correct": "frase correta", "explanationPt": "por que está errado e como corrigir" }
  ],
  "tips": [
    "dica prática — começa com verbo no imperativo: Use, Lembre, Preste atenção em..."
  ],
  "traps": [
    "armadilha típica de brasileiros — por que acontece (influência do português) e como evitar"
  ],
  "finalSummaryPt": "resumo em até 3 linhas do que é essencial saber sobre este tópico"
}

Requisitos obrigatórios:
- whenToUse: mínimo 4 situações com exemplos entre parênteses
- examples: mínimo 5 exemplos variados (afirmativa, negativa, pergunta, contextos diferentes)
- commonMistakes: mínimo 5 erros típicos de brasileiros
- tips: 3 a 5 dicas práticas e aplicáveis
- traps: 3 a 5 armadilhas específicas de falantes de português
- Todas as explicações em português; toda gramática e exemplos em inglês`;
}

function parseJson(raw: string): any | null {
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).end();

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const { grammarName } = req.body ?? {};
  if (!grammarName || typeof grammarName !== 'string') {
    return res.status(400).json({ error: 'grammarName is required' });
  }

  const trimmed = grammarName.trim();

  // Use anon client for grammar_explanations (shared public cache)
  const supabase = createClient(
    process.env.VITE_SUPABASE_URL ?? '',
    process.env.VITE_SUPABASE_ANON_KEY ?? '',
    { global: { headers: { Authorization: req.headers['authorization'] ?? '' } } }
  );

  // Check cache
  try {
    const { data: cached } = await supabase
      .from('grammar_explanations')
      .select('content')
      .ilike('name', trimmed)
      .maybeSingle();

    if (cached?.content) {
      return res.json({ content: cached.content, cached: true });
    }
  } catch (e) {
    console.error('Cache lookup failed:', e);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY não configurada.' });

  let content: any;
  try {
    const openai = new OpenAI({ apiKey });
    const completion = await openai.chat.completions.create({
      model: AI_MODEL,
      temperature: 0.7,
      messages: [
        {
          role: 'system',
          content: 'Você é um professor particular de inglês para brasileiros adultos. Suas explicações são claras, práticas e focadas nos erros típicos de falantes de português brasileiro.',
        },
        { role: 'user', content: buildPrompt(trimmed) },
      ],
    });
    const raw = completion.choices[0]?.message?.content ?? '';
    content = parseJson(raw);
    if (!content) {
      return res.status(500).json({ error: 'Resposta inválida da IA.' });
    }
  } catch (err: any) {
    console.error('OpenAI error:', err);
    return res.status(500).json({ error: err?.message ?? 'Erro ao gerar explicação.' });
  }

  // Persist to shared cache
  try {
    await supabase
      .from('grammar_explanations')
      .insert({ name: trimmed, content })
      .select()
      .single();
  } catch (e) {
    console.error('Failed to cache grammar explanation:', e);
  }

  return res.json({ content, cached: false });
}
