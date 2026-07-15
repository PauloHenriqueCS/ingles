import type { SupabaseClient } from '@supabase/supabase-js';
import { LISTENING_ERRORS, ListeningPublicationError } from './listening-publication-types';

export type ListeningAccessContext = {
  userId: string;
  episodeId: string;
};

export type ListeningAccessResult = {
  allowed: boolean;
  reason?: string;
};

/**
 * Verifica se o usuário pode acessar o episódio.
 * Regras da Etapa 8: autenticado + episódio publicado + não arquivado.
 * Etapa 9 adicionará: plano, episódio atribuído, limite diário, nível.
 */
export async function canUserAccessListeningEpisode(
  supabase: SupabaseClient,
  { userId, episodeId }: ListeningAccessContext,
): Promise<ListeningAccessResult> {
  if (!userId) {
    return { allowed: false, reason: 'unauthenticated' };
  }

  const { data: episode, error } = await supabase
    .from('listening_episodes')
    .select('id, status, access_tier')
    .eq('id', episodeId)
    .maybeSingle();

  if (error || !episode) {
    return { allowed: false, reason: 'episode_not_found' };
  }

  if (episode.status === 'archived') {
    return { allowed: false, reason: 'episode_archived' };
  }

  if (episode.status !== 'published') {
    return { allowed: false, reason: 'episode_not_published' };
  }

  return { allowed: true };
}

export function assertListeningAccess(
  result: ListeningAccessResult,
  episodeId: string,
): void {
  if (result.allowed) return;

  if (result.reason === 'episode_archived') {
    throw new ListeningPublicationError(
      LISTENING_ERRORS.EPISODE_ARCHIVED,
      'Episódio arquivado.',
      episodeId,
    );
  }

  throw new ListeningPublicationError(
    LISTENING_ERRORS.ACCESS_DENIED,
    'Acesso negado a este episódio.',
    episodeId,
  );
}
