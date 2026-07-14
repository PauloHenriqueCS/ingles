import type { MissionStatus } from './mission-status';

export type WritingMissionMode = 'normal' | 'review' | 'diagnostic';

export interface MissionPublicSnapshot {
  title: string;
  promptPtBR: string;
  level: string;
  difficulty: string;
  suggestedWords?: string[];
  supportSentences?: string[];
  mode: WritingMissionMode;
}

export interface MissionInternalSnapshot {
  planId?: string;
  topicIds?: string[];
  diagnosticPlan?: unknown;
  generationAttempts?: number;
  validationPassed?: boolean;
  validationWarnings?: string[];
  fallbackUsed?: boolean;
  templateId?: string;
}

export interface WritingMission {
  id: string;
  userId: string;
  skill: string;
  status: MissionStatus;
  mode: WritingMissionMode;

  // Content fields — frozen after acceptance
  title: string;
  promptPtBR: string;
  level: string;
  difficulty: string;
  suggestedWords?: string[];
  supportSentences?: string[];

  // References
  pedagogicalPlanId?: string;
  legacyThemeId?: string;

  // Timestamps
  generatedAt: string;
  acceptedAt?: string;
  startedAt?: string;
  completedAt?: string;
  skippedAt?: string;
  expiredAt?: string;
  cancelledAt?: string;

  // Server-only audit data
  internalSnapshot?: MissionInternalSnapshot;
}
