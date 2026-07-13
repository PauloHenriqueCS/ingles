/**
 * SERVER ONLY — never import this module from src/ or any client-side code.
 *
 * Reads AZURE_SPEECH_KEY and AZURE_SPEECH_REGION from process.env.
 * These variables have no VITE_ prefix, so Vite never exposes them in the browser bundle.
 */

const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

// ── Error type ────────────────────────────────────────────────────────────────

export type AzureErrorCode =
  | 'AZURE_SPEECH_NOT_CONFIGURED'
  | 'AZURE_SPEECH_AUTH_FAILED'
  | 'AZURE_SPEECH_TIMEOUT'
  | 'AZURE_SPEECH_RATE_LIMITED'
  | 'AZURE_SPEECH_UNAVAILABLE';

export class AzureSpeechError extends Error {
  constructor(
    public readonly code: AzureErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AzureSpeechError';
  }
}

// ── Internal config ───────────────────────────────────────────────────────────

interface AzureSpeechConfig {
  key: string;
  region: string;
  tokenEndpoint: string;
}

function getAzureSpeechConfig(): AzureSpeechConfig {
  const key = (process.env.AZURE_SPEECH_KEY ?? '').trim();
  const region = (process.env.AZURE_SPEECH_REGION ?? '').trim();

  if (!key) {
    throw new AzureSpeechError('AZURE_SPEECH_NOT_CONFIGURED', 'AZURE_SPEECH_KEY is not configured');
  }
  if (!region) {
    throw new AzureSpeechError('AZURE_SPEECH_NOT_CONFIGURED', 'AZURE_SPEECH_REGION is not configured');
  }
  // Reject regions with spaces or characters clearly outside Azure naming conventions
  if (!/^[a-z0-9-]+$/.test(region)) {
    throw new AzureSpeechError('AZURE_SPEECH_NOT_CONFIGURED', 'AZURE_SPEECH_REGION has an invalid format');
  }

  const tokenEndpoint = `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;

  return { key, region, tokenEndpoint };
}

// ── Token issuance ────────────────────────────────────────────────────────────

export interface AzureSpeechTokenResult {
  token: string;
  region: string;
  expiresInSeconds: number;
}

export async function issueAzureSpeechToken(): Promise<AzureSpeechTokenResult> {
  const config = getAzureSpeechConfig();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(config.tokenEndpoint, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': config.key },
      body: '',
      signal: controller.signal,
    });
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    if (isAbort) {
      throw new AzureSpeechError('AZURE_SPEECH_TIMEOUT', 'Request to Azure Speech timed out');
    }
    throw new AzureSpeechError('AZURE_SPEECH_UNAVAILABLE', 'Could not reach Azure Speech service');
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    console.error(`[azure-speech] Auth rejected by Azure: HTTP ${response.status}, region=${config.region}`);
    throw new AzureSpeechError('AZURE_SPEECH_AUTH_FAILED', `Azure rejected credentials: HTTP ${response.status}`);
  }
  if (response.status === 429) {
    console.error(`[azure-speech] Rate limited by Azure, region=${config.region}`);
    throw new AzureSpeechError('AZURE_SPEECH_RATE_LIMITED', 'Azure Speech rate limit exceeded');
  }
  if (!response.ok) {
    console.error(`[azure-speech] Unexpected status from Azure: HTTP ${response.status}, region=${config.region}`);
    throw new AzureSpeechError('AZURE_SPEECH_UNAVAILABLE', `Azure Speech returned HTTP ${response.status}`);
  }

  const token = await response.text();
  if (!token.trim()) {
    console.error(`[azure-speech] Azure returned empty token, region=${config.region}`);
    throw new AzureSpeechError('AZURE_SPEECH_UNAVAILABLE', 'Azure Speech returned an empty token');
  }

  return {
    token,
    region: config.region,
    expiresInSeconds: 540, // conservative: Azure tokens expire after 600 s
  };
}
