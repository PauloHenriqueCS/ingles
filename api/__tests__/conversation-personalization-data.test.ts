/**
 * Blocker 2: conversation FREE personalization TEXT is DATA
 * (conversation_pref_fragments), localized by interface_language — the enums
 * stay in code, their prose does not. And the session context is pure DATA (no
 * Portuguese pedagogical prose from TS). interface=en produces English text with
 * zero Portuguese from code.
 */
import { describe, it, expect } from 'vitest';
import { buildConversationPersonalizationFromData } from '../_curriculum/conversation-personalization';
import { buildConversationContextSection } from '../../src/lib/promptBuilder';
import { BASE_DEFAULTS } from '../../src/lib/tutorPreferences';

// Fragment fixture (pt-BR + en) for the dimensions/values BASE_DEFAULTS selects.
const FRAGMENTS = [
  { dimension: 'pace', value: BASE_DEFAULTS.speechPace, interface_language: 'pt-BR', label: 'Ritmo', text: 'PT ritmo texto' },
  { dimension: 'pace', value: BASE_DEFAULTS.speechPace, interface_language: 'en', label: 'Pace', text: 'EN pace text' },
  { dimension: 'formality', value: BASE_DEFAULTS.formality, interface_language: 'pt-BR', label: 'Formalidade', text: 'PT formalidade' },
  { dimension: 'formality', value: BASE_DEFAULTS.formality, interface_language: 'en', label: 'Formality', text: 'EN formality' },
  // personality (blocker 4) — the preset intro is data now.
  { dimension: 'personality', value: BASE_DEFAULTS.personalityPreset, interface_language: 'pt-BR', label: null, text: 'PT personalidade Orodim' },
  { dimension: 'personality', value: BASE_DEFAULTS.personalityPreset, interface_language: 'en', label: null, text: 'EN personality Orodim' },
  // profanity only has a pt-BR row → proves per-fragment pt-BR fallback.
  { dimension: 'profanity', value: String(BASE_DEFAULTS.profanityEnabled), interface_language: 'pt-BR', label: 'Linguagem', text: 'PT linguagem' },
];
// Per-language accent VARIANTS (blocker 5 / ROOT-2). English holds
// american/british/neutral; a SECOND language (Spanish) holds a DIFFERENT set
// (latin_american/spain/neutral) — proving genericity: a different learning
// language resolves its OWN variants via the SAME code, no union/switch/branch.
// Each language marks exactly one is_default (the data-driven fallback).
const VARIANTS = [
  // English (default accent = 'american').
  { learning_language: 'en', variant_key: 'american', is_default: true,  interface_language: 'en',    prompt_text: 'EN american variant text' },
  { learning_language: 'en', variant_key: 'american', is_default: true,  interface_language: 'pt-BR', prompt_text: 'PT american variant text' },
  { learning_language: 'en', variant_key: 'british',  is_default: false, interface_language: 'en',    prompt_text: 'EN british variant text' },
  // Spanish — a TEST-ONLY fixture (no production seed). 'american' does NOT
  // exist here, so a stored English key must fall back to es's is_default.
  { learning_language: 'es', variant_key: 'latin_american', is_default: true,  interface_language: 'en', prompt_text: 'ES latin_american (default) variant text' },
  { learning_language: 'es', variant_key: 'spain',          is_default: false, interface_language: 'en', prompt_text: 'ES spain variant text' },
  { learning_language: 'es', variant_key: 'neutral',        is_default: false, interface_language: 'en', prompt_text: 'ES neutral variant text' },
];

function makeClient() {
  return {
    from(table: string) {
      const q: any = {
        _dims: null as string[] | null, _langs: null as string[] | null, _eq: {} as Record<string, string>,
        select() { return q; },
        eq(col: string, val: string) { q._eq[col] = val; return q; },
        in(col: string, vals: string[]) { if (col === 'dimension') q._dims = vals; else q._langs = vals; return q; },
        then(resolve: (v: any) => any) {
          if (table === 'conversation_language_variants') {
            // The resolver fetches ALL variants for the language (no variant_key
            // filter) so it can validate the stored key and fall back to
            // is_default — the mock mirrors that.
            const out = VARIANTS.filter((r) => r.learning_language === q._eq.learning_language && (!q._langs || q._langs.includes(r.interface_language)));
            return resolve({ data: out, error: null });
          }
          const out = FRAGMENTS.filter((r) => (!q._dims || q._dims.includes(r.dimension)) && (!q._langs || q._langs.includes(r.interface_language)));
          return resolve({ data: out, error: null });
        },
      };
      return q;
    },
  } as any;
}

