import OpenAI from 'openai';
import { createHmac } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveUserListeningLevel } from '../daily/resolve-user-listening-level';

// ── Public result types ───────────────────────────────────────────────────────

export interface StorySessionResult {
  title: string;
  storyEn: string;
  storyPt: string;
  level: string;
  audioUrl: string;
  audioExpiresAt: string;
  question: {
    prompt: string;
    options: string[]; // exactly 5
  };
  answerToken: string;
}

export interface StoryAnswerResult {
  correct: boolean;
  correctOption: number;
  explanationPt: string;
}

// ── Word ranges per level ─────────────────────────────────────────────────────

const WORD_RANGES: Record<string, { min: number; max: number }> = {
  A1: { min: 120, max: 180 },
  A2: { min: 180, max: 250 },
  B1: { min: 250, max: 340 },
  B2: { min: 300, max: 400 },
  C1: { min: 360, max: 450 },
  C2: { min: 400, max: 480 },
};

// ── AI generation ─────────────────────────────────────────────────────────────

interface AIStory {
  title: string;
  storyEn: string;
  storyPt: string;
  question: {
    prompt: string;
    options: string[];
    correctIndex: number;
    explanationPt: string;
  };
}

function buildPrompt(level: string): string {
  const range = WORD_RANGES[level] ?? { min: 250, max: 340 };
  return `Generate an English listening comprehension activity for a ${level} CEFR learner.

Return ONLY a JSON object — no markdown fences, no extra text:
{
  "title": "Short title in English (max 7 words)",
  "storyEn": "Complete story in English (${range.min}–${range.max} words)",
  "storyPt": "Complete faithful translation into Brazilian Portuguese",
  "question": {
    "prompt": "One comprehension question in English",
    "options": ["Option 1", "Option 2", "Option 3", "Option 4", "Option 5"],
    "correctIndex": 0,
    "explanationPt": "1–2 sentence explanation in Portuguese of why the answer is correct"
  }
}

Rules:
- Story: natural narrative with a clear beginning, middle, end — vocabulary and grammar appropriate for ${level}
- Question: test comprehension of a key detail or inference from the story
- Options: exactly 5, exactly one correct, plausible distractors
- correctIndex: integer 0–4
- Translation: complete, not summarized`;
}

async function callAI(level: string, openaiKey: string): Promise<AIStory> {
  const client = new OpenAI({ apiKey: openaiKey, timeout: 90_000, maxRetries: 1 });

  const resp = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: buildPrompt(level) },
      { role: 'user', content: 'Generate the activity now.' },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.85,
    max_tokens: 2000,
  });

  const raw = resp.choices[0]?.message?.content ?? '';
  if (!raw) throw new Error('AI_EMPTY_RESPONSE');

  const parsed = JSON.parse(raw) as AIStory;

  if (!parsed.title?.trim()) throw new Error('AI_MISSING_TITLE');
  if (!parsed.storyEn?.trim()) throw new Error('AI_MISSING_STORY_EN');
  if (!parsed.storyPt?.trim()) throw new Error('AI_MISSING_STORY_PT');
  if (!parsed.question?.prompt?.trim()) throw new Error('AI_MISSING_QUESTION');
  if (!Array.isArray(parsed.question?.options) || parsed.question.options.length !== 5)
    throw new Error('AI_WRONG_OPTION_COUNT');
  // Normalize: AI may return letter ('A'–'E'), 1-indexed (1–5), or option text
  const rawCi = parsed.question?.correctIndex;
  let ci: number;
  {
    const opts: string[] = parsed.question?.options ?? [];
    const normalize = (raw: unknown): number => {
      if (typeof raw === 'number' && Number.isInteger(raw)) {
        if (raw >= 0 && raw <= 4) return raw;
        if (raw >= 1 && raw <= 5) return raw - 1;
      }
      if (typeof raw === 'string') {
        const upper = raw.trim().toUpperCase();
        if (/^[A-E]$/.test(upper)) return upper.charCodeAt(0) - 65;
        const lower = raw.trim().toLowerCase();
        const idx = opts.findIndex((o: string) => o.trim().toLowerCase() === lower);
        if (idx >= 0) return idx;
      }
      throw new Error('UNNORMALIZABLE');
    };
    try { ci = normalize(rawCi); } catch { throw new Error('AI_INVALID_CORRECT_INDEX'); }
  }
  parsed.question.correctIndex = ci;
  if (!parsed.question?.explanationPt?.trim()) throw new Error('AI_MISSING_EXPLANATION');

  return parsed;
}

