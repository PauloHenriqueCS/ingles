/**
 * SERVER-ONLY central communication-suppression gate. See migration
 * 20260723040002_create_user_communication_blocks.sql.
 *
 * No email/SMS/push/WhatsApp provider (Resend, SendGrid, Mailchimp, Brevo,
 * OneSignal, Firebase Cloud Messaging, Twilio, ...) is integrated in this
 * codebase today — audited before that migration was written. This table
 * and canSendCommunication exist so that whenever a real provider is wired
 * in, every send path (marketing, transactional, crons, retries, campaigns,
 * admin broadcasts) has one gate to call immediately before the actual send.
 *
 * destination_hash is an HMAC-SHA256 of the normalized destination, keyed by
 * COMMUNICATION_SUPPRESSION_HMAC_SECRET (server-only, never returned by any
 * API, never logged) — never a plain hash of a predictable value like an
 * email address (brute-forceable), and never the raw destination itself.
 * This lets a suppression outlive a future LGPD erasure/anonymization of
 * the user's row (user_id on this table is nullable, no ON DELETE CASCADE).
 */

import { createHmac } from 'node:crypto';
import { getSharedServiceClient } from '../_ai-gateway/usage-repository';
import { getCommunicationSuppressionHmacSecret } from '../_env';

export type CommunicationChannel = 'email' | 'sms' | 'push' | 'whatsapp' | 'in_app';
export type CommunicationScope = 'marketing' | 'transactional' | 'all';

export const ACCOUNT_DELETION_COMMUNICATION_REASON = 'user_requested_account_deletion';
export const ACCOUNT_DELETION_COMMUNICATION_SOURCE = 'account_deactivation';

const ALL_CHANNELS: CommunicationChannel[] = ['email', 'sms', 'push', 'whatsapp', 'in_app'];

export class CommunicationBlockedError extends Error {
  readonly code = 'COMMUNICATION_BLOCKED';
  constructor() {
    super('Envio bloqueado: comunicação suprimida para este destinatário.');
  }
}

function normalizeDestination(rawValue: string, channel: CommunicationChannel): string {
  const trimmed = rawValue.trim();
  if (channel === 'email') return trimmed.toLowerCase();
  if (channel === 'sms' || channel === 'whatsapp') return trimmed.replace(/[^\d+]/g, '');
  return trimmed; // push token / in_app identifier — already opaque, used as-is
}

/**
 * Deterministic HMAC-SHA256 hash of a normalized destination. Returns null
 * when the secret isn't configured — callers must treat that as "hashing
 * unavailable" and never fall back to storing or matching the raw value.
 */
export function hashDestination(rawValue: string, channel: CommunicationChannel): string | null {
  const secret = getCommunicationSuppressionHmacSecret();
  if (!secret) return null;
  const normalized = normalizeDestination(rawValue, channel);
  return createHmac('sha256', secret).update(normalized).digest('hex');
}

/**
 * Idempotent — inserts one scope='all' block per channel for the user,
 * skipping channels that already have an active block for this reason
 * (uq_user_communication_blocks_active_user enforces uniqueness at the DB
 * level; the pre-check just avoids noisy duplicate-key round trips).
 */
export async function createAccountDeletionCommunicationBlocks(userId: string): Promise<void> {
  const supabase = getSharedServiceClient();

  const { data: existingRows, error: selectError } = await supabase
    .from('user_communication_blocks')
    .select('channel')
    .eq('user_id', userId)
    .eq('scope', 'all')
    .eq('reason', ACCOUNT_DELETION_COMMUNICATION_REASON)
    .eq('is_active', true);
  if (selectError) throw new Error('Falha ao consultar bloqueios de comunicação.');

  const existingChannels = new Set((existingRows ?? []).map((r: any) => r.channel));
  const missing = ALL_CHANNELS.filter((c) => !existingChannels.has(c));
  if (missing.length === 0) return;

  const { error } = await supabase.from('user_communication_blocks').insert(
    missing.map((channel) => ({
      user_id: userId,
      channel,
      scope: 'all',
      reason: ACCOUNT_DELETION_COMMUNICATION_REASON,
      source: ACCOUNT_DELETION_COMMUNICATION_SOURCE,
      is_active: true,
    })),
  );
  if (error && (error as { code?: string }).code !== '23505') {
    throw new Error('Falha ao registrar bloqueios de comunicação.');
  }
}

export interface CanSendCommunicationParams {
  userId?: string;
  /** Raw destination (email/phone/push token) — hashed here, never
   *  persisted or logged raw by this function. */
  destination?: string;
  channel: CommunicationChannel;
  scope: Exclude<CommunicationScope, 'all'>;
}

/**
 * Central send-time gate. Call this immediately before every actual send —
 * never only when building a list or rendering a campaign UI. Considers
 * user_id, destination hash, channel, scope (a scope='all' block always
 * suppresses, regardless of the requested scope), and expiry. Fails CLOSED:
 * a lookup error (including a missing/unreachable table) is treated as
 * blocked — silently allowing a send on an unreadable suppression table is
 * the unsafe direction.
 */
export async function canSendCommunication(params: CanSendCommunicationParams): Promise<boolean> {
  const { userId, destination, channel, scope } = params;
  if (!userId && !destination) return false;

  const supabase = getSharedServiceClient();
  const destinationHash = destination ? hashDestination(destination, channel) : null;

  const idFilters: string[] = [];
  if (userId) idFilters.push(`user_id.eq.${userId}`);
  if (destinationHash) idFilters.push(`destination_hash.eq.${destinationHash}`);
  if (idFilters.length === 0) return false; // e.g. destination given but hashing unavailable

  const { data, error } = await supabase
    .from('user_communication_blocks')
    .select('id, expires_at')
    .eq('channel', channel)
    .eq('is_active', true)
    .in('scope', [scope, 'all'])
    .or(idFilters.join(','));

  if (error) return false; // fail closed

  const now = Date.now();
  const hasActiveBlock = (data ?? []).some(
    (row: any) => row.expires_at == null || new Date(row.expires_at).getTime() > now,
  );
  return !hasActiveBlock;
}

/** Throws CommunicationBlockedError instead of returning a boolean — use at
 *  call sites that should abort the send with a thrown error. */
export async function assertCommunicationAllowed(params: CanSendCommunicationParams): Promise<void> {
  if (!(await canSendCommunication(params))) {
    throw new CommunicationBlockedError();
  }
}
