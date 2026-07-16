import { useState, useEffect, useMemo, ReactNode } from 'react';
import {
  FileText, AlertTriangle, Target, ArrowLeft, Zap, Check,
  Search, ChevronDown, ChevronUp, ExternalLink,
} from 'lucide-react';
import {
  EnglishReviewSaved, MissionSnapshot, RewriteComparisonResult,
  MainMistake, VocabularyItem, EntriesStore, Status, Difficulty,
} from '../types';
import { fetchEnglishReviews } from '../lib/reviewsHistory';
import { getScheduleForDate, ALL_VERB_TENSES } from '../data/calendar2026';

// ── Types ─────────────────────────────────────────────────────────────────────

interface UnifiedEntry {
  date: string;
  title: string;
  originalText: string;
  status: Status;
  wordCount: number;
  difficulty: Difficulty;
  verbTense: string;
  latestReview: EnglishReviewSaved | null;
  allReviews: EnglishReviewSaved[];
  hasVersion2: boolean;
}

type StatusFilter = 'todos' | 'nao-iniciado' | 'escrito' | 'corrigido' | 'pendente-revisao' | 'revisado';
type DiffFilter = 'todos' | 'facil' | 'medio' | 'dificil';

interface Props {
  entries: EntriesStore;
  onOpenDay: (date: string) => void;
}

const STATUS_BUTTONS: { value: StatusFilter; label: string }[] = [
  { value: 'todos',           label: 'Todos' },
  { value: 'nao-iniciado',   label: 'Não iniciado' },
  { value: 'escrito',        label: 'Escrito' },
  { value: 'corrigido',      label: 'Corrigido' },
  { value: 'pendente-revisao', label: 'Pendente de revisão' },
  { value: 'revisado',       label: 'Revisado' },
];

// ── Main component ────────────────────────────────────────────────────────────

