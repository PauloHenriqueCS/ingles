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
    /** Full parsed response body — may contain extra fields like storyPackage */
    public data?: unknown,
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

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    // Non-JSON response (e.g. Vercel timeout HTML)
    throw new ListeningApiError(
      'NON_JSON_RESPONSE',
      `Erro inesperado do servidor (status ${res.status}).`,
      res.status,
    );
  }

  if (!res.ok) {
    throw new ListeningApiError(
      (json as any).code ?? 'UNKNOWN',
      (json as any).message ?? 'Erro desconhecido',
      res.status,
      json,
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

export type TodayListeningResult =
  | {
      status: 'assigned' | 'in_progress' | 'completed';
      assignmentId: string;
      episodeId: string;
      activityDate: string;
      session: EpisodeSessionResponse;
    }
  | { status: 'empty_inventory' }
  | { status: 'story_completed'; assignmentId: string; activityDate: string };

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

// ── Two-part listening story (on-the-fly, no DB) ─────────────────────────────

export type StoryPart = {
  id: 1 | 2;
  text: string;
  audioBase64: string;
  audioMimeType: string;
  question: {
    prompt: string;
    options: string[]; // exactly 5
    correctOptionIndex: number; // 0-indexed, for client-side comparison
    explanationPt: string;
  };
  answerToken: string;
};

export type ListeningStoryData = {
  title: string;
  level: string;
  summary: string;
  parts: [StoryPart, StoryPart];
};

export function generateListeningStory(storyPackage?: string | null): Promise<ListeningStoryData> {
  return apiFetch<ListeningStoryData>('/api/listening/generate', {
    method: 'POST',
    body: JSON.stringify(storyPackage ? { storyPackage } : {}),
  });
}

// ── Story session (simplified, no DB) ─────────────────────────────────────────

export type StorySessionData = {
  title: string;
  storyEn: string;
  storyPt: string;
  level: string;
  audioUrl: string;
  audioExpiresAt: string;
  question: {
    prompt: string;
    options: string[];
  };
  answerToken: string;
};

export type StoryAnswerResult = {
  correct: boolean;
  correctOption: number;
  explanationPt: string;
};

export function generateStorySession(): Promise<StorySessionData> {
  return apiFetch<StorySessionData>('/api/listening/story/generate', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function verifyStoryAnswer(input: {
  answerToken: string;
  selectedOption: number;
}): Promise<StoryAnswerResult> {
  return apiFetch<StoryAnswerResult>('/api/listening/story/verify', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function completeStoryListening(): Promise<{ activityDate: string; saved: boolean }> {
  const { data: { session } } = await (await import('./supabase')).supabase.auth.getSession();
  console.log('[3] Payload enviado → POST /api/listening/story/complete', {
    hasToken: !!session?.access_token,
    tokenPrefix: session?.access_token?.slice(0, 20) ?? 'NONE',
    userId: session?.user?.id ?? 'NONE',
    body: '{}',
  });
  try {
    const result = await apiFetch<{ activityDate: string; saved: boolean }>(
      '/api/listening/story/complete',
      { method: 'POST', body: JSON.stringify({}) },
    );
    console.log('[4] Resposta HTTP → 200 OK', result);
    return result;
  } catch (err) {
    if (err instanceof ListeningApiError) {
      console.error('[4] Resposta HTTP → erro', { status: err.status, code: err.code, message: err.message, data: err.data });
    } else {
      console.error('[4] Resposta HTTP → erro desconhecido', err);
    }
    throw err;
  }
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
