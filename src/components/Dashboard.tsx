import { useState, useEffect, useMemo } from 'react';
import {
  Target, ArrowRight, Flame, ChevronRight,
  CheckCircle2, Circle, PenLine, MessagesSquare,
} from 'lucide-react';
import { EntriesStore, View, DayEntry } from '../types';
import type { EnglishLearningMemory } from '../types';
import { fetchLearningMemory } from '../lib/learningMemory';
import { getDayTotalSeconds, getConversationGoalMinutes } from '../lib/conversationSessions';
import { fetchCurrentStreak } from '../lib/activeDates';
import { getTodaySP } from '../lib/timezone';

interface Props {
  entries: EntriesStore;
  today: string;
  onOpenDay: (date: string) => void;
  onNavigate: (v: View) => void;
  activeWeekdays?: number[];
}

const SKILL_LABEL: Record<string, string> = {
  grammar: 'Gramática',
  vocabulary: 'Vocabulário',
  naturalness: 'Naturalidade',
  fluency: 'Fluência',
};

function getWeekActiveDates(today: string, activeWeekdays: number[]): string[] {
  const [y, m, d] = today.split('-').map(Number);
  const date = new Date(y, m - 1, d, 12, 0, 0);
  const dow = date.getDay();
  const monday = new Date(y, m - 1, d - (dow === 0 ? 6 : dow - 1), 12, 0, 0);
  const n = (v: number) => String(v).padStart(2, '0');
  const result: string[] = [];
  for (let i = 0; i < 7; i++) {
    const day = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i, 12, 0, 0);
    const dateStr = `${day.getFullYear()}-${n(day.getMonth() + 1)}-${n(day.getDate())}`;
    if (dateStr > today) break;
    if (activeWeekdays.includes(day.getDay())) result.push(dateStr);
  }
  return result;
}

