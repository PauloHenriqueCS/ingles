import { getAuthHeader } from './apiAuth';
import { apiUrl } from './apiUrl';

// Mirrors the backend contract (api/_placement/placement-runtime.ts). The client
// never receives the answer key BEFORE answering — only the visible options and
// the next screen the server decides. AFTER a submission, the /answer response
// carries `answerFeedback` (correct/incorrect + the right option) for the
// question just answered, so it cannot be used to cheat.

export type PlacementStatus =
  | 'not_started'
  | 'in_progress'
  | 'skipped'
  | 'pending_evaluation'
  | 'completed';

export type PlacementScreen = 'intro' | 'question' | 'c2_gate' | 'result' | 'pending' | 'done';

export interface PlacementOption {
  key: string;
  label: string;
}

export interface PlacementQuestionView {
  questionKey: string;
  checkpointKey: string;
  promptType: 'single_choice';
  stem: string;
  context: string | null;
  options: PlacementOption[];
  progress: number;
}

export interface PlacementC2View {
  stepKey: string;
  stem: string;
  context: string | null;
  timeLimitSeconds: number;
  progress: number;
}

export interface PlacementResultView {
  rawLevel: string | null;
  effectiveLevel: string;
  headline: string;
  body: string;
  cta: string;
}

export interface PlacementAnswerFeedback {
  questionKey: string;
  selectedOptionKey: string;
  selectedOptionLabel: string;
  correctOptionKey: string;
  correctOptionLabel: string;
  isCorrect: boolean;
}

export interface PlacementState {
  placementStatus: PlacementStatus;
  learningLanguage: string;
  interfaceLanguage: string;
  languageLabel: string;
  copy: Record<string, string>;
  screen: PlacementScreen;
  attemptId: string | null;
  question?: PlacementQuestionView;
  c2?: PlacementC2View;
  result?: PlacementResultView;
  /** Only on the /answer response — feedback for the question just answered. */
  answerFeedback?: PlacementAnswerFeedback;
}

export class PlacementApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
    this.name = 'PlacementApiError';
  }
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = await getAuthHeader();
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    },
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new PlacementApiError('NON_JSON_RESPONSE', `Erro inesperado do servidor (status ${res.status}).`, res.status);
  }
  if (!res.ok) {
    throw new PlacementApiError((json as any).code ?? 'UNKNOWN', (json as any).message ?? 'Erro desconhecido', res.status);
  }
  return json as T;
}

/** GET /api/placement/state — current onboarding screen + status. */
export function getPlacementState(): Promise<PlacementState> {
  return apiFetch<PlacementState>('/api/placement/state');
}

/** POST /api/placement/start — begin or resume the adaptive test. */
export function startPlacement(): Promise<PlacementState> {
  return apiFetch<PlacementState>('/api/placement/start', { method: 'POST', body: '{}' });
}

/** POST /api/placement/answer — submit one objective answer (server-checked). */
export function submitPlacementAnswer(attemptId: string, questionKey: string, optionKey: string): Promise<PlacementState> {
  return apiFetch<PlacementState>('/api/placement/answer', {
    method: 'POST',
    body: JSON.stringify({ attemptId, questionKey, optionKey }),
  });
}

/** POST /api/placement/skip — skip; keep the user at the course default level. */
export function skipPlacement(): Promise<PlacementState> {
  return apiFetch<PlacementState>('/api/placement/skip', { method: 'POST', body: '{}' });
}

/** POST /api/placement/c2-submit — submit one C2 open response. */
export function submitPlacementC2(attemptId: string, stepKey: string, text: string): Promise<PlacementState> {
  return apiFetch<PlacementState>('/api/placement/c2-submit', {
    method: 'POST',
    body: JSON.stringify({ attemptId, stepKey, text }),
  });
}

/** POST /api/placement/c2-evaluate — retry a pending C2 evaluation. */
export function evaluatePendingPlacementC2(): Promise<PlacementState> {
  return apiFetch<PlacementState>('/api/placement/c2-evaluate', { method: 'POST', body: '{}' });
}