export default function HistoryView({ entries, onOpenDay }: Props) {
  const [reviews, setReviews] = useState<EnglishReviewSaved[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'done' | 'error'>('loading');
  const [selected, setSelected] = useState<UnifiedEntry | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('todos');
  const [verbTenseFilter, setVerbTenseFilter] = useState('todos');
  const [diffFilter, setDiffFilter] = useState<DiffFilter>('todos');
  const [showMoreFilters, setShowMoreFilters] = useState(false);

  function loadReviews() {
    setLoadState('loading');
    fetchEnglishReviews()
      .then((data) => { setReviews(data); setLoadState('done'); })
      .catch(() => setLoadState('error'));
  }

  useEffect(() => { loadReviews(); }, []);

  const reviewsByDate = useMemo(() => {
    const map: Record<string, EnglishReviewSaved[]> = {};
    for (const r of reviews) {
      if (r.entryDate) {
        if (!map[r.entryDate]) map[r.entryDate] = [];
        map[r.entryDate].push(r);
      }
    }
    return map;
  }, [reviews]);

  const unifiedList = useMemo((): UnifiedEntry[] => {
    return Object.keys(entries)
      .sort()
      .reverse()
      .map((date) => {
        const entry = entries[date];
        const schedule = getScheduleForDate(date);
        const dateReviews = reviewsByDate[date] ?? [];
        return {
          date,
          title: entry.title || schedule?.theme || '',
          originalText: entry.originalText,
          status: entry.status,
          wordCount: entry.wordCount,
          difficulty: entry.difficulty,
          verbTense: schedule?.verbTense ?? '',
          latestReview: dateReviews[0] ?? null,
          allReviews: dateReviews,
          hasVersion2: dateReviews.some((r) => !!r.version2Text),
        };
      });
  }, [entries, reviewsByDate]);

  const filtered = useMemo(() => {
    return unifiedList.filter((item) => {
      const hasText = item.originalText.trim().length > 0;

      switch (statusFilter) {
        case 'nao-iniciado':
          if (item.status !== 'nao-iniciado') return false;
          break;
        case 'escrito':
          if (!hasText || item.status !== 'escrito') return false;
          break;
        case 'corrigido':
          if (!hasText || item.status !== 'corrigido') return false;
          break;
        case 'pendente-revisao':
          if (!hasText || item.latestReview === null || item.status === 'revisado') return false;
          break;
        case 'revisado':
          if (!hasText || item.status !== 'revisado') return false;
          break;
        default:
          if (!hasText) return false;
      }

      if (verbTenseFilter !== 'todos' && item.verbTense !== verbTenseFilter) return false;
      if (diffFilter !== 'todos' && item.difficulty !== diffFilter) return false;

      const q = search.trim().toLowerCase();
      if (q && !item.title.toLowerCase().includes(q) && !item.originalText.toLowerCase().includes(q)) {
        return false;
      }

      return true;
    });
  }, [unifiedList, statusFilter, verbTenseFilter, diffFilter, search]);

  if (selected) {
    return (
      <EntryDetail
        item={selected}
        onBack={() => setSelected(null)}
        onOpenDay={onOpenDay}
      />
    );
  }

  const hasExtraFilters = verbTenseFilter !== 'todos' || diffFilter !== 'todos';

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      <header className="sticky top-0 bg-slate-800 border-b border-slate-700 px-4 py-3 z-10 space-y-3">
        <h1 className="text-base font-semibold text-slate-100">Histórico</h1>

        <div className="relative">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none"
            strokeWidth={2}
            aria-hidden="true"
          />
          <input
            type="search"
            placeholder="Buscar por título ou conteúdo…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-slate-700 rounded-lg pl-9 pr-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div
          className="flex gap-2 overflow-x-auto pb-0.5"
          style={{ scrollbarWidth: 'none' }}
        >
          {STATUS_BUTTONS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setStatusFilter(value)}
              className={`px-3 py-1 rounded-full text-xs whitespace-nowrap shrink-0 transition-colors ${
                statusFilter === value
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <button
          onClick={() => setShowMoreFilters((v) => !v)}
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
        >
          {showMoreFilters
            ? <ChevronUp className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
            : <ChevronDown className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
          }
          Mais filtros
          {hasExtraFilters && <span className="w-1.5 h-1.5 rounded-full bg-blue-500 ml-0.5" />}
        </button>

        {showMoreFilters && (
          <div className="space-y-3 pt-1 border-t border-slate-700">
            <div>
              <p className="text-xs text-slate-500 mb-1.5">Tempo verbal</p>
              <select
                value={verbTenseFilter}
                onChange={(e) => setVerbTenseFilter(e.target.value)}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-slate-100 text-sm focus:outline-none focus:border-blue-500"
              >
                <option value="todos">Todos</option>
                {ALL_VERB_TENSES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div>
              <p className="text-xs text-slate-500 mb-1.5">Dificuldade</p>
              <div className="flex gap-2 flex-wrap">
                {(['todos', 'facil', 'medio', 'dificil'] as const).map((d) => (
                  <button
                    key={d}
                    onClick={() => setDiffFilter(d)}
                    className={`px-3 py-1.5 rounded-md text-xs transition-colors ${
                      diffFilter === d
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                    }`}
                  >
                    {d === 'todos' ? 'Todos' : d === 'facil' ? 'Fácil' : d === 'medio' ? 'Médio' : 'Difícil'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </header>

      <div className="flex-1 overflow-auto p-4 max-w-lg mx-auto w-full pb-20">
        {loadState === 'loading' && (
          <div className="flex flex-col items-center justify-center py-20 space-y-3">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-slate-400 text-sm">Carregando histórico…</p>
          </div>
        )}

        {loadState === 'error' && (
          <div className="bg-red-900/30 border border-red-800 rounded-xl p-6 text-center">
            <p className="text-red-300 text-sm">Não foi possível carregar o histórico.</p>
            <button
              onClick={loadReviews}
              className="mt-3 text-xs text-slate-400 hover:text-slate-200 transition-colors"
            >
              Tentar novamente
            </button>
          </div>
        )}

        {loadState === 'done' && (
          <>
            <p className="text-xs text-slate-500 mb-3">
              {filtered.length} resultado{filtered.length !== 1 ? 's' : ''}
            </p>
            <div className="space-y-3">
              {filtered.map((item) => (
                <EntryCard key={item.date} item={item} onOpen={() => setSelected(item)} />
              ))}
              {filtered.length === 0 && (
                <div className="flex flex-col items-center justify-center py-16 text-center space-y-2">
                  <FileText className="w-10 h-10 text-slate-600 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                  <p className="text-slate-300 text-sm font-medium">Nenhum resultado.</p>
                  <p className="text-slate-500 text-xs">Tente ajustar os filtros ou a busca.</p>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Entry card ────────────────────────────────────────────────────────────────

function EntryCard({ item, onOpen }: { item: UnifiedEntry; onOpen: () => void }) {
  const { latestReview } = item;

  const scoreColor =
    latestReview === null ? '' :
    latestReview.score >= 75 ? 'text-green-400' :
    latestReview.score >= 50 ? 'text-amber-400' : 'text-red-400';

  return (
    <button
      onClick={onOpen}
      className="w-full text-left bg-slate-800 rounded-xl p-4 space-y-2 hover:bg-slate-700 active:bg-slate-700 transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-slate-500">{formatDateEntry(item.date)}</p>
        <StatusBadge status={item.status} />
      </div>

      {item.title && (
        <p className="text-sm font-semibold text-slate-100 leading-snug">{item.title}</p>
      )}

      {item.originalText && (
        <p className="text-xs text-slate-500 leading-relaxed line-clamp-1">{item.originalText}</p>
      )}

      <div className="flex items-center gap-2 flex-wrap pt-0.5">
        {latestReview && (
          <>
            <span className={`text-sm font-bold tabular-nums ${scoreColor}`}>
              {latestReview.score}
            </span>
            <span className="px-1.5 py-0.5 rounded bg-blue-900 text-blue-300 text-xs font-bold">
              {latestReview.level}
            </span>
          </>
        )}
        {item.wordCount > 0 && (
          <span className="text-xs text-slate-600">{item.wordCount} pal.</span>
        )}
        {item.verbTense && (
          <span className="text-xs text-blue-800">{item.verbTense}</span>
        )}
        {item.difficulty && <EntryDiffBadge difficulty={item.difficulty} />}
        {item.hasVersion2 && (
          <span className="text-xs text-green-400 font-medium">V2</span>
        )}
        {item.allReviews.length > 1 && (
          <span className="text-xs text-slate-600">{item.allReviews.length} aval.</span>
        )}
      </div>
    </button>
  );
}

// ── Entry detail ──────────────────────────────────────────────────────────────

function EntryDetail({
  item,
  onBack,
  onOpenDay,
}: {
  item: UnifiedEntry;
  onBack: () => void;
  onOpenDay: (date: string) => void;
}) {
  const [reviewIndex, setReviewIndex] = useState(0);
  const currentReview = item.allReviews[reviewIndex] ?? null;
  const headerTitle = item.title || 'Texto sem título';

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      <header className="sticky top-0 bg-slate-800 border-b border-slate-700 px-4 py-3 flex items-center gap-3 z-10">
        <button
          onClick={onBack}
          className="text-slate-400 hover:text-slate-100 transition-colors"
          aria-label="Voltar"
        >
          <ArrowLeft className="w-5 h-5 shrink-0" strokeWidth={2} aria-hidden="true" />
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-100 truncate">{headerTitle}</p>
          <p className="text-xs text-slate-400">{formatDateEntry(item.date)}</p>
        </div>
        <StatusBadge status={item.status} />
      </header>

      <div className="flex-1 overflow-auto p-4 max-w-lg mx-auto w-full space-y-4 pb-10">
        <button
          onClick={() => onOpenDay(item.date)}
          className="w-full flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-slate-300 hover:text-slate-100 transition-colors"
        >
          <ExternalLink className="w-4 h-4 shrink-0" strokeWidth={2} aria-hidden="true" />
          Abrir para editar
        </button>

        <div className="flex gap-2 flex-wrap">
          {item.wordCount > 0 && (
            <span className="text-xs bg-slate-800 px-2 py-1 rounded-lg text-slate-400">
              {item.wordCount} palavras
            </span>
          )}
          {item.verbTense && (
            <span className="text-xs bg-slate-800 px-2 py-1 rounded-lg text-blue-400">
              {item.verbTense}
            </span>
          )}
          {item.difficulty && <EntryDiffBadge difficulty={item.difficulty} />}
        </div>

        {item.originalText && (
          <div className="bg-slate-800 rounded-xl p-4 space-y-2">
            <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Seu Texto</p>
            <p className="text-slate-300 text-sm leading-relaxed whitespace-pre-wrap">{item.originalText}</p>
          </div>
        )}

        {item.allReviews.length > 1 && (
          <div className="flex gap-2 flex-wrap">
            {item.allReviews.map((r, i) => (
              <button
                key={r.id}
                onClick={() => setReviewIndex(i)}
                className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${
                  reviewIndex === i
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                }`}
              >
                Avaliação {i + 1}
                <span className="ml-1 opacity-60">{formatDateShort(r.createdAt)}</span>
              </button>
            ))}
          </div>
        )}

        {currentReview ? (
          <ReviewContent review={currentReview} />
        ) : (
          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-6 text-center">
            <p className="text-xs text-slate-500">Nenhuma avaliação de IA ainda.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Review content ────────────────────────────────────────────────────────────

function ReviewContent({ review }: { review: EnglishReviewSaved }) {
  const scoreColor =
    review.score >= 75 ? 'text-green-400' :
    review.score >= 50 ? 'text-amber-400' : 'text-red-400';

  return (
    <>
      <div className="bg-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">Nota Geral</p>
            <span className={`text-5xl font-bold tabular-nums ${scoreColor}`}>{review.score}</span>
            <span className="text-slate-500 text-base">/100</span>
          </div>
          {review.difficulty && (
            <span className="text-xs text-slate-400 capitalize bg-slate-700 px-2 py-1 rounded-lg">
              {review.difficulty}
            </span>
          )}
        </div>
        <div className="space-y-2 pt-2 border-t border-slate-700">
          <ScoreBar label="Gramática" value={review.grammar} />
          <ScoreBar label="Vocabulário" value={review.vocabulary} />
          <ScoreBar label="Naturalidade" value={review.naturalness} />
          <ScoreBar label="Fluência" value={review.fluency} />
        </div>
      </div>

      {review.summary && (
        <div className="bg-blue-900/20 border border-blue-800/30 rounded-xl p-4 space-y-2">
          <p className="text-xs text-blue-400 font-medium uppercase tracking-wider">Resumo do Professor</p>
          <p className="text-slate-200 text-sm leading-relaxed">{review.summary}</p>
        </div>
      )}

      <MissionSnapshotSection mission={review.missionSnapshot} />

      {review.correctedText && (
        <div className="bg-slate-800 rounded-xl p-4 space-y-2">
          <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Texto Corrigido</p>
          <p className="text-slate-200 text-sm leading-relaxed whitespace-pre-wrap">{review.correctedText}</p>
        </div>
      )}

      {review.mainMistakes.length > 0 && (
        <MainMistakesCard items={review.mainMistakes} />
      )}

      {review.newVocabulary.length > 0 && (
        <VocabularyCard items={review.newVocabulary} />
      )}

      {review.objectiveFeedback && (
        <div className="bg-amber-900/20 border border-amber-800/30 rounded-xl p-4 space-y-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" strokeWidth={2} aria-hidden="true" />
            <p className="text-xs text-amber-400 font-medium uppercase tracking-wider">Feedback do Objetivo</p>
          </div>
          {review.objective && <p className="text-xs text-slate-500 italic">{review.objective}</p>}
          <p className="text-slate-200 text-sm leading-relaxed">{review.objectiveFeedback}</p>
        </div>
      )}

      {review.nextPractice && (
        <div className="bg-purple-900/20 border border-purple-800/30 rounded-xl p-4 space-y-2">
          <div className="flex items-center gap-2">
            <Target className="w-4 h-4 shrink-0 text-purple-400" strokeWidth={2} aria-hidden="true" />
            <p className="text-xs text-purple-400 font-medium uppercase tracking-wider">Próxima Prática</p>
          </div>
          <p className="text-slate-300 text-sm leading-relaxed">{review.nextPractice}</p>
        </div>
      )}

      {review.version2Text && (
        <div className="bg-slate-800 rounded-xl p-4 space-y-2">
          <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Versão 2</p>
          <p className="text-slate-300 text-sm leading-relaxed whitespace-pre-wrap">{review.version2Text}</p>
        </div>
      )}

      {review.version2Comparison && (
        <V2ComparisonCard comparison={review.version2Comparison} />
      )}
    </>
  );
}

// ── Mission snapshot section ──────────────────────────────────────────────────

function MissionSnapshotSection({ mission }: { mission: MissionSnapshot | null }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="bg-slate-800 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-700/50 transition-colors"
      >
        <span className="text-xs text-slate-400 font-medium uppercase tracking-wider">Missão realizada</span>
        <span className="text-xs text-slate-500">{open ? 'Ocultar' : 'Ver missão'}</span>
      </button>

      {open && (
        <div className="border-t border-slate-700 px-4 pb-4 pt-3 space-y-4">
          {!mission ? (
            <p className="text-xs text-slate-500 italic">A missão desta prática não foi registrada.</p>
          ) : (
            <MissionContent mission={mission} />
          )}
        </div>
      )}
    </div>
  );
}

function MissionContent({ mission }: { mission: MissionSnapshot }) {
  const hasSplit = !!(mission.missionSetup && mission.missionTask);

  return (
    <>
      <div className="space-y-2">
        <p className="text-slate-100 font-bold text-sm leading-snug">{mission.missionTitle}</p>
        <div className="flex items-center gap-2 flex-wrap">
          {mission.missionLevel && (
            <span className="px-2 py-0.5 rounded bg-blue-900 text-blue-300 text-xs font-bold">{mission.missionLevel}</span>
          )}
          {mission.missionDifficulty && <MissionDiffBadge difficulty={mission.missionDifficulty} />}
          {mission.missionFormat && (
            <span className="px-2 py-0.5 rounded bg-indigo-900/50 border border-indigo-700/40 text-indigo-300 text-xs font-medium capitalize">
              {mission.missionFormat.replace(/_/g, ' ')}
            </span>
          )}
          {mission.missionContext && (
            <span className="px-2 py-0.5 rounded bg-slate-700 text-slate-400 text-xs">
              {mission.missionContext.replace(/_/g, ' ')}
            </span>
          )}
        </div>
      </div>

      <div className="rounded-xl overflow-hidden border border-slate-600/50">
        {mission.missionConflict && (
          <div className="bg-amber-900/30 border-b border-amber-800/30 px-4 py-2 flex items-center gap-2">
            <Zap className="w-3.5 h-3.5 shrink-0 text-amber-400" strokeWidth={2} aria-hidden="true" />
            <span className="text-xs text-amber-300 font-medium">{mission.missionConflict}</span>
          </div>
        )}
        <div className="bg-slate-700/40 px-4 py-3 space-y-2">
          {hasSplit ? (
            <>
              <p className="text-sm text-slate-100 leading-relaxed font-medium">{mission.missionSetup}</p>
              <p className="text-sm text-slate-300 leading-relaxed">{mission.missionTask}</p>
            </>
          ) : (
            mission.missionPromptPt && (
              <p className="text-sm text-slate-200 leading-relaxed">{mission.missionPromptPt}</p>
            )
          )}
          {mission.missionGoal && (
            <div className="pt-1">
              <span className="text-xs text-slate-500">Objetivo: </span>
              <span className="text-xs text-slate-400">{mission.missionGoal}</span>
            </div>
          )}
        </div>
      </div>

      {mission.missionPromptEn && (
        <p className="text-sm text-blue-300 font-medium italic">{mission.missionPromptEn}</p>
      )}

      {mission.missionInstructions.length > 0 && (
        <MissionSection title="Como fazer">
          <ol className="space-y-1 list-decimal list-inside">
            {mission.missionInstructions.map((item, i) => (
              <li key={i} className="text-xs text-slate-300 leading-relaxed">{item}</li>
            ))}
          </ol>
        </MissionSection>
      )}

      {mission.missionGrammarTopics.length > 0 && (
        <MissionSection title="Gramática">
          <div className="flex flex-wrap gap-1.5">
            {mission.missionGrammarTopics.map((g, i) => (
              <span key={i} className="px-2 py-0.5 bg-purple-900/40 border border-purple-800/40 rounded text-xs text-purple-300">{g}</span>
            ))}
          </div>
        </MissionSection>
      )}

      {mission.missionUsefulVocabulary.length > 0 && (
        <MissionSection title="Vocabulário útil">
          <div className="space-y-1.5">
            {mission.missionUsefulVocabulary.map((v, i) => (
              <div key={i}>
                <div className="flex items-baseline gap-2">
                  <span className="text-blue-400 font-semibold text-xs">{v.word}</span>
                  <span className="text-slate-500 text-xs">{v.meaningPtBr}</span>
                </div>
                {v.example && <p className="text-slate-500 text-xs italic">"{v.example}"</p>}
              </div>
            ))}
          </div>
        </MissionSection>
      )}

      {mission.missionRequiredWords.length > 0 && (
        <MissionSection title="Palavras obrigatórias">
          <div className="flex flex-wrap gap-1.5">
            {mission.missionRequiredWords.map((w, i) => (
              <span key={i} className="px-2 py-0.5 bg-amber-900/40 border border-amber-800/40 rounded text-xs text-amber-300 font-mono">{w}</span>
            ))}
          </div>
        </MissionSection>
      )}

      {mission.missionExampleAnswers.length > 0 && (
        <MissionSection title="Exemplos de resposta">
          <div className="space-y-2">
            {mission.missionExampleAnswers.map((ex, i) => (
              <div key={i} className="rounded-lg bg-slate-700/30 border border-slate-600/30 px-3 py-2 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="px-1.5 py-0.5 rounded bg-blue-900/60 text-blue-300 text-xs font-bold">{ex.level}</span>
                  {ex.note && <span className="text-xs text-slate-500 italic">{ex.note}</span>}
                </div>
                <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">{ex.text}</p>
              </div>
            ))}
          </div>
        </MissionSection>
      )}

      {mission.missionCompletionCriteria.length > 0 && (
        <MissionSection title="Missão cumprida quando…">
          <ul className="space-y-1">
            {mission.missionCompletionCriteria.map((c, i) => (
              <li key={i} className="flex gap-2 text-xs text-slate-300">
                <Check className="w-3.5 h-3.5 shrink-0 text-green-500 mt-0.5" strokeWidth={2} aria-hidden="true" />
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </MissionSection>
      )}

      {mission.missionExtraChallenge && (
        <MissionSection title="Desafio extra">
          <p className="text-xs text-amber-400 leading-relaxed">{mission.missionExtraChallenge}</p>
        </MissionSection>
      )}
    </>
  );
}

// ── V2 comparison card ────────────────────────────────────────────────────────

function V2ComparisonCard({ comparison }: { comparison: RewriteComparisonResult }) {
  const scoreColor =
    comparison.improvementScore >= 75 ? 'text-green-400' :
    comparison.improvementScore >= 50 ? 'text-amber-400' : 'text-red-400';

  return (
    <div className="bg-slate-800 rounded-xl p-4 space-y-3">
      <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Resultado da Versão 2</p>
      <div className="flex items-center gap-4">
        <div>
          <span className={`text-4xl font-bold tabular-nums ${scoreColor}`}>{comparison.improvementScore}</span>
          <span className="text-slate-500 text-lg">/100</span>
        </div>
        <div className="flex gap-3 ml-auto">
          <div className="text-center">
            <p className="text-xl font-bold text-green-400 tabular-nums">{comparison.fixedMistakesCount}</p>
            <p className="text-xs text-slate-500">corrigidos</p>
          </div>
          <div className="text-center">
            <p className="text-xl font-bold text-amber-400 tabular-nums">{comparison.remainingMistakesCount}</p>
            <p className="text-xs text-slate-500">restantes</p>
          </div>
        </div>
      </div>
      {comparison.overallFeedback && (
        <p className="text-sm text-slate-300 leading-relaxed border-t border-slate-700 pt-3">
          {comparison.overallFeedback}
        </p>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ScoreBar({ label, value }: { label: string; value: number }) {
  const color = value >= 75 ? 'bg-green-500' : value >= 50 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-slate-400 w-24 shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${value}%` }} />
      </div>
      <span className="text-xs text-slate-300 w-7 text-right tabular-nums">{value}</span>
    </div>
  );
}

function MissionSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">{title}</p>
      {children}
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const config: Record<Status, { label: string; className: string }> = {
    'nao-iniciado': { label: 'Não iniciado', className: 'bg-slate-700 text-slate-400' },
    'escrito':      { label: 'Escrito',       className: 'bg-blue-900/50 text-blue-400' },
    'corrigido':    { label: 'Corrigido',     className: 'bg-amber-900/50 text-amber-400' },
    'revisado':     { label: 'Revisado',      className: 'bg-green-900/50 text-green-400' },
  };
  const { label, className } = config[status];
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${className}`}>
      {label}
    </span>
  );
}

function EntryDiffBadge({ difficulty }: { difficulty: NonNullable<Difficulty> }) {
  const config: Record<string, { label: string; className: string }> = {
    facil:   { label: 'Fácil',   className: 'bg-green-900/40 text-green-400' },
    medio:   { label: 'Médio',   className: 'bg-amber-900/40 text-amber-400' },
    dificil: { label: 'Difícil', className: 'bg-red-900/40 text-red-400' },
  };
  const c = config[difficulty];
  if (!c) return null;
  return (
    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${c.className}`}>
      {c.label}
    </span>
  );
}

function MissionDiffBadge({ difficulty }: { difficulty: 'easy' | 'medium' | 'hard' }) {
  const config: Record<string, { label: string; className: string }> = {
    easy:   { label: 'Fácil',   className: 'bg-green-900/40 text-green-400' },
    medium: { label: 'Médio',   className: 'bg-amber-900/40 text-amber-400' },
    hard:   { label: 'Difícil', className: 'bg-red-900/40 text-red-400' },
  };
  const c = config[difficulty] ?? { label: difficulty, className: 'bg-slate-700 text-slate-400' };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${c.className}`}>
      {c.label}
    </span>
  );
}

function MainMistakesCard({ items }: { items: MainMistake[] }) {
  return (
    <div className="bg-slate-800 rounded-xl p-4 space-y-4">
      <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Principais Erros</p>
      {items.map((item, i) => (
        <div key={i} className="space-y-1.5 border-b border-slate-700 last:border-0 pb-4 last:pb-0">
          <div className="flex gap-2 text-xs">
            <span className="text-slate-500 shrink-0 w-24">Você escreveu:</span>
            <span className="text-red-400 italic">"{item.original}"</span>
          </div>
          <div className="flex gap-2 text-xs">
            <span className="text-slate-500 shrink-0 w-24">Correção:</span>
            <span className="text-green-400 italic">"{item.correct}"</span>
          </div>
          <div className="flex gap-2 text-xs">
            <span className="text-slate-500 shrink-0 w-24">Explicação:</span>
            <span className="text-slate-300 leading-relaxed">{item.explanation}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function VocabularyCard({ items }: { items: VocabularyItem[] }) {
  return (
    <div className="bg-slate-800 rounded-xl p-4 space-y-3">
      <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Vocabulário Novo</p>
      <div className="space-y-3">
        {items.map((item, i) => (
          <div key={i} className="border-b border-slate-700 last:border-0 pb-3 last:pb-0">
            <div className="flex items-baseline gap-2 mb-0.5">
              <span className="text-blue-400 font-semibold text-sm">{item.word}</span>
              <span className="text-slate-500 text-xs">{item.meaningPtBr}</span>
            </div>
            <p className="text-slate-400 text-xs italic">"{item.example}"</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDateEntry(dateStr: string): string {
  try {
    return new Date(dateStr + 'T12:00:00').toLocaleDateString('pt-BR', {
      day: '2-digit', month: 'long', year: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

function formatDateShort(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  } catch {
    return '';
  }
}
