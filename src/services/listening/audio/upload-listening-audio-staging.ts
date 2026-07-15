import type { SupabaseClient } from '@supabase/supabase-js';
import { AUDIO_STORAGE_BUCKET, AUDIO_CONTENT_TYPE } from './listening-audio-config';

export interface UploadListeningAudioInput {
  supabase: SupabaseClient;
  audioData: ArrayBuffer;
  storagePath: string;
}

export async function uploadListeningAudioStaging(
  input: UploadListeningAudioInput,
): Promise<void> {
  const { supabase, audioData, storagePath } = input;

  const { error } = await supabase.storage
    .from(AUDIO_STORAGE_BUCKET)
    .upload(storagePath, Buffer.from(audioData), {
      contentType: AUDIO_CONTENT_TYPE,
      cacheControl: '3600',
      upsert: false,
    });

  if (error) {
    throw new Error(`LISTENING_AUDIO_UPLOAD_ERROR: ${error.message} (path: ${storagePath})`);
  }
}

export async function listeningAudioFileExists(
  supabase: SupabaseClient,
  storagePath: string,
): Promise<boolean> {
  const parts = storagePath.split('/');
  const fileName = parts.pop()!;
  const folder = parts.join('/');

  const { data, error } = await supabase.storage
    .from(AUDIO_STORAGE_BUCKET)
    .list(folder, { search: fileName });

  if (error) return false;
  return (data ?? []).some(f => f.name === fileName);
}
