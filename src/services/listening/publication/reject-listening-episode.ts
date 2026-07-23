import {
  LISTENING_ERRORS,
  ListeningPublicationError,
} from './listening-publication-types';
import { getListeningServiceClient } from './_supabase';

/**
 * Terminally rejects an episode that will never be published — e.g. a draft
 * whose content-quality correction exhausted its attempts. Sibling to
 * archiveListeningEpisode, but for content that never reached 'published' in
 * the first place (archive requires the opposite: status === 'published').
 *
 * Sets status = 'failed' (the same enum value the rest of the pipeline
 * already uses for terminal content-generation failures), which the
 * existing reuse/assignment/publication guards already treat correctly:
 * - findReusableListeningGroupStory only selects status = 'published'
 * - select-listening-episode-for-user only assigns status = 'published'
 * - validate-listening-publication only allows publishing status = 'ready'
 * Preserves all rows (blocks, questions, whatever subtitles/audio exist) for
 * audit — never deletes anything.
 */
export async function rejectListeningEpisode(
  episodeId: string,
  reason: string,
  rejectedBy?: string,
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

  if (episode.status === 'failed') {
    return; // Idempotente
  }

  if (episode.status === 'published' || episode.status === 'archived') {
    throw new ListeningPublicationError(
      LISTENING_ERRORS.EPISODE_NOT_READY,
      `Não é possível rejeitar um episódio ${episode.status}. Use archiveListeningEpisode para episódios publicados.`,
      episodeId,
    );
  }

  const { error: updateError } = await supabase
    .from('listening_episodes')
    .update({
      status: 'failed',
      updated_at: new Date().toISOString(),
    })
    .eq('id', episodeId);

  if (updateError) {
    throw new ListeningPublicationError(
      LISTENING_ERRORS.PERSISTENCE_ERROR,
      'Erro ao rejeitar episódio.',
      episodeId,
    );
  }

  try {
    await supabase.from('listening_publication_log').insert({
      episode_id: episodeId,
      event: 'listening_episode_rejected',
      published_by: rejectedBy ?? null,
      details: { reason, rejected_by: rejectedBy ?? 'system' },
    });
  } catch {
    // Log não-bloqueante
  }

  console.error(JSON.stringify({
    service: 'listening-publication',
    event: 'listening_episode_rejected',
    episodeId,
    reason,
    t: Date.now(),
  }));
}
