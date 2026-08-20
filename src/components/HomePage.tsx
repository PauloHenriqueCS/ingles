import { PenSquare, MessagesSquare, Headphones, AudioLines, Repeat2 } from 'lucide-react';
import type { View } from '../types';
import { usePlanEntitlements } from '../hooks/usePlanEntitlements';
import { ENTITLEMENT_MESSAGES } from '../domain/entitlements/entitlement-messages';
import { usePublicConfig } from '../hooks/usePublicConfig';
import { useErrorReviewSummary } from '../hooks/useErrorReviewSummary';
import { useCurriculumFocus } from '../hooks/useCurriculumFocus';
import { useStreak } from '../hooks/useStreak';
import { homeUiStrings } from '../i18n/homeUiStrings';
import StreakCard from './home/StreakCard';
import CurrentFocus from './home/CurrentFocus';
import RecommendedPractice from './home/RecommendedPractice';
import PracticeRow from './home/PracticeRow';
import { type AccentKey } from './home/accents';
import {
  activityState,
  limitReachedBadgeLabel,
  resolveRecommendedActivity,
  secondaryBadge,
  type CardVisualState,
  type CurricularActivityKey,
  type PracticeBadge,
} from './home/practiceAvailability';

interface Props {
  onNavigate: (v: View) => void;
  onStartPractice: () => void;
  /** The user's learning days, so the streak treats planned rest days like the calendar. */
  activeWeekdays: number[];
}

// Central de Configuração feature-flag key per curricular activity.
const CONFIG_FLAG: Record<CurricularActivityKey, 'features.writing' | 'features.conversation' | 'features.listening' | 'features.pronunciation'> = {
  writing: 'features.writing',
  conversation: 'features.conversation',
  listening: 'features.listening',
  pronunciation: 'features.pronunciation',
};

const ACCENT: Record<CurricularActivityKey, AccentKey> = {
  writing: 'blue',
  conversation: 'teal',
  listening: 'purple',
  pronunciation: 'orange',
};

// Fixed display order of the secondary curricular rows (the hero is removed from
// this list at render time).
const CURRICULAR_ORDER: CurricularActivityKey[] = ['writing', 'conversation', 'listening', 'pronunciation'];

