import { useState, useEffect, useMemo } from 'react';
import { BookOpen, RefreshCw, Loader2, Search } from 'lucide-react';
import { EnglishLearningMemory, RecurringMistake, VocabularyItem, View } from '../types';
import { fetchLearningMemory, updateLearningMemory } from '../lib/learningMemory';
import type { LearningSettings } from '../lib/learningSettings';

// ── Types ─────────────────────────────────────────────────────────────────────

type LoadState = 'loading' | 'done' | 'empty' | 'error';
type TabKey = 'errors' | 'grammar' | 'vocabulary';

interface Props {
  onNavigate: (v: View) => void;
  onSettingsChange?: (settings: LearningSettings) => void;
}

const TABS: { key: TabKey; label: string }[] = [
  { key: 'errors',     label: 'Erros' },
  { key: 'grammar',    label: 'Gramática' },
  { key: 'vocabulary', label: 'Vocabulário' },
];

const PAGE_SIZE = 5;

// ── Main component ────────────────────────────────────────────────────────────

export default function MemoryView({ onNavigate: _nav, onSettingsChange: _onChange }: Props) {
  const [memory, setMemory] = useState<EnglishLearningMemory | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [isUpdating, setIsUpdating] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('errors');
  const [errorsPage, setErrorsPage] = useState(1);
  const [vocabSearch, setVocabSearch] = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    setLoadState('loading');
    setErrorsPage(1);
    try {
      const m = await fetchLearningMemory();
      if (m) { setMemory(m); setLoadState('done'); }
      else setLoadState('empty');
    } catch {
      setLoadState('error');
    }
  }

  async function update() {
    if (isUpdating) return;
    setIsUpdating(true);
    try {
      const m = await updateLearningMemory();
      setMemory(m);
      setLoadState('done');
      setErrorsPage(1);
    } catch {
      /* silent — UI keeps existing data */
    } finally {
      setIsUpdating(false);
    }
  }

  const visibleErrors = useMemo(() => {
    if (!memory) return [];
    return memory.recurringMistakes.slice(0, errorsPage * PAGE_SIZE);
  }, [memory, errorsPage]);

  const hasMoreErrors = memory
    ? visibleErrors.length < memory.recurringMistakes.length
    : false;

  const filteredVocab = useMemo(() => {
    if (!memory) return [];
    const q = vocabSearch.trim().toLowerCase();
    if (!q) return memory.vocabularyLearned;
    return memory.vocabularyLearned.filter(
      (v) =>
        v.word.toLowerCase().includes(q) ||
        v.meaningPtBr.toLowerCase().includes(q) ||
        (v.example ?? '').toLowerCase().includes(q),
    );
  }, [memory, vocabSearch]);

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      <header className="sticky top-0 bg-slate-800 border-b border-slate-700 px-4 py-3 z-10 space-y-2.5">
        <h1 className="text-base font-semibold text-slate-100">Revisão</h1>

        <div className="flex gap-1.5">
          {TABS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                activeTab === key
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-700 text-slate-400 hover:text-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <div className="flex-1 overflow-auto p-4 max-w-lg mx-auto w-full pb-20">
        {loadState === 'loading' && (
          <div className="flex flex-col items-center justify-center py-20 space-y-3">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-slate-400 text-sm">Carregando revisão…</p>
          </div>
        )}

        {loadState === 'error' && (
          <div className="bg-red-900/30 border border-red-800 rounded-xl p-6 text-center space-y-3">
            <p className="text-red-300 text-sm">Não foi possível carregar os dados de revisão.</p>
            <button
              onClick={load}
              className="text-xs text-slate-400 hover:text-slate-200 transition-colors"
            >
              Tentar novamente
            </button>
          </div>
        )}

        {loadState === 'empty' && (
          <div className="flex flex-col items-center justify-center py-16 text-center space-y-4">
            <BookOpen className="w-12 h-12 text-slate-500 shrink-0" strokeWidth={1.5} aria-hidden="true" />
            <p className="text-slate-300 font-medium">Ainda não há dados de revisão.</p>
            <p className="text-slate-500 text-sm">
              Os dados são gerados automaticamente após as suas avaliações.
            </p>
            <button
              onClick={update}
              disabled={isUpdating}
              className="mt-1 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-medium transition-colors"
            >
              {isUpdating ? 'Calculando…' : 'Calcular agora'}
            </button>
          </div>
        )}

        {loadState === 'done' && memory && (
          <div className="space-y-4">
            {activeTab === 'errors' && (
              <ErrorsTab
                mistakes={visibleErrors}
                hasMore={hasMoreErrors}
                onShowMore={() => setErrorsPage((p) => p + 1)}
              />
            )}

            {activeTab === 'grammar' && (
              <GrammarTab topics={memory.grammarFocus} />
            )}

            {activeTab === 'vocabulary' && (
              <VocabularyTab
                items={filteredVocab}
                total={memory.vocabularyLearned.length}
                search={vocabSearch}
                onSearchChange={setVocabSearch}
              />
            )}

            <button
              onClick={update}
              disabled={isUpdating}
              className="w-full py-2 rounded-xl text-xs text-slate-600 hover:text-slate-400 disabled:opacity-40 transition-colors flex items-center justify-center gap-1.5"
            >
              {isUpdating ? (
                <>
                  <Loader2 className="w-3 h-3 shrink-0 animate-spin" strokeWidth={2} aria-hidden="true" />
                  Atualizando…
                </>
              ) : (
                <>
                  <RefreshCw className="w-3 h-3 shrink-0" strokeWidth={2} aria-hidden="true" />
                  Atualizar análise
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Errors tab ────────────────────────────────────────────────────────────────

function ErrorsTab({
  mistakes,
  hasMore,
  onShowMore,
}: {
  mistakes: RecurringMistake[];
  hasMore: boolean;
  onShowMore: () => void;
}) {
  if (mistakes.length === 0) {
    return (
      <div className="bg-slate-800 rounded-xl p-6 text-center">
        <p className="text-slate-400 text-sm">Nenhum erro registrado ainda.</p>
        <p className="text-slate-500 text-xs mt-1">
          Os erros são extraídos das avaliações de IA dos seus textos.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="bg-slate-800 rounded-xl p-4 divide-y divide-slate-700">
        {mistakes.map((m, i) => (
          <MistakeCard key={i} mistake={m} />
        ))}
      </div>
      {hasMore && (
        <button
          onClick={onShowMore}
          className="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs text-slate-400 hover:text-slate-200 transition-colors"
        >
          Ver mais
        </button>
      )}
    </div>
  );
}

function MistakeCard({ mistake }: { mistake: RecurringMistake }) {
  return (
    <div className="py-4 first:pt-0 last:pb-0 space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        {mistake.count > 1 && (
          <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-red-900/40 text-red-400">
            {mistake.count}× recorrente
          </span>
        )}
        {mistake.lastSeen && (
          <span className="text-xs text-slate-600 ml-auto">
            {formatDate(mistake.lastSeen)}
          </span>
        )}
      </div>
      <div className="flex gap-2 text-xs">
        <span className="text-slate-500 shrink-0 w-16">Escrito:</span>
        <span className="text-red-400 italic">"{mistake.original}"</span>
      </div>
      <div className="flex gap-2 text-xs">
        <span className="text-slate-500 shrink-0 w-16">Correto:</span>
        <span className="text-green-400 italic">"{mistake.correct}"</span>
      </div>
      <p className="text-xs text-slate-400 leading-relaxed">{mistake.explanation}</p>
    </div>
  );
}

// ── Grammar tab ───────────────────────────────────────────────────────────────

function GrammarTab({ topics }: { topics: string[] }) {
  if (topics.length === 0) {
    return (
      <div className="bg-slate-800 rounded-xl p-6 text-center">
        <p className="text-slate-400 text-sm">Nenhum tópico identificado ainda.</p>
        <p className="text-slate-500 text-xs mt-1">
          Os tópicos gramaticais são detectados automaticamente nos seus erros.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-slate-800 rounded-xl p-4 space-y-3">
      <p className="text-xs text-slate-500">Tópicos identificados para revisão:</p>
      <div className="flex flex-wrap gap-2">
        {topics.map((topic, i) => (
          <span
            key={i}
            className="px-3 py-1.5 bg-purple-900/30 border border-purple-800/40 rounded-lg text-sm text-purple-300 font-medium"
          >
            {topic}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Vocabulary tab ────────────────────────────────────────────────────────────

function VocabularyTab({
  items,
  total,
  search,
  onSearchChange,
}: {
  items: VocabularyItem[];
  total: number;
  search: string;
  onSearchChange: (s: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="relative">
        <Search
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none"
          strokeWidth={2}
          aria-hidden="true"
        />
        <input
          type="search"
          placeholder="Buscar palavra…"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="w-full bg-slate-800 rounded-xl pl-9 pr-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      {items.length === 0 && search.trim() ? (
        <div className="bg-slate-800 rounded-xl p-6 text-center">
          <p className="text-slate-400 text-sm">Nenhuma palavra encontrada para "{search}".</p>
        </div>
      ) : items.length === 0 ? (
        <div className="bg-slate-800 rounded-xl p-6 text-center">
          <p className="text-slate-400 text-sm">
            Vocabulário aparecerá aqui após suas próximas revisões.
          </p>
        </div>
      ) : (
        <div className="bg-slate-800 rounded-xl p-4 space-y-1">
          <p className="text-xs text-slate-500 mb-3">
            {search.trim()
              ? `${items.length} de ${total} palavra${total !== 1 ? 's' : ''}`
              : `${total} palavra${total !== 1 ? 's' : ''}`}
          </p>
          <div className="divide-y divide-slate-700">
            {items.map((v, i) => (
              <VocabCard key={i} item={v} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function VocabCard({ item }: { item: VocabularyItem }) {
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-blue-400 font-semibold text-sm">{item.word}</span>
        <span className="text-slate-500 text-xs">{item.meaningPtBr}</span>
      </div>
      {item.example && (
        <p className="text-slate-400 text-xs italic mt-0.5">"{item.example}"</p>
      )}
    </div>
  );
}

// ── Helper ────────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
    });
  } catch {
    return '';
  }
}
