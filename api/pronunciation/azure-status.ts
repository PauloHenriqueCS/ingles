import { requireAuth } from '../_auth';
import { issueAzureSpeechToken, AzureSpeechError } from '../_azure-speech';
import { methodGuard } from '../_helpers';

const ERROR_MESSAGES: Record<string, string> = {
  AZURE_SPEECH_NOT_CONFIGURED: 'O serviço de pronúncia ainda não está configurado.',
  AZURE_SPEECH_AUTH_FAILED: 'Não foi possível autenticar o serviço de pronúncia.',
  AZURE_SPEECH_TIMEOUT: 'O serviço de pronúncia demorou para responder.',
  AZURE_SPEECH_RATE_LIMITED: 'O serviço de pronúncia está temporariamente indisponível.',
  AZURE_SPEECH_UNAVAILABLE: 'O serviço de pronúncia está temporariamente indisponível.',
};

const ERROR_STATUS: Record<string, number> = {
  AZURE_SPEECH_NOT_CONFIGURED: 503,
  AZURE_SPEECH_AUTH_FAILED: 503,
  AZURE_SPEECH_TIMEOUT: 504,
  AZURE_SPEECH_RATE_LIMITED: 503,
  AZURE_SPEECH_UNAVAILABLE: 503,
};

export default async function handler(req: any, res: any) {
  if (!methodGuard(req, res, ['GET'])) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const { region } = await issueAzureSpeechToken();
    // Token is immediately discarded — never returned to the client

    return res.status(200).json({
      configured: true,
      service: 'azure-speech',
      region,
    });
  } catch (err) {
    if (err instanceof AzureSpeechError) {
      return res.status(ERROR_STATUS[err.code] ?? 503).json({
        configured: false,
        code: err.code,
        message: ERROR_MESSAGES[err.code] ?? ERROR_MESSAGES.AZURE_SPEECH_UNAVAILABLE,
      });
    }

    console.error('[azure-status] Unexpected error:', err instanceof Error ? err.message : 'unknown');
    return res.status(503).json({
      configured: false,
      code: 'AZURE_SPEECH_UNAVAILABLE',
      message: ERROR_MESSAGES.AZURE_SPEECH_UNAVAILABLE,
    });
  }
}
