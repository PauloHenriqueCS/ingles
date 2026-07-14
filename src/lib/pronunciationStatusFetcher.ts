import { getAuthHeader } from './apiAuth';
import type { PronunciationStatusResponse } from '../types';

export class PronunciationStatusError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = 'PronunciationStatusError';
  }
}

export async function fetchPronunciationStatus(
  reviewId: string,
  signal?: AbortSignal,
): Promise<PronunciationStatusResponse> {
  const headers = await getAuthHeader();
  const url = `/api/pronunciation/status?textVersionId=${encodeURIComponent(reviewId)}`;
  const resp = await fetch(url, { headers, signal });
  if (!resp.ok) {
    const json: { error?: string } = await resp.json().catch(() => ({}));
    throw new PronunciationStatusError(resp.status, json.error ?? `HTTP ${resp.status}`);
  }
  return resp.json() as Promise<PronunciationStatusResponse>;
}
