import { PenSquare, MessagesSquare, Headphones, AudioLines, Lock } from 'lucide-react';
import type { View } from '../types';
import { usePlanEntitlements } from '../hooks/usePlanEntitlements';
import type { PlanEntitlementsSnapshot } from '../domain/entitlements/entitlement-types';
import { ENTITLEMENT_MESSAGES } from '../domain/entitlements/entitlement-messages';

interface Props {
  onNavigate: (v: View) => void;
  onStartPractice: () => void;
}

type CardVisualState = 'loading' | 'available' | 'disabled_by_plan' | 'limit_reached';

function isExhausted(state: string): boolean {
  return state === 'daily_limit_reached' || state === 'monthly_limit_reached';
}

function writingCardState(entitlements: PlanEntitlementsSnapshot | null): CardVisualState {
  if (!entitlements) return 'loading';
  if (!entitlements.writing.enabled) return 'disabled_by_plan';
  const genExhausted = isExhausted(entitlements.writing.themeGenerations.state);
  const reviewsExhausted = isExhausted(entitlements.writing.reviews.state);
  return genExhausted && reviewsExhausted ? 'limit_reached' : 'available';
}

function listeningCardState(entitlements: PlanEntitlementsSnapshot | null): CardVisualState {
  if (!entitlements) return 'loading';
  if (!entitlements.listening.enabled) return 'disabled_by_plan';
  return isExhausted(entitlements.listening.stories.state) ? 'limit_reached' : 'available';
}

function pronunciationCardState(entitlements: PlanEntitlementsSnapshot | null): CardVisualState {
  if (!entitlements) return 'loading';
  if (!entitlements.pronunciation.enabled) return 'disabled_by_plan';
  return isExhausted(entitlements.pronunciation.evaluations.state) ? 'limit_reached' : 'available';
}

function conversationCardState(entitlements: PlanEntitlementsSnapshot | null): CardVisualState {
  if (!entitlements) return 'loading';
  if (!entitlements.conversation.enabled) return 'disabled_by_plan';
  return isExhausted(entitlements.conversation.monthlyTime.state) ? 'limit_reached' : 'available';
}