export default function Dashboard({
  entries,
  today,
  onOpenDay,
  onNavigate,
  activeWeekdays = [1, 2, 3, 4, 5],
}: Props) {
  const effectiveToday = today || getTodaySP();

  const [memory, setMemory] = useState<EnglishLearningMemory | null>(null);
  const [memoryLoading, setMemoryLoading] = useState(true);
  const [convTotalSec, setConvTotalSec] = useState<number | null>(null);
  const [convGoalMin, setConvGoalMin] = useState(15);
  const [activeStreak, setActiveStreak] = useState<number | null>(null);

  useEffect(() => {
    setMemoryLoading(true);
    fetchLearningMemory()
      .then(setMemory)
      .catch(() => setMemory(null))
      .finally(() => setMemoryLoading(false));
    getDayTotalSeconds(effectiveToday).then(setConvTotalSec).catch(() => {});
    getConversationGoalMinutes().then(setConvGoalMin).catch(() => {});
    fetchCurrentStreak().then(setActiveStreak).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveToday]);

  const recentEntry = useMemo(
    () =>
      Object.values(entries)
        .filter((e) => e.originalText.trim().length > 0)
        .sort((a, b) => b.date.localeCompare(a.date))[0] ?? null,
    [entries],
  );

  const todayEntry = entries[effectiveToday];
  const todayWritten = !!todayEntry?.originalText?.trim();

  const weekDates = getWeekActiveDates(effectiveToday, activeWeekdays);
  const weekDone = weekDates.filter((d) => !!entries[d]?.originalText?.trim()).length;

  const convGoalSec = convGoalMin * 60;
  const convDone = convTotalSec !== null && convTotalSec >= convGoalSec;

  const hasReviews = memory !== null && memory.totalReviews > 0;
  const hasRecommendation =
    memory !== null && memory.totalReviews > 0 && memory.weakestSkill !== null;
  const hasAnything = recentEntry !== null || weekDone > 0;
  const isEmpty = !hasAnything && !hasReviews && !memoryLoading;
  const streak = activeStreak ?? memory?.currentStreak ?? 0;

  if (isEmpty) {
    return (
      <div className="min-h-screen bg-slate-900">
        <div className="p-4 max-w-lg mx-auto w-full">
          <h1 className="text-lg font-semibold text-slate-100 pt-2 mb-6">Início</h1>
          <div className="bg-slate-800 rounded-xl p-8 text-center space-y-4">
            <div className="w-12 h-12 bg-blue-900/40 rounded-full flex items-center justify-center mx-auto">
              <Target className="w-6 h-6 text-blue-400" strokeWidth={1.5} aria-hidden="true" />
            </div>
            <div className="space-y-1">
              <p className="text-slate-200 font-medium">Nenhuma atividade ainda</p>
              <p className="text-slate-500 text-sm leading-relaxed">
                Escreva seu primeiro texto para começar a acompanhar seu progresso.
              </p>
            </div>
            <button
              onClick={() => onOpenDay(effectiveToday)}
              className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-xl transition-colors"
            >
              Começar agora
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900">
      <div className="p-4 max-w-lg mx-auto w-full space-y-4 pb-20">
        <h1 className="text-lg font-semibold text-slate-100 pt-2">Início</h1>

        {/* 1. Próximo treino recomendado */}
        {memoryLoading ? (
          <div className="bg-slate-800 rounded-xl p-4 space-y-2.5 animate-pulse">
            <div className="h-3 bg-slate-700 rounded w-24" />
            <div className="h-3 bg-slate-700 rounded w-full" />
            <div className="h-3 bg-slate-700 rounded w-3/4" />
            <div className="h-8 bg-slate-700 rounded-xl w-32 mt-1" />
          </div>
        ) : hasRecommendation ? (
          <div className="bg-amber-950/40 border border-amber-800/30 rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <Target className="w-4 h-4 text-amber-400 shrink-0" strokeWidth={2} aria-hidden="true" />
              <span className="text-xs font-medium text-amber-400 uppercase tracking-wide">
                Próximo treino
              </span>
              <span className="ml-auto px-2 py-0.5 bg-amber-900/50 text-amber-300 text-xs font-medium rounded">
                {SKILL_LABEL[memory!.weakestSkill!] ?? memory!.weakestSkill}
              </span>
            </div>
            <p className="text-slate-300 text-sm leading-snug line-clamp-2">
              {memory!.recommendedNextFocus}
            </p>
            {memory!.recommendedNextTheme && (
              <div className="bg-slate-800/60 rounded-lg px-3 py-2.5">
                <p className="text-xs text-slate-500 mb-0.5">Exercício sugerido</p>
                <p className="text-sm text-slate-200">{memory!.recommendedNextTheme}</p>
              </div>
            )}
            <button
              onClick={() => onOpenDay(effectiveToday)}
              className="flex items-center gap-1.5 px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium rounded-xl transition-colors"
            >
              Treinar agora
              <ArrowRight className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        ) : (
          <div className="bg-slate-800 rounded-xl p-4 space-y-2">
            <div className="flex items-center gap-2">
              <Target className="w-4 h-4 text-slate-500 shrink-0" strokeWidth={2} aria-hidden="true" />
              <span className="text-sm font-medium text-slate-400">Próximo treino</span>
            </div>
            <p className="text-slate-500 text-sm leading-relaxed">
              Conclua pelo menos uma avaliação de IA para receber recomendações personalizadas.
            </p>
            <button
              onClick={() => onOpenDay(effectiveToday)}
              className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              Escrever agora
              <ArrowRight className="w-3 h-3 shrink-0" strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        )}

        {/* 2. Progresso de hoje / semana */}
        <div className="bg-slate-800 rounded-xl overflow-hidden">
          <div className="p-4 space-y-3">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Hoje</p>
            <div className="flex flex-wrap gap-2">
              <ActivityPill
                label={todayWritten ? 'Escrita concluída' : 'Escrita pendente'}
                done={todayWritten}
                icon="writing"
                onClick={() => onOpenDay(effectiveToday)}
              />
              {convTotalSec !== null && (
                <ActivityPill
                  label={
                    convDone
                      ? 'Conversa concluída'
                      : convTotalSec > 0
                      ? `Conversa ${Math.floor(convTotalSec / 60)}/${convGoalMin} min`
                      : 'Conversa pendente'
                  }
                  done={convDone}
                  icon="conversation"
                />
              )}
            </div>
          </div>
          {weekDates.length > 0 && (
            <button
              onClick={() => onNavigate('month')}
              className="w-full flex items-center justify-between px-4 py-3 border-t border-slate-700 hover:bg-slate-700/50 transition-colors"
            >
              <span className="text-xs text-slate-400">
                Esta semana:{' '}
                <span
                  className={
                    weekDone === weekDates.length && weekDates.length > 0
                      ? 'text-green-400 font-medium'
                      : 'text-slate-200'
                  }
                >
                  {weekDone} de {weekDates.length} dias
                </span>
              </span>
              <ChevronRight
                className="w-3.5 h-3.5 text-slate-500 shrink-0"
                strokeWidth={2}
                aria-hidden="true"
              />
            </button>
          )}
        </div>

        {/* 3. Resumo compacto */}
        {hasReviews && memory && (
          <div className="flex gap-2">
            <button
              onClick={() => onNavigate('evolution')}
              className="flex-1 bg-slate-800 rounded-xl p-3 text-left hover:bg-slate-700/80 transition-colors min-w-0"
            >
              <p className="text-xs text-slate-500 mb-0.5">Nível</p>
              <p className="text-base font-bold text-blue-400">{memory.currentLevel}</p>
            </button>
            <button
              onClick={() => onNavigate('evolution')}
              className="flex-1 bg-slate-800 rounded-xl p-3 text-left hover:bg-slate-700/80 transition-colors min-w-0"
            >
              <p className="text-xs text-slate-500 mb-0.5 truncate">
                Média · {memory.totalReviews} av.
              </p>
              <p
                className={`text-base font-bold tabular-nums ${
                  memory.averageScore >= 75
                    ? 'text-green-400'
                    : memory.averageScore >= 50
                    ? 'text-amber-400'
                    : 'text-red-400'
                }`}
              >
                {memory.averageScore}
              </p>
            </button>
            {streak > 0 && (
              <button
                onClick={() => onNavigate('month')}
                className="flex-1 bg-slate-800 rounded-xl p-3 text-left hover:bg-slate-700/80 transition-colors min-w-0"
              >
                <p className="text-xs text-slate-500 mb-0.5">Sequência</p>
                <p className="text-base font-bold text-orange-400 flex items-center gap-1">
                  <Flame
                    className="w-3.5 h-3.5 shrink-0"
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                  {streak}d
                </p>
              </button>
            )}
          </div>
        )}

        {/* 4. Atividade mais recente */}
        {recentEntry && (
          <RecentActivityCard
            entry={recentEntry}
            onOpen={() => onOpenDay(recentEntry.date)}
          />
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

type ActivityIcon = 'writing' | 'conversation';

function ActivityPill({
  label,
  done,
  icon,
  onClick,
}: {
  label: string;
  done: boolean;
  icon: ActivityIcon;
  onClick?: () => void;
}) {
  const TypeIcon = icon === 'writing' ? PenLine : MessagesSquare;
  const StatusIcon = done ? CheckCircle2 : Circle;

  const cls = `flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
    done ? 'bg-green-900/40 text-green-300' : 'bg-slate-700 text-slate-400'
  }`;

  const inner = (
    <>
      <TypeIcon className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
      <span>{label}</span>
      <StatusIcon
        className={`w-3.5 h-3.5 shrink-0 ${done ? 'text-green-400' : 'text-slate-600'}`}
        strokeWidth={2}
        aria-hidden="true"
      />
    </>
  );

  return onClick ? (
    <button onClick={onClick} className={`${cls} hover:opacity-80`}>
      {inner}
    </button>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

function RecentActivityCard({
  entry,
  onOpen,
}: {
  entry: DayEntry;
  onOpen: () => void;
}) {
  const hasReview = entry.aiReview !== null;
  const isRevisado = entry.status === 'revisado';
  const dateStr = new Date(entry.date + 'T12:00:00').toLocaleDateString('pt-BR', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
  });
  const preview =
    entry.title.trim() ||
    entry.originalText.slice(0, 60) + (entry.originalText.length > 60 ? '…' : '');
  const btnLabel = isRevisado ? 'Ver' : hasReview ? 'Ver resultado' : 'Continuar';

  return (
    <div className="bg-slate-800 rounded-xl p-4 space-y-3">
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">
        Última atividade
      </p>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-slate-500 mb-0.5 capitalize">{dateStr}</p>
          <p className="text-sm text-slate-200 truncate">{preview}</p>
          {hasReview && (
            <p
              className={`text-xs font-semibold tabular-nums mt-0.5 ${
                entry.aiReview!.score >= 75
                  ? 'text-green-400'
                  : entry.aiReview!.score >= 50
                  ? 'text-amber-400'
                  : 'text-red-400'
              }`}
            >
              Nota {entry.aiReview!.score}
            </p>
          )}
        </div>
        <button
          onClick={onOpen}
          className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
        >
          {btnLabel}
        </button>
      </div>
    </div>
  );
}
