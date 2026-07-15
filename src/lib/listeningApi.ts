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
