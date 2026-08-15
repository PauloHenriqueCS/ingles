/**
 * SERVER-ONLY: builds the conversation-style personalization block from DATA
 * (public.conversation_pref_fragments), localized by interface_language. The
 * ENUM preference values stay typed in code; their natural-language
 * representation for the model is DATA — so interface_language=en (or any future
 * language) produces the personalization with NO Portuguese text from TS
 * (blocker 2). Falls back to pt-BR text per fragment when a specific interface
 * language row is missing; a missing fragment is simply omitted (never throws).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AIPreferences } from '../../src/types';

const FALLBACK_INTERFACE = 'pt-BR';

interface WantedFragment { dimension: string; value: string }

function wantedFragments(prefs: AIPreferences): WantedFragment[] {
  return [
    { dimension: 'pace', value: prefs.speechPace },
    { dimension: 'accent', value: prefs.accent },
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

export async function buildConversationPersonalizationFromData(
  client: SupabaseClient,
  prefs: AIPreferences,
  interfaceLanguage: string,
): Promise<string> {
  const wanted = wantedFragments(prefs);
  const { data } = await client
    .from('conversation_pref_fragments')
    .select('dimension, value, interface_language, label, text')
    .in('dimension', wanted.map((w) => w.dimension))
    .in('interface_language', Array.from(new Set([interfaceLanguage, FALLBACK_INTERFACE])));
  const rows = (data ?? []) as Array<{ dimension: string; value: string; interface_language: string; label: string | null; text: string }>;

  // Lookup keyed by dimension|value; prefer the requested interface language,
  // fall back to pt-BR text.
  const byKey = new Map<string, { label: string | null; text: string }>();
  for (const r of rows) if (r.interface_language === FALLBACK_INTERFACE) byKey.set(`${r.dimension}|${r.value}`, { label: r.label, text: r.text });
  for (const r of rows) if (r.interface_language === interfaceLanguage) byKey.set(`${r.dimension}|${r.value}`, { label: r.label, text: r.text });

  const lines: string[] = [];
  for (const w of wanted) {
    const frag = byKey.get(`${w.dimension}|${w.value}`);
    if (!frag) continue;
    if (frag.label) lines.push(`## ${frag.label}`);
    lines.push(frag.text);
    lines.push('');
  }
  return lines.join('\n').trim();
}
