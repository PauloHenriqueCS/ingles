import type { AIPreferences } from '../types';
import { DEFAULT_CONVERSATION_GOAL_MINUTES } from './conversationGoal';

// ── Assistant identity ────────────────────────────────────────────────────────
//
// The assistant's name is fixed and non-configurable: it is always "Lemon".
// This is the single source of truth — every place that needs the assistant's
// name (system prompt, UI labels, DB defaults) must read it from here instead
// of trusting `teacher_name` values coming from the database, since older rows
// may still contain legacy names ("Alex", "Lemon AI") from before the app was
// renamed. See promptBuilder.ts for how this is enforced in the system prompt.
export const ASSISTANT_NAME = 'Lemon';

// ── Voice catalog (OpenAI Realtime API) ──────────────────────────────────────

export interface VoiceEntry {
  id: string;
  label: string;
  description: string;
  /** Closest TTS-API voice for preview (some Realtime voices differ) */
  previewVoice: string;
}

export const REALTIME_VOICES: VoiceEntry[] = [
  { id: 'coral',   label: 'Coral',   description: 'Warm and clear — great for all levels',      previewVoice: 'coral'   },
  { id: 'ash',     label: 'Ash',     description: 'Deep and authoritative',                       previewVoice: 'ash'     },
  { id: 'alloy',   label: 'Alloy',   description: 'Balanced and neutral',                         previewVoice: 'alloy'   },
  { id: 'ballad',  label: 'Ballad',  description: 'Expressive and engaging',                      previewVoice: 'ballad'  },
  { id: 'echo',    label: 'Echo',    description: 'Clean and precise',                             previewVoice: 'echo'    },
  { id: 'marin',   label: 'Marin',   description: 'Natural and conversational',                   previewVoice: 'ash'     },
  { id: 'sage',    label: 'Sage',    description: 'Calm and measured',                             previewVoice: 'sage'    },
  { id: 'shimmer', label: 'Shimmer', description: 'Bright and energetic',                         previewVoice: 'shimmer' },
  { id: 'verse',   label: 'Verse',   description: 'Versatile, storytelling style',                previewVoice: 'verse'   },
];

export const VOICE_PREVIEW_PHRASE =
  "Hi! I'm Lemon, your English tutor. Let's practice together. How was your day?";

// ── Personality presets ───────────────────────────────────────────────────────

export type PersonalityPreset = AIPreferences['personalityPreset'];

interface PresetDetail {
  label: string;
  description: string;
  formality: AIPreferences['formality'];
  humorLevel: AIPreferences['humorLevel'];
  roastIntensity: AIPreferences['roastIntensity'];
  profanityEnabled: boolean;
  topicInitiative: AIPreferences['topicInitiative'];
}

export const PERSONALITY_PRESETS: Record<Exclude<PersonalityPreset, 'custom'>, PresetDetail> = {
  patient: {
    label: 'Paciente',
    description: 'Calmo, acolhedor e sempre encorajador',
    formality: 'medium',
    humorLevel: 'low',
    roastIntensity: 'off',
    profanityEnabled: false,
    topicInitiative: 'medium',
  },
  friend: {
    label: 'Amigo',
    description: 'Informal, espontâneo e bem-humorado',
    formality: 'low',
    humorLevel: 'high',
    roastIntensity: 'light',
    profanityEnabled: false,
    topicInitiative: 'high',
  },
  teacher: {
    label: 'Professor',
    description: 'Didático, organizado e focado',
    formality: 'medium',
    humorLevel: 'low',
    roastIntensity: 'off',
    profanityEnabled: false,
    topicInitiative: 'high',
  },
  unfiltered_friend: {
    label: 'Amigo sem filtro',
    description: 'Alta zoação, palavrões liberados e zero formalidade',
    formality: 'very_low',
    humorLevel: 'high',
    roastIntensity: 'high',
    profanityEnabled: true,
    topicInitiative: 'high',
  },
};

// ── Labels for UI ─────────────────────────────────────────────────────────────

export const PACE_LABELS: Record<AIPreferences['speechPace'], { label: string; description: string }> = {
  slow:    { label: 'Superdevagar (0.65×)', description: 'Velocidade muito reduzida — máxima clareza para iniciantes' },
  normal:  { label: 'Devagar (0.80×)',      description: 'Velocidade reduzida — confortável para praticar' },
  natural: { label: 'Normal (1×)',           description: 'Velocidade natural de conversa' },
};

/** Audio playback rate for each speech pace mode.
 *  Applied to the WebRTC audio element so speed changes are perceptible. */
export const PACE_PLAYBACK_RATE: Record<AIPreferences['speechPace'], number> = {
  slow:    0.65,
  normal:  0.80,
  natural: 1.0,
};

export const ACCENT_LABELS: Record<AIPreferences['accent'], string> = {
  american: 'Americano',
  british:  'Britânico',
  neutral:  'Neutro',
};

export const FORMALITY_LABELS: Record<AIPreferences['formality'], string> = {
  very_low: 'Muito informal',
  low:      'Informal',
  medium:   'Médio',
  high:     'Formal',
};