export default function HomePage({ onNavigate, onStartPractice }: Props) {
  const { data: entitlements, isLoading } = usePlanEntitlements();
  // Loading and "not yet resolved" both render the neutral loading state —
  // never a flash of a card looking available before the plan is known.
  const resolved = isLoading ? null : entitlements;

  return (
    <div className="p-4 pt-8 max-w-2xl mx-auto">

      {/* Page header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-100">O que você quer praticar hoje?</h1>
        <p className="text-slate-400 text-sm mt-2 leading-relaxed">
          Escolha uma atividade e continue sua evolução no inglês.
        </p>
      </div>

      {/* Activity cards — always all four, regardless of plan */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

        <ActivityCard
          state={writingCardState(resolved)}
          onClick={onStartPractice}
          accent="blue"
          icon={<PenSquare className="w-6 h-6 text-white shrink-0 transition-transform duration-150 group-hover:scale-105" strokeWidth={2} aria-hidden="true" />}
          title="Praticar escrita e voz"
          description="Receba uma missão, escreva seu texto, revise com a IA e treine sua pronúncia."
          cta="Começar prática"
          exhaustedBadge="Limite de hoje atingido"
        />

        <ActivityCard
          state={conversationCardState(resolved)}
          onClick={() => onNavigate('conversation')}
          accent="teal"
          icon={<MessagesSquare className="w-6 h-6 text-white shrink-0 transition-transform duration-150 group-hover:scale-105" strokeWidth={2} aria-hidden="true" />}
          title="Conversar com IA"
          description="Pratique inglês falado em uma conversa natural com seu tutor virtual."
          cta="Iniciar conversa"
          exhaustedBadge="Minutos esgotados"
        />

        <ActivityCard
          state={listeningCardState(resolved)}
          onClick={() => onNavigate('listening')}
          accent="purple"
          icon={<Headphones className="w-6 h-6 text-white shrink-0 transition-transform duration-150 group-hover:scale-105" strokeWidth={2} aria-hidden="true" />}
          title="Praticar listening"
          description="Ouça histórias em inglês, responda perguntas e treine sua compreensão auditiva."
          cta="Ouvir agora"
          exhaustedBadge="Limite de hoje atingido"
        />

        <ActivityCard
          state={pronunciationCardState(resolved)}
          onClick={() => onNavigate('pronunciation-training')}
          accent="orange"
          icon={<AudioLines className="w-6 h-6 text-white shrink-0 transition-transform duration-150 group-hover:scale-105" strokeWidth={2} aria-hidden="true" />}
          title="Treinar pronúncia"
          description="Leia um texto, descubra quais palavras precisam de atenção e pratique uma por uma."
          cta="Começar treino"
          exhaustedBadge="Limite de hoje atingido"
        />

      </div>
    </div>
  );
}

// ── Shared card ───────────────────────────────────────────────────────────────

const ACCENTS = {
  blue:   { border: 'hover:border-blue-600', ring: 'focus:ring-blue-500', grad: 'from-blue-500 to-blue-700', shadow: 'shadow-blue-900/40', text: 'text-blue-400 group-hover:text-blue-300' },
  teal:   { border: 'hover:border-teal-600', ring: 'focus:ring-teal-500', grad: 'from-teal-500 to-teal-700', shadow: 'shadow-teal-900/40', text: 'text-teal-400 group-hover:text-teal-300' },
  purple: { border: 'hover:border-purple-600', ring: 'focus:ring-purple-500', grad: 'from-purple-500 to-purple-700', shadow: 'shadow-purple-900/40', text: 'text-purple-400 group-hover:text-purple-300' },
  orange: { border: 'hover:border-orange-600', ring: 'focus:ring-orange-500', grad: 'from-orange-500 to-orange-700', shadow: 'shadow-orange-900/40', text: 'text-orange-400 group-hover:text-orange-300' },
} as const;

interface ActivityCardProps {
  state: CardVisualState;
  onClick: () => void;
  accent: keyof typeof ACCENTS;
  icon: React.ReactNode;
  title: string;
  description: string;
  cta: string;
  exhaustedBadge: string;
}

function ActivityCard({ state, onClick, accent, icon, title, description, cta, exhaustedBadge }: ActivityCardProps) {
  const a = ACCENTS[accent];
  const isDisabledByPlan = state === 'disabled_by_plan';
  const isLimitReached = state === 'limit_reached';
  const isDimmed = state === 'loading' || isDisabledByPlan || isLimitReached;

  function handleClick() {
    if (state === 'loading') return; // avoid starting an action before the plan is known
    if (isDisabledByPlan) {
      window.alert(ENTITLEMENT_MESSAGES.featureUnavailable);
      return;
    }
    // limit_reached and available both navigate through — the destination
    // screen itself already distinguishes "start new" (blocked) from
    // "continue/use what you have" (still allowed).
    onClick();
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-disabled={isDisabledByPlan || state === 'loading'}
      className={`group text-left bg-slate-800 border border-slate-700 rounded-2xl p-6 transition-all duration-200 focus:outline-none focus:ring-2 ${a.ring} focus:ring-offset-2 focus:ring-offset-slate-900 ${
        isDimmed ? 'opacity-60' : `${a.border} hover:bg-slate-700/60`
      }`}
    >
      <div className="flex items-center justify-between mb-5">
        <div className={`flex items-center justify-center w-14 h-14 rounded-xl bg-gradient-to-br ${a.grad} shadow-lg ${a.shadow} ${isDimmed ? 'grayscale' : ''}`}>
          {isDisabledByPlan ? <Lock className="w-6 h-6 text-white shrink-0" strokeWidth={2} aria-hidden="true" /> : icon}
        </div>
        {isDisabledByPlan && (
          <span className="px-2 py-0.5 rounded bg-slate-700 text-slate-400 text-xs font-medium">
            {ENTITLEMENT_MESSAGES.notIncludedInPlanBadge}
          </span>
        )}
        {isLimitReached && (
          <span className="px-2 py-0.5 rounded bg-amber-900/40 border border-amber-800/40 text-amber-300 text-xs font-medium">
            {exhaustedBadge}
          </span>
        )}
      </div>

      <h2 className="text-base font-semibold text-slate-100 mb-2">{title}</h2>
      <p className="text-sm text-slate-400 leading-relaxed mb-6">{description}</p>

      <span className={`inline-flex items-center gap-1 text-sm font-medium transition-colors ${isDimmed ? 'text-slate-500' : a.text}`}>
        {cta}
        <span aria-hidden="true">→</span>
      </span>
    </button>
  );
}
