/**
 * SERVER-ONLY: pure resolution logic for one capability's value given the
 * plan's configured plan_capability_values rows and the user's active
 * user_capability_overrides rows. No I/O — the caller fetches the rows.
 *
 * Fail-open rule: when NEITHER the plan nor an override configures a key at
 * all, it resolves as enabled/unlimited rather than blocked. This mirrors
 * the existing precedent in api/_ai-gateway/entitlements.ts ("defaults novos
 * devem ser ilimitados para não bloquear usuários existentes") — required
 * here too, since today no real plan has these new keys configured yet and
 * writing/listening/pronunciation must keep working exactly as before until
 * an admin explicitly sets a limit in a new plan draft.
 */

export interface CapabilityValueRow {
  capability_key: string;
  value: unknown;
}

export interface CapabilityOverrideRow {
  capability_key: string;
  operation: 'add' | 'replace' | 'unlimited' | 'disable';
  value: unknown;
}

export function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function findRow(rows: CapabilityValueRow[], key: string): CapabilityValueRow | undefined {
  return rows.find((r) => r.capability_key === key);
}

function findOverride(rows: CapabilityOverrideRow[], key: string): CapabilityOverrideRow | undefined {
  return rows.find((r) => r.capability_key === key);
}

export function resolveEnabledFlag(
  key: string,
  planRows: CapabilityValueRow[],
  overrideRows: CapabilityOverrideRow[],
): boolean {
  const override = findOverride(overrideRows, key);
  if (override) {
    if (override.operation === 'disable') return false;
    if (override.operation === 'unlimited') return true;
    if (override.operation === 'replace') return Boolean(override.value);
    // 'add' does not apply to a boolean flag — ignored.
  }

  const row = findRow(planRows, key);
  if (row) return Boolean(row.value);

  return true; // unconfigured -> fail-open
}

export interface ResolvedNumericLimit {
  limit: number;
  unlimited: boolean;
}

export function resolveNumericLimit(
  baseKey: string,
  unlimitedKey: string,
  planRows: CapabilityValueRow[],
  overrideRows: CapabilityOverrideRow[],
): ResolvedNumericLimit {
  const override = findOverride(overrideRows, baseKey);
  if (override?.operation === 'unlimited') return { limit: 0, unlimited: true };
  if (override?.operation === 'disable') return { limit: 0, unlimited: false };

  const baseRow = findRow(planRows, baseKey);
  const unlimitedRow = findRow(planRows, unlimitedKey);
  const baseConfigured = baseRow !== undefined;
  const unlimitedConfigured = unlimitedRow !== undefined;

  let limit = baseConfigured ? (toNumberOrNull(baseRow!.value) ?? 0) : 0;
  let unlimited = unlimitedConfigured ? Boolean(unlimitedRow!.value) : false;

  if (override?.operation === 'replace') {
    limit = toNumberOrNull(override.value) ?? limit;
    unlimited = false;
  } else if (override?.operation === 'add') {
    limit = limit + (toNumberOrNull(override.value) ?? 0);
  }

  if (!baseConfigured && !unlimitedConfigured && !override) {
    unlimited = true;
  }

  return { limit, unlimited };
}
