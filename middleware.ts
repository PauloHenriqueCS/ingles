import { next } from '@vercel/functions';
import { getProductConfig, isWithinConfiguredWindow, resolveConfigEnvironment } from './src/server/product-config';

/**
 * CORS for the packaged mobile app only. The web app is same-origin with
 * /api/* and never hits this — these are the two Capacitor WebView origins
 * (Android today, iOS when that platform ships), never a wildcard, since
 * these endpoints receive the Supabase Authorization bearer token.
 */
const ALLOWED_NATIVE_ORIGINS = new Set([
  'https://localhost',    // Capacitor Android
  'capacitor://localhost', // Capacitor iOS
]);

function corsHeadersFor(origin: string | null): Record<string, string> | null {
  if (!origin || !ALLOWED_NATIVE_ORIGINS.has(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

// maintenance.mode (Central de Configuração) is separate from the AI
// kill switch (api/_ai-gateway/kill-switch.ts) — this blocks
// product/infrastructure access, that blocks AI calls by runtime policy.
// Cron/internal routes and the config-read endpoint itself must always stay
// reachable, or the frontend could never learn the maintenance state and
// scheduled jobs would stall for an unrelated, user-facing reason.
const ALWAYS_ALLOWED_PATHS = new Set(['/api/config/public']);

function isExemptFromMaintenance(pathname: string): boolean {
  return pathname.startsWith('/api/internal/') || ALWAYS_ALLOWED_PATHS.has(pathname);
}

// Reads the `sub` claim without verifying the signature — used only to
// decide whether to let a request past the maintenance block, never to
// grant any actual access. The route behind it still runs its own real
// auth (signature-verified) independently, so a forged token here only
// ever downgrades a 503 into whatever that route's real auth check
// returns, never into unauthorized access.
function decodeJwtSubUnverified(authHeader: string | null): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length);
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    return typeof payload?.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

async function buildMaintenanceBlockResponse(request: Request, pathname: string, cors: Record<string, string> | null): Promise<Response | null> {
  if (isExemptFromMaintenance(pathname)) return null;

  let config;
  try {
    config = await getProductConfig(resolveConfigEnvironment());
  } catch {
    return null; // never block the app because the config read itself failed
  }

  const maintenance = config.values['maintenance.mode'];
  if (maintenance.mode === 'off' || maintenance.mode === 'banner') return null;
  if (!isWithinConfiguredWindow(maintenance.startsAt, maintenance.endsAt)) return null;

  const method = request.method.toUpperCase();
  const isMutating = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
  const blocks = maintenance.mode === 'unavailable' || (maintenance.mode === 'read_only' && isMutating);
  if (!blocks) return null;

  if (maintenance.allowedAdminUserIds.length > 0) {
    const sub = decodeJwtSubUnverified(request.headers.get('authorization'));
    if (sub && maintenance.allowedAdminUserIds.includes(sub)) return null;
  }

  const body = JSON.stringify({
    code: 'MAINTENANCE_MODE',
    mode: maintenance.mode,
    title: maintenance.title || 'Manutenção em andamento',
    message: maintenance.message || 'O aplicativo está temporariamente indisponível. Tente novamente em breve.',
    statusUrl: maintenance.statusUrl,
  });
  return new Response(body, {
    status: 503,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '60', ...(cors ?? {}) },
  });
}

export default async function middleware(request: Request): Promise<Response> {
  const cors = corsHeadersFor(request.headers.get('origin'));

  // Preflight never reaches the function — most routes 405 on OPTIONS.
  if (request.method === 'OPTIONS' && cors) {
    return new Response(null, { status: 204, headers: cors });
  }

  const pathname = new URL(request.url).pathname;
  const maintenanceBlock = await buildMaintenanceBlockResponse(request, pathname, cors);
  if (maintenanceBlock) return maintenanceBlock;

  if (!cors) return next();
  return next({ headers: cors });
}

export const config = {
  matcher: '/api/:path*',
};
