import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../lib/supabase';
import { BASE_DEFAULTS, getDefaultsForLevel, resolvePreset } from '../lib/tutorPreferences';
import { DEFAULT_CONVERSATION_GOAL_MINUTES } from '../lib/conversationGoal';
import type { AIPreferences } from '../types';

export interface UseTutorPreferences {
  /** Current draft (local, unsaved) */
  prefs: AIPreferences;
  /** Last saved preferences from DB */
  saved: AIPreferences;
  loading: boolean;
  saving: boolean;
  saveResult: 'success' | 'error' | null;
  isDirty: boolean;
  cefrLevel: string;
  updateDraft: (updates: Partial<AIPreferences>) => void;
  save: () => Promise<void>;
  resetToDefault: () => void;
  clearSaveResult: () => void;
}

function rowToPrefs(row: Record<string, unknown>): AIPreferences {
  const personality = (row.personality_preset as string | undefined) ?? BASE_DEFAULTS.personalityPreset;
  const prefs: AIPreferences = {
    teacherName:        (row.teacher_name         as string)  ?? BASE_DEFAULTS.teacherName,
    voice:              (row.voice                as string)  ?? BASE_DEFAULTS.voice,
    accent:             (row.accent               as AIPreferences['accent'])      ?? BASE_DEFAULTS.accent,
    speechPace:         (row.speech_pace          as AIPreferences['speechPace'])  ?? BASE_DEFAULTS.speechPace,
    personalityPreset:  personality as AIPreferences['personalityPreset'],
    formality:          (row.formality            as AIPreferences['formality'])   ?? BASE_DEFAULTS.formality,
    humorLevel:         (row.humor_level          as AIPreferences['humorLevel'])  ?? BASE_DEFAULTS.humorLevel,
    roastIntensity:     (row.roast_intensity      as AIPreferences['roastIntensity']) ?? BASE_DEFAULTS.roastIntensity,
    profanityEnabled:   (row.profanity_enabled    as boolean) ?? BASE_DEFAULTS.profanityEnabled,
    topicInitiative:    (row.topic_initiative     as AIPreferences['topicInitiative']) ?? BASE_DEFAULTS.topicInitiative,
    correctionTiming:   (row.correction_timing    as AIPreferences['correctionTiming'])  ?? BASE_DEFAULTS.correctionTiming,
    correctionScope:    (row.correction_scope     as AIPreferences['correctionScope'])   ?? BASE_DEFAULTS.correctionScope,
    correctionLanguage: (row.correction_language  as AIPreferences['correctionLanguage']) ?? BASE_DEFAULTS.correctionLanguage,
    correctionDetail:   (row.correction_detail    as AIPreferences['correctionDetail'])   ?? BASE_DEFAULTS.correctionDetail,
    focusAreas:         Array.isArray(row.focus_areas) ? (row.focus_areas as string[]) : BASE_DEFAULTS.focusAreas,
    dailyConversationGoalMinutes: (row.daily_conversation_goal_minutes as number | null) ?? DEFAULT_CONVERSATION_GOAL_MINUTES,
  };
  // Auto-resolve preset from manual controls in case DB preset tag is stale
  prefs.personalityPreset = resolvePreset(prefs);
  return prefs;
}

function prefsToRow(p: AIPreferences): Record<string, unknown> {
  return {
    teacher_name:        p.teacherName,
    voice:               p.voice,
    accent:              p.accent,
    speech_pace:         p.speechPace,
    personality_preset:  p.personalityPreset,
    formality:           p.formality,
    humor_level:         p.humorLevel,
    roast_intensity:     p.roastIntensity,
    profanity_enabled:   p.profanityEnabled,
    topic_initiative:    p.topicInitiative,
    correction_timing:   p.correctionTiming,
    correction_scope:    p.correctionScope,
    correction_language: p.correctionLanguage,
    correction_detail:   p.correctionDetail,
    focus_areas:         p.focusAreas,
    daily_conversation_goal_minutes: p.dailyConversationGoalMinutes,
  };
}

export function useTutorPreferences(): UseTutorPreferences {
  const [cefrLevel, setCefrLevel] = useState('A1');
  const [saved, setSaved]         = useState<AIPreferences>(BASE_DEFAULTS);
  const [draft, setDraft]         = useState<AIPreferences>(BASE_DEFAULTS);
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [saveResult, setSaveResult] = useState<'success' | 'error' | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Fetch in parallel
        const [prefsResult, memoryResult] = await Promise.all([
          supabase.from('ai_conversation_preferences').select('*').maybeSingle(),
          supabase.from('english_learning_memory').select('current_level').order('updated_at', { ascending: false }).limit(1),
        ]);

        if (cancelled) return;

        const level = (memoryResult.data?.[0] as { current_level?: string } | undefined)?.current_level ?? 'A1';
        setCefrLevel(level);

        const levelDefaults = getDefaultsForLevel(level);
        if (prefsResult.data) {
          const fromDb = rowToPrefs(prefsResult.data as Record<string, unknown>);
          setSaved(fromDb);
          setDraft(fromDb);
        } else {
          // First access: use level-based defaults
          setSaved(levelDefaults);
          setDraft(levelDefaults);
        }
      } catch {
        // Keep defaults
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const isDirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(saved),
    [draft, saved],
  );

  const updateDraft = useCallback((updates: Partial<AIPreferences>) => {
    setDraft((prev) => {
      const next = { ...prev, ...updates };
      // If any personality controls change, auto-resolve preset
      const personalityKeys: (keyof AIPreferences)[] = [
        'formality', 'humorLevel', 'roastIntensity', 'profanityEnabled', 'topicInitiative',
      ];
      if (personalityKeys.some((k) => k in updates)) {
        next.personalityPreset = resolvePreset(next);
      }
      return next;
    });
    setSaveResult(null);
  }, []);

  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setSaveResult(null);
    try {
      const { error } = await supabase
        .from('ai_conversation_preferences')
        .upsert(prefsToRow(draft), { onConflict: 'user_id' });
      if (error) throw error;
      setSaved(draft);
      setSaveResult('success');
    } catch {
      setSaveResult('error');
    } finally {
      setSaving(false);
    }
  }, [draft, saving]);

  const resetToDefault = useCallback(() => {
    const defaults = getDefaultsForLevel(cefrLevel);
    setDraft(defaults);
    setSaveResult(null);
  }, [cefrLevel]);

  const clearSaveResult = useCallback(() => setSaveResult(null), []);

  return {
    prefs: draft,
    saved,
    loading,
    saving,
    saveResult,
    isDirty,
    cefrLevel,
    updateDraft,
    save,
    resetToDefault,
    clearSaveResult,
  };
}
