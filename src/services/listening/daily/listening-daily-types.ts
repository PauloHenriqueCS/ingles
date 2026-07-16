import type { EpisodeSessionResponse } from '../execution/listening-execution-types';

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

export type TodayListeningResponse =
  | {
      status: ListeningAssignmentStatus;
      assignmentId: string;
      episodeId: string;
      activityDate: string;
      session: EpisodeSessionResponse;
    }
  | { status: 'empty_inventory' }
  | { status: 'story_completed'; assignmentId: string; activityDate: string };

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