export const HUMOR_LABELS: Record<AIPreferences['humorLevel'], string> = {
  low:    'Baixo',
  medium: 'Médio',
  high:   'Alto',
};

export const ROAST_LABELS: Record<AIPreferences['roastIntensity'], string> = {
  off:   'Desligada',
  light: 'Leve',
  high:  'Alta',
};

export const INITIATIVE_LABELS: Record<AIPreferences['topicInitiative'], string> = {
  low:    'Baixa',
  medium: 'Média',
  high:   'Alta',
};

export const TIMING_LABELS: Record<AIPreferences['correctionTiming'], { label: string; description: string }> = {
  after_each:      { label: 'Após cada resposta',    description: 'Corrige imediatamente e continua a conversa' },
  end_of_block:    { label: 'Fim de bloco',          description: 'Acumula e corrige a cada 3–4 trocas' },
  session_summary: { label: 'Resumo da sessão',      description: 'Apresenta correções apenas ao encerrar' },
};

export const SCOPE_LABELS: Record<AIPreferences['correctionScope'], { label: string; description: string }> = {
  important_only:      { label: 'Apenas erros importantes', description: 'Foca em erros que afetam a comunicação' },
  all_relevant:        { label: 'Todos os relevantes',      description: 'Corrige a maioria dos erros notáveis' },
  communication_impact: { label: 'Só se prejudicar',        description: 'Corrige apenas quando o erro impede o entendimento' },
};

export const LANGUAGE_LABELS: Record<AIPreferences['correctionLanguage'], string> = {
  portuguese: 'Português brasileiro',
  english:    'Inglês',
};

export const DETAIL_LABELS: Record<AIPreferences['correctionDetail'], { label: string; description: string }> = {
  brief:    { label: 'Breve',     description: 'Mostra a forma correta e segue em frente' },
  detailed: { label: 'Detalhado', description: 'Explica a regra e dá exemplos adicionais' },
};

// ── Defaults ──────────────────────────────────────────────────────────────────

export const BASE_DEFAULTS: AIPreferences = {
  teacherName: ASSISTANT_NAME,
  voice: 'coral',
  accent: 'american',
  speechPace: 'slow',
  personalityPreset: 'patient',
  formality: 'medium',
  humorLevel: 'low',
  roastIntensity: 'off',
  profanityEnabled: false,
  topicInitiative: 'medium',
  correctionTiming: 'after_each',
  correctionScope: 'important_only',
  correctionLanguage: 'portuguese',
  correctionDetail: 'brief',
  focusAreas: [],
  dailyConversationGoalMinutes: DEFAULT_CONVERSATION_GOAL_MINUTES,
};

/** Returns defaults tuned to the user's CEFR level. */
export function getDefaultsForLevel(level: string): AIPreferences {
  const l = (level ?? 'A1').toUpperCase();
  const isAdvanced    = l === 'C1' || l === 'C2';
  const isIntermediate = l === 'B1' || l === 'B2';

  return {
    ...BASE_DEFAULTS,
    speechPace: isAdvanced ? 'natural' : isIntermediate ? 'normal' : 'slow',
    personalityPreset: isAdvanced ? 'friend' : isIntermediate ? 'friend' : 'patient',
    formality: isAdvanced || isIntermediate ? 'low' : 'medium',
    humorLevel: isAdvanced ? 'high' : isIntermediate ? 'medium' : 'low',
    topicInitiative: isAdvanced ? 'high' : 'medium',
  };
}

/** Returns a summary chip list for display in the tutor card. */
export function getPrefsSummaryChips(prefs: AIPreferences): string[] {
  const voice  = REALTIME_VOICES.find((v) => v.id === prefs.voice)?.label ?? prefs.voice;
  const pace   = PACE_LABELS[prefs.speechPace]?.label ?? prefs.speechPace;
  const accent = ACCENT_LABELS[prefs.accent] ?? prefs.accent;
  const preset =
    prefs.personalityPreset === 'custom'
      ? 'Personalizado'
      : (PERSONALITY_PRESETS[prefs.personalityPreset as Exclude<PersonalityPreset, 'custom'>]?.label ?? '');

  return [
    `Voz: ${voice}`,
    accent,
    pace,
    preset,
  ].filter(Boolean);
}

/** Detect if manual controls differ from a known preset, returning 'custom'. */
export function resolvePreset(prefs: AIPreferences): AIPreferences['personalityPreset'] {
  const knownPresets = Object.entries(PERSONALITY_PRESETS) as [
    Exclude<PersonalityPreset, 'custom'>,
    PresetDetail,
  ][];
  for (const [key, def] of knownPresets) {
    if (
      prefs.formality       === def.formality       &&
      prefs.humorLevel      === def.humorLevel       &&
      prefs.roastIntensity  === def.roastIntensity   &&
      prefs.profanityEnabled === def.profanityEnabled &&
      prefs.topicInitiative === def.topicInitiative
    ) return key;
  }
  return 'custom';
}
