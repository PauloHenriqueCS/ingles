import { requireAuth } from '../_auth';
import { isValidUuid, buildStatusResponse, rowToAssessment } from '../../src/lib/pronunciationAssessment';

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') return res.status(405).end();

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
    return res.status(500).json({ error: reviewError.message });
  }

  if (!review) {
    return res.status(404).json({ error: 'Revisão não encontrada.' });
  }

  const { data: row, error: assessmentError } = await supabase
    .from('pronunciation_assessments')
    .select('*')
    .eq('text_version_id', textVersionId)
    .eq('user_id', userId)
    .maybeSingle();

  if (assessmentError) {
    return res.status(500).json({ error: assessmentError.message });
  }

  const assessment = row ? rowToAssessment(row as Record<string, unknown>) : null;
  return res.json(buildStatusResponse(assessment));
}
