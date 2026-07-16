import { useState, useEffect } from 'react';
import { Target, TrendingUp, PenLine, Mic, MessagesSquare } from 'lucide-react';
import { EntriesStore, EnglishLearningMemory } from '../types';
import { computeStats } from '../utils/stats';
import { MONTH_NAMES_PT } from '../data/calendar2026';
import { fetchLearningMemory } from '../lib/learningMemory';
import { getDayTotalSeconds, getConversationGoalMinutes } from '../lib/conversationSessions';
import { fetchSkillsOverview, SkillOverview, SkillProgressStatus } from '../lib/dashboardSkillsService';
import { getTodaySP } from '../lib/timezone';
import { fetchCurrentStreak } from '../lib/activeDates';

interface Props {
  entries: EntriesStore;
  today: string;
  onOpenDay: (date: string) => void;
  activeWeekdays?: number[];
}

function skillLabel(skill: string): string {
  if (skill === 'writing') return 'Escrita';
  if (skill === 'pronunciation') return 'Pronúncia';
  if (skill === 'conversation') return 'Conversação';
  return skill;
}

function skillIcon(skill: string) {
  if (skill === 'writing') return PenLine;
  if (skill === 'pronunciation') return Mic;
  return MessagesSquare;
}

function statusMessage(status: SkillProgressStatus, skill: string): string {
  const label = skillLabel(skill);
  switch (status) {
    case 'insufficient_data':
      return `Ainda não há atividades suficientes para calcular seu progresso em ${label.toLowerCase()}.`;
    case 'evaluation_pending':
      return 'Estamos atualizando seu progresso com base nas atividades mais recentes.';
    case 'pending_recalibration':
      return 'Seu nível está sendo recalculado com as novas regras.';
    case 'ready_for_promotion':
      return 'Você cumpriu os requisitos deste nível!';
    case 'maximum_supported_level':
      return 'Você alcançou o nível mais alto disponível no Lemon.';
    case 'configuration_error':
      return 'Não foi possível calcular seu progresso neste momento.';
    case 'legacy_data':
      return 'Dados sendo migrados para o novo sistema.';
    default:
      return '';
  }
}

