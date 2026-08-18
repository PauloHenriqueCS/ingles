/**
 * SERVER-ONLY: resolve human-readable language NAMES from DATA (public.languages).
 *
 * WHY THIS EXISTS (root cause of the "wrong/mixed output language" regression):
 * curriculum prompt templates historically interpolated the raw ISO code
 * ({{learning_language}} → "en") as their output-language directive. "Generate a
 * story in en" is a weak, ambiguous instruction; combined with interface-language
 * (e.g. Portuguese) curricular metadata flooding the same prompt, the model drifts
 * and produces the WRONG language. Naming the language explicitly ("English")
 * turns a weak signal into an unambiguous one.
 *
 * The names are DATA — adding/adjusting a language is a `languages` row, never a
 * code change. `englishName` is used for the model-facing directive because an
 * English endonym is the least-ambiguous instruction for an LLM regardless of the
 * prose language of the template; `nativeName` is exposed for templates that want
 * the endonym. Never throws — falls back to the raw code so a missing row degrades
 * to today's (weaker) behavior instead of breaking generation.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface LanguageNames {
  /** e.g. "English", "Brazilian Portuguese" — model-facing, unambiguous. */
  englishName: string;
  /** endonym, e.g. "English", "Español", "Português (Brasil)". */
  nativeName: string;
}

/**
 * Resolve (englishName, nativeName) for a set of language codes in a single query.
 * Returns a Map keyed by the input code; any code with no row (or a transient read
 * error) falls back to { englishName: code, nativeName: code }.
 */
export async function getLanguageNamesMap(
  client: SupabaseClient,
  codes: readonly string[],
): Promise<Map<string, LanguageNames>> {
  const unique = Array.from(new Set(codes.filter((c) => !!c)));
  const out = new Map<string, LanguageNames>();
  for (const c of unique) out.set(c, { englishName: c, nativeName: c });
  if (unique.length === 0) return out;

  // Name resolution must NEVER break prompt generation: any read failure degrades
  // to the raw code (today's weaker behavior), never a thrown error.
  try {
    const { data } = await client
      .from('languages')
      .select('code, english_name, native_name')
      .in('code', unique);
    const rows = (data ?? []) as Array<{ code: string; english_name: string | null; native_name: string | null }>;
    for (const r of rows) {
      out.set(r.code, {
        englishName: (r.english_name && r.english_name.trim()) || r.code,
        nativeName: (r.native_name && r.native_name.trim()) || r.english_name?.trim() || r.code,
      });
    }
  } catch {
    /* keep the code fallbacks already seeded into `out` */
  }
  return out;
}

/** Convenience: resolve names for one code (never throws). */
export async function getLanguageNames(
  client: SupabaseClient,
  code: string,
): Promise<LanguageNames> {
  const map = await getLanguageNamesMap(client, [code]);
  return map.get(code) ?? { englishName: code, nativeName: code };
}
