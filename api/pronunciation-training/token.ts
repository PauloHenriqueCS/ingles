import { requireAuth } from '../_auth';
import { methodGuard, jsonError } from '../_helpers';
import { issueAzureSpeechToken, AzureSpeechError } from '../_azure-speech';

const AZURE_ERROR_STATUS: Partial<Record<string, number>> = {
  AZURE_SPEECH_NOT_CONFIGURED: 503,
  AZURE_SPEECH_AUTH_FAILED:    503,
  AZURE_SPEECH_TIMEOUT:        504,
  AZURE_SPEECH_RATE_LIMITED:   503,
  AZURE_SPEECH_UNAVAILABLE:    503,
};

/**
 * POST /api/pronunciation-training/token
 *
 * Issues a short-lived Azure Speech token for the pronunciation training module.
 * No database writes — the training module is ephemeral (no progress saved).
 */
export default async function handler(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const { token, region, expiresInSeconds } = await issueAzureSpeechToken();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ token, region, expiresInSeconds });
  } catch (err) {
    if (err instanceof AzureSpeechError) {
      const status = AZURE_ERROR_STATUS[err.code] ?? 503;
      return jsonError(
        res,
        status,
        err.code,
        'Serviço de pronúncia temporariamente indisponível. Tente novamente.',
      );
    }
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno. Tente novamente.');
  }
}
