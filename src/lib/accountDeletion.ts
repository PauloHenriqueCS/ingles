import { getAuthHeader } from './apiAuth';
import { apiUrl } from './apiUrl';

export type DeactivateAccountErrorCode =
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'ACCOUNT_DEACTIVATED'
  | 'INTERNAL_ERROR'
  | 'NETWORK_ERROR';

export class DeactivateAccountError extends Error {
  constructor(readonly code: DeactivateAccountErrorCode, message: string) {
    super(message);
  }
}

export interface DeactivateAccountResponse {
  success: true;
  status: 'deactivated';
}

const GENERIC_FAILURE_MESSAGE = 'Não foi possível concluir a exclusão da conta. Tente novamente.';

/** Calls POST /api/account/deactivate. The backend identifies the account
 *  solely from the session token — no user identifier is ever sent here. */
export async function deactivateAccount(): Promise<DeactivateAccountResponse> {
  const authHeader = await getAuthHeader();
  if (!authHeader.Authorization) {
    throw new DeactivateAccountError('UNAUTHORIZED', 'Sessão expirada. Faça login novamente.');
  }

  let res: Response;
  try {
    res = await fetch(apiUrl('/api/account/deactivate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
    });
  } catch {
    throw new DeactivateAccountError('NETWORK_ERROR', 'Não foi possível conectar. Verifique sua internet e tente novamente.');
  }

  let body: any = null;
  try { body = await res.json(); } catch { /* no/invalid JSON body */ }

  if (!res.ok) {
    const code: DeactivateAccountErrorCode =
      body?.code === 'RATE_LIMITED' ? 'RATE_LIMITED'
      : body?.code === 'ACCOUNT_DEACTIVATED' ? 'ACCOUNT_DEACTIVATED'
      : res.status === 401 ? 'UNAUTHORIZED'
      : 'INTERNAL_ERROR';
    throw new DeactivateAccountError(code, body?.message ?? GENERIC_FAILURE_MESSAGE);
  }

  if (body?.success !== true || body?.status !== 'deactivated') {
    throw new DeactivateAccountError('INTERNAL_ERROR', GENERIC_FAILURE_MESSAGE);
  }

  return body as DeactivateAccountResponse;
}
