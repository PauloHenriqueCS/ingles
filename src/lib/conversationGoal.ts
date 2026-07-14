export const AVAILABLE_CONVERSATION_GOALS = [5, 10, 15, 20, 30] as const;
export type ConversationGoalMinutes = (typeof AVAILABLE_CONVERSATION_GOALS)[number];
export const DEFAULT_CONVERSATION_GOAL_MINUTES: ConversationGoalMinutes = 15;