describe('buildConversationPersonalizationFromData (blockers 2, 4, 5)', () => {
  it('interface=en yields ENGLISH fragment text — no Portuguese from code', async () => {
    const out = await buildConversationPersonalizationFromData(makeClient(), BASE_DEFAULTS, 'en', 'en');
    expect(out).toContain('EN pace text');
    expect(out).toContain('EN formality');
    expect(out).not.toContain('PT ritmo texto');
    expect(out).not.toContain('PT formalidade');
  });

  it('includes the personalityPreset intro (blocker 4 — no regression)', async () => {
    const out = await buildConversationPersonalizationFromData(makeClient(), BASE_DEFAULTS, 'en', 'en');
    expect(out).toContain('EN personality Orodim');
  });

  it('accent is data-driven per learning language (blocker 5): en → EN variant', async () => {
    const out = await buildConversationPersonalizationFromData(makeClient(), BASE_DEFAULTS, 'en', 'en');
    expect(out).toContain('EN american variant text');
  });

  it('a SECOND learning language resolves its OWN variant with the same code (blocker 5 / ROOT-2)', async () => {
    // prefs.accent = 'spain' is a VALID es key → resolves that variant, no branch.
    const prefs = { ...BASE_DEFAULTS, accent: 'spain' };
    const out = await buildConversationPersonalizationFromData(makeClient(), prefs, 'en', 'es');
    expect(out).toContain('ES spain variant text');
    expect(out).not.toContain('EN american variant text');
  });

  it('validates the stored key against the language catalog and falls back to is_default (ROOT-2, items 2 & 5)', async () => {
    // BASE_DEFAULTS.accent = 'american' does NOT exist for 'es' → the server must
    // NOT reuse it blindly, NOT emit an English variant, and NOT invent a
    // hardcoded american/british/neutral. It uses es's is_default (latin_american).
    const out = await buildConversationPersonalizationFromData(makeClient(), BASE_DEFAULTS, 'en', 'es');
    expect(out).toContain('ES latin_american (default) variant text');
    expect(out).not.toContain('EN american variant text');
    expect(out).not.toContain('ES spain variant text');
  });

  it('interface=pt-BR yields Portuguese fragment text', async () => {
    const out = await buildConversationPersonalizationFromData(makeClient(), BASE_DEFAULTS, 'pt-BR', 'en');
    expect(out).toContain('PT ritmo texto');
  });

  it('a fragment missing in the requested interface language falls back to pt-BR', async () => {
    const out = await buildConversationPersonalizationFromData(makeClient(), BASE_DEFAULTS, 'en', 'en');
    expect(out).toContain('PT linguagem');
  });
});

describe('buildConversationContextSection — DATA only (blocker 2)', () => {
  it('emits neutral key: value data lines, no Portuguese pedagogical prose', () => {
    const out = buildConversationContextSection({
      theme: null,
      missionTitle: 'My trip',
      missionDescription: 'Talk about a trip',
      studentText: 'I went to the beach.',
      version2: null,
      mandatoryWords: ['beach', 'sunny'],
      recentMistakes: ['past tense'],
      currentGrammarObjectives: ['present perfect'],
      conversationGoalMinutes: 20,
      remainingConversationMinutes: 5,
    });
    expect(out).toContain('mission_title: My trip');
    expect(out).toContain('student_text: ');
    expect(out).toContain('mandatory_words: beach, sunny');
    expect(out).toContain('remaining_minutes: 5');
    // No Portuguese framing/prose from the code.
    expect(out).not.toMatch(/Contexto da sessão|Missão de escrita|Você DEVE falar|briefing|Como iniciar/);
  });
});
