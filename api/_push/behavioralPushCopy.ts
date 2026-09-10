/**
 * SERVER-ONLY, deterministic copy for behavioral push. NO AI — push text must
 * be deterministic and free (spec).
 *
 * v2 (2026-09) — GLOBAL DAILY ROTATION. Every eligible user on the SAME
 * `local_date` receives the SAME copy; the next day rotates to the next copy;
 * after the last it wraps to the first. Selection is deterministic and
 * reproducible from `local_date` alone (epoch-day index modulo the list length)
 * — never random, never per-user. See docs/behavioral-push.md.
 *
 * The approved list is Portuguese (the product decision: one voice for everyone
 * this round). The legacy per-type builder below (streak_risk/abandonment) is
 * kept only for historical rows / analytics — it is no longer produced by the
 * sweep.
 */

import type { BehavioralPushType } from './behavioralPushDomain';

export type PushLanguage = 'pt' | 'en';

export interface PushCopy {
  title: string;
  body: string;
  /** Stable identifier of the exact copy used, persisted for analytics. */
  variant: string;
}

// ── v2: daily global rotation ────────────────────────────────────────────────

/** Version tag of the approved rotation. Bump when the LIST changes so the
 *  Dashboard can tell historical rotations apart. */
const DAILY_COPY_VERSION = 'v1';

/**
 * The approved rotation (owner-approved 2026-09-10). ORDER IS SIGNIFICANT — it
 * defines the day-over-day sequence. Tone is intentional (humor/drama); do NOT
 * soften, rewrite, or corporate-ise. Some lines mention "sequência" even though
 * the user may have streak 0 — approved as-is for this round (analysed later in
 * the Dashboard). Adding/removing/reordering entries changes what every user
 * sees on a given day → treat as a copy change (bump DAILY_COPY_VERSION).
 */
export const DAILY_PRACTICE_COPIES: ReadonlyArray<{ title: string; body: string }> = [
  { title: 'Não me abandonaaa 😭', body: 'Você tem 3 min pra salvar seu inglês hoje.' },
  { title: 'Você sumiu. Eu notei.', body: '3 min. Só isso que eu tô pedindo.' },
  { title: 'É sério que vai me ignorar?', body: 'Abre o Orodim por 3 min e eu paro de drama.' },
  { title: 'Sua sequência tá morrendo aqui 🔥', body: '3 min e você salva ela.' },
  { title: 'Eu ainda acredito em você.', body: 'Mas tenho exatamente 3 min de paciência.' },
  { title: 'VOLTA AQUI.', body: 'Seu inglês não vai praticar sozinho.' },
  { title: 'Última chance de hoje 👀', body: '3 min e sua sequência continua viva.' },
  { title: 'Você disse “amanhã” ontem.', body: 'Hoje são só 3 min.' },
  { title: 'Não faz isso comigo 😭', body: 'Uma prática. Três minutinhos. Fechou?' },
  { title: 'Seu inglês entrou em contato.', body: 'Ele quer saber por que você desapareceu.' },
  { title: 'Eu vi que você não praticou.', body: 'Não adianta fingir que não aconteceu.' },
  { title: 'Tá me evitando?', body: 'Abre o app. Eu prometo ser rápido.' },
  { title: 'A sequência pediu socorro.', body: 'Você ainda pode salvar ela hoje.' },
  { title: '3 minutos. Eu cronometro.', body: 'Vem praticar antes que eu fique dramático.' },
  { title: 'Hoje você não escapa.', body: 'Uma prática rápida e estamos quites.' },
] as const;

/** Number of whole days from the Unix epoch for a YYYY-MM-DD date (UTC-based,
 *  timezone-independent — the caller already resolved the São Paulo local
 *  date). Deterministic and monotonic: consecutive dates differ by exactly 1,
 *  so the rotation advances by one entry per day. */
function epochDayIndex(localDate: string): number {
  const [y, m, d] = localDate.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

/**
 * Pick the copy for a given São Paulo `local_date`. Deterministic and global:
 * the same date always yields the same copy, and every eligible user that day
 * gets exactly this one. Wraps around after the last entry.
 */
export function selectDailyPushCopy(localDate: string): PushCopy {
  const n = DAILY_PRACTICE_COPIES.length;
  const index = ((epochDayIndex(localDate) % n) + n) % n;
  const { title, body } = DAILY_PRACTICE_COPIES[index];
  // 1-based, zero-padded to 2 digits for stable sort/read in the Dashboard.
  const variant = `practice_reminder_behavioral.${DAILY_COPY_VERSION}.${String(index + 1).padStart(2, '0')}`;
  return { title, body, variant };
}

// ── Legacy per-type copy (streak_risk / abandonment) — historical only ───────

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

/**
 * LEGACY. Builds the old per-type copy. No longer called by the sweep (v2 uses
 * selectDailyPushCopy); retained for historical rows / analytics and covered by
 * existing tests. Only 'streak_risk' and 'abandonment' are handled.
 */
export function buildBehavioralPushCopy(params: BuildCopyParams): PushCopy {
  const { pushType, language, streak } = params;

  if (pushType === 'streak_risk') {
    const n = Math.max(1, Math.trunc(streak));
    if (language === 'pt') {
      const dias = n === 1 ? '1 dia' : `${n} dias`;
      return {
        title: 'Sua sequência está em risco 🔥',
        body: `Você chegou a ${dias}. Faça uma atividade hoje para manter sua sequência.`,
        variant: `streak_risk.pt.${COPY_VERSION}`,
      };
    }
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
