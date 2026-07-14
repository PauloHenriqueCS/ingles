import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { DEFAULT_PREFERENCES } from '../lib/promptBuilder';
import type { AIPreferences } from '../types';

export function useAIPreferences() {
  const [prefs, setPrefs] = useState<AIPreferences>(DEFAULT_PREFERENCES);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase
          .from('ai_conversation_preferences')
          .select('*')
          .maybeSingle();
        if (data) {
          setPrefs({
            teacherName:    data.teacher_name    ?? DEFAULT_PREFERENCES.teacherName,
            personality:    data.personality     ?? DEFAULT_PREFERENCES.personality,
            correctionStyle: data.correction_style ?? DEFAULT_PREFERENCES.correctionStyle,
            voice:          data.voice           ?? DEFAULT_PREFERENCES.voice,
            focusAreas:     data.focus_areas     ?? DEFAULT_PREFERENCES.focusAreas,
          });
        }
      } catch {
        // use defaults
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = useCallback(
    async (updates: Partial<AIPreferences>) => {
      const next = { ...prefs, ...updates };
      setPrefs(next);
      await supabase.from('ai_conversation_preferences').upsert(
        {
          teacher_name: next.teacherName,
          personality: next.personality,
          correction_style: next.correctionStyle,
          voice: next.voice,
          focus_areas: next.focusAreas,
        },
        { onConflict: 'user_id' },
      );
    },
    [prefs],
  );

  return { prefs, loading, save };
}
