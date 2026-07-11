import { supabase } from './supabase';

export interface LearningSettings {
  activeWeekdays: number[]; // 0=Dom, 1=Seg, ..., 6=Sáb
}

export const DEFAULT_SETTINGS: LearningSettings = {
  activeWeekdays: [1, 2, 3, 4, 5],
};

export async function fetchLearningSettings(): Promise<LearningSettings> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return DEFAULT_SETTINGS;

  const { data } = await supabase
    .from('user_learning_settings')
    .select('active_weekdays')
    .eq('user_id', user.id)
    .single();

  if (!data) return DEFAULT_SETTINGS;
  const weekdays = data.active_weekdays as number[];
  if (!Array.isArray(weekdays) || weekdays.length === 0) return DEFAULT_SETTINGS;
  return { activeWeekdays: weekdays };
}

export async function saveLearningSettings(settings: LearningSettings): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Não autenticado');

  const { error } = await supabase
    .from('user_learning_settings')
    .upsert(
      { user_id: user.id, active_weekdays: settings.activeWeekdays, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );

  if (error) throw new Error(error.message);
}

export async function addLearningDayOverride(date: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Não autenticado');

  const { error } = await supabase
    .from('learning_day_overrides')
    .upsert(
      { user_id: user.id, entry_date: date, is_active: true },
      { onConflict: 'user_id,entry_date' }
    );

  if (error) throw new Error(error.message);
}

export async function checkLearningDayOverride(date: string): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;

  const { data } = await supabase
    .from('learning_day_overrides')
    .select('id')
    .eq('user_id', user.id)
    .eq('entry_date', date)
    .eq('is_active', true)
    .maybeSingle();

  return !!data;
}

export async function fetchActiveDayOverrides(year: number, month: number): Promise<string[]> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const paddedMonth = String(month).padStart(2, '0');
  const startDate = `${year}-${paddedMonth}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${year}-${paddedMonth}-${String(lastDay).padStart(2, '0')}`;

  const { data } = await supabase
    .from('learning_day_overrides')
    .select('entry_date')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .gte('entry_date', startDate)
    .lte('entry_date', endDate);

  return (data ?? []).map((d) => d.entry_date as string);
}
