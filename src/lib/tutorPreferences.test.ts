import { describe, it, expect } from 'vitest';
import {
  getDefaultsForLevel,
  getPrefsSummaryChips,
  resolvePreset,
  BASE_DEFAULTS,
  PERSONALITY_PRESETS,
  REALTIME_VOICES,
  PACE_LABELS,
} from './tutorPreferences';
import { buildTutorInstructions } from './promptBuilder';
import type { AIPreferences } from '../types';

// ── 1. Defaults per level ─────────────────────────────────────────────────────

describe('getDefaultsForLevel', () => {
  it('A1 → slow pace, patient preset', () => {
    const d = getDefaultsForLevel('A1');
    expect(d.speechPace).toBe('slow');
    expect(d.personalityPreset).toBe('patient');
  });

  it('A2 → slow pace, patient preset', () => {
    const d = getDefaultsForLevel('A2');
    expect(d.speechPace).toBe('slow');
    expect(d.personalityPreset).toBe('patient');
  });

  it('B1 → normal pace, friend preset', () => {
    const d = getDefaultsForLevel('B1');
    expect(d.speechPace).toBe('normal');
    expect(d.personalityPreset).toBe('friend');
  });

  it('B2 → normal pace, friend preset', () => {
    const d = getDefaultsForLevel('B2');
    expect(d.speechPace).toBe('normal');
    expect(d.personalityPreset).toBe('friend');
  });

  it('C1 → natural pace, friend preset', () => {
    const d = getDefaultsForLevel('C1');
    expect(d.speechPace).toBe('natural');
    expect(d.personalityPreset).toBe('friend');
  });

  it('C2 → natural pace, friend preset', () => {
    const d = getDefaultsForLevel('C2');
    expect(d.speechPace).toBe('natural');
    expect(d.personalityPreset).toBe('friend');
  });

  it('unknown level → slow pace (safe default)', () => {
    const d = getDefaultsForLevel('XX');
    expect(d.speechPace).toBe('slow');
  });
});

// ── 2. Preset configurations ──────────────────────────────────────────────────

describe('PERSONALITY_PRESETS', () => {
  it('patient has no profanity and no roasting', () => {
    expect(PERSONALITY_PRESETS.patient.profanityEnabled).toBe(false);
    expect(PERSONALITY_PRESETS.patient.roastIntensity).toBe('off');
  });

  it('unfiltered_friend has profanity and high roasting', () => {
    expect(PERSONALITY_PRESETS.unfiltered_friend.profanityEnabled).toBe(true);
    expect(PERSONALITY_PRESETS.unfiltered_friend.roastIntensity).toBe('high');
    expect(PERSONALITY_PRESETS.unfiltered_friend.formality).toBe('very_low');
  });

  it('teacher has high initiative', () => {
    expect(PERSONALITY_PRESETS.teacher.topicInitiative).toBe('high');
    expect(PERSONALITY_PRESETS.teacher.roastIntensity).toBe('off');
  });

  it('friend has light roasting and no profanity', () => {
    expect(PERSONALITY_PRESETS.friend.roastIntensity).toBe('light');
    expect(PERSONALITY_PRESETS.friend.profanityEnabled).toBe(false);
  });
});

// ── 3. Prompt — speech pace applied ──────────────────────────────────────────

describe('buildTutorInstructions — pace', () => {
  const basePrefs = getDefaultsForLevel('B1');

  it('slow pace includes "1–3 frases"', () => {
    const p = buildTutorInstructions({ ...basePrefs, speechPace: 'slow' }, 'B1');
    expect(p).toContain('1–3 frases');
  });

  it('normal pace includes "2–4 frases"', () => {
    const p = buildTutorInstructions({ ...basePrefs, speechPace: 'normal' }, 'B1');
    expect(p).toContain('2–4 frases');
  });

  it('natural pace includes "3–5 frases"', () => {
    const p = buildTutorInstructions({ ...basePrefs, speechPace: 'natural' }, 'B1');
    expect(p).toContain('3–5 frases');
  });
});

// ── 4. Prompt — correction rules ─────────────────────────────────────────────

describe('buildTutorInstructions — corrections', () => {
  const basePrefs = getDefaultsForLevel('B1');

  it('portuguese correction language includes "português brasileiro"', () => {
    const p = buildTutorInstructions({ ...basePrefs, correctionLanguage: 'portuguese' }, 'B1');
    expect(p.toLowerCase()).toContain('português brasileiro');
  });

  it('english correction language mentions inglês', () => {
    const p = buildTutorInstructions({ ...basePrefs, correctionLanguage: 'english' }, 'B1');
    expect(p.toLowerCase()).toContain('inglês');
  });

  it('session_summary timing says NÃO corrija durante', () => {
    const p = buildTutorInstructions({ ...basePrefs, correctionTiming: 'session_summary' }, 'B1');
    expect(p).toContain('NÃO corrija durante');
  });

  it('important_only scope says APENAS erros', () => {
    const p = buildTutorInstructions({ ...basePrefs, correctionScope: 'important_only' }, 'B1');
    expect(p).toContain('APENAS');
  });

  it('detailed correction mentions regra', () => {
    const p = buildTutorInstructions({ ...basePrefs, correctionDetail: 'detailed' }, 'B1');
    expect(p.toLowerCase()).toContain('regra');
  });
});

