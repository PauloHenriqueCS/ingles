/**
 * Pure, testable logic for the Home practice cards: per-activity availability
 * state, the compact badge shown on each row, and which activity is the current
 * recommendation. NO React, NO data fetching — it takes the already-fetched
 * entitlements snapshot + public config and returns plain values. This is the
 * single place the Home decides "available / limit reached / blocked" so the UI
 * components stay dumb.
 *
 * All quota numbers come from the server-resolved entitlements snapshot — never
 * from local state and never hardcoded per-plan limits.
 */
import type { PlanEntitlementsSnapshot } from '../../domain/entitlements/entitlement-types';
import type { PublicConfigValues } from '../../hooks/usePublicConfig';
import { deriveMinuteBalance } from '../../domain/conversation/minute-balance';
import type { HomeUiStrings } from '../../i18n/homeUiStrings';

export type CardVisualState =
  | 'loading'
  | 'available'
  | 'disabled_by_plan'
  | 'disabled_globally'
  | 'limit_reached';

export type BadgeTone = 'positive' | 'warning' | 'muted';

export interface PracticeBadge {
  label: string;
  tone: BadgeTone;
}

/** The four curricular activities that can be the "recommended" hero. */
export type CurricularActivityKey = 'writing' | 'conversation' | 'listening' | 'pronunciation';

function isExhausted(state: string): boolean {
  return state === 'daily_limit_reached' || state === 'monthly_limit_reached' || state === 'trial_balance_exhausted';
}

/**
 * Label for a `limit_reached` badge. Conversation is a special case: its
 * exhaustion is ALWAYS a zero minute BALANCE (monthly or trial — it has no
 * daily period), so it must read "Sem minutos", never "Limite de hoje" (which
 * would wrongly imply it resets tomorrow). Every other activity is a genuine
 * daily cap and keeps "Limite de hoje". Shared by the secondary rows and the
 * hero so both stay consistent.
 */
export function limitReachedBadgeLabel(key: CurricularActivityKey, s: HomeUiStrings): string {
  return key === 'conversation' ? s.noMinutes : s.limitReached;
}

// Central de Configuração's global on/off (checked first, distinct from the
// per-plan gate) — an admin-wide switch, not a plan capability.
function globallyDisabled(flag: { enabled: boolean } | undefined): boolean {
  return flag !== undefined && flag.enabled === false;
}

export function writingCardState(e: PlanEntitlementsSnapshot | null, config: PublicConfigValues | null): CardVisualState {
  if (!e) return 'loading';
  if (globallyDisabled(config?.['features.writing'])) return 'disabled_globally';
  if (!e.writing.enabled) return 'disabled_by_plan';
  const genExhausted = isExhausted(e.writing.themeGenerations.state);
  const reviewsExhausted = isExhausted(e.writing.reviews.state);
  return genExhausted && reviewsExhausted ? 'limit_reached' : 'available';
}

export function conversationCardState(e: PlanEntitlementsSnapshot | null, config: PublicConfigValues | null): CardVisualState {
  if (!e) return 'loading';
  if (globallyDisabled(config?.['features.conversation'])) return 'disabled_globally';
  if (!e.conversation.enabled) return 'disabled_by_plan';
  return isExhausted(e.conversation.monthlyTime.state) ? 'limit_reached' : 'available';
}

export function listeningCardState(e: PlanEntitlementsSnapshot | null, config: PublicConfigValues | null): CardVisualState {
  if (!e) return 'loading';
  if (globallyDisabled(config?.['features.listening'])) return 'disabled_globally';
  if (!e.listening.enabled) return 'disabled_by_plan';
  return isExhausted(e.listening.stories.state) ? 'limit_reached' : 'available';
}

