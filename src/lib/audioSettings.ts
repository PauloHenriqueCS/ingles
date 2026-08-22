import { supabase } from './supabase';
import { getCurrentUserId } from './authSession';

export interface AzureVoiceEntry {
  id: string;
  azureVoiceName: string;
  label: string;
  gender: 'female' | 'male';
  badge?: string;
}

export const AZURE_VOICES: AzureVoiceEntry[] = [
  { id: 'ava',    azureVoiceName: 'en-US-AvaMultilingualNeural',    label: 'Ava',    gender: 'female', badge: 'Recomendada' },
  { id: 'andrew', azureVoiceName: 'en-US-AndrewMultilingualNeural', label: 'Andrew', gender: 'male',   badge: 'Melhor para iniciantes' },
  { id: 'jenny',  azureVoiceName: 'en-US-JennyNeural',              label: 'Jenny',  gender: 'female', badge: 'Mais natural' },
  { id: 'guy',    azureVoiceName: 'en-US-GuyNeural',                label: 'Guy',    gender: 'male' },
];

export const AUDIO_PREVIEW_TEXT = "Hello! I'm your English tutor. Let's practice together.";

// NOTE: audio playback settings intentionally have NO accent field. Accent /
// language variant is a CONVERSATION concept (AIPreferences.accent), resolved
// from the data-driven per-language catalog conversation_language_variants — it
// must not be duplicated here as a second, hardcoded English authority (ROOT-2).
export interface AudioSettings {
  voice: string;
  playbackRate: 0.75 | 0.9 | 1;
  autoPlayShadowing: boolean;
  showTranslation: boolean;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  voice: 'en-US-AvaMultilingualNeural',
  playbackRate: 1,
  autoPlayShadowing: true,
  showTranslation: false,
};

export async function fetchAudioSettings(): Promise<AudioSettings> {
  const uid = await getCurrentUserId();
  if (!uid) return DEFAULT_AUDIO_SETTINGS;

  const { data } = await supabase
    .from('user_learning_settings')
    .select('audio_preferences')
    .eq('user_id', uid)
    .single();

  if (!data?.audio_preferences) return DEFAULT_AUDIO_SETTINGS;
  return { ...DEFAULT_AUDIO_SETTINGS, ...(data.audio_preferences as Partial<AudioSettings>) };
}

export async function saveAudioSettings(settings: AudioSettings): Promise<void> {
  const uid = await getCurrentUserId();
  if (!uid) throw new Error('Não autenticado');

  const { error } = await supabase
    .from('user_learning_settings')
    .upsert(
      { user_id: uid, audio_preferences: settings, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );

  if (error) throw new Error(error.message);
}
