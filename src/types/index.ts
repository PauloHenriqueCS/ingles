export type Status = 'nao-iniciado' | 'escrito' | 'corrigido' | 'revisado';
export type Difficulty = 'facil' | 'medio' | 'dificil' | null;
export type View = 'dashboard' | 'month' | 'year' | 'filters' | 'day';

export interface DaySchedule {
  date: string;
  theme: string;
  grammarObjective: string;
  verbTense: string;
  isWeekend: boolean;
  weekendActivity?: 'revisao' | 'descanso';
}

export interface DayEntry {
  date: string;
  originalText: string;
  correctedText: string;
  observations: string;
  mainErrors: string;
  difficulty: Difficulty;
  status: Status;
  wordCount: number;
  updatedAt: string;
}

export type EntriesStore = Record<string, DayEntry>;

export interface MonthStats {
  month: number;
  year: number;
  written: number;
  total: number;
  totalWords: number;
}

export interface DashboardStats {
  textsThisMonth: number;
  textsThisYear: number;
  currentStreak: number;
  bestStreak: number;
  totalWords: number;
  avgWords: number;
  monthlyStats: MonthStats[];
}
