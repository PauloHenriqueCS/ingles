import OpenAI from 'openai';
import { createHmac } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveUserListeningLevel } from '../daily/resolve-user-listening-level';

// ── Public types ──────────────────────────────────────────────────────────────

export interface StoryPartResult {
  id: 1 | 2;
  text: string;
  audioBase64: string;
  audioMimeType: string;
  question: {
    prompt: string;
    options: string[]; // exactly 5
    correctOptionIndex: number; // 0-indexed, for client-side comparison
    explanationPt: string;
  };
  answerToken: string;
}

export interface ListeningStoryResult {
  title: string;
  level: string;
  summary: string;
  parts: [StoryPartResult, StoryPartResult];
}

// Thrown when OpenAI succeeded but TTS failed — carries packed story for retry
export class StoryTtsError extends Error {
  constructor(
    message: string,
    public readonly storyPackage: string,
    public readonly step: string,
  ) {
    super(message);
    this.name = 'StoryTtsError';
  }
}

// ── Word ranges per level (per PART, ~5 min at 130 wpm) ──────────────────────

const PART_WORD_RANGES: Record<string, { min: number; max: number }> = {
  A1: { min: 500,  max: 650  },
  A2: { min: 650,  max: 850  },
  B1: { min: 800,  max: 1050 },
  B2: { min: 950,  max: 1250 },
  C1: { min: 1050, max: 1450 },
  C2: { min: 1200, max: 1600 },
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

// ── Story package (HMAC-signed blob, used for TTS-only retry) ─────────────────

interface PackedStory {
  title: string;
  level: string;
  summary: string;
  parts: AIPart[];
  x: number; // expiry timestamp
}

function packStory(ai: AIStory, secret: string): string {
  const pkg: PackedStory = {
    title: ai.title,
    level: ai.level,
    summary: ai.summary,
    parts: ai.parts,
    x: Date.now() + 60 * 60 * 1000, // 1 hour
  };
  const payload = JSON.stringify(pkg);
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return Buffer.from(JSON.stringify({ p: payload, s: sig })).toString('base64url');
}

export function unpackStory(token: string, secret: string): AIStory {
  let decoded: { p: string; s: string };
  try {
    decoded = JSON.parse(Buffer.from(token, 'base64url').toString());
  } catch {
    throw new Error('INVALID_STORY_PACKAGE');
  }
  const expectedSig = createHmac('sha256', secret).update(decoded.p).digest('base64url');
  if (decoded.s !== expectedSig) throw new Error('INVALID_STORY_PACKAGE');
  const data = JSON.parse(decoded.p) as PackedStory;
  if (data.x < Date.now()) throw new Error('STORY_PACKAGE_EXPIRED');
  return { title: data.title, level: data.level, summary: data.summary, parts: data.parts };
}

// ── Structured step logger ────────────────────────────────────────────────────

function stepLog(requestId: string, step: string, extra: Record<string, unknown> = {}) {
  console.error(JSON.stringify({ src: 'listening/generate', requestId, step, t: Date.now(), ...extra }));
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
      "text": "First half of the story (${range.min}–${range.max} words). Must end at a natural pause — story is NOT finished.",
      "question": {
        "text": "Comprehension question about Part 1 ONLY",
        "options": ["Option A", "Option B", "Option C", "Option D", "Option E"],
        "correctIndex": 0,
        "explanationPt": "1–2 sentence explanation in Brazilian Portuguese"
      }
    },
    {
      "id": 2,
      "text": "Second half continuing directly from Part 1 (${range.min}–${range.max} words). Must resolve the story.",
      "question": {
        "text": "Comprehension question about Part 2 ONLY",
        "options": ["Option A", "Option B", "Option C", "Option D", "Option E"],
        "correctIndex": 0,
        "explanationPt": "1–2 sentence explanation in Brazilian Portuguese"
      }
    }
  ]
}

