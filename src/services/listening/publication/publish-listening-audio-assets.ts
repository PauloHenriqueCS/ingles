import type { SupabaseClient } from '@supabase/supabase-js';
import {
  LISTENING_BUCKET,
  buildPublishedPath,
} from './listening-publication-config';
import {
  LISTENING_ERRORS,
  ListeningPublicationError,
  type PublishedListeningBlockResult,
} from './listening-publication-types';

type AudioAssetRow = {
  id: string;
  block_id: string;
  ssml_hash: string;
  audio_hash: string;
  staging_path: string;
  published_path: string | null;
  file_size_bytes: number | null;
  duration_ms: number | null;
  content_type: string;
  status: string;
};

type BlockRow = {
  id: string;
  block_order: 1 | 2;
};

async function copyFileInStorage(
  supabase: SupabaseClient,
  fromPath: string,
  toPath: string,
): Promise<void> {
  const { error } = await supabase.storage
    .from(LISTENING_BUCKET)
    .copy(fromPath, toPath);

  if (error) {
    throw new Error(`Storage copy failed: ${fromPath} → ${toPath}: ${error.message}`);
  }
}

async function validatePublishedFile(
  supabase: SupabaseClient,
  publishedPath: string,
  expectedSizeBytes: number | null,
): Promise<void> {
  const folder = publishedPath.substring(0, publishedPath.lastIndexOf('/'));
  const filename = publishedPath.substring(publishedPath.lastIndexOf('/') + 1);

  const { data, error } = await supabase.storage
    .from(LISTENING_BUCKET)
    .list(folder, { search: filename });

  if (error || !data) {
    throw new Error(`Cannot verify published file: ${publishedPath}`);
  }

  const file = data.find((f) => f.name === filename);
  if (!file) {
    throw new Error(`Published file not found after copy: ${publishedPath}`);
  }

  const actualSize = Number((file.metadata as any)?.size ?? 0);
  if (actualSize === 0) {
    throw new Error(`Published file is empty: ${publishedPath}`);
  }

  if (expectedSizeBytes !== null && actualSize !== expectedSizeBytes) {
    throw new Error(`Published file size mismatch: expected ${expectedSizeBytes}, got ${actualSize}`);
  }
}

export async function publishListeningAudioAsset(
  supabase: SupabaseClient,
  asset: AudioAssetRow,
  block: BlockRow,
  cefrLevel: string,
  episodeId: string,
  contentVersion: number,
): Promise<PublishedListeningBlockResult> {
  if (!asset.staging_path) {
    throw new ListeningPublicationError(
      LISTENING_ERRORS.AUDIO_MISSING,
      `Bloco ${block.block_order} sem staging_path.`,
      episodeId,
      block.id,
    );
  }

  const publishedPath = buildPublishedPath(
    cefrLevel,
    episodeId,
    contentVersion,
    asset.audio_hash,
    block.block_order,
  );

  // Se o arquivo definitivo já existe, retornar sem sobrescrever.
  if (asset.published_path === publishedPath) {
    return {
      blockId: block.id,
      blockOrder: block.block_order,
      finalAudioPath: publishedPath,
      durationMs: asset.duration_ms ?? 0,
      audioHash: asset.audio_hash,
    };
  }

  await copyFileInStorage(supabase, asset.staging_path, publishedPath);
  await validatePublishedFile(supabase, publishedPath, asset.file_size_bytes);

  const now = new Date().toISOString();
  const { error: updateError } = await supabase
    .from('listening_audio_assets')
    .update({
      published_path: publishedPath,
      status: 'published',
      updated_at: now,
    })
    .eq('id', asset.id);

  if (updateError) {
    throw new ListeningPublicationError(
      LISTENING_ERRORS.PERSISTENCE_ERROR,
      `Erro ao atualizar audio asset do bloco ${block.block_order}.`,
      episodeId,
      block.id,
    );
  }

  return {
    blockId: block.id,
    blockOrder: block.block_order,
    finalAudioPath: publishedPath,
    durationMs: asset.duration_ms ?? 0,
    audioHash: asset.audio_hash,
  };
}
