import { requireAuth } from '../_auth';
import { isValidUuid, buildStatusResponse, rowToAssessment } from '../../src/lib/pronunciationAssessment';
import { methodGuard, safeLog } from '../_helpers';

export default async function handler(req: any, res: any) {
  if (!methodGuard(req, res, ['GET'])) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const { textVersionId } = req.query ?? {};

  if (!isValidUuid(textVersionId)) {
    return res.status(400).json({ error: 'textVersionId inválido.' });
  }

  const { userId, supabase } = auth;

  // Verify the review belongs to this user before querying assessments
  const { data: review, error: reviewError } = await supabase
    .from('english_reviews')
    .select('id')
    .eq('id', textVersionId)
    .eq('user_id', userId)
    .maybeSingle();

  if (reviewError) {
    safeLog('pronunciation/status', 'db_error', 500);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno.' });
  }

  if (!review) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Revisão não encontrada.' });
  }

  const { data: row, error: assessmentError } = await supabase
    .from('pronunciation_assessments')
    .select('*')
    .eq('text_version_id', textVersionId)
    .eq('user_id', userId)
    .maybeSingle();

  if (assessmentError) {
    safeLog('pronunciation/status', 'db_error', 500);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno.' });
  }

  const assessment = row ? rowToAssessment(row as Record<string, unknown>) : null;
  return res.json(buildStatusResponse(assessment));
}
