/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Infrastructure for provider sessions that use ephemeral tokens:
 *   - OpenAI Realtime / WebRTC (conversation.webrtc_connect)
 *   - Azure Pronunciation Assessment from browser (pronunciation.assess_text)
 *
 * CRITICAL RULES:
 *   - Never store the ephemeral token.
 *   - Never return the token from any function in this module.
 *   - Only the SHA-256 fingerprint of the token is persisted.
 *   - The fingerprint is computed in-memory and never re-derived from stored data.
 *   - This module does NOT alter the current token issuance flow.
 */

import { createHash } from 'crypto';
import type { ProviderSessionContext } from './types';
import type { UsageRepositoryInterface } from './usage-repository';

// ── Fingerprint ───────────────────────────────────────────────────────────────

/**
 * Computes a SHA-256 hex fingerprint of an ephemeral token in-memory.
 * The token is never returned and never stored.
 */
function computeFingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// ── Session lifecycle ─────────────────────────────────────────────────────────

export interface AuthorizedSessionResult {
  sessionId: string;
  authorizationFingerprint: string;
}

/**
 * Records a newly authorized provider session.
 * Computes and stores only the SHA-256 fingerprint of the token.
 * The token itself is never passed to the repository.
 */
export async function authorizeProviderSession(
  repo: UsageRepositoryInterface,
  context: ProviderSessionContext,
  ephemeralToken: string,
): Promise<AuthorizedSessionResult> {
  const authorizationFingerprint = computeFingerprint(ephemeralToken);

  const sessionId = await repo.createProviderSession({
    featureKey:              context.featureKey,
    provider:                context.provider,
    userId:                  context.userId,
    initiatedByUserId:       context.initiatedByUserId,
    internalSessionType:     context.internalSessionType,
    internalSessionId:       context.internalSessionId,
    authorizationFingerprint,
    authorizationExpiresAt:  context.authorizationExpiresAt,
    metadata:                context.metadata,
  });

  return { sessionId, authorizationFingerprint };
}

/**
 * Transitions session from 'authorized'/'connecting' to 'active'.
 * Optionally records the provider-assigned session ID (e.g. OpenAI session_id).
 */
export async function activateProviderSession(
  repo: UsageRepositoryInterface,
  sessionId: string,
  providerSessionId?: string,
): Promise<void> {
  await repo.activateSession(sessionId, providerSessionId);
}

/**
 * Marks session as completed with a measured duration.
 * Duration must be >= 0.
 */
export async function completeProviderSession(
  repo: UsageRepositoryInterface,
  sessionId: string,
  durationSeconds: number,
): Promise<void> {
  if (durationSeconds < 0) {
    throw new Error(`completeProviderSession: durationSeconds must be >= 0, got ${durationSeconds}`);
  }
  await repo.completeSession(sessionId, durationSeconds);
}

/**
 * Marks session as failed (provider-side error or connection drop).
 */
export async function failProviderSession(
  repo: UsageRepositoryInterface,
  sessionId: string,
): Promise<void> {
  await repo.failSession(sessionId);
}

/**
 * Marks session as expired (authorization window elapsed without connection).
 */
export async function expireProviderSession(
  repo: UsageRepositoryInterface,
  sessionId: string,
): Promise<void> {
  await repo.expireSession(sessionId);
}
