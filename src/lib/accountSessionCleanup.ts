import { supabase } from './supabase';

export type AccountSessionNoticeKind = 'deleted' | 'blocked';

const NOTICE_KEY = 'lemon.accountSessionNotice';

function setNotice(kind: AccountSessionNoticeKind): void {
  try { sessionStorage.setItem(NOTICE_KEY, kind); } catch { /* storage unavailable — non-fatal */ }
}

/** Reads and clears the pending notice, if any. Call once on the login
 *  screen so the message shows exactly once, right after the redirect. */
export function consumeAccountSessionNotice(): AccountSessionNoticeKind | null {
  try {
    const value = sessionStorage.getItem(NOTICE_KEY);
    if (value !== 'deleted' && value !== 'blocked') return null;
    sessionStorage.removeItem(NOTICE_KEY);
    return value;
  } catch {
    return null;
  }
}

async function clearPrivateCaches(): Promise<void> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const userId = session?.user?.id;
    if (userId) localStorage.removeItem(`english-calendar-entries-v2-${userId}`);
  } catch {
    // Best-effort cache cleanup only — sign-out below is what actually ends
    // the session regardless of whether this succeeds.
  }
}

/** Call right after the user's own "Excluir minha conta" action succeeds. */
export async function endSessionAfterAccountDeletion(): Promise<void> {
  await clearPrivateCaches();
  setNotice('deleted');
  await supabase.auth.signOut();
}

/** Call when any authenticated request comes back ACCOUNT_DEACTIVATED — this
 *  session is still open on an account that is deactivated (another device,
 *  or a previous deletion that outlived this tab's still-valid token). */
export async function endSessionAfterAccountBlocked(): Promise<void> {
  await clearPrivateCaches();
  setNotice('blocked');
  await supabase.auth.signOut();
}