function SkillCard({ skill }: { skill: SkillOverview }) {
  const Icon = skillIcon(skill.skill);
  const label = skillLabel(skill.skill);
  const pct = skill.progressPercent != null ? Math.round(skill.progressPercent) : null;
  const conf = skill.confidence != null ? Math.round(skill.confidence * 100) : null;
  const msg = skill.status !== 'active' ? statusMessage(skill.status, skill.skill) : null;

  return (
    <div className="bg-slate-800 rounded-xl p-4 space-y-2.5">
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4 text-slate-400 shrink-0" strokeWidth={2} aria-hidden="true" />
        <span className="text-sm font-medium text-slate-200">{label}</span>
        {skill.currentLevel && (
          <span className="ml-auto px-2 py-0.5 bg-blue-900 text-blue-300 text-xs font-bold rounded">
            {skill.currentLevel}
          </span>
        )}
      </div>

      {skill.currentLevel && skill.targetLevel && (
        <p className="text-xs text-slate-400">
          {skill.currentLevel} → {skill.targetLevel}
        </p>
      )}

      {pct !== null && (
        <div>
          <div className="flex justify-between text-xs text-slate-400 mb-1">
            <span>Progresso</span>
            <span>{pct}%</span>
          </div>
          <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                pct >= 80 ? 'bg-green-500' : pct >= 50 ? 'bg-blue-500' : 'bg-amber-500'
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {skill.status === 'ready_for_promotion' && (
        <p className="text-xs text-green-400 font-medium">✓ Pronto para avançar</p>
      )}

      {msg && skill.status !== 'active' && skill.status !== 'ready_for_promotion' && (
        <p className="text-xs text-slate-400 leading-relaxed">{msg}</p>
      )}

      {skill.blockingReasons.length > 0 && (
        <div className="space-y-0.5">
          <p className="text-xs text-slate-500">Falta:</p>
          {skill.blockingReasons.slice(0, 3).map((r, i) => (
            <p key={i} className="text-xs text-slate-400 leading-snug">· {r}</p>
          ))}
        </div>
      )}

      {conf !== null && (
        <p className="text-xs text-slate-500">Confiança: {conf}%</p>
      )}
    </div>
  );
}

function SkillCardSkeleton() {
  return (
    <div className="bg-slate-800 rounded-xl p-4 space-y-2.5 animate-pulse">
      <div className="flex items-center gap-2">
        <div className="w-4 h-4 bg-slate-700 rounded" />
        <div className="h-3 bg-slate-700 rounded w-20" />
        <div className="ml-auto h-5 w-8 bg-slate-700 rounded" />
      </div>
      <div className="h-2 bg-slate-700 rounded-full" />
      <div className="h-3 bg-slate-700 rounded w-32" />
    </div>
  );
}

export default function Dashboard({ entries, today, onOpenDay, activeWeekdays = [1, 2, 3, 4, 5] }: Props) {
  const stats = computeStats(entries, undefined, activeWeekdays);
  const [memory, setMemory] = useState<EnglishLearningMemory | null>(null);
  const [convTotalSec, setConvTotalSec] = useState<number | null>(null);
  const [convGoalMin, setConvGoalMin] = useState<number>(15);
  const [skills, setSkills] = useState<SkillOverview[] | null>(null);
  const [skillsError, setSkillsError] = useState(false);
  const [activeStreak, setActiveStreak] = useState<number | null>(null);

  // Ensure today is always in São Paulo timezone
  const todaySP = getTodaySP();
  const effectiveToday = today || todaySP;

  useEffect(() => {
    fetchLearningMemory().then(setMemory).catch(() => {});
    getDayTotalSeconds(effectiveToday).then(setConvTotalSec).catch(() => {});
    getConversationGoalMinutes().then(setConvGoalMin).catch(() => {});
    fetchSkillsOverview().then(setSkills).catch(() => setSkillsError(true));
    fetchCurrentStreak().then(setActiveStreak).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveToday]);

  const recentWritten = Object.values(entries)
    .filter((e) => e.originalText.trim().length > 0)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5);

  const todayEntry = entries[effectiveToday];
  const todayWritten = todayEntry && todayEntry.originalText.trim().length > 0;
  const { aiStats } = stats;

  const hasAnySkillData = skills !== null && skills.some((s) => s.currentLevel !== null);

  return (
    <div className="p-4 max-w-lg mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-slate-100">Meu dashboard</h1>
        <p className="text-slate-400 text-sm mt-1">
          {new Date(effectiveToday + 'T12:00:00').toLocaleDateString('pt-BR', {
            weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
          })}
        </p>
      </div>

      {/* Today's entry */}
      <button
        onClick={() => onOpenDay(effectiveToday)}
        className={`w-full text-left rounded-lg p-4 mb-6 border transition-colors ${
          todayWritten
            ? 'bg-green-900/30 border-green-700'
            : 'bg-blue-900/30 border-blue-700'
        }`}
      >
        <p className="text-xs text-slate-400 mb-1">Hoje</p>
        <p className="font-medium text-slate-100">
          {todayWritten ? '✓ Texto do dia escrito' : 'Escrever texto de hoje →'}
        </p>
        {todayEntry?.originalText && (
          <p className="text-slate-400 text-sm mt-1 line-clamp-2">{todayEntry.originalText}</p>
        )}
      </button>

      {/* Conversation goal */}
      {convTotalSec !== null && (
        <div className="bg-slate-800 rounded-lg p-4 mb-6">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium text-slate-300">Conversa hoje</p>
            {convTotalSec >= convGoalMin * 60
              ? <span className="text-xs text-green-400 font-semibold">✓ Meta concluída</span>
              : <span className="text-xs text-slate-400">{Math.floor(convTotalSec / 60)}/{convGoalMin} min</span>
            }
          </div>
          <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${convTotalSec >= convGoalMin * 60 ? 'bg-green-500' : 'bg-blue-500'}`}
              style={{ width: `${Math.min(100, Math.round((convTotalSec / (convGoalMin * 60)) * 100))}%` }}
            />
          </div>
          {convTotalSec === 0 && (
            <p className="text-xs text-slate-500 mt-1.5">Nenhuma sessão hoje</p>
          )}
          {convTotalSec > 0 && convTotalSec < convGoalMin * 60 && (
            <p className="text-xs text-slate-500 mt-1.5">
              Faltam {Math.ceil(convGoalMin - convTotalSec / 60)} minuto{Math.ceil(convGoalMin - convTotalSec / 60) !== 1 ? 's' : ''}
            </p>
          )}
        </div>
      )}

      {/* Skill levels */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <TrendingUp className="w-4 h-4 text-slate-400" strokeWidth={2} aria-hidden="true" />
          <h2 className="text-sm font-medium text-slate-300">Nível por habilidade</h2>
        </div>

        {!skills && !skillsError && (
          <div className="space-y-3">
            <SkillCardSkeleton />
            <SkillCardSkeleton />
            <SkillCardSkeleton />
          </div>
        )}

        {skillsError && (
          <div className="bg-slate-800 rounded-xl p-4 text-center">
            <p className="text-xs text-slate-500">Não foi possível carregar os níveis agora.</p>
            <button
              onClick={() => {
                setSkillsError(false);
                fetchSkillsOverview().then(setSkills).catch(() => setSkillsError(true));
              }}
              className="text-xs text-blue-400 hover:text-blue-300 mt-1"
            >
              Tentar novamente
            </button>
          </div>
        )}

        {skills && !hasAnySkillData && (
          <div className="bg-slate-800 rounded-xl p-4 text-center space-y-1">
            <p className="text-sm text-slate-300">Nenhum nível avaliado ainda</p>
            <p className="text-xs text-slate-500">Conclua missões e atividades para calcular seu nível.</p>
          </div>
        )}

        {skills && hasAnySkillData && (
          <div className="space-y-3">
            {skills.map((s) => <SkillCard key={s.skill} skill={s} />)}
          </div>
        )}
      </div>

      {/* Writing stats */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        <StatCard label="Textos este mês" value={stats.textsThisMonth} />
        <StatCard label="Textos este ano" value={stats.textsThisYear} />
        <StatCard label="Sequência atual" value={activeStreak !== null ? `${activeStreak}d` : `${stats.currentStreak}d`} />
        <StatCard label="Maior sequência" value={`${stats.bestStreak}d`} />
        <StatCard label="Total de palavras" value={stats.totalWords.toLocaleString('pt-BR')} />
        <StatCard label="Média por texto" value={`${stats.avgWords} pal.`} />
      </div>

      {/* AI stats — shown only when at least one review exists */}
      {aiStats.reviewedCount > 0 && (
        <div className="bg-slate-800 rounded-lg p-4 mb-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-slate-300">Avaliação IA</h2>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">{aiStats.reviewedCount} revisões</span>
              {aiStats.latestLevel && (
                <span className="px-2 py-0.5 rounded bg-blue-900 text-blue-300 text-xs font-bold">
                  {aiStats.latestLevel}
                </span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <MiniScoreCard label="Nota média" value={aiStats.avgScore} />
            <MiniScoreCard label="Gramática" value={aiStats.avgGrammar} />
            <MiniScoreCard label="Vocabulário" value={aiStats.avgVocabulary} />
            <MiniScoreCard label="Naturalidade" value={aiStats.avgNaturalness} />
            <MiniScoreCard label="Fluência" value={aiStats.avgFluency} />
          </div>

          {/* Monthly evolution */}
          {aiStats.monthlyAvgScores.some((m) => m.count > 0) && (
            <div>
              <p className="text-xs text-slate-500 mb-2">Evolução mensal</p>
              <div className="space-y-1.5">
                {aiStats.monthlyAvgScores
                  .filter((m) => m.count > 0)
                  .map((m) => (
                    <div key={m.month} className="flex items-center gap-2">
                      <span className="text-xs text-slate-400 w-8">{MONTH_NAMES_PT[m.month - 1].slice(0, 3)}</span>
                      <div className="flex-1 h-2 bg-slate-700 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            m.avgScore >= 75 ? 'bg-green-500' :
                            m.avgScore >= 50 ? 'bg-amber-500' : 'bg-red-500'
                          }`}
                          style={{ width: `${m.avgScore}%` }}
                        />
                      </div>
                      <span className="text-xs text-slate-400 w-8 text-right tabular-nums">{m.avgScore}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Recommended focus from learning memory */}
      {memory?.recommendedNextFocus && (
        <div className="bg-amber-900/20 border border-amber-800/30 rounded-lg p-4 mb-6">
          <div className="flex items-center gap-2 mb-2">
            <Target className="w-4 h-4 shrink-0 text-amber-400" strokeWidth={2} aria-hidden="true" />
            <h2 className="text-sm font-medium text-amber-400">Foco recomendado</h2>
          </div>
          <p className="text-slate-200 text-sm leading-relaxed">{memory.recommendedNextFocus}</p>
          {memory.recommendedNextTheme && (
            <p className="text-xs text-slate-500 mt-2 italic">{memory.recommendedNextTheme}</p>
          )}
        </div>
      )}

      {/* Monthly writing consistency */}
      {stats.monthlyStats.some((ms) => ms.total > 0) && (
        <div className="bg-slate-800 rounded-lg p-4 mb-6">
          <h2 className="text-sm font-medium text-slate-300 mb-3">Consistência mensal</h2>
          <div className="space-y-2">
            {stats.monthlyStats.map((ms) => {
              const pct = ms.total > 0 ? Math.round((ms.written / ms.total) * 100) : 0;
              return (
                <div key={ms.month} className="flex items-center gap-2">
                  <span className="text-xs text-slate-400 w-8">{MONTH_NAMES_PT[ms.month - 1].slice(0, 3)}</span>
                  <div className="flex-1 h-2 bg-slate-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-xs text-slate-400 w-16 text-right">
                    {ms.written}/{ms.total}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty state — no writing yet */}
      {recentWritten.length === 0 && (
        <div className="bg-slate-800 rounded-lg p-6 text-center mb-6">
          <p className="text-slate-300 text-sm mb-1">Nenhum texto ainda</p>
          <p className="text-slate-500 text-xs">Conclua sua primeira missão para começar a acompanhar sua evolução.</p>
        </div>
      )}

      {/* Recent entries */}
      {recentWritten.length > 0 && (
        <div className="bg-slate-800 rounded-lg p-4">
          <h2 className="text-sm font-medium text-slate-300 mb-3">Recentes</h2>
          <div className="space-y-2">
            {recentWritten.map((e) => (
              <button
                key={e.date}
                onClick={() => onOpenDay(e.date)}
                className="w-full text-left flex items-center gap-3 py-2 border-b border-slate-700 last:border-0"
              >
                <span className="text-xs text-slate-400 w-20 shrink-0">
                  {new Date(e.date + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}
                </span>
                <span className="text-sm text-slate-300 truncate flex-1">
                  {e.title ? e.title : e.originalText.slice(0, 60) + '…'}
                </span>
                <div className="flex items-center gap-2 shrink-0">
                  {e.aiReview && (
                    <span className={`text-xs font-bold tabular-nums ${
                      e.aiReview.score >= 75 ? 'text-green-400' :
                      e.aiReview.score >= 50 ? 'text-amber-400' : 'text-red-400'
                    }`}>{e.aiReview.score}</span>
                  )}
                  <StatusBadge status={e.status} />
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-slate-800 rounded-lg p-3">
      <p className="text-xs text-slate-400 mb-1">{label}</p>
      <p className="text-2xl font-bold text-slate-100">{value}</p>
    </div>
  );
}

function MiniScoreCard({ label, value }: { label: string; value: number }) {
  const color =
    value >= 75 ? 'text-green-400' :
    value >= 50 ? 'text-amber-400' : 'text-red-400';
  return (
    <div className="bg-slate-700/50 rounded-lg p-2.5">
      <p className="text-xs text-slate-500 mb-0.5">{label}</p>
      <p className={`text-xl font-bold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    'escrito': 'text-blue-400',
    'corrigido': 'text-amber-400',
    'revisado': 'text-green-400',
    'nao-iniciado': 'text-slate-500',
  };
  const labels: Record<string, string> = {
    'escrito': 'Escrito',
    'corrigido': 'Corrigido',
    'revisado': 'Revisado',
    'nao-iniciado': '—',
  };
  return <span className={`text-xs ${map[status] ?? ''}`}>{labels[status] ?? status}</span>;
}
