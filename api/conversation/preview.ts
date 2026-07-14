import { requireAuth } from '../_auth';
import { REALTIME_VOICES, VOICE_PREVIEW_PHRASE, PACE_LABELS } from '../../src/lib/tutorPreferences';
import type { AIPreferences } from '../../src/types';

const TTS_URL = 'https://api.openai.com/v1/audio/speech';

// Speed values used ONLY for preview — Realtime sessions use prompt-based pacing
const PREVIEW_SPEED: Record<AIPreferences['speechPace'], number> = {
  slow:    0.82,
  normal:  1.0,
  natural: 1.18,
};

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).end();

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const openaiKey = (process.env.OPENAI_API_KEY ?? '').trim();
  if (!openaiKey) {
    return res.status(503).json({ code: 'OPENAI_NOT_CONFIGURED', message: 'Serviço não configurado.' });
  }

  const body = req.body ?? {};
  const voiceId  = typeof body.voice === 'string' ? body.voice.trim() : '';
  const pace     = typeof body.pace  === 'string' ? body.pace  as AIPreferences['speechPace'] : 'normal';

  // Validate voice
  const voiceEntry = REALTIME_VOICES.find((v) => v.id === voiceId);
  if (!voiceEntry) {
    return res.status(400).json({ code: 'INVALID_VOICE', message: 'Voz inválida.' });
  }

  const previewVoice = voiceEntry.previewVoice;
  const speed        = PREVIEW_SPEED[pace] ?? 1.0;
  const paceLabel    = PACE_LABELS[pace]?.label ?? pace;

  // Construct a short phrase that mentions pace
  const input = `${VOICE_PREVIEW_PHRASE} I'll be speaking at a ${paceLabel.toLowerCase()} pace during our practice.`;

  let ttsRes: Response;
  try {
    ttsRes = await fetch(TTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        voice: previewVoice,
        input,
        speed,
        response_format: 'mp3',
      }),
    });
  } catch (err) {
    console.error('[conversation/preview] network error:', (err as Error).message);
    return res.status(502).json({ code: 'PREVIEW_FAILED', message: 'Não foi possível gerar a amostra.' });
  }

  if (!ttsRes.ok) {
    const txt = await ttsRes.text().catch(() => '');
    console.error('[conversation/preview] TTS error', ttsRes.status, txt.slice(0, 100));
    return res.status(502).json({ code: 'PREVIEW_FAILED', message: 'Não foi possível gerar a amostra.' });
  }

  const audioBuffer = await ttsRes.arrayBuffer();

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(Buffer.from(audioBuffer));
}
