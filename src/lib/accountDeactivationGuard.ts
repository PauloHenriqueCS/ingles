import { endSessionAfterAccountBlocked } from './accountSessionCleanup';

let installed = false;
let handling = false;

function isAccountDeactivatedBody(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as { code?: unknown }).code === 'ACCOUNT_DEACTIVATED';
}

async function handleBlocked(): Promise<void> {
  if (handling) return;
  handling = true;
  try {
    await endSessionAfterAccountBlocked();
  } finally {
    handling = false;
  }
}

/**
 * Installs a one-time global fetch interceptor that watches every response
 * for the backend's ACCOUNT_DEACTIVATED signal (api/_auth.ts's requireAuth)
 * and signs the session out immediately, regardless of which screen or hook
 * made the call. The backend gate is authoritative — this is just the
 * frontend reacting to it everywhere, instead of requiring every one of the
 * app's many fetch call sites to check for it individually.
 */
export function installAccountDeactivationGuard(): void {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof window.fetch>) => {
    const response = await originalFetch(...args);
    if (response.status === 403) {
      response
        .clone()
        .json()
        .then((body) => { if (isAccountDeactivatedBody(body)) void handleBlocked(); })
        .catch(() => { /* non-JSON or empty 403 body — not our signal */ });
    }
    return response;
  };
}
