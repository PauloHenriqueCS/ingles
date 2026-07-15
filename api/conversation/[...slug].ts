import { createHash } from 'node:crypto';
import { requireAuth } from '../_auth';
import { REALTIME_VOICES, VOICE_PREVIEW_PHRASE, PACE_LABELS, BASE_DEFAULTS } from '../../src/lib/tutorPreferences';
import { buildTutorInstructionsWithContext, ConversationStartContext } from '../../src/lib/promptBuilder';
import type { AIPreferences } from '../../src/types';
import { methodGuard, sizeGuard, PAYLOAD_LIMITS, TIMEOUTS, safeLog } from '../_helpers';
import { applyRateLimit } from '../_rateLimit';

// ─── POST /api/conversation/preview ──────────────────────────────────────────

const TTS_URL = 'https://api.openai.com/v1/audio/speech';

const PREVIEW_SPEED: Record<AIPreferences['speechPace'], number> = {
  slow:    0.82,
  normal:  1.0,
  natural: 1.18,
};

async function handlePreview(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, PAYLOAD_LIMITS.PREVIEW)) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;

  const openaiKey = (process.env.OPENAI_API_KEY ?? '').trim();
  if (!openaiKey) {
    return res.status(503).json({ code: 'OPENAI_NOT_CONFIGURED', message: 'Serviço não configurado.' });
  }

  const body = req.body ?? {};
  const voiceId = typeof body.voice === 'string' ? body.voice.trim() : '';
  const pace    = typeof body.pace  === 'string' ? body.pace as AIPreferences['speechPace'] : 'normal';

  if (!await applyRateLimit(res, userId, 'conversation-preview')) return;

  const voiceEntry = REALTIME_VOICES.find((v) => v.id === voiceId);
  if (!voiceEntry) {
    return res.status(400).json({ code: 'INVALID_VOICE', message: 'Voz inválida.' });
  }

  const previewVoice = voiceEntry.previewVoice;
  const speed        = PREVIEW_SPEED[pace] ?? 1.0;
  const paceLabel    = PACE_LABELS[pace]?.label ?? pace;

  const input = `${VOICE_PREVIEW_PHRASE} I'll be speaking at a ${paceLabel.toLowerCase()} pace during our practice.`;

  let ttsRes: Response;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUTS.SHORT);
  try {
    ttsRes = await fetch(TTS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', voice: previewVoice, input, speed, response_format: 'mp3' }),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const isAbort = err instanceof Error && err.name === 'AbortError';
    if (isAbort) {
      safeLog('conversation/preview', 'timeout', 504);
      return res.status(504).json({ code: 'AI_TIMEOUT', message: 'O serviço demorou para responder. Tente novamente.' });
    }
    safeLog('conversation/preview', 'network_error', 502);
    return res.status(502).json({ code: 'PREVIEW_FAILED', message: 'Não foi possível gerar a amostra.' });
  } finally {
    clearTimeout(timer);
  }

  if (!ttsRes.ok) {
    safeLog('conversation/preview', 'tts_error', ttsRes.status);
    return res.status(502).json({ code: 'PREVIEW_FAILED', message: 'Não foi possível gerar a amostra.' });
  }

  const audioBuffer = await ttsRes.arrayBuffer();
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(Buffer.from(audioBuffer));
}

// ─── POST /api/conversation/session ──────────────────────────────────────────

const REALTIME_MODEL =
  (process.env.OPENAI_REALTIME_MODEL ?? '').trim() || 'gpt-realtime-2.1-mini';

const CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';

const SESSION_ERROR_STATUS: Record<string, number> = {
  OPENAI_INVALID_SESSION: 400,
  OPENAI_AUTH_FAILED:     401,
  OPENAI_RATE_LIMITED:    429,
  OPENAI_UNAVAILABLE:     502,
  OPENAI_SESSION_FAILED:  502,
};

