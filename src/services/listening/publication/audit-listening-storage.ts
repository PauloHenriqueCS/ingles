import {
  type ListeningStorageAuditResult,
  type ListeningStorageAuditIssue,
} from './listening-publication-types';
import { LISTENING_BUCKET } from './listening-publication-config';
import { getListeningServiceClient } from './_supabase';

/**
 * Auditoria de consistência entre banco de dados e Storage.
 * Identifica orphans, hashes divergentes, arquivos vazios, etc.
 * Não apaga nada automaticamente — gera relatório para rotina de limpeza.
 */
export async function auditListeningStorageConsistency(): Promise<ListeningStorageAuditResult> {
  const supabase = getListeningServiceClient();
  const issues: ListeningStorageAuditIssue[] = [];

  // ── Carregar todos os assets ──────────────────────────────────────────────

  const { data: assets, error: assetError } = await supabase
    .from('listening_audio_assets')
    .select('id, episode_id, block_id, audio_hash, audio_path, published_path, file_size_bytes, status');

  if (assetError || !assets) {
    return {
      auditedAt: new Date().toISOString(),
      issues: [{ type: 'invalid_path', details: 'Erro ao carregar audio assets.' }],
      summary: { totalIssues: 1, recordsWithoutFiles: 0, filesWithoutRecords: 0, staleStagingPaths: 0, hashMismatches: 0, emptyFiles: 0 },
    };
  }

  // ── Carregar episódios publicados ─────────────────────────────────────────

  const { data: publishedEpisodes } = await supabase
    .from('listening_episodes')
    .select('id, status')
    .eq('status', 'published');

  const publishedIds = new Set((publishedEpisodes ?? []).map((e) => e.id));

  // ── Verificar cada asset contra Storage ──────────────────────────────────

  for (const asset of assets) {
    // Arquivo publicado sem episódio publicado
    if (asset.published_path && !publishedIds.has(asset.episode_id)) {
      issues.push({
        type: 'published_file_without_published_episode',
        path: asset.published_path,
        episodeId: asset.episode_id,
        blockId: asset.block_id,
        details: `Asset ${asset.id} tem published_path mas o episódio não está publicado.`,
      });
    }

    // Verificar staging path no Storage
    if (asset.audio_path) {
      const stagingExists = await fileExistsInStorage(supabase, asset.audio_path);
      if (!stagingExists.exists) {
        issues.push({
          type: 'record_without_file',
          path: asset.audio_path,
          episodeId: asset.episode_id,
          blockId: asset.block_id,
          details: `staging_path registrado mas arquivo não encontrado: ${asset.audio_path}`,
        });
      } else if (stagingExists.sizeBytes === 0) {
        issues.push({
          type: 'empty_file',
          path: asset.audio_path,
          episodeId: asset.episode_id,
          blockId: asset.block_id,
          details: `Arquivo de staging vazio: ${asset.audio_path}`,
        });
      }

      // Staging existente em episódio publicado = candidato para limpeza
      if (publishedIds.has(asset.episode_id) && stagingExists.exists) {
        issues.push({
          type: 'stale_staging',
          path: asset.audio_path,
          episodeId: asset.episode_id,
          blockId: asset.block_id,
          details: `Staging não removido após publicação: ${asset.audio_path}`,
        });
      }
    }

    // Verificar published path no Storage
    if (asset.published_path) {
      const pubExists = await fileExistsInStorage(supabase, asset.published_path);
      if (!pubExists.exists) {
        issues.push({
          type: 'record_without_file',
          path: asset.published_path,
          episodeId: asset.episode_id,
          blockId: asset.block_id,
          details: `published_path registrado mas arquivo não encontrado: ${asset.published_path}`,
        });
      } else if (pubExists.sizeBytes === 0) {
        issues.push({
          type: 'empty_file',
          path: asset.published_path,
          episodeId: asset.episode_id,
          blockId: asset.block_id,
          details: `Arquivo publicado vazio: ${asset.published_path}`,
        });
      } else if (
        asset.file_size_bytes !== null &&
        pubExists.sizeBytes !== asset.file_size_bytes
      ) {
        issues.push({
          type: 'hash_mismatch',
          path: asset.published_path,
          episodeId: asset.episode_id,
          blockId: asset.block_id,
          details: `Tamanho divergente: banco=${asset.file_size_bytes} bytes, storage=${pubExists.sizeBytes} bytes`,
        });
      }
    }
  }

  // ── Listar arquivos no Storage e verificar contra banco ──────────────────

  try {
    await auditStorageFolder(supabase, 'published', assets, issues);
    await auditStorageFolder(supabase, 'staging', assets, issues);
  } catch {
    // Falha na listagem não invalida o relatório parcial
  }

  const summary = {
    totalIssues: issues.length,
    recordsWithoutFiles: issues.filter((i) => i.type === 'record_without_file').length,
    filesWithoutRecords: issues.filter((i) => i.type === 'file_without_record').length,
    staleStagingPaths: issues.filter((i) => i.type === 'stale_staging').length,
    hashMismatches: issues.filter((i) => i.type === 'hash_mismatch').length,
    emptyFiles: issues.filter((i) => i.type === 'empty_file').length,
  };

  console.error(JSON.stringify({
    service: 'listening-publication',
    event: 'listening_storage_inconsistency_found',
    total_issues: summary.totalIssues,
    t: Date.now(),
  }));

  return {
    auditedAt: new Date().toISOString(),
    issues,
    summary,
  };
}

async function fileExistsInStorage(
  supabase: ReturnType<typeof getListeningServiceClient>,
  path: string,
): Promise<{ exists: boolean; sizeBytes: number }> {
  const folder = path.substring(0, path.lastIndexOf('/'));
  const filename = path.substring(path.lastIndexOf('/') + 1);
  const { data, error } = await supabase.storage
    .from(LISTENING_BUCKET)
    .list(folder, { search: filename });
  if (error || !data) return { exists: false, sizeBytes: 0 };
  const file = data.find((f) => f.name === filename);
  if (!file) return { exists: false, sizeBytes: 0 };
  return { exists: true, sizeBytes: Number((file.metadata as any)?.size ?? 0) };
}

async function auditStorageFolder(
  supabase: ReturnType<typeof getListeningServiceClient>,
  prefix: string,
  assets: { audio_path: string | null; published_path: string | null; episode_id: string; block_id: string }[],
  issues: ListeningStorageAuditIssue[],
): Promise<void> {
  const allPaths = new Set([
    ...assets.map((a) => a.audio_path).filter(Boolean) as string[],
    ...assets.map((a) => a.published_path).filter(Boolean) as string[],
  ]);

  const { data: topFolders } = await supabase.storage
    .from(LISTENING_BUCKET)
    .list(prefix);

  if (!topFolders) return;

  for (const cefrFolder of topFolders) {
    const { data: episodeFolders } = await supabase.storage
      .from(LISTENING_BUCKET)
      .list(`${prefix}/${cefrFolder.name}`);
    if (!episodeFolders) continue;

    for (const epFolder of episodeFolders) {
      const { data: deepFiles } = await supabase.storage
        .from(LISTENING_BUCKET)
        .list(`${prefix}/${cefrFolder.name}/${epFolder.name}`, { limit: 100 });
      if (!deepFiles) continue;

      for (const file of deepFiles) {
        const filePath = `${prefix}/${cefrFolder.name}/${epFolder.name}/${file.name}`;
        if (!allPaths.has(filePath)) {
          issues.push({
            type: 'file_without_record',
            path: filePath,
            details: `Arquivo no Storage sem registro no banco: ${filePath}`,
          });
        }
      }
    }
  }
}
