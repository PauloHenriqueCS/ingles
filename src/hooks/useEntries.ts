import { useState, useEffect, useCallback } from 'react';
import { DayEntry, EntriesStore } from '../types';
import { countWords } from '../utils/wordCount';
import { fetchAllEntries, upsertEntry } from '../lib/db';

const LS_KEY = 'english-calendar-entries-v1';

function lsLoad(): EntriesStore {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as EntriesStore) : {};
  } catch {
    return {};
  }
}

function lsSave(entries: EntriesStore): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(entries));
  } catch {
    // ignore quota errors
  }
}

function makeDefault(date: string): DayEntry {
  return {
    date,
    title: '',
    originalText: '',
    correctedText: '',
    observations: '',
    mainErrors: '',
    difficulty: null,
    status: 'nao-iniciado',
    wordCount: 0,
    updatedAt: new Date().toISOString(),
    aiReview: null,
  };
}

export function useEntries() {
  const [entries, setEntries] = useState<EntriesStore>(lsLoad);
  const [loading, setLoading] = useState(true);
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    fetchAllEntries()
      .then((data) => {
        setEntries(data);
        lsSave(data);
        setSyncError(null);
      })
      .catch(() => {
        setSyncError('Sem conexão com a nuvem. Usando dados locais.');
      })
      .finally(() => setLoading(false));
  }, []);

  const getEntry = useCallback(
    (date: string): DayEntry | null => entries[date] ?? null,
    [entries],
  );

  const saveEntry = useCallback(
    async (patch: Partial<DayEntry> & { date: string }): Promise<void> => {
      const existing = entries[patch.date] ?? makeDefault(patch.date);
      const merged: DayEntry = {
        ...existing,
        ...patch,
        wordCount: countWords(patch.originalText ?? existing.originalText),
        updatedAt: new Date().toISOString(),
      };

      // Optimistic update
      setEntries((prev) => {
        const next = { ...prev, [merged.date]: merged };
        lsSave(next);
        return next;
      });

      await upsertEntry(merged);
    },
    [entries],
  );

  return { entries, loading, syncError, getEntry, saveEntry };
}
