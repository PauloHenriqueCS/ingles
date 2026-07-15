/**
 * GET /api/listening/episodes
 * Returns a list of published episodes the user can access.
 */

import { requireAuth } from '../_auth';
import { methodGuard, jsonError, safeLog } from '../_helpers';

export default async function handler(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['GET'])) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { supabase } = auth;

  try {
    const { data: episodes, error } = await supabase
      .from('listening_episodes')
      .select('id, title, cefr_level, estimated_duration_seconds')
      .eq('status', 'published')
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      safeLog('listening/episodes', 'db_error', 500, { error: error.message });
      return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro ao buscar episódios.');
    }

    const result = (episodes ?? []).map((ep: any) => ({
      id: ep.id,
      title: ep.title,
      cefrLevel: ep.cefr_level,
      estimatedDurationSeconds: ep.estimated_duration_seconds,
    }));

    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.status(200).json(result);
  } catch {
    safeLog('listening/episodes', 'internal_error', 500, {});
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno.');
  }
}
