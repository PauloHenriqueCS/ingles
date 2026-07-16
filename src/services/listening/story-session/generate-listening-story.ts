import OpenAI from 'openai';
import { createHmac } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveUserListeningLevel } from '../daily/resolve-user-listening-level';

// ── Public types ──────────────────────────────────────────────────────────────

export interface StoryPartResult {
  id: 1 | 2;
  text: string;
  audioUrl: string;
  audioExpiresAt: string;
  question: {
    prompt: string;
    options: string[]; // exactly 5
  };
  answerToken: string;
}

export interface ListeningStoryResult {
  title: string;
  level: string;
  summary: string;
  parts: [StoryPartResult, StoryPartResult];
}

// ── Word ranges per level (per PART) ─────────────────────────────────────────
// Target: ~5 min per part at ~130 wpm English TTS

const PART_WORD_RANGES: Record<string, { min: number; max: number }> = {
  A1: { min: 500,  max: 650  }, // total ~1000–1300
  A2: { min: 650,  max: 850  }, // total ~1300–1700
  B1: { min: 800,  max: 1050 }, // total ~1600–2100
  B2: { min: 950,  max: 1250 }, // total ~1900–2500
  C1: { min: 1050, max: 1450 }, // total ~2100–2900
  C2: { min: 1200, max: 1600 }, // total ~2400–3200
};

// ── AI response structure ─────────────────────────────────────────────────────

interface AIPart {
  id: number;
  text: string;
  question: {
    text: string;
    options: string[];
    correctIndex: number;
    explanationPt: string;
  };
}

interface AIStory {
  title: string;
  level: string;
  summary: string;
  parts: AIPart[];
}

// ── Prompt ────────────────────────────────────────────────────────────────────

function buildPrompt(level: string): string {
  const range = PART_WORD_RANGES[level] ?? { min: 500, max: 650 };
  return `Generate an English listening comprehension activity for a ${level} CEFR learner.

The activity is ONE continuous story divided into exactly 2 parts.

Return ONLY a JSON object — no markdown fences, no extra text:
{
  "title": "Short title in English (max 8 words)",
  "level": "${level}",
  "summary": "One-sentence summary of the full story in English (max 20 words)",
  "parts": [
    {
      "id": 1,
      "text": "First half of the story in English (${range.min}–${range.max} words). Must end at a natural point — the story is NOT finished yet.",
      "question": {
        "text": "Comprehension question about Part 1 ONLY (not about Part 2)",
        "options": ["Option A", "Option B", "Option C", "Option D", "Option E"],
        "correctIndex": 0,
        "explanationPt": "1–2 sentence explanation in Brazilian Portuguese of why the correct answer is right"
      }
    },
    {
      "id": 2,
      "text": "Second half of the story, continuing directly from Part 1 (${range.min}–${range.max} words). Must complete the story with a clear resolution.",
      "question": {
        "text": "Comprehension question about Part 2 ONLY (not about Part 1)",
        "options": ["Option A", "Option B", "Option C", "Option D", "Option E"],
        "correctIndex": 0,
        "explanationPt": "1–2 sentence explanation in Brazilian Portuguese of why the correct answer is right"
      }
    }
  ]
}

Rules:
- Story: natural narrative, vocabulary and grammar appropriate for ${level}
- Part 1 must end mid-story (a cliffhanger or natural pause), Part 2 must resolve it
- Parts must be real continuations — Part 2 begins exactly where Part 1 ended
- Question 1: tests comprehension of Part 1 ONLY — must be answerable without Part 2
- Question 2: tests comprehension of Part 2 ONLY — must be answerable without Part 1
- Each question: exactly 5 options, exactly one clearly correct, all distractors plausible
- correctIndex: integer 0–4
- Do NOT include translations, summaries, or Portuguese text of the story`;
}

// ── OpenAI call ───────────────────────────────────────────────────────────────

async function callAI(level: string, openaiKey: string): Promise<AIStory> {
  const client = new OpenAI({ apiKey: openaiKey, timeout: 120_000, maxRetries: 1 });

  const resp = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: buildPrompt(level) },
      { role: 'user', content: 'Generate the listening activity now.' },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.8,
    max_tokens: 6000,
  });

  const raw = resp.choices[0]?.message?.content ?? '';
  if (!raw) throw new Error('AI_EMPTY_RESPONSE');

  let parsed: AIStory;
  try {
    parsed = JSON.parse(raw) as AIStory;
  } catch {
    throw new Error('AI_INVALID_JSON');
  }

  if (!parsed.title?.trim()) throw new Error('AI_MISSING_TITLE');
  if (!parsed.summary?.trim()) throw new Error('AI_MISSING_SUMMARY');
  if (!Array.isArray(parsed.parts) || parsed.parts.length < 2)
    throw new Error('AI_WRONG_PARTS_COUNT');

  for (let i = 0; i < 2; i++) {
    const p = parsed.parts[i];
    if (!p?.text?.trim()) throw new Error(`AI_MISSING_PART_${i + 1}_TEXT`);
    if (!p.question?.text?.trim()) throw new Error(`AI_MISSING_PART_${i + 1}_QUESTION`);
    if (!Array.isArray(p.question?.options) || p.question.options.length !== 5)
      throw new Error(`AI_WRONG_OPTION_COUNT_PART_${i + 1}`);
    const ci = p.question?.correctIndex;
    if (typeof ci !== 'number' || ci < 0 || ci > 4)
      throw new Error(`AI_INVALID_CORRECT_INDEX_PART_${i + 1}`);
    if (!p.question?.explanationPt?.trim())
      throw new Error(`AI_MISSING_EXPLANATION_PART_${i + 1}`);
  }

  return parsed;
}