const SESSION_ERROR_MESSAGE: Record<string, string> = {
  OPENAI_INVALID_SESSION: 'A configuração da conversa precisa ser corrigida.',
  OPENAI_AUTH_FAILED:     'A chave da OpenAI não foi aceita.',
  OPENAI_RATE_LIMITED:    'O limite de uso da conversa foi atingido. Verifique o saldo da OpenAI.',
  OPENAI_UNAVAILABLE:     'O serviço de conversa está indisponível no momento.',
  OPENAI_SESSION_FAILED:  'Não foi possível criar a sessão de conversa.',
};

function getTodayUtc(): string {
  return new Date().toISOString().split('T')[0];
}

function extractMission(snapshot: unknown): { title: string; description: string; requiredWords: string[] } | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const r = snapshot as Record<string, unknown>;
  if (typeof r.missionTitle === 'string') {
    return {
      title: r.missionTitle,
      description: String(r.missionPromptPt ?? r.missionPromptEn ?? r.missionTask ?? ''),
      requiredWords: Array.isArray(r.missionRequiredWords) ? (r.missionRequiredWords as string[]) : [],
    };
  }
  if (typeof r.title === 'string') {
    return {
      title: r.title,
      description: String(r.mission ?? r.themePtBr ?? r.themeEn ?? ''),
      requiredWords: [
        ...(Array.isArray(r.useTheseWords) ? (r.useTheseWords as string[]) : []),
        ...(Array.isArray(r.requiredWords) ? (r.requiredWords as string[]) : []),
      ],
    };
  }
  return null;
}

function mapOpenAIStatus(status: number): string {
  if (status === 400) return 'OPENAI_INVALID_SESSION';
  if (status === 401 || status === 403) return 'OPENAI_AUTH_FAILED';
  if (status === 429) return 'OPENAI_RATE_LIMITED';
  if (status >= 500 && status <= 599) return 'OPENAI_UNAVAILABLE';
  return 'OPENAI_SESSION_FAILED';
}

function rowToPrefs(row: Record<string, unknown>): AIPreferences {
  return {
    teacherName:        String(row.teacher_name        ?? BASE_DEFAULTS.teacherName),
    voice:              String(row.voice               ?? BASE_DEFAULTS.voice),
    accent:             (row.accent              as AIPreferences['accent'])            ?? BASE_DEFAULTS.accent,
    speechPace:         (row.speech_pace         as AIPreferences['speechPace'])        ?? BASE_DEFAULTS.speechPace,
    personalityPreset:  (row.personality_preset  as AIPreferences['personalityPreset']) ?? BASE_DEFAULTS.personalityPreset,
    formality:          (row.formality           as AIPreferences['formality'])          ?? BASE_DEFAULTS.formality,
    humorLevel:         (row.humor_level         as AIPreferences['humorLevel'])         ?? BASE_DEFAULTS.humorLevel,
    roastIntensity:     (row.roast_intensity     as AIPreferences['roastIntensity'])     ?? BASE_DEFAULTS.roastIntensity,
    profanityEnabled:   typeof row.profanity_enabled === 'boolean' ? row.profanity_enabled : BASE_DEFAULTS.profanityEnabled,
    topicInitiative:    (row.topic_initiative    as AIPreferences['topicInitiative'])    ?? BASE_DEFAULTS.topicInitiative,
    correctionTiming:   (row.correction_timing   as AIPreferences['correctionTiming'])   ?? BASE_DEFAULTS.correctionTiming,
    correctionScope:    (row.correction_scope    as AIPreferences['correctionScope'])    ?? BASE_DEFAULTS.correctionScope,
    correctionLanguage: (row.correction_language as AIPreferences['correctionLanguage']) ?? BASE_DEFAULTS.correctionLanguage,
    correctionDetail:   (row.correction_detail   as AIPreferences['correctionDetail'])   ?? BASE_DEFAULTS.correctionDetail,
    focusAreas:         Array.isArray(row.focus_areas) ? (row.focus_areas as string[]) : BASE_DEFAULTS.focusAreas,
    dailyConversationGoalMinutes: (row.daily_conversation_goal_minutes as number | null) ?? BASE_DEFAULTS.dailyConversationGoalMinutes,
  };
}

