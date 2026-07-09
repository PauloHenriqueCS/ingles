import { useState, useCallback } from 'react';
import { DayEntry, EntriesStore } from '../types';
import { countWords } from '../utils/wordCount';

const STORAGE_KEY = 'english-calendar-entries-v1';

function loadEntries(): EntriesStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as EntriesStore) : {};
  } catch {
    return {};
  }
}

function persist(entries: EntriesStore): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

export function useEntries() {
  const [entries, setEntries] = useState<EntriesStore>(loadEntries);

  const getEntry = useCallback((date: string): DayEntry | null => entries[date] ?? null, [entries]);

  const saveEntry = useCallback((patch: Partial<DayEntry> & { date: string }) => {
    setEntries((prev) => {
      const existing: DayEntry = prev[patch.date] ?? {
        date: patch.date,
        originalText: '',
        correctedText: '',
        observations: '',
        mainErrors: '',
        difficulty: null,
        status: 'nao-iniciado',
        wordCount: 0,
        updatedAt: new Date().toISOString(),
      };
      const merged: DayEntry = {
        ...existing,
        ...patch,
        wordCount: countWords(patch.originalText ?? existing.originalText),
        updatedAt: new Date().toISOString(),
      };
      const next = { ...prev, [patch.date]: merged };
      persist(next);
      return next;
    });
  }, []);

  return { entries, getEntry, saveEntry };
}
