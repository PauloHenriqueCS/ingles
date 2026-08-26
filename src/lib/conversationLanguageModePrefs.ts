/**
 * Persistence of the user's LAST conversation language-mode choice, so the next
 * Conversation pre-selects it. Stored on ai_conversation_preferences (the same
 * user-level, browser-written tutor-prefs row) — cross-device and data-driven,
 * never localStorage. A trigger fills user_id on insert, so a partial upsert is
 * safe even before the row exists; RLS restricts it to the caller's own row.
 *
 * This is only the pre-selection hint. The choice is ALSO frozen server-side on
 * each session's authorization row (the authoritative per-session record); this
 * table just remembers the latest pick. Every failure is swallowed: remembering
 * the last choice must never block starting a conversation.
 */
import { supabase } from './supabase';
import { isConversationLanguageMode, type ConversationLanguageMode } from '../domain/conversation/conversationLanguageMode';

/** Reads the user's last chosen language mode, or null if none/unavailable. */
export async function loadLastConversationLanguageMode(): Promise<ConversationLanguageMode | null> {
  try {
    const { data, error } = await supabase
      .from('ai_conversation_preferences')
      .select('conversation_language_mode')
      .maybeSingle();
    if (error) return null;
    const value = (data as { conversation_language_mode?: unknown } | null)?.conversation_language_mode;
    return isConversationLanguageMode(value) ? value : null;
  } catch {
    return null;
  }
}

/** Persists the user's latest language-mode choice (fire-and-forget, fail-safe). */
export async function saveLastConversationLanguageMode(mode: ConversationLanguageMode): Promise<void> {
  try {
    await supabase
      .from('ai_conversation_preferences')
      .upsert({ conversation_language_mode: mode }, { onConflict: 'user_id' });
  } catch {
    /* remembering the choice is best-effort — never block the session */
  }
}
