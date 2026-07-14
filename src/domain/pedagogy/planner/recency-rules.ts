import type { RecentMissionPlan } from './planner-types';
import {
  OBJECTIVE_RECENCY_WINDOW,
  TOPIC_RECENCY_WINDOW,
  CONTEXT_RECENCY_WINDOW,
} from './planner-constants';

/** Returns true if the objective was used in the recent plan window. */
export function isObjectiveRecentlyUsed(
  objectiveId: string,
  recentPlans: RecentMissionPlan[],
  window = OBJECTIVE_RECENCY_WINDOW,
): boolean {
  const relevant = recentPlans.slice(0, window);
  return relevant.some(p => p.communicativeObjectiveId === objectiveId);
}

/** Returns true if a grammar topic was used as primary in the recent plan window. */
export function isTopicRecentlyUsedAsPrimary(
  topicId: string,
  recentPlans: RecentMissionPlan[],
  window = TOPIC_RECENCY_WINDOW,
): boolean {
  const relevant = recentPlans.slice(0, window);
  return relevant.some(p => p.primaryTopicIds.includes(topicId));
}

/** Returns true if a context family was used in the recent plan window. */
export function isContextFamilyRecentlyUsed(
  contextFamily: string,
  recentPlans: RecentMissionPlan[],
  window = CONTEXT_RECENCY_WINDOW,
): boolean {
  const relevant = recentPlans.slice(0, window);
  return relevant.some(p => p.contextFamilies.includes(contextFamily));
}

/** Returns how many times a topic appeared as primary in recent plans. */
export function countRecentPrimaryUses(
  topicId: string,
  recentPlans: RecentMissionPlan[],
  window = TOPIC_RECENCY_WINDOW,
): number {
  return recentPlans.slice(0, window).filter(p => p.primaryTopicIds.includes(topicId)).length;
}

/** Returns context families NOT recently used — preferred for diversity. */
export function getAvailableContextFamilies(
  allFamilies: readonly string[],
  recentPlans: RecentMissionPlan[],
  window = CONTEXT_RECENCY_WINDOW,
): string[] {
  return allFamilies.filter(f => !isContextFamilyRecentlyUsed(f, recentPlans, window));
}
