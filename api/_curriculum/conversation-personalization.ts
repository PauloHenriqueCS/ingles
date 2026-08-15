/**
 * SERVER-ONLY: builds the conversation-style personalization block from DATA,
 * localized by interface_language. The ENUM preference values stay typed in
 * code; their natural-language representation for the model is DATA:
 *   - most dimensions          → public.conversation_pref_fragments
 *   - accent / language variant → public.conversation_language_variants, keyed by
 *     learning_language (so a future language defines its OWN variants as data,
 *     with NO union/switch/validator/builder change — blocker 5)
 * personalityPreset is included (blocker 4). interface_language=en produces the
 * block with NO Portuguese text from TS. Falls back to pt-BR per row when a
 * specific interface language is missing; a missing fragment is omitted.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AIPreferences } from '../../src/types';

const FALLBACK_INTERFACE = 'pt-BR';

interface WantedFragment { dimension: string; value: string }

// Order here is the ORDER of the assembled block (personality intro first).
function wantedFragments(prefs: AIPreferences): WantedFragment[] {
  return [
    { dimension: 'personality', value: prefs.personalityPreset },
    { dimension: 'pace', value: prefs.speechPace },
    { dimension: 'formality', value: prefs.formality },
    { dimension: 'humor', value: prefs.humorLevel },
    { dimension: 'roast', value: prefs.roastIntensity },
    { dimension: 'initiative', value: prefs.topicInitiative },
    { dimension: 'correction_timing', value: prefs.correctionTiming },
    { dimension: 'correction_scope', value: prefs.correctionScope },
    { dimension: 'correction_detail', value: prefs.correctionDetail },
    { dimension: 'correction_language', value: prefs.correctionLanguage },
    { dimension: 'profanity', value: String(prefs.profanityEnabled) },
  ];
}

// Resolve the accent/variant instruction from the per-learning-language variant
// catalog. The stored variant_key is VALIDATED against the catalog for THIS
// learning_language: if it applies, it is used; if it does NOT (e.g. an English
// key like 'american' stored while the active path is Spanish), we fall back to
// the language's is_default variant — never a blind reuse of a key that belongs
// to another language, and never a hardcoded american/british/neutral (ROOT-2,
// items 2 & 5). Prefers the requested interface language, then pt-BR. Returns
// null only when the language defines NO variants at all (caller then uses the
// generic accent fragment).
async function resolveVariantText(
  client: SupabaseClient,
  learningLanguage: string,
  variantKey: string,
  interfaceLanguage: string,
): Promise<string | null> {
  const { data } = await client
    .from('conversation_language_variants')
    .select('variant_key, is_default, interface_language, prompt_text')
    .eq('learning_language', learningLanguage)
    .in('interface_language', Array.from(new Set([interfaceLanguage, FALLBACK_INTERFACE])));
  const rows = (data ?? []) as Array<{ variant_key: string; is_default: boolean; interface_language: string; prompt_text: string }>;
  if (rows.length === 0) return null;

  // Validate the requested key against THIS language's catalog; otherwise use
  // the data-driven default (is_default), then the first available key.
  const availableKeys = new Set(rows.map((r) => r.variant_key));
  const effectiveKey = availableKeys.has(variantKey)
    ? variantKey
    : (rows.find((r) => r.is_default)?.variant_key ?? rows[0].variant_key);

  const forKey = rows.filter((r) => r.variant_key === effectiveKey);
  const exact = forKey.find((r) => r.interface_language === interfaceLanguage);
  const fallback = forKey.find((r) => r.interface_language === FALLBACK_INTERFACE);
  return exact?.prompt_text ?? fallback?.prompt_text ?? null;
}

export async function buildConversationPersonalizationFromData(
  client: SupabaseClient,
  prefs: AIPreferences,
  interfaceLanguage: string,
  learningLanguage: string,
): Promise<string> {
  const wanted = wantedFragments(prefs);
  const [{ data: fragData }, accentVariant] = await Promise.all([
    client
      .from('conversation_pref_fragments')
      .select('dimension, value, interface_language, label, text')
      // 'accent' is included so the generic-fragment fallback works when a
      // learning language has no per-language variant row.
      .in('dimension', Array.from(new Set([...wanted.map((w) => w.dimension), 'accent'])))
      .in('interface_language', Array.from(new Set([interfaceLanguage, FALLBACK_INTERFACE]))),
    // Accent/variant is data-driven per learning language (blocker 5).
    resolveVariantText(client, learningLanguage, prefs.accent, interfaceLanguage),
  ]);
  const rows = (fragData ?? []) as Array<{ dimension: string; value: string; interface_language: string; label: string | null; text: string }>;

  const byKey = new Map<string, { label: string | null; text: string }>();
  for (const r of rows) if (r.interface_language === FALLBACK_INTERFACE) byKey.set(`${r.dimension}|${r.value}`, { label: r.label, text: r.text });
  for (const r of rows) if (r.interface_language === interfaceLanguage) byKey.set(`${r.dimension}|${r.value}`, { label: r.label, text: r.text });

  const lines: string[] = [];
  const emit = (label: string | null, text: string) => {
    if (label) lines.push(`## ${label}`);
    lines.push(text);
    lines.push('');
  };
  for (const w of wanted) {
    const frag = byKey.get(`${w.dimension}|${w.value}`);
    if (frag) emit(frag.label, frag.text);
    // Accent slot: after personality/pace, insert the variant (or the generic
    // accent fragment fallback). We place it right after 'pace' for readability.
    if (w.dimension === 'pace') {
      if (accentVariant) {
        emit('Sotaque', accentVariant);
      } else {
        const generic = byKey.get(`accent|${prefs.accent}`);
        if (generic) emit(generic.label, generic.text);
      }
    }
  }
  return lines.join('\n').trim();
}
