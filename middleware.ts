import { next } from '@vercel/functions';

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

export default function middleware(request: Request) {
  const cors = corsHeadersFor(request.headers.get('origin'));
  if (!cors) return next();

  // Preflight never reaches the function — most routes 405 on OPTIONS.
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  return next({ headers: cors });
}

export const config = {
  matcher: '/api/:path*',
};
