// SERVER-ONLY: server-to-server auth for the internal product-config status
// endpoint. Same Bearer-header shape as api/internal/_auth.ts's
// checkCronAuth, but a dedicated secret — the caller here is the dashboard,
// a different identity than Vercel's own cron trigger.

export function checkProductConfigStatusAuth(req: { headers: Record<string, string | undefined> }): boolean {
  const secret = process.env.PRODUCT_CONFIG_STATUS_SECRET;
  if (!secret) return false;
  const auth = req.headers['authorization'] ?? '';
  return auth === `Bearer ${secret}`;
}
