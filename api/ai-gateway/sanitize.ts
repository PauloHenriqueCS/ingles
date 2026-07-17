/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Central sanitization of metadata and errors.
 * Prevents sensitive data (tokens, keys, user content) from reaching storage.
 */

// Keys whose values are always blocked, matched case-insensitively.
const BLOCKED_KEY_PATTERNS = [
  'token',
  'authorization',
  'apikey',
  'api_key',
  'secret',
  'prompt',
  'text',
  'content',
  'response',
  'transcript',
  'audio',
  'ssml',
  'body',
  'password',
  'cookie',
];

const MAX_STRING_LENGTH = 256;
const MAX_DEPTH = 4;

function isBlockedKey(key: string): boolean {
  const lower = key.toLowerCase();
  return BLOCKED_KEY_PATTERNS.some(p => lower === p || lower.includes(p));
}

function truncate(s: string): string {
  return s.length > MAX_STRING_LENGTH ? s.slice(0, MAX_STRING_LENGTH) + '…' : s;
}

/**
 * Recursively sanitizes an object for safe storage as metadata.
 * - Removes blocked keys (tokens, secrets, user content)
 * - Truncates long strings
 * - Limits object depth
 * - Handles circular references via the visited set
 */
export function sanitizeMetadata(
  value: unknown,
  depth = 0,
  visited = new Set<object>(),
): Record<string, unknown> {
  if (depth > MAX_DEPTH) return { _truncated: true };
  if (value === null || value === undefined || typeof value !== 'object') return {};
  if (visited.has(value as object)) return { _circular: true };

  visited.add(value as object);
  const result: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isBlockedKey(k)) continue;

    if (v === null || v === undefined) {
      result[k] = null;
    } else if (typeof v === 'string') {
      result[k] = truncate(v);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      result[k] = v;
    } else if (Array.isArray(v)) {
      // Flatten arrays to string representation to avoid complexity
      result[k] = `[array:${v.length}]`;
    } else if (typeof v === 'object') {
      result[k] = sanitizeMetadata(v, depth + 1, visited);
    }
  }

  return result;
}

// ── Error sanitization ────────────────────────────────────────────────────────

export interface SanitizedError {
  category?: string;
  code?: string;
  httpStatus?: number;
  sanitizedMessage?: string;
  provider?: string;
  model?: string;
  latencyMs?: number;
}

const SENSITIVE_MESSAGE_PATTERN = /sk-|bearer|key=|password|token|secret|service_role/i;

/**
 * Extracts safe technical information from a caught error.
 * Never includes raw error messages that may contain secrets or user data.
 */
export function sanitizeError(
  err: unknown,
  context?: { provider?: string; model?: string; latencyMs?: number },
): SanitizedError {
  const result: SanitizedError = {};

  if (context?.provider) result.provider = context.provider;
  if (context?.model) result.model = context.model;
  if (context?.latencyMs !== undefined) result.latencyMs = context.latencyMs;

  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;

    if (typeof e['status'] === 'number') {
      result.httpStatus = e['status'] as number;
    }
    if (typeof e['code'] === 'string') {
      result.code = (e['code'] as string).slice(0, 64);
    }
    if (typeof e['name'] === 'string') {
      result.category = (e['name'] as string).slice(0, 64);
    }

    // Include message only when it doesn't look like it carries secrets
    if (typeof e['message'] === 'string') {
      const msg = (e['message'] as string).slice(0, 256);
      if (!SENSITIVE_MESSAGE_PATTERN.test(msg)) {
        result.sanitizedMessage = msg;
      }
    }
  }

  return result;
}
