import {
  LISTENING_ERRORS,
  ListeningPublicationError,
} from './listening-publication-types';
import { LISTENING_BUCKET } from './listening-publication-config';
import { getListeningServiceClient } from './_supabase';

type CleanupResult = {
  episodeId: string;
  removedPaths: string[];
  skippedPaths: string[];
  errors: string[];
};

/**
 * Remove arquivos de staging após publicação confirmada.
 * Idempotente: não falha se o arquivo já foi removido.
 * Nunca remove arquivos definitivos (published/).
 */
export async function cleanupPublishedListeningStaging(
  episodeId: string,
): Promise<CleanupResult> {
  const supabase = getListeningServiceClient();
  const result: CleanupResult = {
    episodeId,
    removedPaths: [],
    skippedPaths: [],
    errors: [],
  };

  // Confirmar que o episódio está publicado
  const { data: episode, error: epError } = await supabase
    .from('listening_episodes')
    .select('id, status')
    .eq('id', episodeId)
    .maybeSingle();

  if (epError || !episode) {
    throw new ListeningPublicationError(
      LISTENING_ERRORS.EPISODE_NOT_FOUND,
      'Episódio não encontrado.',
      episodeId,
    );
  }

  if (episode.status !== 'published' && episode.status !== 'archived') {
    throw new ListeningPublicationError(
      LISTENING_ERRORS.EPISODE_NOT_READY,
      `Limpeza de staging requer episódio publicado. Status: ${episode.status}`,
      episodeId,
    );
  }

  // Carregar assets e confirmar arquivos definitivos existem
  const { data: assets, error: assetError } = await supabase
    .from('listening_audio_assets')
    .select('id, block_id, staging_path, published_path, audio_hash, status, file_size_bytes')
    .eq('episode_id', episodeId);

  if (assetError || !assets) {
    throw new ListeningPublicationError(
      LISTENING_ERRORS.STORAGE_CLEANUP_FAILED,
      'Erro ao carregar assets.',
      episodeId,
    );
  }

  for (const asset of assets) {
    if (!asset.staging_path) {
      result.skippedPaths.push('(no staging path)');
      continue;
    }

    // Confirmar arquivo definitivo antes de remover staging
    if (!asset.published_path) {
      result.skippedPaths.push(asset.staging_path);
      result.errors.push(`Bloco ${asset.block_id}: published_path ausente, staging mantido.`);
      continue;
    }

    // Verificar arquivo definitivo no Storage
    const folder = asset.published_path.substring(0, asset.published_path.lastIndexOf('/'));
    const filename = asset.published_path.substring(asset.published_path.lastIndexOf('/') + 1);
    const { data: pubFiles } = await supabase.storage
      .from(LISTENING_BUCKET)
      .list(folder, { search: filename });

    const pubFile = pubFiles?.find((f) => f.name === filename);
    if (!pubFile) {
      result.skippedPaths.push(asset.staging_path);
      result.errors.push(`Arquivo definitivo não encontrado: ${asset.published_path}. Staging mantido.`);
      continue;
    }

    const pubSize = Number((pubFile.metadata as any)?.size ?? 0);
    if (pubSize === 0) {
      result.skippedPaths.push(asset.staging_path);
      result.errors.push(`Arquivo definitivo vazio: ${asset.published_path}. Staging mantido.`);
      continue;
    }

    // Remover staging
    const { error: removeError } = await supabase.storage
      .from(LISTENING_BUCKET)
      .remove([asset.staging_path]);

    if (removeError) {
      result.skippedPaths.push(asset.staging_path);
      result.errors.push(`Erro ao remover ${asset.staging_path}: ${removeError.message}`);
    } else {
      result.removedPaths.push(asset.staging_path);
    }
  }

  console.error(JSON.stringify({
    service: 'listening-publication',
    event: 'listening_staging_cleanup_completed',
    episodeId,
    removed: result.removedPaths.length,
    skipped: result.skippedPaths.length,
    errors: result.errors.length,
    t: Date.now(),
  }));

  try {
    await supabase.from('listening_publication_log').insert({
      episode_id: episodeId,
      event: 'listening_staging_cleanup_completed',
      details: {
        removed_paths: result.removedPaths,
        skipped_paths: result.skippedPaths,
        errors: result.errors,
      },
    });
  } catch {
    // Log não-bloqueante
  }

  return result;
}
