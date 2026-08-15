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
  // profanity only has a pt-BR row → proves per-fragment pt-BR fallback.
  { dimension: 'profanity', value: String(BASE_DEFAULTS.profanityEnabled), interface_language: 'pt-BR', label: 'Linguagem', text: 'PT linguagem' },
];

function makeClient() {
  return {
    from() {
      const q: any = {
        _dims: null as string[] | null, _langs: null as string[] | null,
        select() { return q; },
        in(col: string, vals: string[]) { if (col === 'dimension') q._dims = vals; else q._langs = vals; return q; },
        then(resolve: (v: any) => any) {
          const out = FRAGMENTS.filter((r) => (!q._dims || q._dims.includes(r.dimension)) && (!q._langs || q._langs.includes(r.interface_language)));
          return resolve({ data: out, error: null });
        },
      };
      return q;
    },
  } as any;
}

describe('buildConversationPersonalizationFromData (blocker 2)', () => {
  it('interface=en yields ENGLISH fragment text — no Portuguese from code', async () => {
    const out = await buildConversationPersonalizationFromData(makeClient(), BASE_DEFAULTS, 'en');
    expect(out).toContain('EN pace text');
    expect(out).toContain('EN formality');
    expect(out).not.toContain('PT ritmo texto');
    expect(out).not.toContain('PT formalidade');
  });

  it('interface=pt-BR yields Portuguese fragment text', async () => {
    const out = await buildConversationPersonalizationFromData(makeClient(), BASE_DEFAULTS, 'pt-BR');
    expect(out).toContain('PT ritmo texto');
  });

  it('a fragment missing in the requested interface language falls back to pt-BR', async () => {
    // profanity has only a pt-BR row; interface=en must still surface it via fallback.
    const out = await buildConversationPersonalizationFromData(makeClient(), BASE_DEFAULTS, 'en');
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