// ── 5. Prompt — personality presets ──────────────────────────────────────────

describe('buildTutorInstructions — personality', () => {
  it('unfiltered_friend mentions zoação alta', () => {
    const p = buildTutorInstructions({
      ...BASE_DEFAULTS,
      personalityPreset: 'unfiltered_friend',
      roastIntensity: 'high',
      profanityEnabled: true,
    }, 'B1');
    expect(p).toContain('Zoação alta');
    expect(p).toContain('Palavrões e linguagem crua são PERMITIDOS');
  });

  it('patient mentions calmo e acolhedor', () => {
    const p = buildTutorInstructions({
      ...BASE_DEFAULTS,
      personalityPreset: 'patient',
    }, 'A1');
    expect(p.toLowerCase()).toContain('calmo e acolhedor');
  });

  it('teacher mentions didático', () => {
    const p = buildTutorInstructions({
      ...BASE_DEFAULTS,
      personalityPreset: 'teacher',
    }, 'B1');
    expect(p.toLowerCase()).toContain('didático');
  });
});

// ── 6. CEFR level instructions ────────────────────────────────────────────────

describe('buildTutorInstructions — CEFR level', () => {
  it('A1 mentions INICIANTE', () => {
    const p = buildTutorInstructions(BASE_DEFAULTS, 'A1');
    expect(p).toContain('INICIANTE');
  });

  it('C2 mentions PROFICIENTE', () => {
    const p = buildTutorInstructions(BASE_DEFAULTS, 'C2');
    expect(p).toContain('PROFICIENTE');
  });

  it('unknown level falls back to A1 instructions', () => {
    const p = buildTutorInstructions(BASE_DEFAULTS, 'XX');
    expect(p).toContain('INICIANTE');
  });
});

// ── 7. Summary chips ──────────────────────────────────────────────────────────

describe('getPrefsSummaryChips', () => {
  it('returns 4 chips', () => {
    const chips = getPrefsSummaryChips(BASE_DEFAULTS);
    expect(chips).toHaveLength(4);
  });

  it('chip includes voice label', () => {
    const prefs = { ...BASE_DEFAULTS, voice: 'coral' };
    const chips = getPrefsSummaryChips(prefs);
    expect(chips.some((c) => c.includes('Coral'))).toBe(true);
  });

  it('chip includes pace label', () => {
    const prefs = { ...BASE_DEFAULTS, speechPace: 'natural' as const };
    const chips = getPrefsSummaryChips(prefs);
    expect(chips.some((c) => c.toLowerCase().includes('natural'))).toBe(true);
  });

  it('custom preset shows "Personalizado"', () => {
    const prefs: AIPreferences = {
      ...BASE_DEFAULTS,
      personalityPreset: 'custom',
      humorLevel: 'high',
      roastIntensity: 'light',
      formality: 'very_low',
      profanityEnabled: false,
      topicInitiative: 'low',
    };
    const chips = getPrefsSummaryChips(prefs);
    expect(chips.some((c) => c.includes('Personalizado'))).toBe(true);
  });
});

// ── 8. resolvePreset — fallback to custom ────────────────────────────────────

describe('resolvePreset', () => {
  it('matches patient preset exactly', () => {
    const prefs = { ...BASE_DEFAULTS, ...PERSONALITY_PRESETS.patient };
    expect(resolvePreset(prefs)).toBe('patient');
  });

  it('returns custom when controls don\'t match any preset', () => {
    const prefs: AIPreferences = {
      ...BASE_DEFAULTS,
      formality: 'high',
      humorLevel: 'high',
      roastIntensity: 'off',
      profanityEnabled: false,
      topicInitiative: 'low',
    };
    expect(resolvePreset(prefs)).toBe('custom');
  });

  it('matches unfiltered_friend preset', () => {
    const prefs = { ...BASE_DEFAULTS, ...PERSONALITY_PRESETS.unfiltered_friend };
    expect(resolvePreset(prefs)).toBe('unfiltered_friend');
  });
});

// ── 9. Voice catalog completeness ─────────────────────────────────────────────

describe('REALTIME_VOICES', () => {
  it('all voices have id, label, description and previewVoice', () => {
    for (const v of REALTIME_VOICES) {
      expect(v.id).toBeTruthy();
      expect(v.label).toBeTruthy();
      expect(v.description).toBeTruthy();
      expect(v.previewVoice).toBeTruthy();
    }
  });

  it('coral is in the list', () => {
    expect(REALTIME_VOICES.some((v) => v.id === 'coral')).toBe(true);
  });
});

// ── 10. Pace labels ──────────────────────────────────────────────────────────

describe('PACE_LABELS', () => {
  it('all paces have label and description', () => {
    for (const [, val] of Object.entries(PACE_LABELS)) {
      expect(val.label).toBeTruthy();
      expect(val.description).toBeTruthy();
    }
  });
});

// ── 11. Prompt doesn't leak instructions in a single call ─────────────────────

describe('buildTutorInstructions — safety', () => {
  it('does not return empty string', () => {
    const p = buildTutorInstructions(BASE_DEFAULTS, 'B1');
    expect(p.length).toBeGreaterThan(200);
  });

  it('always includes teacher name', () => {
    const p = buildTutorInstructions({ ...BASE_DEFAULTS, teacherName: 'Lemon' }, 'A2');
    expect(p).toContain('Lemon');
  });
});
