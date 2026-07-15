import {
  ListeningAttemptNumber,
  ListeningSubtitleMode,
  UserListeningProgress,
  UserListeningProgressStatus,
  ListeningQuestion,
  ListeningQuestionPublic,
} from './listening-types';
import { validateListeningAttemptNumber } from './listening-validation';

export { validateListeningActivityStructure } from './listening-validation';

export function getSubtitleModeForAttempt(attemptNumber: number): ListeningSubtitleMode {
  validateListeningAttemptNumber(attemptNumber);
  const map: Record<ListeningAttemptNumber, ListeningSubtitleMode> = {
    1: 'none',
    2: 'en',
    3: 'pt-BR',
  };
  return map[attemptNumber];
}

export function canAccessListeningBlock(
  progress: UserListeningProgress | null,
  blockOrder: 1 | 2
): boolean {
  if (blockOrder === 1) return true;
  return progress !== null && progress.block1CompletedAt !== null;
}

export function isListeningEpisodeCompleted(progress: UserListeningProgress | null): boolean {
  if (progress === null) return false;
  return (
    progress.status === 'completed' &&
    progress.block1CompletedAt !== null &&
    progress.block2CompletedAt !== null &&
    progress.completedAt !== null
  );
}

export function getNextListeningProgressState(
  progress: UserListeningProgress,
  completedBlock: 1 | 2
): UserListeningProgressStatus {
  if (completedBlock === 2 && progress.block1CompletedAt === null) {
    throw new TypeError('Cannot complete block 2 before block 1 is completed');
  }
  if (completedBlock === 1) return 'block_1_completed';
  return 'completed';
}

export function toPublicListeningQuestion(question: ListeningQuestion): ListeningQuestionPublic {
  return {
    id: question.id,
    episodeId: question.episodeId,
    blockId: question.blockId,
    questionOrder: question.questionOrder,
    prompt: question.prompt,
    optionsJson: question.optionsJson,
    explanationPt: question.explanationPt,
    maxAttempts: question.maxAttempts,
  };
}
