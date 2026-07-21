/**
 * Single source of truth for resolving `/api/*` paths to an absolute backend
 * origin. Web builds (no VITE_API_BASE_URL) keep same-origin relative paths
 * unchanged — this is a no-op there. Mobile builds set VITE_API_BASE_URL at
 * build time (see .env.mobile) because the packaged Capacitor WebView has no
 * same-origin server to resolve a relative path against.
 */

const RAW_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim();
const API_BASE = RAW_BASE ? RAW_BASE.replace(/\/+$/, '') : '';

function isAbsoluteUrl(path: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('//');
}

export function apiUrl(path: string): string {
  if (isAbsoluteUrl(path) || !API_BASE) return path;
  return `${API_BASE}/${path.replace(/^\/+/, '')}`;
}
