import type { WritingMission, MissionPublicSnapshot } from './mission-types';
import type { MissionStatus } from './mission-status';

export interface PublicWritingMissionDTO {
  id: string;
  status: MissionStatus;
  mode: string;
  snapshot: MissionPublicSnapshot;
  acceptedAt?: string;
  startedAt?: string;
  completedAt?: string;
}

export function buildPublicWritingMissionDTO(mission: WritingMission): PublicWritingMissionDTO {
  return {
    id: mission.id,
    status: mission.status,
    mode: mission.mode,
    snapshot: {
      title: mission.title,
      promptPtBR: mission.promptPtBR,
      level: mission.level,
      difficulty: mission.difficulty,
      suggestedWords: mission.suggestedWords,
      supportSentences: mission.supportSentences,
      mode: mission.mode,
    },
    acceptedAt: mission.acceptedAt,
    startedAt: mission.startedAt,
    completedAt: mission.completedAt,
  };
}

export function toPublicMissionStatusDTO(mission: WritingMission): { id: string; status: MissionStatus } {
  return {
    id: mission.id,
    status: mission.status,
  };
}