async function handleSession(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, PAYLOAD_LIMITS.CONVERSATION)) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { supabase, userId } = auth;

  const openaiKey = (process.env.OPENAI_API_KEY ?? '').trim();
  if (!openaiKey) {
    return res.status(503).json({ code: 'OPENAI_NOT_CONFIGURED', message: 'O serviço de conversa não está configurado.' });
  }

  const safetyIdentifier = createHash('sha256').update(userId).digest('hex');
  const today = getTodayUtc();

  let prefs: AIPreferences = { ...BASE_DEFAULTS };
  let cefrLevel = 'A1';
  let ctx: ConversationStartContext = {
    theme: null,
    missionTitle: null,
    missionDescription: null,
    studentText: null,
    version2: null,
    mandatoryWords: [],
    recentMistakes: [],
    currentGrammarObjectives: [],
    conversationGoalMinutes: BASE_DEFAULTS.dailyConversationGoalMinutes,
    remainingConversationMinutes: 0,
  };

  try {
    const [prefsResult, memoryResult, todayReviewResult, recentReviewsResult, convTotalResult] = await Promise.all([
      supabase.from('ai_conversation_preferences').select('*').maybeSingle(),
      supabase.from('english_learning_memory').select('current_level').order('updated_at', { ascending: false }).limit(1),
      supabase.from('english_reviews').select('original_text,version_2_text,main_mistakes,mission_snapshot').eq('entry_date', today).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('english_reviews').select('main_mistakes,objective,next_practice').order('created_at', { ascending: false }).limit(5),
      supabase.from('conversation_sessions').select('duration_sec').eq('session_date', today),
    ]);

    if (prefsResult.data) prefs = rowToPrefs(prefsResult.data as Record<string, unknown>);
    const memRow = memoryResult.data?.[0] as { current_level?: string } | undefined;
    if (memRow?.current_level) cefrLevel = memRow.current_level;

    ctx.conversationGoalMinutes = prefs.dailyConversationGoalMinutes;

    if (todayReviewResult.data) {
      const r = todayReviewResult.data as Record<string, unknown>;
      ctx.studentText = r.original_text ? String(r.original_text) : null;
      ctx.version2    = r.version_2_text ? String(r.version_2_text) : null;
      const mission = extractMission(r.mission_snapshot);
      if (mission) {
        ctx.missionTitle       = mission.title;
        ctx.missionDescription = mission.description || null;
        ctx.mandatoryWords     = mission.requiredWords;
      }
    }

    const reviewRows = (recentReviewsResult.data ?? []) as Record<string, unknown>[];
    const seenMistakes = new Set<string>();
    const seenObjectives = new Set<string>();
    for (const r of reviewRows) {
      for (const m of Array.isArray(r.main_mistakes) ? (r.main_mistakes as Record<string, string>[]) : []) {
        const key = (m.original ?? '').trim().toLowerCase();
        if (!key || seenMistakes.has(key)) continue;
        seenMistakes.add(key);
        ctx.recentMistakes.push(`${m.original} → ${m.correct}: ${m.explanation}`);
        if (ctx.recentMistakes.length >= 5) break;
      }
      const obj = r.objective ? String(r.objective).trim() : '';
      if (obj && !seenObjectives.has(obj)) {
        seenObjectives.add(obj);
        ctx.currentGrammarObjectives.push(obj);
      }
      if (ctx.recentMistakes.length >= 5 && ctx.currentGrammarObjectives.length >= 3) break;
    }
    ctx.currentGrammarObjectives = ctx.currentGrammarObjectives.slice(0, 3);

    const totalConvSec = ((convTotalResult.data ?? []) as Record<string, number>[])
      .reduce((sum, row) => sum + (row.duration_sec ?? 0), 0);
    const totalConvMin = Math.floor(totalConvSec / 60);
    ctx.remainingConversationMinutes = Math.max(0, prefs.dailyConversationGoalMinutes - totalConvMin);
  } catch {
    // context is optional
  }

  if (!await applyRateLimit(res, userId, 'conversation-session')) return;

  const instructions = buildTutorInstructionsWithContext(prefs, cefrLevel, ctx);
  if (!instructions) {
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno ao preparar a sessão.' });
  }

  const sessionConfig = {
    expires_after: { anchor: 'created_at', seconds: 120 },
    session: {
      type: 'realtime',
      model: REALTIME_MODEL,
      instructions,
      audio: {
        input: {
          noise_reduction: { type: 'near_field' },
          transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 2500,
            create_response: true,
            interrupt_response: true,
          },
        },
        output: { voice: prefs.voice },
      },
    },
  };

  let rawText: string;
  let httpStatus: number;
  let requestId: string | null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUTS.SHORT);
  try {
    const openaiRes = await fetch(CLIENT_SECRETS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Safety-Identifier': safetyIdentifier,
      },
      body: JSON.stringify(sessionConfig),
      signal: ctrl.signal,
    });
    httpStatus = openaiRes.status;
    requestId  = openaiRes.headers.get('x-request-id');
    rawText    = await openaiRes.text();
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    if (isAbort) {
      safeLog('conversation/session', 'timeout', 504);
      return res.status(504).json({ code: 'AI_TIMEOUT', message: 'O serviço demorou para responder. Tente novamente.' });
    }
    safeLog('conversation/session', 'network_error', 502);
    return res.status(502).json({ code: 'OPENAI_UNREACHABLE', message: 'Não foi possível conectar ao serviço de IA.' });
  } finally {
    clearTimeout(timer);
  }

  if (httpStatus < 200 || httpStatus >= 300) {
    const errorCode = mapOpenAIStatus(httpStatus);
    let parsed: { error?: { type?: string; code?: string; param?: string; message?: string } } = {};
    try { parsed = JSON.parse(rawText); } catch { /* ok */ }
    const e = parsed.error ?? {};
    safeLog('conversation/session', 'openai_error', SESSION_ERROR_STATUS[errorCode] ?? 502, {
      httpStatus, requestId,
      type: typeof e.type === 'string' ? e.type : null,
      code: typeof e.code === 'string' ? e.code : null,
    });
    return res.status(SESSION_ERROR_STATUS[errorCode] ?? 502)
      .json({ code: errorCode, message: SESSION_ERROR_MESSAGE[errorCode] });
  }

  let data: { value?: unknown; expires_at?: unknown; session?: { id?: string; model?: string } };
  try { data = JSON.parse(rawText); }
  catch {
    console.error('[conversation/session] Failed to parse OpenAI response');
    return res.status(502).json({ code: 'OPENAI_SESSION_FAILED', message: SESSION_ERROR_MESSAGE.OPENAI_SESSION_FAILED });
  }

  if (typeof data.value !== 'string' || !data.value) {
    console.error('[conversation/session] GA response missing value field');
    return res.status(502).json({ code: 'OPENAI_SESSION_FAILED', message: SESSION_ERROR_MESSAGE.OPENAI_SESSION_FAILED });
  }
  if (typeof data.expires_at !== 'number') {
    console.error('[conversation/session] GA response missing expires_at');
    return res.status(502).json({ code: 'OPENAI_SESSION_FAILED', message: SESSION_ERROR_MESSAGE.OPENAI_SESSION_FAILED });
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    token:     data.value,
    sessionId: data.session?.id ?? null,
    model:     data.session?.model ?? REALTIME_MODEL,
    voice:     prefs.voice,
    expiresAt: data.expires_at,
  });
}

// ─── dispatcher ───────────────────────────────────────────────────────────────

export default async function handler(req: any, res: any) {
  const slug = (Array.isArray(req.query.slug) ? req.query.slug : [req.query.slug ?? '']).join('/');
  switch (slug) {
    case 'preview': return handlePreview(req, res);
    case 'session': return handleSession(req, res);
    default:        return res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' });
  }
}