// ── Azure TTS ─────────────────────────────────────────────────────────────────
// Reuses the same voice/format/endpoint pattern as generate-story-session.ts

function escapeXml(t: string): string {
  return t
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function synthesizeAudio(
  text: string,
  azureKey: string,
  azureRegion: string,
  partLabel: string,
): Promise<Buffer> {
  const ssml =
    `<speak version="1.0" xml:lang="en-US">` +
    `<voice name="en-US-AvaMultilingualNeural">` +
    `<prosody rate="0%">${escapeXml(text)}</prosody>` +
    `</voice></speak>`;

  const url = `https://${azureRegion}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': azureKey,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
        'User-Agent': 'lemon-english-app/1.0',
      },
      body: ssml,
      signal: controller.signal,
    });
  } catch (err: unknown) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    throw new Error(isAbort ? `AZURE_TTS_TIMEOUT_${partLabel}` : `AZURE_TTS_NETWORK_ERROR_${partLabel}`);
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 429) throw new Error(`AZURE_TTS_RATE_LIMITED_${partLabel}`);
  if (resp.status === 401 || resp.status === 403) throw new Error(`AZURE_TTS_AUTH_FAILED_${partLabel}`);
  if (!resp.ok) throw new Error(`AZURE_TTS_HTTP_${resp.status}_${partLabel}`);

  const buf = await resp.arrayBuffer();
  if (!buf.byteLength) throw new Error(`AZURE_TTS_EMPTY_AUDIO_${partLabel}`);

  return Buffer.from(buf);
}

// ── Supabase Storage ──────────────────────────────────────────────────────────

const BUCKET = 'listening-audio';
const SIGNED_URL_SECONDS = 3600;

async function uploadAndSign(
  audio: Buffer,
  userId: string,
  partId: 1 | 2,
  supabase: SupabaseClient,
): Promise<{ url: string; expiresAt: string }> {
  const path = `story-sessions/${userId}/${crypto.randomUUID()}-part${partId}.mp3`;

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, audio, { contentType: 'audio/mpeg', upsert: false });

  if (upErr) throw new Error(`STORAGE_UPLOAD_PART${partId}: ${upErr.message}`);

  const { data: signed, error: signErr } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_SECONDS);

  if (signErr || !signed?.signedUrl)
    throw new Error(`STORAGE_SIGN_PART${partId}: ${signErr?.message ?? 'no URL'}`);

  return {
    url: signed.signedUrl,
    expiresAt: new Date(Date.now() + SIGNED_URL_SECONDS * 1000).toISOString(),
  };
}

// ── HMAC answer token ─────────────────────────────────────────────────────────
// Reuses same signing logic as generate-story-session.ts

function signToken(correctIndex: number, explanationPt: string, secret: string): string {
  const payload = JSON.stringify({
    c: correctIndex,
    e: explanationPt,
    x: Date.now() + 4 * 60 * 60 * 1000,
  });
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return Buffer.from(JSON.stringify({ p: payload, s: sig })).toString('base64url');
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateListeningStory(
  userId: string,
  serviceClient: SupabaseClient,
  openaiKey: string,
  azureKey: string,
  azureRegion: string,
  secret: string,
): Promise<ListeningStoryResult> {
  // 1. Resolve CEFR level from DB
  const level = await resolveUserListeningLevel(serviceClient, userId);

  // 2. AI: generate 2-part story with questions
  const ai = await callAI(level, openaiKey);

  // 3. Synthesize both audio parts in parallel
  const [audio1, audio2] = await Promise.all([
    synthesizeAudio(ai.parts[0].text, azureKey, azureRegion, 'part1'),
    synthesizeAudio(ai.parts[1].text, azureKey, azureRegion, 'part2'),
  ]);

  // 4. Upload both to Supabase Storage in parallel
  const [stored1, stored2] = await Promise.all([
    uploadAndSign(audio1, userId, 1, serviceClient),
    uploadAndSign(audio2, userId, 2, serviceClient),
  ]);

  // 5. Sign HMAC answer tokens (correctIndex stays server-side)
  const token1 = signToken(
    ai.parts[0].question.correctIndex,
    ai.parts[0].question.explanationPt,
    secret,
  );
  const token2 = signToken(
    ai.parts[1].question.correctIndex,
    ai.parts[1].question.explanationPt,
    secret,
  );

  return {
    title: ai.title,
    level,
    summary: ai.summary,
    parts: [
      {
        id: 1,
        text: ai.parts[0].text,
        audioUrl: stored1.url,
        audioExpiresAt: stored1.expiresAt,
        question: {
          prompt: ai.parts[0].question.text,
          options: ai.parts[0].question.options,
        },
        answerToken: token1,
      },
      {
        id: 2,
        text: ai.parts[1].text,
        audioUrl: stored2.url,
        audioExpiresAt: stored2.expiresAt,
        question: {
          prompt: ai.parts[1].question.text,
          options: ai.parts[1].question.options,
        },
        answerToken: token2,
      },
    ],
  };
}