Rules:
- Vocabulary and grammar appropriate for ${level}
- Part 2 must continue naturally where Part 1 ended
- Each question tests only the part just heard — do not cross-reference parts
- Exactly 5 options per question, exactly one correct, all distractors plausible
- correctIndex: integer 0–4
- Do NOT include Portuguese translations of the story text`;
}

// ── Normalize correctIndex from AI (may return letter, 1-indexed, or text) ────

export function normalizeCorrectIndex(raw: unknown, options: string[]): number {
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    if (raw >= 0 && raw <= 4) return raw;      // 0-indexed ✓
    if (raw >= 1 && raw <= 5) return raw - 1;  // 1-indexed → 0-indexed
  }
  if (typeof raw === 'string') {
    const upper = raw.trim().toUpperCase();
    if (/^[A-E]$/.test(upper)) return upper.charCodeAt(0) - 65; // 'A'→0 … 'E'→4
    const lower = raw.trim().toLowerCase();
    const idx = options.findIndex(o => o.trim().toLowerCase() === lower);
    if (idx >= 0) return idx; // matched option text
  }
  throw new Error('UNNORMALIZABLE');
}

// ── OpenAI call ───────────────────────────────────────────────────────────────

async function callAI(
  level: string,
  openaiKey: string,
  requestId: string,
): Promise<AIStory> {
  const client = new OpenAI({ apiKey: openaiKey, timeout: 120_000, maxRetries: 1 });

  const t0 = Date.now();
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
  const aiMs = Date.now() - t0;

  const raw = resp.choices[0]?.message?.content ?? '';
  const finishReason = resp.choices[0]?.finish_reason ?? 'unknown';
  const inputTokens = resp.usage?.prompt_tokens ?? 0;
  const outputTokens = resp.usage?.completion_tokens ?? 0;

  stepLog(requestId, 'ai_done', { aiMs, finishReason, inputTokens, outputTokens, rawLen: raw.length });

  if (!raw) throw new Error('AI_EMPTY_RESPONSE');
  if (finishReason === 'length') throw new Error('AI_OUTPUT_TRUNCATED');

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

  // Enforce the requested level — the AI must not decide or change it
  if (parsed.level !== level) {
    stepLog(requestId, 'ai_level_override', { requested: level, returned: parsed.level });
  }
  parsed.level = level;

  for (let i = 0; i < 2; i++) {
    const p = parsed.parts[i];
    if (!p?.text?.trim()) throw new Error(`AI_MISSING_PART_${i + 1}_TEXT`);
    if (!p.question?.text?.trim()) throw new Error(`AI_MISSING_PART_${i + 1}_QUESTION`);
    if (!Array.isArray(p.question?.options) || p.question.options.length !== 5)
      throw new Error(`AI_WRONG_OPTION_COUNT_PART_${i + 1}`);
    // Normalize: AI may return letter, 1-indexed number, or option text
    let ci: number;
    try {
      ci = normalizeCorrectIndex(p.question?.correctIndex, p.question?.options ?? []);
    } catch {
      stepLog(requestId, `ai_bad_correct_index_part${i + 1}`, { raw: p.question?.correctIndex });
      throw new Error(`AI_INVALID_CORRECT_INDEX_PART_${i + 1}`);
    }
    p.question.correctIndex = ci; // write back canonical 0-indexed value
    if (!p.question?.explanationPt?.trim())
      throw new Error(`AI_MISSING_EXPLANATION_PART_${i + 1}`);
  }

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
  partLabel: string,
  requestId: string,
): Promise<Buffer> {
  const ssml =
    `<speak version="1.0" xml:lang="en-US">` +
    `<voice name="en-US-AvaMultilingualNeural">` +
    `<prosody rate="0%">${escapeXml(text)}</prosody>` +
    `</voice></speak>`;

  const endpoint = `https://${azureRegion}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);

  const t0 = Date.now();
  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': azureKey,
        'Content-Type': 'application/ssml+xml',
        // 64 kbps mono — adequate for speech, ~half the size of 128 kbps
        'X-Microsoft-OutputFormat': 'audio-16khz-64kbitrate-mono-mp3',
        'User-Agent': 'lemon-english-app/1.0',
      },
      body: ssml,
      signal: controller.signal,
    });
  } catch (err: unknown) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    const code = isAbort ? `AZURE_TTS_TIMEOUT_${partLabel}` : `AZURE_TTS_NETWORK_ERROR_${partLabel}`;
    stepLog(requestId, 'tts_fetch_error', { partLabel, code, region: azureRegion });
    throw new Error(code);
  } finally {
    clearTimeout(timer);
  }

  const ttsMs = Date.now() - t0;
  stepLog(requestId, 'tts_response', { partLabel, httpStatus: resp.status, ttsMs, region: azureRegion });

  if (resp.status === 429) throw new Error(`AZURE_TTS_RATE_LIMITED_${partLabel}`);
  if (resp.status === 401 || resp.status === 403) throw new Error(`AZURE_TTS_AUTH_FAILED_${partLabel}`);
  if (!resp.ok) throw new Error(`AZURE_TTS_HTTP_${resp.status}_${partLabel}`);

  const buf = await resp.arrayBuffer();
  if (!buf.byteLength) throw new Error(`AZURE_TTS_EMPTY_AUDIO_${partLabel}`);

  stepLog(requestId, 'tts_audio_received', { partLabel, bytes: buf.byteLength });
  return Buffer.from(buf);
}

