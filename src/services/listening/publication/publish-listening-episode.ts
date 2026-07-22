import {
  LISTENING_ERRORS,
  ListeningPublicationError,
  type PublishListeningEpisodeInput,
  type PublishListeningEpisodeResult,
  type PublishedListeningBlockResult,
} from './listening-publication-types';
import { validateListeningEpisodeForPublication } from './validate-listening-publication';
import { publishListeningAudioAsset } from './publish-listening-audio-assets';
import { getListeningServiceClient } from './_supabase';
import { PUBLICATION_RETRY_MAX, PUBLICATION_RETRY_BACKOFF_MS } from './listening-publication-config';

function logPublication(event: string, episodeId: string, extra?: Record<string, unknown>): void {
  console.error(JSON.stringify({ service: 'listening-publication', event, episodeId, t: Date.now(), ...extra }));
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function persistPublicationLog(
  supabase: ReturnType<typeof getListeningServiceClient>,
  episodeId: string,
  event: string,
  publicationVersion: number | null,
  publishedBy: string | null,
  publicationSource: string | null,
  details?: Record<string, unknown>,
): Promise<void> {
  try {
    await supabase.from('listening_publication_log').insert({
      episode_id: episodeId,
      event,
      publication_version: publicationVersion,
      published_by: publishedBy ?? null,
      publication_source: publicationSource ?? null,
      details: details ?? null,
    });
  } catch {
    // Log insertion failure is non-blocking.
  }
}

/**
 * Publica um episódio de Listening.
 *
 * Fluxo:
 * 1. Valida o episódio
 * 2. Marca como 'publishing'
 * 3. Copia e valida cada bloco de staging → published
 * 4. Atualiza banco (paths + published status)
 * 5. Idempotente: retorna publicação existente se hashes coincidem
 */
export async function publishListeningEpisode(
  input: PublishListeningEpisodeInput,
): Promise<PublishListeningEpisodeResult> {
  const { episodeId, publishedBy, publicationSource = 'system', force: _force } = input;
  const supabase = getListeningServiceClient();

  logPublication('listening_publication_validation_started', episodeId);

  // ── Idempotência: episódio já publicado ───────────────────────────────────

  const { data: existing } = await supabase
    .from('listening_episodes')
    .select('id, status, published_at, publication_version, cefr_level, content_version')
    .eq('id', episodeId)
    .maybeSingle();

  if (existing?.status === 'published' && existing.published_at) {
    const { data: assets } = await supabase
      .from('listening_audio_assets')
      .select('id, block_id, audio_hash, published_path, duration_ms')
      .eq('episode_id', episodeId)
      .eq('status', 'published');

    if (assets && assets.length === 2) {
      const { data: blocks } = await supabase
        .from('listening_blocks')
        .select('id, block_order')
        .eq('episode_id', episodeId)
        .order('block_order');

      if (blocks && blocks.length === 2) {
        logPublication('listening_episode_already_published', episodeId, { publication_version: existing.publication_version });
        return {
          episodeId,
          publicationStatus: 'published',
          publishedAt: existing.published_at,
          publicationVersion: existing.publication_version,
          blocks: assets.map((a) => {
            const block = blocks.find((b) => b.id === a.block_id)!;
            return {
              blockId: a.block_id,
              blockOrder: block.block_order as 1 | 2,
              finalAudioPath: a.published_path ?? '',
              durationMs: a.duration_ms ?? 0,
              audioHash: a.audio_hash,
            };
          }) as [PublishedListeningBlockResult, PublishedListeningBlockResult],
        };
      }
    }
  }

  // ── Validação final ───────────────────────────────────────────────────────

  const validation = await validateListeningEpisodeForPublication(episodeId, supabase);

  if (!validation.valid) {
    logPublication('listening_publication_validation_failed', episodeId, {
      error_count: validation.errors.length,
      first_error: validation.errors[0]?.code,
    });
    await persistPublicationLog(supabase, episodeId, 'listening_publication_validation_failed', null, publishedBy ?? null, publicationSource, {
      errors: validation.errors.map((e) => e.code),
    });
    throw new ListeningPublicationError(
      LISTENING_ERRORS.VALIDATION_FAILED,
      `Validação falhou com ${validation.errors.length} erro(s): ${validation.errors.map((e) => e.code).join(', ')}`,
      episodeId,
    );
  }

  // ── Carregar dados necessários ────────────────────────────────────────────

  const { data: episode } = await supabase
    .from('listening_episodes')
    .select('cefr_level, content_version, publication_version')
    .eq('id', episodeId)
    .single();

  if (!episode) {
    throw new ListeningPublicationError(LISTENING_ERRORS.EPISODE_NOT_FOUND, 'Episódio não encontrado.', episodeId);
  }

  const { data: blocks } = await supabase
    .from('listening_blocks')
    .select('id, block_order')
    .eq('episode_id', episodeId)
    .order('block_order');

  const { data: assets } = await supabase
    .from('listening_audio_assets')
    .select('id, block_id, ssml_hash, audio_hash, audio_path, published_path, file_size_bytes, duration_ms, content_type, status')
    .eq('episode_id', episodeId);

  if (!blocks || blocks.length !== 2 || !assets || assets.length !== 2) {
    throw new ListeningPublicationError(LISTENING_ERRORS.VALIDATION_FAILED, 'Dados incompletos após validação.', episodeId);
  }

  const newPublicationVersion = (episode.publication_version ?? 0) + 1;

  // ── Marcar como publishing ────────────────────────────────────────────────

  const { error: markError } = await supabase
    .from('listening_episodes')
    .update({ status: 'publishing', updated_at: new Date().toISOString() })
    .eq('id', episodeId)
    .eq('status', 'ready');

  if (markError) {
    throw new ListeningPublicationError(
      LISTENING_ERRORS.PERSISTENCE_ERROR,
      'Erro ao marcar episódio como publishing.',
      episodeId,
      undefined,
      true,
    );
  }

  logPublication('listening_publication_started', episodeId, { publication_version: newPublicationVersion });
  await persistPublicationLog(supabase, episodeId, 'listening_publication_started', newPublicationVersion, publishedBy ?? null, publicationSource);

  // ── Copiar arquivos com retry ─────────────────────────────────────────────

  const publishedBlocks: PublishedListeningBlockResult[] = [];

  for (const block of blocks as { id: string; block_order: 1 | 2 }[]) {
    const asset = assets.find((a) => a.block_id === block.id)!;

    let lastError: unknown;
    let result: PublishedListeningBlockResult | null = null;

    for (let attempt = 0; attempt <= PUBLICATION_RETRY_MAX; attempt++) {
      try {
        result = await publishListeningAudioAsset(
          supabase,
          asset,
          block,
          episode.cefr_level,
          episodeId,
          episode.content_version,
        );
        logPublication('listening_audio_asset_copied', episodeId, {
          block_id: block.id,
          block_order: block.block_order,
          published_path: result.finalAudioPath,
          audio_hash: result.audioHash,
        });
        break;
      } catch (err) {
        lastError = err;
        // Não retenta para erros de validação de hash ou inconsistência — apenas falhas transientes.
        if (err instanceof ListeningPublicationError) {
          break;
        }
        if (attempt < PUBLICATION_RETRY_MAX) {
          await sleep(PUBLICATION_RETRY_BACKOFF_MS[attempt] ?? 1500);
        }
      }
    }

    if (!result) {
      // Marcar publicação como falha
      await supabase
        .from('listening_episodes')
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', episodeId);

      logPublication('listening_publication_failed', episodeId, {
        block_id: block.id,
        error: lastError instanceof Error ? lastError.message.slice(0, 200) : 'unknown',
      });
      await persistPublicationLog(supabase, episodeId, 'listening_publication_failed', newPublicationVersion, publishedBy ?? null, publicationSource, {
        block_id: block.id,
      });

      throw new ListeningPublicationError(
        LISTENING_ERRORS.STORAGE_COPY_FAILED,
        `Falha ao publicar bloco ${block.block_order}.`,
        episodeId,
        block.id,
        true,
        lastError,
      );
    }

    publishedBlocks.push(result);
  }

  // ── Atualizar banco e marcar como published ───────────────────────────────

  const now = new Date().toISOString();

  const { error: publishError } = await supabase
    .from('listening_episodes')
    .update({
      status: 'published',
      published_at: now,
      publication_version: newPublicationVersion,
      published_by: publishedBy ?? null,
      publication_source: publicationSource,
      updated_at: now,
    })
    .eq('id', episodeId);

  if (publishError) {
    logPublication('listening_publication_failed', episodeId, { reason: 'db_update_failed' });
    await persistPublicationLog(supabase, episodeId, 'listening_publication_failed', newPublicationVersion, publishedBy ?? null, publicationSource, {
      reason: 'db_update_failed',
    });
    throw new ListeningPublicationError(
      LISTENING_ERRORS.PERSISTENCE_ERROR,
      'Erro ao salvar publicação no banco. Arquivos copiados com sucesso — recuperação possível.',
      episodeId,
      undefined,
      true,
    );
  }

  logPublication('listening_episode_published', episodeId, {
    publication_version: newPublicationVersion,
    published_at: now,
  });
  await persistPublicationLog(supabase, episodeId, 'listening_episode_published', newPublicationVersion, publishedBy ?? null, publicationSource);

  return {
    episodeId,
    publicationStatus: 'published',
    publishedAt: now,
    publicationVersion: newPublicationVersion,
    blocks: publishedBlocks as [PublishedListeningBlockResult, PublishedListeningBlockResult],
  };
}
