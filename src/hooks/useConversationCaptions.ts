import { useState, useCallback, useEffect } from 'react';
import { supabase } from '../lib/supabase';

const LS_PREFIX = 'conversation_captions_enabled';
const DEFAULT_ENABLED = true;

function lsKey(userId: string): string {
  return `${LS_PREFIX}_${userId}`;
}

function readLs(userId: string | null): boolean {
  if (!userId) return DEFAULT_ENABLED;
  try {
    const v = localStorage.getItem(lsKey(userId));
    return v === null ? DEFAULT_ENABLED : v === 'true';
  } catch {
    return DEFAULT_ENABLED;
  }
}

function writeLs(userId: string | null, enabled: boolean): void {
  if (!userId) return;
  try {
    localStorage.setItem(lsKey(userId), String(enabled));
  } catch { /* ignore */ }
}

export interface UseConversationCaptions {
  captionsEnabled: boolean;
  toggleCaptions: () => void;
}

export function useConversationCaptions(): UseConversationCaptions {
  const [userId, setUserId] = useState<string | null>(null);
  const [captionsEnabled, setCaptionsEnabled] = useState<boolean>(DEFAULT_ENABLED);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase.auth.getUser();
        if (cancelled) return;

        const id = data.user?.id ?? null;
        setUserId(id);

        // Apply localStorage immediately for fast UX
        setCaptionsEnabled(readLs(id));

        if (!id) return;

        // Load from DB to get the authoritative value
        try {
          const { data: row } = await supabase
            .from('ai_conversation_preferences')
            .select('captions_enabled')
            .maybeSingle();
          if (cancelled) return;
          const r = row as Record<string, unknown> | null;
          if (r && typeof r['captions_enabled'] === 'boolean') {
            const dbValue = r['captions_enabled'] as boolean;
            setCaptionsEnabled(dbValue);
            writeLs(id, dbValue);
          }
        } catch { /* keep localStorage value */ }
      } catch { /* keep default */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const toggleCaptions = useCallback(() => {
    setCaptionsEnabled((prev) => {
      const next = !prev;
      writeLs(userId, next);
      if (userId) {
        void (async () => {
          try {
            await supabase
              .from('ai_conversation_preferences')
              .upsert({ user_id: userId, captions_enabled: next }, { onConflict: 'user_id' });
          } catch { /* non-critical — preference already saved to localStorage */ }
        })();
      }
      return next;
    });
  }, [userId]);

  return { captionsEnabled, toggleCaptions };
}
