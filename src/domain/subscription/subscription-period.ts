/**
 * Turns a store-provided subscription period (RevenueCat
 * PurchasesStoreProduct.subscriptionPeriod, ISO-8601 e.g. "P1M", "P1Y") into a
 * short Portuguese billing-cycle label for the paywall — the "duration" the App
 * Store Guideline 3.1.2(c) requires next to the price.
 *
 * The STORE is the source of truth: whenever the native offering exposes a
 * period, that value drives the label. This never hardcodes a period; the
 * caller supplies a fallback (used only on web / before the offering loads,
 * where no store period exists). Returns null for an unrecognized/empty input
 * so the caller can fall back deliberately.
 *
 * Label is the suffix shown after "R$ 34,90 /", i.e. "mês", "ano", "3 meses".
 */
export function formatBillingPeriodPtBr(isoPeriod: string | null | undefined): string | null {
  if (!isoPeriod) return null;
  const match = /^P(\d+)([DWMY])$/.exec(isoPeriod.trim().toUpperCase());
  if (!match) return null;
  const count = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(count) || count < 1) return null;

  const singular: Record<string, string> = { D: 'dia', W: 'semana', M: 'mês', Y: 'ano' };
  const plural: Record<string, string> = { D: 'dias', W: 'semanas', M: 'meses', Y: 'anos' };

  if (count === 1) return singular[unit] ?? null;
  const word = plural[unit];
  return word ? `${count} ${word}` : null;
}
