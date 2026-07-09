import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

// Keep in sync with src/config/ai.ts
const AI_MODEL = 'gpt-5-mini';

const SYSTEM_PROMPT = `Você é um professor particular de inglês para um brasileiro chamado Paulo.

Objetivo do aluno:
- melhorar escrita em inglês
- ganhar constância
- evoluir para inglês profissional
- preparar-se futuramente para entrevistas internacionais como Software Engineer

Analise o texto abaixo considerando:
- tema do dia
- objetivo gramatical
- tempo verbal esperado
- nível estimado de escrita

Retorne APENAS JSON válido, sem markdown, sem comentários e sem texto fora do JSON.

Schema obrigatório:

{
  "score": 0,
  "cefrLevel": "A1",
  "grammarScore": 0,
  "vocabularyScore": 0,
  "naturalnessScore": 0,
  "fluencyScore": 0,
  "correctedText": "",
  "summary": "",
  "grammarFeedback": [
    {
      "title": "",
      "explanationPt": "",
      "wrongExample": "",
      "correctExample": ""
    }
  ],
  "mainErrors": [""],
  "newVocabulary": [
    {
      "word": "",
      "meaningPt": "",
      "example": ""
    }
  ],
  "naturalExpressions": [
    {
      "original": "",
      "better": "",
      "explanationPt": ""
    }
  ],
  "grammarGoalAchieved": true,
  "rewriteChallenge": ""
}

Regras:
- score deve ser de 0 a 100
- cefrLevel deve ser A1, A2, B1, B2, C1 ou C2
- grammarScore, vocabularyScore, naturalnessScore e fluencyScore devem ser de 0 a 100
- Explicações devem ser em português
- correctedText deve estar em inglês
- Seja honesto, mas motivador
- Não inventar erro se o texto estiver correto
- Se o texto for muito curto, informar isso no summary e dar nota proporcional
- Avaliar se o objetivo gramatical foi cumprido
- O rewriteChallenge deve ser opcional e simples`;

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
        return res.status(500).json({
          error: `Modelo não retornou JSON válido. Resposta: ${rawContent.slice(0, 300)}`,
        });
      }
      feedback = JSON.parse(jsonMatch[0]);
    }

    const reviewedAt = new Date().toISOString();

    // Persist to Supabase (non-fatal if it fails)
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
            cefr_level: feedback.cefrLevel ?? null,
            grammar_score: feedback.grammarScore ?? null,
            vocabulary_score: feedback.vocabularyScore ?? null,
            naturalness_score: feedback.naturalnessScore ?? null,
            fluency_score: feedback.fluencyScore ?? null,
            ai_summary: feedback.summary ?? null,
            grammar_feedback: feedback.grammarFeedback ?? null,
            ai_main_errors: feedback.mainErrors ?? null,
            new_vocabulary: feedback.newVocabulary ?? null,
            natural_expressions: feedback.naturalExpressions ?? null,
            grammar_goal_achieved: feedback.grammarGoalAchieved ?? null,
            rewrite_challenge: feedback.rewriteChallenge ?? null,
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
