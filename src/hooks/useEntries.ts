import { useState, useEffect, useCallback, useRef } from 'react';
import { DayEntry, EntriesStore } from '../types';
import { countWords } from '../utils/wordCount';
import { fetchAllEntries, upsertEntry } from '../lib/db';

function lsKey(userId: string): string {
  return `english-calendar-entries-v2-${userId}`;
}

function lsLoad(key: string): EntriesStore {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as EntriesStore) : {};
  } catch {
    return {};
  }
}

function lsSave(entries: EntriesStore, key: string): void {
  try {
    localStorage.setItem(key, JSON.stringify(entries));
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
    reviewedAt: null,
  };
}

export function useEntries(userId?: string) {
  const [entries, setEntries] = useState<EntriesStore>({});
  const [loading, setLoading] = useState(true);
  const [syncError, setSyncError] = useState<string | null>(null);
  const keyRef = useRef<string>('');

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }

    const key = lsKey(userId);
    keyRef.current = key;

    // Show cached data immediately while fetching
    const cached = lsLoad(key);
    if (Object.keys(cached).length > 0) {
      setEntries(cached);
    }

    setLoading(true);
    fetchAllEntries()
      .then((data) => {
        setEntries(data);
        lsSave(data, key);
        setSyncError(null);
      })
      .catch(() => {
        setSyncError('Sem conexão com a nuvem. Usando dados locais.');
      })
      .finally(() => setLoading(false));
  }, [userId]);

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
        if (keyRef.current) lsSave(next, keyRef.current);
        return next;
      });

      await upsertEntry(merged);
    },
    [entries],
  );

  return { entries, loading, syncError, getEntry, saveEntry };
}