export default function HomePage({ onNavigate, onStartPractice, activeWeekdays }: Props) {
  const { data: entitlements, isLoading } = usePlanEntitlements();
  const { config } = usePublicConfig();
  const errorReview = useErrorReviewSummary();
  const focus = useCurriculumFocus();
  const { streak, loading: streakLoading } = useStreak(activeWeekdays);

  // Loading and "not yet resolved" both render the neutral loading state — never
  // a flash of a card looking available before the plan is known.
  const resolved = isLoading ? null : entitlements;
  const s = homeUiStrings(focus.data?.interfaceLanguage);

  const icon = (key: CurricularActivityKey, size: string) => {
    const cls = `${size} text-white shrink-0`;
    switch (key) {
      case 'writing': return <PenSquare className={cls} strokeWidth={2} aria-hidden="true" />;
      case 'conversation': return <MessagesSquare className={cls} strokeWidth={2} aria-hidden="true" />;
      case 'listening': return <Headphones className={cls} strokeWidth={2} aria-hidden="true" />;
      case 'pronunciation': return <AudioLines className={cls} strokeWidth={2} aria-hidden="true" />;
    }
  };

  const titleOf: Record<CurricularActivityKey, string> = {
    writing: s.writingTitle,
    conversation: s.conversationTitle,
    listening: s.listeningTitle,
    pronunciation: s.pronunciationTitle,
  };
  const descOf: Record<CurricularActivityKey, string> = {
    writing: s.writingDesc,
    conversation: s.conversationDesc,
    listening: s.listeningDesc,
    pronunciation: s.pronunciationDesc,
  };

  // Navigation intent per activity when it is startable.
  function navigateTo(key: CurricularActivityKey) {
    switch (key) {
      case 'writing': return onStartPractice();
      case 'conversation': return onNavigate('conversation');
      case 'listening': return onNavigate('listening');
      case 'pronunciation': return onNavigate('pronunciation-training');
    }
  }

  // Same gating semantics as the previous ActivityCard: a blocked activity opens
  // the subscription screen (per-plan) or surfaces the configured unavailable
  // message (globally off); loading is inert; otherwise it starts.
  function handleActivityClick(key: CurricularActivityKey, state: CardVisualState) {
    if (state === 'loading') return;
    if (state === 'disabled_globally') {
      window.alert(config?.[CONFIG_FLAG[key]]?.unavailableMessage || ENTITLEMENT_MESSAGES.featureUnavailable);
      return;
    }
    if (state === 'disabled_by_plan') {
      onNavigate('subscription');
      return;
    }
    // limit_reached and available both navigate through — the destination screen
    // distinguishes "start new" (blocked) from "use what you have" (allowed).
    navigateTo(key);
  }

  // ── Recommended hero ────────────────────────────────────────────────────────
  const heroKey = resolveRecommendedActivity(resolved, config);
  const heroState = activityState(heroKey, resolved, config);
  const heroStateBadge =
    heroState === 'limit_reached' ? limitReachedBadgeLabel(heroKey, s)
    : heroState === 'disabled_by_plan' ? s.notInPlan
    : heroState === 'disabled_globally' ? s.featureUnavailable
    : null;

  // ── Secondary rows: the other curricular activities + error review ──────────
  const secondaryKeys = CURRICULAR_ORDER.filter((k) => k !== heroKey);

  const errorReviewBadge: PracticeBadge | null = errorReview.loading
    ? null
    : (errorReview.available ?? 0) > 0
      ? { label: s.reviewsToDo(errorReview.available!), tone: 'positive' }
      : { label: s.allCaughtUp, tone: 'muted' };
  const errorReviewDesc = !errorReview.loading && (errorReview.available ?? 0) === 0
    ? s.errorReviewEmptyDesc
    : s.errorReviewDesc;

  return (
    <div className="p-4 pt-6 pb-10 max-w-2xl mx-auto">

      {/* Header: title + streak side by side (mobile-first) */}
      <div className="flex items-start justify-between gap-3 mb-5">
        <div className="min-w-0 flex-1 pt-1">
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-50 leading-tight break-words">{s.title}</h1>
          <p className="text-slate-400 text-sm mt-2 leading-relaxed">{s.subtitle}</p>
        </div>
        <StreakCard streak={streak} loading={streakLoading} s={s} />
      </div>

      {/* Foco atual — read-only context, not a button */}
      <div className="mb-6">
        <CurrentFocus data={focus.data} loading={focus.loading} error={focus.error} />
      </div>

      {/* Próxima recomendação — the prominent hero */}
      <section className="mb-6">
        <h2 className="text-base font-bold text-slate-100 mb-3">{s.nextRecommendation}</h2>
        <RecommendedPractice
          accent={ACCENT[heroKey]}
          icon={icon(heroKey, 'w-6 h-6')}
          title={titleOf[heroKey]}
          description={descOf[heroKey]}
          cta={s.startPractice}
          state={heroState}
          badgeLabel={heroState === 'available' ? s.recommendedBadge : null}
          stateBadge={heroStateBadge}
          onClick={() => handleActivityClick(heroKey, heroState)}
        />
      </section>

      {/* Outras práticas — compact rows */}
      <section>
        <h2 className="text-base font-bold text-slate-100 mb-3">{s.otherPractices}</h2>
        <div className="space-y-2.5">
          {secondaryKeys.map((key) => {
            const state = activityState(key, resolved, config);
            return (
              <PracticeRow
                key={key}
                accent={ACCENT[key]}
                icon={icon(key, 'w-5 h-5')}
                title={titleOf[key]}
                description={descOf[key]}
                state={state}
                badge={secondaryBadge(key, state, resolved, s)}
                onClick={() => handleActivityClick(key, state)}
              />
            );
          })}

          {/* Revisão de erros — independent, complementary activity: never plan-
              gated, never part of curricular progression. Always visible. */}
          <PracticeRow
            accent="emerald"
            icon={<Repeat2 className="w-5 h-5 text-white shrink-0" strokeWidth={2} aria-hidden="true" />}
            title={s.errorReviewTitle}
            description={errorReviewDesc}
            state={errorReview.loading ? 'loading' : 'available'}
            badge={errorReviewBadge}
            onClick={() => onNavigate('error-review')}
          />
        </div>
      </section>

    </div>
  );
}
