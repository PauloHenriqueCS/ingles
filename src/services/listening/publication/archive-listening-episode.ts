import {
  LISTENING_ERRORS,
  ListeningPublicationError,
} from './listening-publication-types';
import { getListeningServiceClient } from './_supabase';

/**
 * Arquiva um episódio publicado.
 * Mantém dados históricos, tentativas e progresso de usuários.
 * Impede novas atribuições. Não apaga arquivos.
 */
export async function archiveListeningEpisode(
  episodeId: string,
  archivedBy?: string,
): Promise<void> {
  const supabase = getListeningServiceClient();

  const { data: episode, error: loadError } = await supabase
    .from('listening_episodes')
    .select('id, status')
    .eq('id', episodeId)
    .maybeSingle();

  if (loadError || !episode) {
    throw new ListeningPublicationError(
      LISTENING_ERRORS.EPISODE_NOT_FOUND,
      'Episódio não encontrado.',
      episodeId,
    );
  }

  if (episode.status === 'archived') {
    return; // Idempotente
  }

  if (episode.status !== 'published') {
    throw new ListeningPublicationError(
      LISTENING_ERRORS.EPISODE_NOT_READY,
      `Apenas episódios publicados podem ser arquivados. Status atual: ${episode.status}`,
      episodeId,
    );
  }

  const { error: updateError } = await supabase
    .from('listening_episodes')
    .update({
      status: 'archived',
      updated_at: new Date().toISOString(),
    })
    .eq('id', episodeId);

  if (updateError) {
    throw new ListeningPublicationError(
      LISTENING_ERRORS.PERSISTENCE_ERROR,
      'Erro ao arquivar episódio.',
      episodeId,
    );
  }

  try {
    await supabase.from('listening_publication_log').insert({
      episode_id: episodeId,
      event: 'listening_episode_archived',
      published_by: archivedBy ?? null,
      details: { archived_by: archivedBy ?? 'system' },
    });
  } catch {
    // Log não-bloqueante
  }

  console.error(JSON.stringify({
    service: 'listening-publication',
    event: 'listening_episode_archived',
    episodeId,
    t: Date.now(),
  }));
}