export function pronunciationCardState(e: PlanEntitlementsSnapshot | null, config: PublicConfigValues | null): CardVisualState {
  if (!e) return 'loading';
  if (globallyDisabled(config?.['features.pronunciation'])) return 'disabled_globally';
  if (!e.pronunciation.enabled) return 'disabled_by_plan';
  return isExhausted(e.pronunciation.evaluations.state) ? 'limit_reached' : 'available';
}

export function activityState(
  key: CurricularActivityKey,
  e: PlanEntitlementsSnapshot | null,
  config: PublicConfigValues | null,
): CardVisualState {
  switch (key) {
    case 'writing': return writingCardState(e, config);
    case 'conversation': return conversationCardState(e, config);
    case 'listening': return listeningCardState(e, config);
    case 'pronunciation': return pronunciationCardState(e, config);
  }
}

/** Whole remaining conversation minutes (plan + purchased extra), floored but
 *  never rounding a positive remainder down to 0. */
export function conversationMinutesRemaining(e: PlanEntitlementsSnapshot): number {
  const m = e.conversation.monthlyTime;
  const bal = deriveMinuteBalance(m.limit, m.consumed, m.unlimited, e.conversation.extraSecondsAvailable);
  const sec = bal.totalRemainingSeconds;
  return sec > 0 ? Math.max(1, Math.floor(sec / 60)) : 0;
}

/**
 * Compact badge for a secondary practice row. Returns null when there's nothing
 * useful/honest to show (e.g. still loading, or an available activity whose
 * remaining count we don't surface). Blocked/exhausted states always produce a
 * muted/warning badge so a blocked activity never looks normally available.
 */
export function secondaryBadge(
  key: CurricularActivityKey,
  state: CardVisualState,
  e: PlanEntitlementsSnapshot | null,
  s: HomeUiStrings,
): PracticeBadge | null {
  if (state === 'loading') return null;
  if (state === 'disabled_by_plan') return { label: s.notInPlan, tone: 'muted' };
  if (state === 'disabled_globally') return { label: s.featureUnavailable, tone: 'muted' };
  if (state === 'limit_reached') return { label: limitReachedBadgeLabel(key, s), tone: 'warning' };
  if (!e) return null;

  // available → surface the real remaining balance when it's finite.
  switch (key) {
    case 'conversation': {
      if (e.conversation.monthlyTime.unlimited && e.conversation.extraSecondsAvailable <= 0) {
        return { label: s.unlimited, tone: 'positive' };
      }
      return { label: s.minutesRemaining(conversationMinutesRemaining(e)), tone: 'positive' };
    }
    case 'listening': {
      const l = e.listening.stories;
      if (l.unlimited) return { label: s.unlimited, tone: 'positive' };
      return { label: s.remainingCount(Math.max(0, l.remaining)), tone: 'positive' };
    }
    case 'pronunciation': {
      const p = e.pronunciation.evaluations;
      if (p.unlimited) return { label: s.unlimited, tone: 'positive' };
      return { label: s.remainingCount(Math.max(0, p.remaining)), tone: 'positive' };
    }
    case 'writing':
      return null; // writing is the hero, badged separately
  }
}

/**
 * The recommended practice for the hero card. Today the pedagogical primary flow
 * is Writing + voice, so it leads — but this is resolved through a single
 * function (never hardcoded at the call site) so a future curriculum-engine
 * recommendation can slot in here. If the primary is blocked/exhausted we fall
 * back to the next curricular activity that is actually startable, so the hero
 * never recommends something the user can't begin. When nothing is clearly
 * available we still return the primary and let the card show its real state.
 */
export const RECOMMENDATION_PRIORITY: CurricularActivityKey[] = ['writing', 'conversation', 'listening', 'pronunciation'];

export function resolveRecommendedActivity(
  e: PlanEntitlementsSnapshot | null,
  config: PublicConfigValues | null,
): CurricularActivityKey {
  for (const key of RECOMMENDATION_PRIORITY) {
    if (activityState(key, e, config) === 'available') return key;
  }
  return 'writing';
}
