/**
 * SERVER-ONLY: the one place "is this event sandbox, and are we allowed to
 * apply it" is decided — shared by the subscription sync and minute-credit
 * services so the rule can never drift between the two.
 */

export function isSandboxEnvironment(environment: string): boolean {
  return environment.trim().toUpperCase() === 'SANDBOX';
}

/** Vercel's own built-in env var — never a new one to invent/misconfigure.
 *  Undefined in every non-Vercel-production context (including this task's
 *  homologation deploys), so this only ever actually blocks something once
 *  this code runs in the real production project. */
export function isProductionDeployment(): boolean {
  return process.env.VERCEL_ENV === 'production';
}

/** "evento sandbox nunca pode alterar produção" — decided by THIS
 *  deployment's own environment, never by trusting the event alone. */
export function isSandboxBlockedHere(environment: string): boolean {
  return isProductionDeployment() && isSandboxEnvironment(environment);
}
