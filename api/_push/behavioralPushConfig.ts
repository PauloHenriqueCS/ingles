/**
 * SERVER-ONLY resolution helpers for behavioral push: the real-send gate and
 * the per-user interface-language lookup. Env getters themselves live in
 * api/_env.ts (readEnv-based, fail-closed).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface SendGateConfig {
  enabled: boolean;
  dryRun: boolean;
  testUserIds: Set<string>;
  appId: string;
  restApiKey: string;
}

/**
 * Whether a REAL OneSignal send should happen for this user (vs. recording a
 * dry_run). Fails closed on every axis:
 *   - the master flag must be on and global dry-run off;
 *   - explicit OneSignal config (App ID + REST key) must be present — NO
 *     fallback to the public client App ID;
 *   - when a test allowlist is configured (homologation), only those users get
 *     a real send — everyone else is dry_run, so a homolog sweep can never
 *     blast the whole environment.
 */
export function shouldRealSend(userId: string, cfg: SendGateConfig): boolean {
  if (!cfg.enabled || cfg.dryRun) return false;
  if (!cfg.appId || !cfg.restApiKey) return false;
  if (cfg.testUserIds.size > 0 && !cfg.testUserIds.has(userId.toLowerCase())) return false;
  return true;
}

/**
 * Server-authoritative UI language for a user, read directly from
 * user_curriculum_preferences.interface_language (the canonical column, also
 * exposed to the client via /api/curriculum/progress). Returns null when
 * unavailable — the copy layer then defaults to English.
 */
export async function resolveUserInterfaceLanguage(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  try {
    const { data } = await supabase
      .from('user_curriculum_preferences')
      .select('interface_language')
      .eq('user_id', userId)
      .maybeSingle();
    const value = (data as { interface_language?: string | null } | null)?.interface_language;
    return value ?? null;
  } catch {
    return null;
  }
}
