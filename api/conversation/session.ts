import { createHash } from 'node:crypto';
import { requireAuth } from '../_auth';
import { buildSystemPrompt, DEFAULT_PREFERENCES } from '../../src/lib/promptBuilder';
import type { AIPreferences } from '../../src/types';

const REALTIME_MODEL =
  (process.env.OPENAI_REALTIME_MODEL ?? '').trim() || 'gpt-realtime-2.1-mini';

const CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';

const ERROR_STATUS: Record<string, number> = {
  OPENAI_INVALID_SESSION: 400,
  OPENAI_AUTH_FAILED:     401,
  OPENAI_RATE_LIMITED:    429,
  OPENAI_UNAVAILABLE:     502,
  OPENAI_SESSION_FAILED:  502,
};

const ERROR_MESSAGE: Record<string, string> = {
  OPENAI_INVALID_SESSION: 'A configuração da conversa precisa ser corrigida.',
  OPENAI_AUTH_FAILED:     'A chave da OpenAI não foi aceita.',
  OPENAI_RATE_LIMITED:    'O limite de uso da conversa foi atingido. Verifique o saldo da OpenAI.',
  OPENAI_UNAVAILABLE:     'O serviço de conversa está indisponível no momento.',
  OPENAI_SESSION_FAILED:  'Não foi possível criar a sessão de conversa.',
};

function mapOpenAIStatus(status: number): string {
  if (status === 400) return 'OPENAI_INVALID_SESSION';
  if (status === 401 || status === 403) return 'OPENAI_AUTH_FAILED';
  if (status === 429) return 'OPENAI_RATE_LIMITED';
  if (status >= 500 && status <= 599) return 'OPENAI_UNAVAILABLE';
  return 'OPENAI_SESSION_FAILED';
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).end();

  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { supabase, userId } = auth;

  const openaiKey = (process.env.OPENAI_API_KEY ?? '').trim();
  if (!openaiKey) {
    return res.status(503).json({
      code: 'OPENAI_NOT_CONFIGURED',
      message: 'O serviço de conversa não está configurado.',
    });
  }

  // Safety identifier: SHA-256 of userId — no raw UUID or PII to OpenAI
  const safetyIdentifier = createHash('sha256').update(userId).digest('hex');

  // Load user preferences
  let prefs: AIPreferences = { ...DEFAULT_PREFERENCES };
  try {
    const { data: row } = await supabase
      .from('ai_conversation_preferences')
      .select('*')
      .maybeSingle();
    if (row) {
      prefs = {
        teacherName:    row.teacher_name    ?? DEFAULT_PREFERENCES.teacherName,
        personality:    row.personality     ?? DEFAULT_PREFERENCES.personality,
        correctionStyle: row.correction_style ?? DEFAULT_PREFERENCES.correctionStyle,
        voice:          row.voice           ?? DEFAULT_PREFERENCES.voice,
        focusAreas:     row.focus_areas     ?? DEFAULT_PREFERENCES.focusAreas,
      };
    }
  } catch {
    // use defaults — non-fatal
  }

  const instructions = buildSystemPrompt(prefs);
  if (!instructions) {
    return res.status(500).json({
      code: 'INTERNAL_ERROR',
      message: 'Erro interno ao preparar a sessão.',
    });
  }

  const sessionConfig = {
    expires_after: {
      anchor: 'created_at',
      seconds: 120,
    },
    session: {
      type: 'realtime',
      model: REALTIME_MODEL,
      instructions,
      audio: {
        input: {
          noise_reduction: { type: 'near_field' },
          transcription: {
            model: 'gpt-4o-mini-transcribe',
            language: 'en',
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 800,
            create_response: true,
            interrupt_response: true,
          },
        },
        output: {
          voice: prefs.voice,
        },
      },
    },
  };

  // Create ephemeral credential via GA endpoint
  let rawText: string;
  let httpStatus: number;
  let requestId: string | null;
  try {
    const openaiRes = await fetch(CLIENT_SECRETS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Safety-Identifier': safetyIdentifier,
      },
      body: JSON.stringify(sessionConfig),
    });
    httpStatus = openaiRes.status;
    requestId = openaiRes.headers.get('x-request-id');
    rawText = await openaiRes.text();
  } catch (err) {
    console.error('[conversation/session] Network error reaching OpenAI:', (err as Error).message);
    return res.status(502).json({
      code: 'OPENAI_UNREACHABLE',
      message: 'Não foi possível conectar ao serviço de IA.',
    });
  }

  if (httpStatus < 200 || httpStatus >= 300) {
    const errorCode = mapOpenAIStatus(httpStatus);
    // Log sanitized info only — no key, no token, no prompt
    let parsed: { error?: { type?: string; code?: string; param?: string; message?: string } } = {};
    try { parsed = JSON.parse(rawText); } catch { /* ok */ }
    const e = parsed.error ?? {};
    console.error('[conversation/session] OpenAI error', {
      status: httpStatus,
      requestId,
      type: e.type ?? null,
      code: e.code ?? null,
      param: e.param ?? null,
      message: e.message ? e.message.slice(0, 120) : null,
    });
    return res
      .status(ERROR_STATUS[errorCode] ?? 502)
      .json({ code: errorCode, message: ERROR_MESSAGE[errorCode] });
  }

  // Parse GA response: { value, expires_at, session: { id?, model? } }
  let data: { value?: unknown; expires_at?: unknown; session?: { id?: string; model?: string } };
  try {
    data = JSON.parse(rawText);
  } catch {
    console.error('[conversation/session] Failed to parse OpenAI response');
    return res.status(502).json({
      code: 'OPENAI_SESSION_FAILED',
      message: ERROR_MESSAGE.OPENAI_SESSION_FAILED,
    });
  }

  if (typeof data.value !== 'string' || !data.value) {
    console.error('[conversation/session] GA response missing value field');
    return res.status(502).json({
      code: 'OPENAI_SESSION_FAILED',
      message: ERROR_MESSAGE.OPENAI_SESSION_FAILED,
    });
  }

  if (typeof data.expires_at !== 'number') {
    console.error('[conversation/session] GA response missing expires_at');
    return res.status(502).json({
      code: 'OPENAI_SESSION_FAILED',
      message: ERROR_MESSAGE.OPENAI_SESSION_FAILED,
    });
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    token: data.value,
    sessionId: data.session?.id ?? null,
    model: data.session?.model ?? REALTIME_MODEL,
    voice: prefs.voice,
    expiresAt: data.expires_at,
  });
}
