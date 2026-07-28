/** "R$ 34,90" — cents to BRL currency string. */
export function formatPriceBRL(priceCents: number): string {
  return (priceCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** "R$ 34,90/mês". */
export function formatPriceBRLPerMonth(priceCents: number): string {
  return `${formatPriceBRL(priceCents)}/mês`;
}

/** Whole days between `now` and `endsAt`, floored at 0 — never negative, never fractional. */
export function computeDaysRemaining(endsAtIso: string, now: Date = new Date()): number {
  const msRemaining = new Date(endsAtIso).getTime() - now.getTime();
  return Math.max(0, Math.ceil(msRemaining / (24 * 60 * 60 * 1000)));
}

/** "7 dias restantes" / "1 dia restante" / "Último dia". */
export function formatTrialDaysRemainingLabel(days: number): string {
  const d = Math.max(0, Math.floor(days));
  if (d === 0) return 'Último dia';
  if (d === 1) return '1 dia restante';
  return `${d} dias restantes`;
}

/** "27 de julho de 2026" — long pt-BR date, for "termina em" / "acesso até" labels. */
export function formatDatePtBr(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
}
