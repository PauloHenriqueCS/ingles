/**
 * SERVER-ONLY, deterministic copy for behavioral push. NO AI — push text must
 * be deterministic and free (spec). Language follows the user's server-side
 * interface language (user_curriculum_preferences.interface_language); anything
 * that is not Portuguese falls back to English.
 *
 * Tone rules (abandonment): no guilt, no threat, no "you're behind / you
 * failed", no count of missing activities. Just a warm nudge to come back.
 */

import type { BehavioralPushType } from './behavioralPushDomain';

export type PushLanguage = 'pt' | 'en';

export interface PushCopy {
  title: string;
  body: string;
  /** Stable identifier of the exact copy used, persisted for analytics
   *  (e.g. "streak_risk.pt.v1"). Bump the suffix when wording changes. */
  variant: string;
}

const COPY_VERSION = 'v1';

/** Normalize an interface-language code (pt-BR, pt, en-US, en, …) to 'pt'|'en'. */
export function resolvePushLanguage(interfaceLanguage: string | null | undefined): PushLanguage {
  const code = (interfaceLanguage ?? '').trim().toLowerCase();
  return code.startsWith('pt') ? 'pt' : 'en';
}

export interface BuildCopyParams {
  pushType: BehavioralPushType;
  language: PushLanguage;
  /** Current streak length — only used by streak_risk copy. */
  streak: number;
}

export function buildBehavioralPushCopy(params: BuildCopyParams): PushCopy {
  const { pushType, language, streak } = params;

  if (pushType === 'streak_risk') {
    const n = Math.max(1, Math.trunc(streak));
    if (language === 'pt') {
      // Singular/plural: "1 dia" vs "N dias".
      const dias = n === 1 ? '1 dia' : `${n} dias`;
      return {
        title: 'Sua sequência está em risco 🔥',
        body: `Você chegou a ${dias}. Faça uma atividade hoje para manter sua sequência.`,
        variant: `streak_risk.pt.${COPY_VERSION}`,
      };
    }
    // English: "1-day streak" vs "N-day streak" (the noun "day" stays singular
    // in the compound modifier, which reads correctly for any N).
    return {
      title: 'Your streak is at risk 🔥',
      body: `You're on a ${n}-day streak. Complete one activity today to keep it going.`,
      variant: `streak_risk.en.${COPY_VERSION}`,
    };
  }

  // abandonment
  if (language === 'pt') {
    return {
      title: 'Que tal retomar hoje?',
      body: 'Faz alguns dias desde sua última prática. Continue de onde parou.',
      variant: `abandonment.pt.${COPY_VERSION}`,
    };
  }
  return {
    title: 'Ready to practice again?',
    body: "It's been a few days since your last practice. Pick up where you left off.",
    variant: `abandonment.en.${COPY_VERSION}`,
  };
}
