/**
 * Blocker 24 (structural second-language proof) for the PRESENTATION layer:
 * band labels + language display names come from DATA (the same resolver, any
 * language/interface), and the UI chrome is interface-language aware — with NO
 * per-language branch and NO hardcoded English/pt-BR authority in the component.
 */
import { describe, it, expect } from 'vitest';
import { getBandLabelMap, getLanguageDisplayName } from '../../../api/_curriculum/presentation-i18n';
import { curriculumUiStrings } from '../curriculumUiStrings';

// In-memory fixture for proficiency_band_i18n + language_i18n.
function makeClient(bands: any[], langs: any[]) {
  return {
    from(table: string) {
      const rows = table === 'proficiency_band_i18n' ? bands : table === 'language_i18n' ? langs : [];
      const q: any = {
        _lang: null as string | null, _codes: null as string[] | null, _code: null as string | null,
        select() { return q; },
        eq(col: string, val: string) { if (col === 'language_code') q._code = val; return q; },
        in(_col: string, vals: string[]) { q._codes = vals; return q; },
        then(resolve: (v: any) => any) {
          let out = rows;
          if (q._code) out = out.filter((r: any) => r.language_code === q._code);
          if (q._codes) out = out.filter((r: any) => q._codes!.includes(r.interface_language));
          return resolve({ data: out, error: null });
        },
      };
      return q;
    },
  } as any;
}

const BANDS = [
  { band_key: 'beginner', interface_language: 'pt-BR', label: 'Iniciante' },
  { band_key: 'beginner', interface_language: 'en', label: 'Beginner' },
  { band_key: 'intermediate', interface_language: 'pt-BR', label: 'Intermediário' },
  { band_key: 'intermediate', interface_language: 'en', label: 'Intermediate' },
];
const LANGS = [
  { language_code: 'en', interface_language: 'pt-BR', display_name: 'inglês' },
  { language_code: 'en', interface_language: 'en', display_name: 'English' },
  { language_code: 'es', interface_language: 'pt-BR', display_name: 'espanhol' },
  { language_code: 'es', interface_language: 'en', display_name: 'Spanish' },
];

describe('band labels — data-driven, any interface language (blocker 14)', () => {
  it('resolves pt-BR and en band labels from the same code', async () => {
    const c = makeClient(BANDS, LANGS);
    expect((await getBandLabelMap(c, 'pt-BR')).get('beginner')).toBe('Iniciante');
    expect((await getBandLabelMap(c, 'en')).get('beginner')).toBe('Beginner');
  });

  it('falls back to pt-BR for an unmapped interface language (never throws)', async () => {
    const c = makeClient(BANDS, LANGS);
    expect((await getBandLabelMap(c, 'xx')).get('intermediate')).toBe('Intermediário');
  });
});

describe('language display names — data-driven (blocker 16)', () => {
  it('a Spanish learner with an English interface sees "Spanish" — same code path, no branch', async () => {
    const c = makeClient(BANDS, LANGS);
    expect(await getLanguageDisplayName(c, 'es', 'en')).toBe('Spanish');
    expect(await getLanguageDisplayName(c, 'es', 'pt-BR')).toBe('espanhol');
    expect(await getLanguageDisplayName(c, 'en', 'en')).toBe('English');
  });

  it('falls back to the raw code when a language has no i18n row', async () => {
    const c = makeClient(BANDS, LANGS);
    expect(await getLanguageDisplayName(c, 'ja', 'en')).toBe('ja');
  });
});

describe('curriculum UI chrome — interface-language aware (blockers 13/20)', () => {
  it('renders pt-BR and en chrome from one module, keyed by interface language', () => {
    expect(curriculumUiStrings('pt-BR').statusYourLevel).toBe('SEU NÍVEL');
    expect(curriculumUiStrings('en').statusYourLevel).toBe('YOUR LEVEL');
    expect(curriculumUiStrings('pt-BR').planTitle).toBe('Plano de ensino');
    expect(curriculumUiStrings('en').planTitle).toBe('Teaching plan');
  });

  it('the conversation description is parameterized by the learning-language name (never "inglês" hardcoded)', () => {
    // interface=en + learning=Spanish → "practise spoken Spanish", no code change.
    expect(curriculumUiStrings('en').descConversation('Spanish')).toContain('Spanish');
    expect(curriculumUiStrings('pt-BR').descConversation('espanhol')).toContain('espanhol');
    // The template itself carries no hardcoded language name.
    expect(curriculumUiStrings('pt-BR').descConversation('')).not.toMatch(/inglês/);
  });

  it('falls back to pt-BR for an unknown interface language', () => {
    expect(curriculumUiStrings('zz').planTitle).toBe('Plano de ensino');
  });
});
