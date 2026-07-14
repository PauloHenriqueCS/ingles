import { requireAuth } from '../_auth';
import { buildSystemPrompt, DEFAULT_PREFERENCES } from '../../src/lib/promptBuilder';
import type { AIPreferences } from '../../src/types';

const OPENAI_SESSIONS_URL = 'https://api.openai.com/v1/realtime/sessions';
const REALTIME_MODEL = 'gpt-realtime-2.1-mini';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).end();

  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { supabase } = auth;

  const openaiKey = (process.env.OPENAI_API_KEY ?? '').trim();
  if (!openaiKey) {
    return res.status(503).json({
      code: 'OPENAI_NOT_CONFIGURED',
      message: 'O serviço de conversa não está configurado.',
    });
  }

  // Load user preferences
  let prefs: AIPreferences = { ...DEFAULT_PREFERENCES };
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

  const instructions = buildSystemPrompt(prefs);

  // Create ephemeral session with OpenAI
  let openaiRes: Response;
  try {
    openaiRes = await fetch(OPENAI_SESSIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: REALTIME_MODEL,
        voice: prefs.voice,
        instructions,
        input_audio_transcription: { model: 'gpt-4o-mini-transcribe' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
          create_response: true,
        },
      }),
    });
  } catch (err) {
    console.error('[conversation/session] Network error reaching OpenAI:', err);
    return res.status(502).json({
      code: 'OPENAI_UNREACHABLE',
      message: 'Não foi possível conectar ao serviço de IA.',
    });
  }

  if (!openaiRes.ok) {
    const body = await openaiRes.json().catch(() => ({}));
    console.error('[conversation/session] OpenAI error:', openaiRes.status, body);
    return res.status(502).json({
      code: 'OPENAI_SESSION_FAILED',
      message: 'Não foi possível criar a sessão de conversa.',
    });
  }

  const session = await openaiRes.json() as {
    id: string;
    client_secret: { value: string; expires_at: number };
  };

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    token: session.client_secret.value,
    sessionId: session.id,
    voice: prefs.voice,
    expiresAt: session.client_secret.expires_at,
  });
}
