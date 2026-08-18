// Internal endpoint authentication for cron jobs and internal workers.
// Vercel automatically adds Authorization: Bearer {CRON_SECRET} to cron requests.

import { safeCompare } from '../_helpers';

export function checkCronAuth(req: { headers: Record<string, string | undefined> }): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers['authorization'] ?? '';
  return safeCompare(auth, `Bearer ${secret}`);
}
