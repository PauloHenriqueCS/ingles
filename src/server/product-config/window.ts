// Shared by the maintenance-mode check (middleware.ts) and the per-feature
// global gates: an enabled/disabled state can be scoped to a startsAt/endsAt
// window; outside it, the state reverts to its default (not blocking).
export function isWithinConfiguredWindow(startsAt: string | null, endsAt: string | null, now: number = Date.now()): boolean {
  if (startsAt) {
    const start = Date.parse(startsAt);
    if (!Number.isNaN(start) && now < start) return false;
  }
  if (endsAt) {
    const end = Date.parse(endsAt);
    if (!Number.isNaN(end) && now > end) return false;
  }
  return true;
}
