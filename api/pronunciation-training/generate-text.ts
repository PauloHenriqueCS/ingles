import OpenAI from 'openai';
import { requireAuth } from '../_auth';
import { methodGuard, jsonError, safeLog, sanitizeProviderError } from '../_helpers';

const AI_MODEL = 'gpt-4o-mini';
const GENERATE_TIMEOUT_MS = 30_000;

const WORD_TARGETS: Record<string, { min: number; max: number }> = {
  A1: { min: 50, max: 80  },
  A2: { min: 50, max: 80  },
  B1: { min: 80, max: 120 },
  B2: { min: 80, max: 120 },
  C1: { min: 120, max: 160 },
  C2: { min: 120, max: 160 },
};

function buildSystemPrompt(level: string): string {
  const { min, max } = WORD_TARGETS[level] ?? { min: 80, max: 120 };

  const levelGuide: Record<string, string> = {
    A1: 'A1 (beginner): simple present tense, common everyday words, very short sentences',
    A2: 'A2 (elementary): simple past and present, everyday vocabulary, short connected sentences',
    B1: 'B1 (intermediate): varied tenses, compound sentences, everyday and some idiomatic expressions',
    B2: 'B2 (upper-intermediate): complex structures, nuanced vocabulary, subordinate clauses',
    C1: 'C1 (advanced): sophisticated grammar, wide vocabulary, complex ideas expressed naturally',
    C2: 'C2 (proficient): native-like fluency, subtle distinctions, rich idiomatic language',
  };

  return `You write short English texts for pronunciation practice.

Level: ${levelGuide[level] ?? levelGuide.B1}
Word count target: ${min}–${max} words (count carefully before submitting)

Rules:
- Write a vivid, specific scenario featuring a real decision, small conflict, or unexpected turn
- Use concrete names, specific places, and a moment of tension or surprise
- Avoid: daily-routine lists, hobby catalogues, generic "I woke up and…" intros
- Sentences should be short to medium length and flow naturally when read aloud
- No bullet points, no headings, no titles — just a continuous narrative paragraph
- Write in third person or second person; no first-person "I" narrator
- Vocabulary must be natural for ${level} — do not inflate difficulty to "test" pronunciation

Output only the text. Nothing else.`;
}

/**
 * POST /api/pronunciation-training/generate-text
 *
 * Generates a short English reading passage at the user's current level.
 * Reads the level from english_learning_memory; defaults to A2 if unavailable.
 * No DB writes — this is a stateless, ephemeral training session.
 */
export default async function handler(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { supabase, userId } = auth;

  // Best-effort level lookup — falls back to A2 on any error
  let userLevel = 'A2';
  try {
    const { data } = await supabase
      .from('english_learning_memory')
      .select('current_level')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.current_level && typeof data.current_level === 'string') {
      userLevel = data.current_level;
    }
  } catch {
    // Use default
  }

  const apiKey = (process.env.OPENAI_API_KEY ?? '').trim();
  if (!apiKey) {
    return jsonError(res, 503, 'AI_UNAVAILABLE', 'Serviço de IA não configurado.');
  }

  const openai = new OpenAI({ apiKey, timeout: GENERATE_TIMEOUT_MS });

  try {
    const completion = await openai.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: buildSystemPrompt(userLevel) },
        { role: 'user',   content: 'Write the text now.' },
      ],
      temperature: 0.9,
      max_tokens: 400,
    });

    const text = completion.choices[0]?.message?.content?.trim() ?? '';
    if (!text) {
      return jsonError(res, 503, 'AI_UNAVAILABLE', 'Não foi possível gerar o texto. Tente novamente.');
    }

    safeLog('pronunciation-training/generate-text', 'success', 200);
    return res.status(200).json({ text, level: userLevel });
  } catch (err) {
    const { code, status } = sanitizeProviderError(err);
    return jsonError(res, status, code, 'Não foi possível gerar o texto. Tente novamente.');
  }
}
