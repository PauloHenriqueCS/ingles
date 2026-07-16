import { getAuthHeader } from './apiAuth';
import type {
  EpisodeSessionResponse,
  SubmitAnswerResult,
  SessionAudioInfo,
} from '../services/listening/execution/listening-execution-types';

export type { EpisodeSessionResponse, SubmitAnswerResult, SessionAudioInfo };

export type PublishedEpisode = {
  id: string;
  title: string;
  synopsis: string | null;
  cefrLevel: string;
  estimatedDurationSeconds: number;
};

export class ListeningApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'ListeningApiError';
  }
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = await getAuthHeader();
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
      ...(init.headers as Record<string, string> | undefined ?? {}),
    },
  });
  const json = await res.json();
  if (!res.ok) {
    throw new ListeningApiError(
      (json as any).code ?? 'UNKNOWN',
      (json as any).message ?? 'Erro desconhecido',
      res.status,
    );
  }
  return json as T;
}

export function getPublishedEpisodes(): Promise<PublishedEpisode[]> {
  return apiFetch<PublishedEpisode[]>('/api/listening/episodes');
}

export function getEpisodeSession(episodeId: string): Promise<EpisodeSessionResponse> {
  return apiFetch<EpisodeSessionResponse>(
    `/api/listening/episode-session?episodeId=${encodeURIComponent(episodeId)}`,
  );
}

export function markPlaybackCompleted(sessionId: string): Promise<void> {
  return apiFetch('/api/listening/session/playback-completed', {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  });
}

export type SubmitAnswerInput = {
  sessionId: string;
  questionId: string;
  selectedOption: number;
  submissionId: string;
  playbackRate?: number;
};

export function submitAnswer(input: SubmitAnswerInput): Promise<SubmitAnswerResult> {
  return apiFetch<SubmitAnswerResult>('/api/listening/session/answer', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function refreshAudioUrl(
  sessionId: string,
): Promise<SessionAudioInfo & { sessionId: string }> {
  return apiFetch('/api/listening/session/audio-refresh', {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  });
}

export function abandonSession(sessionId: string): Promise<void> {
  return apiFetch('/api/listening/session/abandon', {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  });
}

export type TodayListeningResult = {
  status: 'assigned' | 'in_progress' | 'completed';
  assignmentId: string;
  episodeId: string;
  activityDate: string;
  session: EpisodeSessionResponse;
} | { status: 'empty_inventory' };

export type ByDateListeningResult = {
  status: 'assigned' | 'in_progress' | 'completed';
  assignmentId: string;
  episodeId: string;
  activityDate: string;
} | { status: 'no_assignment' };

export type ListeningResultData = {
  assignmentId: string;
  episodeId: string;
  performanceScore: number;
  q1AttemptCycle: number;
  q2AttemptCycle: number;
  q1Weight: number;
  q2Weight: number;
  calculationVersion: string;
  calculatedAt: string;
};

export function getTodayListening(): Promise<TodayListeningResult> {
  return apiFetch<TodayListeningResult>('/api/listening/today');
}

export function getListeningByDate(date: string): Promise<ByDateListeningResult> {
  return apiFetch<ByDateListeningResult>(`/api/listening/by-date?date=${encodeURIComponent(date)}`);
}

export function getListeningResult(assignmentId: string): Promise<ListeningResultData> {
  return apiFetch<ListeningResultData>(`/api/listening/assignment-result?assignmentId=${encodeURIComponent(assignmentId)}`);
}

// ── On-demand generation ───────────────────────────────────────────────────────

export type GenerationSessionStatus =
  | 'created' | 'identifying_level'
  | 'generating_block_1' | 'validating_block_1'
  | 'generating_block_2' | 'validating_block_2'
  | 'generating_questions' | 'preparing_description' | 'preparing_subtitles'
  | 'generating_audio_block_1' | 'generating_audio_block_2'
  | 'validating_duration' | 'finalizing' | 'ready' | 'failed' | 'cancelled';

export type StartGenerationResult = {
  generationSessionId: string;
  status: GenerationSessionStatus;
  currentStep: string | null;
  progressPercent: number;
  episodeId: string | null;
};

export type GenerationStatusResult = {
  generationSessionId: string;
  status: GenerationSessionStatus;
  currentStep: string | null;
  progressPercent: number;
  episodeId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
};

export function startListeningGeneration(): Promise<StartGenerationResult> {
  return apiFetch<StartGenerationResult>('/api/listening/on-demand/start', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function getListeningGenerationStatus(sessionId: string): Promise<GenerationStatusResult> {
  return apiFetch<GenerationStatusResult>(
    `/api/listening/on-demand/status?sessionId=${encodeURIComponent(sessionId)}`,
  );
}

export function processNextListeningStep(sessionId: string): Promise<GenerationStatusResult> {
  return apiFetch<GenerationStatusResult>('/api/listening/on-demand/process-next', {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  });
}

export function retryListeningGeneration(sessionId: string): Promise<GenerationStatusResult> {
  return apiFetch<GenerationStatusResult>('/api/listening/on-demand/retry', {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  });
}
