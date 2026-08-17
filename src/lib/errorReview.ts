import { supabase } from './supabase';
import { getTodaySP } from './timezone';
import { ERROR_REVIEW_DAILY_LIMIT } from '../domain/error-review/constants';

/** Um card de revisão servido ao aluno — sem a correção (fica no servidor). */
export interface ErrorReviewItem {
  id: string;
  originalValue: string;
  originalSentence: string | null;
}

export interface ErrorReviewSession {
  /** Quantos exercícios estão disponíveis hoje (limitado a ERROR_REVIEW_DAILY_LIMIT). */
  available: number;
  /** Total de itens vencidos (pode ser maior que o limite diário). */
  dueTotal: number;
  /** Quantos já foram respondidos hoje. */
  consumed: number;
  dailyLimit: number;
  items: ErrorReviewItem[];
}

export interface ErrorReviewResult {
  passed: boolean;
  correctedValue: string;
  originalValue: string;
  explanation: string | null;
  newLevel: number;
  newStatus: 'scheduled' | 'mastered';
  nextReviewAt: string | null;
  intervalDays: number | null;
  mastered: boolean;
  consumed: number;
}

/**
 * Carrega a fila do dia. Abrir/carregar NÃO consome nada — só
 * submitErrorReviewItem move o scheduler.
 */
export async function fetchErrorReviewSession(): Promise<ErrorReviewSession> {
  const { data, error } = await supabase.rpc('get_error_review_session', {
    p_activity_date: getTodaySP(),
    p_daily_limit: ERROR_REVIEW_DAILY_LIMIT,
  });
  if (error) throw new Error(error.message);
  const d = (data ?? {}) as Record<string, unknown>;
  if (d.error) throw new Error(String(d.error));
  const rawItems = Array.isArray(d.items) ? (d.items as Record<string, unknown>[]) : [];
  return {
    available: Number(d.available ?? 0),
    dueTotal: Number(d.dueTotal ?? 0),
    consumed: Number(d.consumed ?? 0),
    dailyLimit: Number(d.dailyLimit ?? ERROR_REVIEW_DAILY_LIMIT),
    items: rawItems.map((it) => ({
      id: String(it.id),
      originalValue: String(it.originalValue ?? ''),
      originalSentence: it.originalSentence != null ? String(it.originalSentence) : null,
    })),
  };
}

/** Lightweight count for the Home card — reuses the session RPC. */
export async function fetchErrorReviewAvailableCount(): Promise<number> {
  const session = await fetchErrorReviewSession();
  return session.available;
}

/**
 * Submete uma resposta. Este é o ÚNICO ponto que cria tentativa, atualiza o
 * scheduler e conta contra o limite diário. O acerto/erro é decidido no
 * servidor (a correção nunca sai antes da resposta).
 */
export async function submitErrorReviewItem(
  itemId: string,
  submittedText: string,
): Promise<ErrorReviewResult> {
  const { data, error } = await supabase.rpc('submit_error_review_item', {
    p_item_id: itemId,
    p_submitted_text: submittedText,
    p_activity_date: getTodaySP(),
    p_daily_limit: ERROR_REVIEW_DAILY_LIMIT,
  });
  if (error) throw new Error(error.message);
  const d = (data ?? {}) as Record<string, unknown>;
  if (d.error) throw new Error(String(d.error));
  return {
    passed: Boolean(d.passed),
    correctedValue: String(d.correctedValue ?? ''),
    originalValue: String(d.originalValue ?? ''),
    explanation: d.explanation != null ? String(d.explanation) : null,
    newLevel: Number(d.newLevel ?? 0),
    newStatus: d.newStatus === 'mastered' ? 'mastered' : 'scheduled',
    nextReviewAt: d.nextReviewAt != null ? String(d.nextReviewAt) : null,
    intervalDays: d.intervalDays != null ? Number(d.intervalDays) : null,
    mastered: Boolean(d.mastered),
    consumed: Number(d.consumed ?? 0),
  };
}
