import type { EpisodeSessionResponse } from '../execution/listening-execution-types';
import type { CEFRLevel } from '../../../domain/curriculum/cefr';
import type { ListeningLevelGroup } from '../listening-level-group';
import type { GroupGenerationStatus } from '../group-generation/listening-group-generation-types';

export type ListeningAssignmentStatus = 'assigned' | 'in_progress' | 'completed';

export type ListeningAssignment = {
  id: string;
  userId: string;
  episodeId: string;
  activityDate: string;
  status: ListeningAssignmentStatus;
  assignedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Snapshot of the ONE shared listening_generation_jobs row for the caller's
 *  level_group — never per-user. See src/services/listening/group-generation. */
export type ListeningGroupGenerationSummary = {
  jobId: string;
  status: GroupGenerationStatus;
  currentStep: string | null;
  progressPercent: number;
  attempts: number;
  maxAttempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
};

export type TodayListeningResponse =
  | {
      status: ListeningAssignmentStatus;
      assignmentId: string;
      episodeId: string;
      activityDate: string;
      session: EpisodeSessionResponse;
    }
  | { status: 'empty_inventory' }
  | { status: 'story_completed'; assignmentId: string; activityDate: string }
  | {
      status: 'group_generating';
      levelGroup: ListeningLevelGroup;
      targetLevel: CEFRLevel;
      groupJob: ListeningGroupGenerationSummary;
    };

export type ByDateListeningResponse =
  | {
      status: ListeningAssignmentStatus;
      assignmentId: string;
      episodeId: string;
      activityDate: string;
    }
  | { status: 'no_assignment' };

export type AssignmentResultResponse = {
  assignmentId: string;
  episodeId: string;
  activityDate: string;
  performanceScore: number;
  q1AttemptCycle: number;
  q2AttemptCycle: number;
  q1Weight: number;
  q2Weight: number;
  calculationVersion: string;
  calculatedAt: string;
};