// ── HMAC answer token ─────────────────────────────────────────────────────────

function signToken(correctIndex: number, explanationPt: string, secret: string): string {
  const payload = JSON.stringify({
    c: correctIndex,
    e: explanationPt,
    x: Date.now() + 4 * 60 * 60 * 1000,
  });
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return Buffer.from(JSON.stringify({ p: payload, s: sig })).toString('base64url');
}

// ── Synthesize both parts, return audio as base64 (no storage) ────────────────

async function synthesizeParts(
  ai: AIStory,
  azureKey: string,
  azureRegion: string,
  secret: string,
  requestId: string,
): Promise<ListeningStoryResult> {
  const t0 = Date.now();
  stepLog(requestId, 'tts_start', {
    region: azureRegion,
    part1Words: ai.parts[0].text.split(' ').length,
    part2Words: ai.parts[1].text.split(' ').length,
  });

  const [audio1, audio2] = await Promise.all([
    synthesizeAudio(ai.parts[0].text, azureKey, azureRegion, 'part1', requestId),
    synthesizeAudio(ai.parts[1].text, azureKey, azureRegion, 'part2', requestId),
  ]);

  stepLog(requestId, 'tts_all_done', {
    ttsMs: Date.now() - t0,
    bytes1: audio1.byteLength,
    bytes2: audio2.byteLength,
  });

  const token1 = signToken(ai.parts[0].question.correctIndex, ai.parts[0].question.explanationPt, secret);
  const token2 = signToken(ai.parts[1].question.correctIndex, ai.parts[1].question.explanationPt, secret);

  return {
    title: ai.title,
    level: ai.level,
    summary: ai.summary,
    parts: [
      {
        id: 1,
        text: ai.parts[0].text,
        audioBase64: audio1.toString('base64'),
        audioMimeType: 'audio/mpeg',
        question: {
          prompt: ai.parts[0].question.text,
          options: ai.parts[0].question.options,
          correctOptionIndex: ai.parts[0].question.correctIndex,
          explanationPt: ai.parts[0].question.explanationPt,
        },
        answerToken: token1,
      },
      {
        id: 2,
        text: ai.parts[1].text,
        audioBase64: audio2.toString('base64'),
        audioMimeType: 'audio/mpeg',
        question: {
          prompt: ai.parts[1].question.text,
          options: ai.parts[1].question.options,
          correctOptionIndex: ai.parts[1].question.correctIndex,
          explanationPt: ai.parts[1].question.explanationPt,
        },
        answerToken: token2,
      },
    ],
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateListeningStory(
  userId: string,
  serviceClient: SupabaseClient,
  openaiKey: string,
  azureKey: string,
  azureRegion: string,
  secret: string,
  /** Optional: packed story from a previous call. Skips OpenAI if provided. */
  storyPackage?: string | null,
): Promise<ListeningStoryResult> {
  const requestId = crypto.randomUUID().slice(0, 8);
  const totalStart = Date.now();

  stepLog(requestId, 'start', {
    hasStoryPackage: !!storyPackage,
    hasOpenaiKey: !!openaiKey,
    hasAzureKey: !!azureKey,
    azureRegion: azureRegion || 'NOT_SET',
    hasSecret: !!secret,
  });

  // 1. Resolve CEFR level from DB
  const level = await resolveUserListeningLevel(serviceClient, userId);
  stepLog(requestId, 'level_resolved', { level });

  // 2. Get story content — either from retry package or fresh OpenAI call
  let ai: AIStory;
  if (storyPackage) {
    stepLog(requestId, 'using_story_package');
    try {
      ai = unpackStory(storyPackage, secret);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stepLog(requestId, 'story_package_invalid', { msg });
      throw new Error(`STORY_PACKAGE_INVALID: ${msg}`);
    }
  } else {
    stepLog(requestId, 'ai_start', { level });
    ai = await callAI(level, openaiKey, requestId);
  }

  // Pack the story now — before TTS — so we can return it on audio failure
  const packed = packStory(ai, secret);

  // 3. TTS (throws StoryTtsError on failure, carrying the packed story for retry)
  try {
    const result = await synthesizeParts(ai, azureKey, azureRegion, secret, requestId);
    stepLog(requestId, 'complete', { totalMs: Date.now() - totalStart });
    return result;
  } catch (err) {
    const step = err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
    stepLog(requestId, 'tts_failed', { step, totalMs: Date.now() - totalStart });
    throw new StoryTtsError(step, packed, step);
  }
}
