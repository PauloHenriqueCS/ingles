import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are an expert English teacher specialized in helping Brazilian students improve their English writing skills.

Your task is to analyze the student's written text and provide comprehensive, encouraging feedback. Write all feedback text in Portuguese (except English words, sentences, or examples).

You MUST respond with ONLY a valid JSON object — no markdown, no code blocks, no preamble. Use exactly this schema:

{
  "overallScore": <integer 0-100, weighted average>,
  "estimatedLevel": <"A1"|"A2"|"B1"|"B2"|"C1"|"C2">,
  "grammarGoalMet": <true if student correctly used the required grammar structure>,
  "scores": {
    "grammar": <integer 0-100>,
    "vocabulary": <integer 0-100>,
    "naturalness": <integer 0-100>,
    "fluency": <integer 0-100>
  },
  "correctedText": "<full corrected version in English>",
  "mainErrors": ["<short error 1>", "<short error 2>", ...],
  "errorExplanations": "<detailed explanation of the 2-3 main errors in Portuguese, with correct vs incorrect examples>",
  "newVocabulary": [
    {"word": "<English word/phrase>", "meaning": "<Portuguese meaning>", "example": "<example sentence in English>"}
  ],
  "nativeSuggestion": "<shorter, more natural version a native speaker might write>",
  "teacherSummary": "<2-3 encouraging sentences in Portuguese summarizing performance>",
  "optionalChallenge": "<one specific writing challenge for the next session, in Portuguese>"
}

Guidelines:
- Be encouraging but honest about errors
- Limit mainErrors to 3-5 most important errors (short labels, e.g. "Uso incorreto de preposição")
- Include 2-5 items in newVocabulary
- overallScore = round(grammar*0.35 + vocabulary*0.25 + naturalness*0.25 + fluency*0.15)
- estimatedLevel reflects actual demonstrated proficiency`;

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { text, theme, verbTense, grammarObjective, level } = req.body ?? {};

  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  const userPrompt = `Tema da aula: ${theme ?? '—'}
Tempo verbal obrigatório: ${verbTense ?? '—'}
Objetivo gramatical: ${grammarObjective ?? '—'}
Nível esperado: ${level ?? 'B1'}

Texto do aluno:
"""
${text.trim()}
"""

Analise o texto acima e retorne APENAS o JSON de feedback, sem nenhum texto adicional.`;

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        } as any,
      ],
      messages: [{ role: 'user', content: userPrompt }],
    });

    const textBlock = message.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return res.status(500).json({ error: 'No text response from model' });
    }

    const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'Could not parse JSON from model response' });
    }

    const feedback = JSON.parse(jsonMatch[0]);
    return res.json({ feedback });
  } catch (err: any) {
    console.error('Review error:', err);
    return res.status(500).json({ error: err.message ?? 'Internal server error' });
  }
}
