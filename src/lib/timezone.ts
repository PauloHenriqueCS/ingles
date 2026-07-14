const SP_TZ = 'America/Sao_Paulo';

const SP_DATE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: SP_TZ });

export function getTodaySP(): string {
  return SP_DATE_FMT.format(new Date());
}

export function toSpDate(utcTimestamp: string): string {
  return SP_DATE_FMT.format(new Date(utcTimestamp));
}

export function getSpYear(): number {
  return parseInt(getTodaySP().slice(0, 4), 10);
}

export function getSpMonth(): number {
  return parseInt(getTodaySP().slice(5, 7), 10);
}

export function getYesterdaySP(): string {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  return SP_DATE_FMT.format(yesterday);
}
