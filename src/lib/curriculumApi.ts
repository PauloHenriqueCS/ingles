import { getAuthHeader } from './apiAuth';
import { apiUrl } from './apiUrl';

// ── Types ──────────────────────────────────────────────────────────────────
// These mirror the backend contract exactly. The MACRO plan NEVER carries
// recorte/subtopic IDs — modules expose only display + aggregate counts.

export type CurriculumStatus = 'active' | 'not_started' | 'completed' | string;

export type ModuleState = 'completed' | 'current' | 'upcoming';

export interface CurriculumModule {
  title: string;
  capability: string;
  state: ModuleState;
  completedCount: number;
  totalCount: number;
}

export interface CurriculumLevel {
  /** CEFR code used purely as a display label (A1..C2). */
  code: string;
  modules: CurriculumModule[];
}

export interface CurriculumPlan {
  status: CurriculumStatus;
  learningLanguage: string;
  interfaceLanguage: string;
  currentLevel: string;
  levels: CurriculumLevel[];
}

// ── Macro tree (the "Plano de ensino" experience) ────────────────────────────
// Fully data-driven from the backend. Carries ONLY display fields: no recorte /
// subtopic keys, no counts, no technical ids, no ordering of recortes.

export type CurriculumNodeStatus = 'completed' | 'current' | 'future';

export interface CurriculumTreeModule {
  /** Opaque, stable module id (safe to show; carries no recorte data). */
  moduleKey: string;
  /** Localized (interface language) title. */
  title: string;
  status: CurriculumNodeStatus;
}

export interface CurriculumTreeLevel {
  levelCode: string;
  /** Localized level name (display label). */
  name: string;
  /** Localized proficiency band (Iniciante / Intermediário / Avançado). */
  band: string;
  status: CurriculumNodeStatus;
  modules: CurriculumTreeModule[];
}

export interface CurriculumTree {
  versionId: string;
  learningLanguage: string;
  interfaceLanguage: string;
  status: 'active' | 'curriculum_completed';
  /** The level the user is on (C2 when the curriculum is completed). */
  currentLevelCode: string | null;
  /** Ordered A1..C2 (or the framework's ladder). */
  levels: CurriculumTreeLevel[];
}

export type ModalityKey = 'writing' | 'listening' | 'pronunciation' | 'conversation';

export interface CurriculumModalities {
  writing: boolean;
  listening: boolean;
  pronunciation: boolean;
  conversation: boolean;
}

export interface CurriculumPreferences {
  learningLanguage: string;
  interfaceLanguage: string;
  modalities: CurriculumModalities;
}

export interface CurriculumProgress {
  status: CurriculumStatus;
  currentLevel: string;
  currentModuleTitle: string;
  completedRecortes: number;
  totalRecortes: number;
}

// ── Error ──────────────────────────────────────────────────────────────────

export class CurriculumApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public data?: unknown,
  ) {
    super(message);
    this.name = 'CurriculumApiError';
  }
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = await getAuthHeader();
  const res = await fetch(apiUrl(path), {
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
    throw new CurriculumApiError(
      'NON_JSON_RESPONSE',
      `Erro inesperado do servidor (status ${res.status}).`,
      res.status,
    );
  }

  if (!res.ok) {
    throw new CurriculumApiError(
      (json as any).code ?? 'UNKNOWN',
      (json as any).message ?? 'Erro desconhecido',
      res.status,
      json,
    );
  }
  return json as T;
}

// ── Endpoints ──────────────────────────────────────────────────────────────

/**
 * GET /api/curriculum/tree — the full MACRO plan tree for the "Plano de ensino"
 * experience: every level (A1..C2) with its localized name, band and status, and
 * each level's modules with status. Read-only; never exposes recortes.
 */
export function getCurriculumTree(): Promise<CurriculumTree> {
  return apiFetch<CurriculumTree>('/api/curriculum/tree');
}

/** GET /api/curriculum/plan — (legacy) MACRO view (levels → modules). No recorte IDs. */
export function getCurriculumPlan(): Promise<CurriculumPlan> {
  return apiFetch<CurriculumPlan>('/api/curriculum/plan');
}

/** GET /api/curriculum/preferences */
export function getCurriculumPreferences(): Promise<CurriculumPreferences> {
  return apiFetch<CurriculumPreferences>('/api/curriculum/preferences');
}

/**
 * PUT /api/curriculum/preferences — partial update of the modality menu.
 * Returns the resulting modalities. "menu = regra": each selected modality
 * becomes required to advance every recorte.
 */
export function updateCurriculumPreferences(
  modalities: Partial<CurriculumModalities>,
): Promise<{ modalities: CurriculumModalities }> {
  return apiFetch<{ modalities: CurriculumModalities }>('/api/curriculum/preferences', {
    method: 'PUT',
    body: JSON.stringify(modalities),
  });
}

/** GET /api/curriculum/progress — aggregate recorte counters (no IDs). */
export function getCurriculumProgress(): Promise<CurriculumProgress> {
  return apiFetch<CurriculumProgress>('/api/curriculum/progress');
}
