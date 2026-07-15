import {
  LISTENING_EPISODE_STATUSES,
  LISTENING_BLOCK_STATUSES,
  LISTENING_SUBTITLE_LANGUAGES,
  LISTENING_SUBTITLE_MODES,
  USER_LISTENING_PROGRESS_STATUSES,
  ListeningEpisodeStatus,
  ListeningBlockStatus,
  ListeningSubtitleLanguage,
  ListeningSubtitleMode,
  UserListeningProgressStatus,
  ListeningAttemptNumber,
  ListeningQuestion,
  UserListeningAttempt,
  ListeningActivity,
} from './listening-types';

const EPISODE_STATUS_SET = new Set<string>(LISTENING_EPISODE_STATUSES as ListeningEpisodeStatus[]);
const BLOCK_STATUS_SET = new Set<string>(LISTENING_BLOCK_STATUSES as ListeningBlockStatus[]);
const SUBTITLE_LANGUAGE_SET = new Set<string>(LISTENING_SUBTITLE_LANGUAGES as ListeningSubtitleLanguage[]);
const SUBTITLE_MODE_SET = new Set<string>(LISTENING_SUBTITLE_MODES as ListeningSubtitleMode[]);
const PROGRESS_STATUS_SET = new Set<string>(USER_LISTENING_PROGRESS_STATUSES as UserListeningProgressStatus[]);

export function validateListeningEpisodeStatus(value: string): void {
  if (!EPISODE_STATUS_SET.has(value)) {
    throw new TypeError(`Invalid listening episode status: "${value}"`);
  }
}

export function validateListeningBlockStatus(value: string): void {
  if (!BLOCK_STATUS_SET.has(value)) {
    throw new TypeError(`Invalid listening block status: "${value}"`);
  }
}

export function validateListeningSubtitleLanguage(value: string): void {
  if (!SUBTITLE_LANGUAGE_SET.has(value)) {
    throw new TypeError(`Invalid listening subtitle language: "${value}"`);
  }
}

export function validateListeningSubtitleMode(value: string): void {
  if (!SUBTITLE_MODE_SET.has(value)) {
    throw new TypeError(`Invalid listening subtitle mode: "${value}"`);
  }
}

export function validateUserListeningProgressStatus(value: string): void {
  if (!PROGRESS_STATUS_SET.has(value)) {
    throw new TypeError(`Invalid user listening progress status: "${value}"`);
  }
}

export function validateListeningAttemptNumber(value: number): asserts value is ListeningAttemptNumber {
  if (value !== 1 && value !== 2 && value !== 3) {
    throw new RangeError(`Attempt number must be 1, 2, or 3, got: ${value}`);
  }
}

export function validateListeningQuestion(question: ListeningQuestion): void {
  if (question.optionsJson.length < 2) {
    throw new RangeError('Question must have at least 2 options');
  }
  if (question.correctOption < 0 || question.correctOption >= question.optionsJson.length) {
    throw new RangeError(
      `correct_option ${question.correctOption} is out of range for ${question.optionsJson.length} options`
    );
  }
  if (question.maxAttempts !== 3) {
    throw new RangeError(`max_attempts must be 3, got: ${question.maxAttempts}`);
  }
}

export function validateListeningAttempt(attempt: UserListeningAttempt): void {
  validateListeningAttemptNumber(attempt.attemptNumber);

  const expectedMode: ListeningSubtitleMode =
    attempt.attemptNumber === 1 ? 'none' :
    attempt.attemptNumber === 2 ? 'en' : 'pt-BR';

  if (attempt.subtitleMode !== expectedMode) {
    throw new TypeError(
      `Attempt ${attempt.attemptNumber} must have subtitle_mode "${expectedMode}", got "${attempt.subtitleMode}"`
    );
  }
  if (attempt.selectedOption < 0) {
    throw new RangeError(`selected_option must be >= 0, got: ${attempt.selectedOption}`);
  }
  if (attempt.playbackRate <= 0) {
    throw new RangeError(`playback_rate must be > 0, got: ${attempt.playbackRate}`);
  }
  if (attempt.attemptCycle < 1) {
    throw new RangeError(`attempt_cycle must be >= 1, got: ${attempt.attemptCycle}`);
  }
}

export function validateProgressOwnership(
  progress: { userId: string },
  requestingUserId: string
): void {
  if (progress.userId !== requestingUserId) {
    throw new TypeError(
      `Access denied: progress belongs to user "${progress.userId}", requesting user is "${requestingUserId}"`
    );
  }
}

export function validateListeningActivityStructure(activity: ListeningActivity): void {
  if (activity.blocks.length !== 2) {
    throw new RangeError(
      `Activity must have exactly 2 blocks, got: ${activity.blocks.length}`
    );
  }

  const orders = activity.blocks
    .map(b => b.block.blockOrder)
    .sort((a, b) => a - b) as [number, number];

  if (orders[0] !== 1 || orders[1] !== 2) {
    throw new TypeError(
      `Block orders must be exactly [1, 2], got: [${orders.join(', ')}]`
    );
  }

  const blockIds = new Set(activity.blocks.map(b => b.block.id));
  if (blockIds.size !== 2) {
    throw new TypeError('Activity blocks must have distinct IDs (two questions cannot share the same block)');
  }

  const questionOrders = activity.blocks
    .map(b => b.question.questionOrder)
    .sort((a, b) => a - b) as [number, number];

  if (questionOrders[0] !== 1 || questionOrders[1] !== 2) {
    throw new TypeError(
      `Question orders must be exactly [1, 2], got: [${questionOrders.join(', ')}]`
    );
  }

  for (const activityBlock of activity.blocks) {
    const { block, question, subtitlesEn, subtitlesPt } = activityBlock;

    if (question.blockId !== block.id) {
      throw new TypeError(
        `Question blockId "${question.blockId}" does not match block id "${block.id}"`
      );
    }

    if (question.questionOrder !== block.blockOrder) {
      throw new TypeError(
        `Question order ${question.questionOrder} does not match block order ${block.blockOrder}`
      );
    }

    if (question.episodeId !== activity.episode.id) {
      throw new TypeError(
        `Question episodeId "${question.episodeId}" does not match activity episode id "${activity.episode.id}"`
      );
    }

    for (const cue of [...subtitlesEn, ...subtitlesPt]) {
      if (cue.endMs <= cue.startMs) {
        throw new RangeError(
          `Subtitle cue has endMs (${cue.endMs}) <= startMs (${cue.startMs}) in block ${block.blockOrder}`
        );
      }
    }

    if (activity.episode.status === 'published') {
      if (subtitlesEn.length === 0) {
        throw new TypeError(
          `Published episode must have English subtitles for block ${block.blockOrder}`
        );
      }
      if (subtitlesPt.length === 0) {
        throw new TypeError(
          `Published episode must have Portuguese subtitles for block ${block.blockOrder}`
        );
      }
    }
  }
}
