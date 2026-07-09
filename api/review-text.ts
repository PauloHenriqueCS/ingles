import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

const AI_MODEL = 'gpt-4o-mini';

const SYSTEM_PROMPT = `Você é um professor de inglês para brasileiros adultos iniciantes.

Avalie o texto em inglês escrito pelo usuário.

Responda sempre em português do Brasil, exceto nos campos de texto corrigido, exemplos e palavras em inglês.

Você deve ser didático, direto e encorajador. Não seja agressivo. O objetivo é ensinar, não humilhar.

Analise:
- gramática
- vocabulário
- naturalidade
- fluência
- cumprimento do objetivo do dia

Retorne somente JSON válido. Não use markdown. Não escreva nada antes ou depois do JSON.

Formato obrigatório:

{
  "score": number,
  "level": "A1" | "A2" | "B1" | "B2" | "C1" | "C2",
  "grammar": number,
  "vocabulary": number,
  "naturalness": number,
  "fluency": number,
  "summary": string,
  "correctedText": string,
  "mainMistakes": [
    {
      "original": string,
      "correct": string,
      "explanation": string
    }
  ],
  "newVocabulary": [
    {
      "word": string,
      "meaningPtBr": string,
      "example": string
    }
  ],
  "objectiveFeedback": string,
  "nextPractice": string
}

Regras:
- score deve ir de 0 a 100.
- grammar, vocabulary, naturalness e fluency devem ir de 0 a 100.
- level deve ser A1, A2, B1, B2, C1 ou C2.
- correctedText deve corrigir o texto mantendo a ideia original do aluno, em inglês.
- mainMistakes deve conter no máximo 5 erros principais.
- newVocabulary deve conter de 3 a 5 itens.
- objectiveFeedback deve explicar se o objetivo gramatical do dia foi cumprido.
- nextPractice deve ser uma tarefa curta e prática para o próximo treino.
- Se o texto for muito curto, avalie mesmo assim e explique no summary que a nota ficou baixa por falta de conteúdo.
- Se o texto estiver vazio ou quase vazio, retorne score 0 e peça para o usuário escrever pelo menos 3 frases.`;

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).end();

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'OPENAI_API_KEY não configurada. Adicione a variável no Vercel → Settings → Environment Variables.',
    });
  }

  const { entryId, originalText, theme, grammarGoal, mainTense } = req.body ?? {};

  if (!originalText || typeof originalText !== 'string' || !originalText.trim()) {
    return res.status(400).json({ error: 'originalText é obrigatório' });
  }

  const userMessage = `Tema do dia: ${theme || '—'}
Objetivo gramatical: ${grammarGoal || '—'}
Tempo verbal esperado: ${mainTense || '—'}

Texto do aluno:
"""
${originalText.trim()}
"""`;

  try {
    const openai = new OpenAI({ apiKey });

    const completion = await openai.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    });

    const rawContent = completion.choices[0]?.message?.content ?? '';

    let feedback: any;
    try {
      feedback = JSON.parse(rawContent);
    } catch {
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error('Non-JSON response from model:', rawContent.slice(0, 500));
        return res.status(500).json({
          error: 'O professor está com dificuldades para responder. Tente novamente em alguns instantes.',
        });
      }
      try {
        feedback = JSON.parse(jsonMatch[0]);
      } catch {
        console.error('Failed to parse extracted JSON:', jsonMatch[0].slice(0, 500));
        return res.status(500).json({
          error: 'O professor está com dificuldades para responder. Tente novamente em alguns instantes.',
        });
      }
    }

    const reviewedAt = new Date().toISOString();

    if (entryId) {
      try {
        const supabase = createClient(
          process.env.VITE_SUPABASE_URL ?? '',
          process.env.VITE_SUPABASE_ANON_KEY ?? ''
        );
        await supabase
          .from('writing_entries')
          .update({
            corrected_text: feedback.correctedText ?? null,
            ai_score: feedback.score ?? null,
            cefr_level: feedback.level ?? null,
            grammar_score: feedback.grammar ?? null,
            vocabulary_score: feedback.vocabulary ?? null,
            naturalness_score: feedback.naturalness ?? null,
            fluency_score: feedback.fluency ?? null,
            ai_summary: feedback.summary ?? null,
            grammar_feedback: feedback.mainMistakes ?? null,
            ai_main_errors: feedback.mainMistakes?.map((m: any) => m.original) ?? null,
            new_vocabulary: feedback.newVocabulary ?? null,
            natural_expressions: null,
            grammar_goal_achieved: null,
            rewrite_challenge: feedback.nextPractice ?? null,
            reviewed_at: reviewedAt,
            status: 'corrigido',
          })
          .eq('entry_date', entryId);
      } catch (dbErr) {
        console.error('Supabase update error:', dbErr);
      }
    }

    return res.json({ feedback, reviewedAt });
  } catch (err: any) {
    const message = err?.message ?? 'Erro interno';
    const detail = err?.error?.message ?? '';
    console.error('Review error:', err);
    return res.status(500).json({
      error: detail ? `${message} — ${detail}` : message,
    });
  }
}
