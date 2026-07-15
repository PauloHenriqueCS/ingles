import type { SupabaseClient } from '@supabase/supabase-js';
import type { ListeningBlockSsmlResult } from './listening-ssml-types';
import { SSML_GENERATOR_VERSION } from './listening-ssml-config';

export interface PersistListeningSsmlInput {
  supabase: SupabaseClient;
  episodeId: string;
  voiceName: string;
  locale: string;
  blocks: [ListeningBlockSsmlResult, ListeningBlockSsmlResult];
}

export async function persistListeningSsml(input: PersistListeningSsmlInput): Promise<void> {
  const { supabase, episodeId, voiceName, locale, blocks } = input;
  const now = new Date().toISOString();

  for (const block of blocks) {
    const { error } = await supabase
      .from('listening_blocks')
      .update({
        ssml: block.ssml,
        ssml_status: 'ready',
        ssml_version: block.ssmlVersion,
        ssml_generator_version: SSML_GENERATOR_VERSION,
        ssml_generated_at: now,
        ssml_content_hash: block.contentHash,
      })
      .eq('id', block.blockId);

    if (error) {
      throw new Error(`Failed to persist SSML for block ${block.blockOrder}: ${error.message}`);
    }
  }

  const { error: epError } = await supabase
    .from('listening_episodes')
    .update({
      ssml_status: 'ready',
      ssml_generated_at: now,
      ssml_generator_version: SSML_GENERATOR_VERSION,
      voice_name: voiceName,
      locale,
    })
    .eq('id', episodeId);

  if (epError) {
    throw new Error(`Failed to update episode SSML status: ${epError.message}`);
  }
}
