/**
 * SERVER-ONLY presentation localization resolved from DATA (blockers 14 & 16):
 *   - proficiency band labels   → public.proficiency_band_i18n (by band_key)
 *   - language display names     → public.language_i18n (by language_code)
 *
 * No hardcoded pt-BR/en maps and no pair-assumption band derivation live in the
 * code anymore; adding a language or a band grouping is data, not a code change.
 * Falls back to pt-BR when a specific interface language row is missing, and to
 * the raw key/code when even that is absent — never throws (presentation only).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

const FALLBACK_INTERFACE = 'pt-BR';

/** band_key → localized label, for a given interface language (with pt-BR fallback). */
export async function getBandLabelMap(
  client: SupabaseClient,
  interfaceLanguage: string,
): Promise<Map<string, string>> {
  const { data } = await client
    .from('proficiency_band_i18n')
    .select('band_key, interface_language, label')
    .in('interface_language', Array.from(new Set([interfaceLanguage, FALLBACK_INTERFACE])));
  const rows = (data ?? []) as Array<{ band_key: string; interface_language: string; label: string }>;
  const map = new Map<string, string>();
  // Fallback first, then override with the requested interface language.
  for (const r of rows) if (r.interface_language === FALLBACK_INTERFACE) map.set(r.band_key, r.label);
  for (const r of rows) if (r.interface_language === interfaceLanguage) map.set(r.band_key, r.label);
  return map;
}

/** language_code → display name in the given interface language (with pt-BR fallback). */
export async function getLanguageDisplayName(
  client: SupabaseClient,
  languageCode: string,
  interfaceLanguage: string,
): Promise<string> {
  const { data } = await client
    .from('language_i18n')
    .select('interface_language, display_name')
    .eq('language_code', languageCode)
    .in('interface_language', Array.from(new Set([interfaceLanguage, FALLBACK_INTERFACE])));
  const rows = (data ?? []) as Array<{ interface_language: string; display_name: string }>;
  const exact = rows.find((r) => r.interface_language === interfaceLanguage);
  const fallback = rows.find((r) => r.interface_language === FALLBACK_INTERFACE);
  return exact?.display_name ?? fallback?.display_name ?? languageCode;
}
