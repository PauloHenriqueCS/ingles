/**
 * Orchestration: given the activity that JUST genuinely completed (a confirmed,
 * server-persisted not-completed → completed transition), resolve which
 * celebration to show — 'day-complete' when this finished every obligatory
 * practice configured for today, otherwise 'activity-complete'.
 *
 * All I/O is injected (`deps`) so this is exhaustively unit-testable and so the
 * whole thing stays fail-safe: any failure degrades to a plain 'activity-
 * complete' (we can only ever UNDER-claim a completed day, never falsely
 * celebrate one). The just-finished activity is forced to "completed" locally,
 * so the decision never races the read-after-write of its own persist.
 */
import { fetchPlanEntitlements } from '../lib/planEntitlementsFetcher';
import { fetchCurrentStreak } from '../lib/activeDates';
import { fetchLearningSettings } from '../lib/learningSettings';
import { decideCelebrationLevel } from './decideCelebrationLevel';
import {
  buildQueryPlan,
  fetchObligatoryCompletion,
  type CompletionQueryPlan,
} from './fetchObligatoryCompletion';
import {
  type Celebration,
  type CelebrationActivityType,
  type ObligatoryCompletion,
  type ObligatoryFeatures,
  isObligatoryActivity,
} from './celebration-types';

export interface ResolveDeps {
  fetchFeatures: () => Promise<ObligatoryFeatures | null>;
  fetchCompletion: (plan: CompletionQueryPlan) => Promise<ObligatoryCompletion>;
  fetchStreak: () => Promise<number | null>;
}

const defaultDeps: ResolveDeps = {
  fetchFeatures: async () => {
    const ent = await fetchPlanEntitlements();
    return {
      writing: ent.writing.enabled,
      pronunciation: ent.pronunciation.enabled,
      listening: ent.listening.enabled,
    };
  },
  fetchCompletion: (plan) => fetchObligatoryCompletion(plan),
  fetchStreak: async () => {
    const settings = await fetchLearningSettings();
    return fetchCurrentStreak(settings.activeWeekdays);
  },
};

// Matches the calendar's own fail-safe default (ALL_FEATURES_ACTIVE): if we
// cannot read the plan, assume all three are required so we never falsely
// declare a day complete on partial information.
const ALL_ACTIVE: ObligatoryFeatures = {
  writing: true,
  pronunciation: true,
  listening: true,
};

export async function resolveActivityCelebration(
  activity: CelebrationActivityType,
  deps: ResolveDeps = defaultDeps,
): Promise<Celebration> {
  // Conversation and error-review are always optional — they can never, on their
  // own, complete a day, so there is nothing to fetch or compute.
  if (!isObligatoryActivity(activity)) {
    return { type: 'activity-complete', activityType: activity };
  }

  let features: ObligatoryFeatures = ALL_ACTIVE;
  try {
    const resolved = await deps.fetchFeatures();
    if (resolved) features = resolved;
  } catch {
    /* keep ALL_ACTIVE — conservative */
  }

  let completion: ObligatoryCompletion = {
    writing: false,
    pronunciation: false,
    listening: false,
  };
  try {
    completion = await deps.fetchCompletion(buildQueryPlan(features, activity));
  } catch {
    /* under-claim — safe */
  }
  // The activity that just finished is known-completed (confirmed persist).
  completion = { ...completion, [activity]: true };

  const decision = decideCelebrationLevel({ features, completion, justFinished: activity });

  if (decision.level === 'day-complete') {
    let streakDays: number | null = null;
    try {
      streakDays = await deps.fetchStreak();
    } catch {
      streakDays = null;
    }
    return {
      type: 'day-complete',
      streakDays,
      completedCount: decision.completedCount,
      totalCount: decision.totalCount,
    };
  }

  return {
    type: 'activity-complete',
    activityType: activity,
    completedCount: decision.completedCount,
    totalCount: decision.totalCount,
  };
}
