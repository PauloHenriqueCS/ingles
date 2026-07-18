/**
 * SERVER-ONLY: pure resolution logic for one capability's value given the
 * plan's configured plan_capability_values rows and the user's active
 * user_capability_overrides rows. No I/O — the caller fetches the rows and
 * is responsible for logging based on the returned `source`.
 *
 * Three possible outcomes, never conflated:
 *   - 'value': resolved from an explicit override or an explicit plan
 *     value. `unlimited` here only ever comes from an explicit config/override.
 *   - 'legacy_fallback': the plan version has NO entitlements configuration
 *     at all (a pre-existing plan/version that predates this system). Kept
 *     permissive so existing users are not broken, but the caller MUST log
 *     a structured legacy-fallback event.
 *   - 'config_error': the plan version DOES have some entitlements
 *     configured, but this specific capability key is missing from both the
 *     plan values and any override. This is a configuration bug, never
 *     unlimited — the caller must block the operation and alert.
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

export type EnabledFlagResolution =
  | { source: 'value' | 'legacy_fallback'; enabled: boolean }
  | { source: 'config_error' };

export type NumericLimitResolution =
  | { source: 'value' | 'legacy_fallback'; limit: number; unlimited: boolean }
  | { source: 'config_error' };

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
  hasAnyPlanConfiguration: boolean,
): EnabledFlagResolution {
  const override = findOverride(overrideRows, key);
  if (override) {
    if (override.operation === 'disable') return { source: 'value', enabled: false };
    if (override.operation === 'unlimited') return { source: 'value', enabled: true };
    if (override.operation === 'replace') return { source: 'value', enabled: Boolean(override.value) };
    // 'add' does not apply to a boolean flag — ignored.
  }

  const row = findRow(planRows, key);
  if (row) return { source: 'value', enabled: Boolean(row.value) };

  if (!hasAnyPlanConfiguration) return { source: 'legacy_fallback', enabled: true };
  return { source: 'config_error' };
}

export function resolveNumericLimit(
  baseKey: string,
  unlimitedKey: string,
  planRows: CapabilityValueRow[],
  overrideRows: CapabilityOverrideRow[],
  hasAnyPlanConfiguration: boolean,
): NumericLimitResolution {
  const override = findOverride(overrideRows, baseKey);

  if (override) {
    if (override.operation === 'unlimited') return { source: 'value', limit: 0, unlimited: true };
    if (override.operation === 'disable') return { source: 'value', limit: 0, unlimited: false };
    if (override.operation === 'replace') {
      return { source: 'value', limit: toNumberOrNull(override.value) ?? 0, unlimited: false };
    }
    // 'add' falls through below, applied on top of the resolved base.
  }

  const baseRow = findRow(planRows, baseKey);
  const unlimitedRow = findRow(planRows, unlimitedKey);
  const baseConfigured = baseRow !== undefined;
  const unlimitedTrue = unlimitedRow !== undefined && Boolean(unlimitedRow.value);

  // A capability is sufficiently configured when either a finite base value
  // is set, or it is explicitly marked unlimited — never inferred from
  // absence of both.
  if (!baseConfigured && !unlimitedTrue) {
    if (override?.operation === 'add') {
      // An active 'add' override is itself deliberate, explicit
      // configuration for this exact key — never fails open to unlimited,
      // and is not a config error even on an otherwise legacy plan version.
      return { source: 'value', limit: toNumberOrNull(override.value) ?? 0, unlimited: false };
    }
    if (!hasAnyPlanConfiguration) {
      return { source: 'legacy_fallback', limit: 0, unlimited: true };
    }
    return { source: 'config_error' };
  }

  const limit = baseConfigured ? (toNumberOrNull(baseRow!.value) ?? 0) : 0;
  const unlimited = unlimitedTrue;

  if (override?.operation === 'add' && !unlimited) {
    return { source: 'value', limit: limit + (toNumberOrNull(override.value) ?? 0), unlimited: false };
  }

  return { source: 'value', limit, unlimited };
}
