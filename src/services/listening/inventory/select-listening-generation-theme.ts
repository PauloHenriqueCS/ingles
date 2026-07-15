import type { SupabaseClient } from '@supabase/supabase-js';
import type { CEFRLevel } from '../../../domain/curriculum/cefr';

// Themes to avoid repetition — checked against recent episode titles/synopses
const THEME_POOL = [
  'technology and daily life',
  'travel and exploration',
  'friendship and community',
  'food and culture',
  'work and career',
  'health and wellbeing',
  'environment and nature',
  'arts and creativity',
  'education and learning',
  'family and relationships',
  'sports and recreation',
  'city life and transport',
  'holidays and celebrations',
  'science and discovery',
  'shopping and services',
  'news and media',
  'music and entertainment',
  'animals and wildlife',
  'history and traditions',
  'future and innovation',
];

// Themes that are considered overused (fallback guard)
const AVOID_THEMES = [
  'encomenda errada',
  'trem errado',
  'hotel',
  'objeto perdido',
  'wrong order',
  'lost item',
];

export async function selectListeningGenerationTheme(
  supabase: SupabaseClient,
  cefrLevel: CEFRLevel,
): Promise<string | null> {
  // Get recent episode themes/titles for this level
  const { data: recentEpisodes } = await supabase
    .from('listening_episodes')
    .select('title, synopsis')
    .eq('cefr_level', cefrLevel)
    .order('created_at', { ascending: false })
    .limit(10);

  const recentContent = (recentEpisodes ?? [])
    .map((ep: { title: string | null; synopsis: string | null }) =>
      `${ep.title ?? ''} ${ep.synopsis ?? ''}`.toLowerCase(),
    )
    .join(' ');

  // Score each theme by how absent it is from recent content
  const scoredThemes = THEME_POOL.map(theme => {
    const keywords = theme.toLowerCase().split(' ');
    const hits = keywords.filter(k => recentContent.includes(k)).length;
    const avoided = AVOID_THEMES.some(av => theme.toLowerCase().includes(av.toLowerCase()));
    return { theme, score: hits + (avoided ? 100 : 0) };
  });

  // Sort ascending by score (least-used themes first), shuffle ties
  scoredThemes.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return Math.random() - 0.5;
  });

  const selected = scoredThemes[0];
  if (!selected) return null;

  return selected.theme;
}
