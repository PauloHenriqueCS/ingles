import { DAILY_LISTENING_CONFIG } from './listening-daily-config';

export function resolveListeningActivityDate(now?: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: DAILY_LISTENING_CONFIG.TIMEZONE })
    .format(now ?? new Date());
}