// ── Azure TTS ─────────────────────────────────────────────────────────────────

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
): Promise<Buffer> {
  const ssml =
    `<speak version="1.0" xml:lang="en-US">` +
    `<voice name="en-US-AvaMultilingualNeural">` +
    `<prosody rate="0%">${escapeXml(text)}</prosody>` +
    `</voice></speak>`;

  const url = `https://${azureRegion}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

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
    throw new Error(isAbort ? 'AZURE_TTS_TIMEOUT' : `AZURE_TTS_NETWORK_ERROR`);
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 429) throw new Error('AZURE_TTS_RATE_LIMITED');
  if (resp.status === 401 || resp.status === 403) throw new Error('AZURE_TTS_AUTH_FAILED');
  if (!resp.ok) throw new Error(`AZURE_TTS_HTTP_${resp.status}`);

  const buf = await resp.arrayBuffer();
  if (!buf.byteLength) throw new Error('AZURE_TTS_EMPTY_AUDIO');

  return Buffer.from(buf);
}

// ── Supabase Storage ──────────────────────────────────────────────────────────

const BUCKET = 'listening-audio';
const SIGNED_URL_SECONDS = 3600; // 1 hour

async function uploadAndSign(
  audio: Buffer,
  userId: string,
  supabase: SupabaseClient,
): Promise<{ url: string; expiresAt: string }> {
  const path = `story-sessions/${userId}/${crypto.randomUUID()}.mp3`;

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, audio, { contentType: 'audio/mpeg', upsert: false });

  if (upErr) throw new Error(`STORAGE_UPLOAD: ${upErr.message}`);

  const { data: signed, error: signErr } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_SECONDS);

  if (signErr || !signed?.signedUrl)
    throw new Error(`STORAGE_SIGN: ${signErr?.message ?? 'no URL'}`);

  return {
    url: signed.signedUrl,
    expiresAt: new Date(Date.now() + SIGNED_URL_SECONDS * 1000).toISOString(),
  };
}

// ── Answer token (HMAC, no DB) ────────────────────────────────────────────────

function signToken(correctIndex: number, explanationPt: string, secret: string): string {
  const payload = JSON.stringify({
    c: correctIndex,
    e: explanationPt,
    x: Date.now() + 4 * 60 * 60 * 1000, // 4-hour expiry
  });
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return Buffer.from(JSON.stringify({ p: payload, s: sig })).toString('base64url');
}

export function decodeAnswerToken(
  token: string,
  secret: string,
): { correctIndex: number; explanationPt: string } {
  let decoded: { p: string; s: string };
  try {
    decoded = JSON.parse(Buffer.from(token, 'base64url').toString());
  } catch {
    throw new Error('INVALID_TOKEN');
  }

  const expectedSig = createHmac('sha256', secret).update(decoded.p).digest('base64url');
  if (decoded.s !== expectedSig) throw new Error('INVALID_TOKEN');

  const data = JSON.parse(decoded.p);
  if (typeof data.x !== 'number' || data.x < Date.now()) throw new Error('TOKEN_EXPIRED');

  return { correctIndex: Number(data.c), explanationPt: String(data.e ?? '') };
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateStorySession(
  userId: string,
  serviceClient: SupabaseClient,
  openaiKey: string,
  azureKey: string,
  azureRegion: string,
  secret: string,
): Promise<StorySessionResult> {
  // 1. Resolve CEFR level from DB (never from caller)
  const level = await resolveUserListeningLevel(serviceClient, userId);

  // 2. AI: story text + question (includes correctIndex on server side only)
  const ai = await callAI(level, openaiKey);

  // 3. Azure TTS: synthesize story audio
  const audioBuffer = await synthesizeAudio(ai.storyEn, azureKey, azureRegion);

  // 4. Upload to Supabase Storage, get 1-hour signed URL
  const { url: audioUrl, expiresAt: audioExpiresAt } = await uploadAndSign(
    audioBuffer, userId, serviceClient,
  );

  // 5. Sign answer token (correctIndex stays on server, never sent in plain form)
  const answerToken = signToken(ai.question.correctIndex, ai.question.explanationPt, secret);

  return {
    title: ai.title,
    storyEn: ai.storyEn,
    storyPt: ai.storyPt,
    level,
    audioUrl,
    audioExpiresAt,
    question: { prompt: ai.question.prompt, options: ai.question.options },
    answerToken,
  };
}
