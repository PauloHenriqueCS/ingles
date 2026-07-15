import type { CEFRLevel } from '../../../domain/curriculum/cefr';

export const DAILY_LISTENING_CONFIG = {
  FALLBACK_CEFR_LEVEL: 'A2' as CEFRLevel,
  TIMEZONE: 'America/Sao_Paulo',
} as const;
