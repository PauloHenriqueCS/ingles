import type { SupabaseClient } from '@supabase/supabase-js';
import {
  LISTENING_ERRORS,
  ListeningPublicationError,
  type ListeningSignedAudio,
} from './listening-publication-types';
import { LISTENING_BUCKET, SIGNED_URL_CONFIG } from './listening-publication-config';
import { getListeningServiceClient } from './_supabase';

type SignedUrlCacheEntry = {
  audio: ListeningSignedAudio;
  expiresAtMs: number;
};

// Warm-start cache: válido por instância do processo (stateless entre invocações frias).
const _cache = new Map<string, SignedUrlCacheEntry>();

function cacheKey(userId: string, audioAssetId: string): string {
  return `${userId}::${audioAssetId}`;
}

function getCached(userId: string, audioAssetId: string): ListeningSignedAudio | null {
  const entry = _cache.get(cacheKey(userId, audioAssetId));
  if (!entry) return null;
  const refreshThreshold = SIGNED_URL_CONFIG.refreshBeforeExpirationSeconds * 1000;
  if (Date.now() >= entry.expiresAtMs - refreshThreshold) {
    _cache.delete(cacheKey(userId, audioAssetId));
    return null;
  }
  return entry.audio;
}

function setCached(userId: string, audioAssetId: string, audio: ListeningSignedAudio): void {
  _cache.set(cacheKey(userId, audioAssetId), {
    audio,
    expiresAtMs: new Date(audio.expiresAt).getTime(),
  });
}

/**
 * Gera URL assinada temporária para um bloco de áudio.
 * Confirma: usuário autenticado, episódio publicado, bloco válido.
 * Nunca retorna caminhos de staging.
 */
export async function createListeningAudioSignedUrl(
  params: {
    userId: string;
    episodeId: string;
    blockId: string;
  },
  authedSupabase: SupabaseClient,
): Promise<ListeningSignedAudio> {
  const { userId, episodeId, blockId } = params;
  const serviceClient = getListeningServiceClient();

  // Confirmar episódio publicado
  const { data: episode, error: epError } = await authedSupabase
    .from('listening_episodes')
    .select('id, status')
    .eq('id', episodeId)
    .eq('status', 'published')
    .maybeSingle();

  if (epError || !episode) {
    throw new ListeningPublicationError(
      LISTENING_ERRORS.ACCESS_DENIED,
      'Episódio não publicado ou não encontrado.',
      episodeId,
    );
  }

  // Confirmar bloco pertence ao episódio
  const { data: block, error: blError } = await authedSupabase
    .from('listening_blocks')
    .select('id, block_order')
    .eq('id', blockId)
    .eq('episode_id', episodeId)
    .maybeSingle();

  if (blError || !block) {
    throw new ListeningPublicationError(
      LISTENING_ERRORS.ACCESS_DENIED,
      'Bloco não pertence ao episódio.',
      episodeId,
      blockId,
    );
  }

  // Carregar asset publicado via service role
  const { data: asset, error: assetError } = await serviceClient
    .from('listening_audio_assets')
    .select('id, published_path, duration_ms, content_type, status, audio_hash')
    .eq('block_id', blockId)
    .eq('status', 'published')
    .maybeSingle();

  if (assetError || !asset) {
    throw new ListeningPublicationError(
      LISTENING_ERRORS.SIGNED_URL_FAILED,
      'Audio asset não disponível.',
      episodeId,
      blockId,
    );
  }

  if (!asset.published_path) {
    throw new ListeningPublicationError(
      LISTENING_ERRORS.AUDIO_MISSING,
      'Caminho definitivo do áudio ausente.',
      episodeId,
      blockId,
    );
  }

  // Verificar cache warm-start
  const cached = getCached(userId, asset.id);
  if (cached) return cached;

  // Gerar URL assinada via service role (bucket privado)
  const { data: signedData, error: signedError } = await serviceClient.storage
    .from(LISTENING_BUCKET)
    .createSignedUrl(asset.published_path, SIGNED_URL_CONFIG.expiresInSeconds);

  if (signedError || !signedData?.signedUrl) {
    throw new ListeningPublicationError(
      LISTENING_ERRORS.SIGNED_URL_FAILED,
      'Falha ao gerar URL assinada.',
      episodeId,
      blockId,
    );
  }

  const expiresAt = new Date(Date.now() + SIGNED_URL_CONFIG.expiresInSeconds * 1000).toISOString();

  const audio: ListeningSignedAudio = {
    blockId,
    blockOrder: block.block_order as 1 | 2,
    url: signedData.signedUrl,
    expiresAt,
    durationMs: asset.duration_ms ?? 0,
    contentType: asset.content_type,
  };

  setCached(userId, asset.id, audio);
  return audio;
}
