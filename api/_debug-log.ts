/**
 * SERVER-ONLY: on-demand diagnostic tracing.
 *
 * A dashboard-controlled switch (public.app_debug_logging_config, one row per
 * environment) turns per-request timing capture on/off with LEVELS. When the
 * level is 'off' (the default) every method here is a near-zero-cost no-op —
 * nothing is read per request beyond a 30s-cached level and nothing is written.
 *
 * The whole point is to answer "where is the latency?" in production without a
 * redeploy — especially how much of a request is spent waiting on the database
 * (trace.db(...)), which is the current prime suspect.
 *
 * NEVER log audio, PII, tokens or reference text. `detail` is for small,
 * structured, non-sensitive extras only (sizes, counts, codes).
 *
 * NOT Edge-safe: imports a Node service client. Only import this from API route
 * handlers (Node runtime) — never from api/_helpers.ts or middleware.ts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSharedServiceClient } from './_ai-gateway/usage-repository';
import { resolveConfigEnvironment } from '../src/server/product-config/environment';

export type DebugLevel = 'off' | 'error' | 'info' | 'debug' | 'trace';
export type EmitLevel = Exclude<DebugLevel, 'off'>;

const LEVEL_RANK: Record<DebugLevel, number> = { off: 0, error: 1, info: 2, debug: 3, trace: 4 };

/** How long a resolved level is trusted before re-reading it from the DB. */
const LEVEL_TTL_MS = 30_000;

interface ResolvedDebugConfig {
  level: DebugLevel;
  sampleRate: number; // 0..100
}

interface CachedConfig extends ResolvedDebugConfig {
  expiresAt: number;
}

let _cache: CachedConfig | null = null;

/**
 * Reads the environment's level (cached ~30s per lambda instance). Fail-closed:
 * any read/credential error resolves to 'off' so a diagnostic outage can never
 * degrade a real request.
 */
async function resolveDebugConfig(now: number): Promise<ResolvedDebugConfig> {
  if (_cache && _cache.expiresAt > now) return _cache;

  let resolved: ResolvedDebugConfig = { level: 'off', sampleRate: 100 };
  try {
    const client = getSharedServiceClient();
    const env = resolveConfigEnvironment();
    const { data } = await client
      .from('app_debug_logging_config')
      .select('level, sample_rate, auto_off_at')
      .eq('environment', env)
      .maybeSingle();
    if (data) {
      const autoOff = data.auto_off_at ? Date.parse(data.auto_off_at as string) : NaN;
      const expired = !Number.isNaN(autoOff) && now > autoOff;
      resolved = {
        level: expired ? 'off' : ((data.level as DebugLevel) ?? 'off'),
        sampleRate: typeof data.sample_rate === 'number' ? data.sample_rate : 100,
      };
    }
  } catch {
    resolved = { level: 'off', sampleRate: 100 };
  }
  _cache = { ...resolved, expiresAt: now + LEVEL_TTL_MS };
  return _cache;
}

/** Force the next resolve to re-read (used by the dashboard write path/tests). */
export function invalidateDebugConfigCache(): void {
  _cache = null;
}

export interface StageOptions {
  /** Level at which this stage is emitted. Default 'debug'. */
  level?: EmitLevel;
  durationMs?: number;
  dbMs?: number;
  status?: number;
  errorCode?: string | null;
  provider?: 'supabase' | 'azure' | 'openai' | null;
  bytes?: number;
  detail?: Record<string, unknown>;
}

interface LogRow {
  environment: string;
  surface: 'server';
  correlation_id: string;
  endpoint: string;
  stage: string;
  level: EmitLevel;
  status_code: number | null;
  error_code: string | null;
  duration_ms: number | null;
  db_ms: number | null;
  provider: string | null;
  bytes: number | null;
  user_id: string | null;
  detail: Record<string, unknown> | null;
}

export interface DebugTrace {
  /** Correlation id shared by every row of this request (also handy to return
   *  to the client so client-side timings can be joined later). */
  readonly correlationId: string;
  /** True only when this request is actually being captured. */
  readonly enabled: boolean;
  /** Record a completed stage. No-op unless the configured level allows it. */
  stage(name: string, opts?: StageOptions): void;
  /** Measure an async step and record it (returns the step's value untouched). */
  timed<T>(name: string, fn: () => Promise<T>, opts?: Omit<StageOptions, 'durationMs'>): Promise<T>;
  /** Like timed(), but tagged as a database call and accumulated into db_ms. */
  db<T>(name: string, fn: () => Promise<T>, opts?: Omit<StageOptions, 'durationMs' | 'provider'>): Promise<T>;
  /** Record the request total ('total' stage) and flush all buffered rows. */
  finish(status: number, opts?: { errorCode?: string | null; detail?: Record<string, unknown> }): Promise<void>;
}

/** Cheap sentinel used when logging is off — every method is a no-op. */
class NoopTrace implements DebugTrace {
  constructor(public readonly correlationId: string) {}
  readonly enabled = false;
  stage(): void { /* no-op */ }
  async timed<T>(_name: string, fn: () => Promise<T>): Promise<T> { return fn(); }
  async db<T>(_name: string, fn: () => Promise<T>): Promise<T> { return fn(); }
  async finish(): Promise<void> { /* no-op */ }
}

class ActiveTrace implements DebugTrace {
  readonly enabled = true;
  private readonly rows: LogRow[] = [];
  private readonly startedAt: number;
  private dbAccumMs = 0;

  constructor(
    readonly correlationId: string,
    private readonly endpoint: string,
    private readonly environment: string,
    private readonly userId: string | null,
    private readonly level: DebugLevel,
    private readonly client: SupabaseClient,
    private readonly clock: () => number,
  ) {
    this.startedAt = clock();
  }

  private allows(emit: EmitLevel): boolean {
    return LEVEL_RANK[this.level] >= LEVEL_RANK[emit];
  }

  stage(name: string, opts: StageOptions = {}): void {
    const emit = opts.level ?? 'debug';
    if (opts.dbMs && opts.dbMs > 0) this.dbAccumMs += opts.dbMs;
    if (!this.allows(emit)) return;
    this.rows.push({
      environment: this.environment,
      surface: 'server',
      correlation_id: this.correlationId,
      endpoint: this.endpoint,
      stage: name,
      level: emit,
      status_code: opts.status ?? null,
      error_code: opts.errorCode ?? null,
      duration_ms: typeof opts.durationMs === 'number' ? Math.round(opts.durationMs) : null,
      db_ms: typeof opts.dbMs === 'number' ? Math.round(opts.dbMs) : null,
      provider: opts.provider ?? null,
      bytes: typeof opts.bytes === 'number' ? opts.bytes : null,
      user_id: this.userId,
      detail: opts.detail ?? null,
    });
  }

  async timed<T>(name: string, fn: () => Promise<T>, opts: Omit<StageOptions, 'durationMs'> = {}): Promise<T> {
    const t0 = this.clock();
    try {
      const value = await fn();
      this.stage(name, { ...opts, durationMs: this.clock() - t0 });
      return value;
    } catch (err) {
      this.stage(name, {
        ...opts,
        level: opts.level ?? 'error',
        durationMs: this.clock() - t0,
        errorCode: opts.errorCode ?? (err instanceof Error ? err.name : 'error'),
      });
      throw err;
    }
  }

  db<T>(name: string, fn: () => Promise<T>, opts: Omit<StageOptions, 'durationMs' | 'provider'> = {}): Promise<T> {
    const t0 = this.clock();
    // dbMs is recorded on the row AND accumulated into the request total so the
    // 'total' stage can report exactly how much of the request was database.
    return this.timed(name, fn, { ...opts, provider: 'supabase' }).finally(() => {
      this.dbAccumMs += this.clock() - t0;
    }) as Promise<T>;
  }

  async finish(status: number, opts: { errorCode?: string | null; detail?: Record<string, unknown> } = {}): Promise<void> {
    // The 'total' row is emitted at 'info' (or 'error' on failure) so it shows
    // up even at low verbosity, and always carries the DB share of the request.
    const totalMs = this.clock() - this.startedAt;
    const totalLevel: EmitLevel = status >= 400 ? 'error' : 'info';
    if (this.allows(totalLevel)) {
      this.rows.push({
        environment: this.environment,
        surface: 'server',
        correlation_id: this.correlationId,
        endpoint: this.endpoint,
        stage: 'total',
        level: totalLevel,
        status_code: status,
        error_code: opts.errorCode ?? null,
        duration_ms: Math.round(totalMs),
        db_ms: Math.round(this.dbAccumMs),
        provider: null,
        bytes: null,
        user_id: this.userId,
        detail: opts.detail ?? null,
      });
    }
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.rows.length === 0) return;
    const batch = this.rows.splice(0, this.rows.length);
    try {
      await this.client.from('debug_request_logs').insert(batch);
    } catch {
      /* best-effort: a diagnostic write must never surface to the caller */
    }
  }
}

export interface StartTraceParams {
  endpoint: string;
  userId?: string | null;
  /** Reuse an id sent by the client so client+server rows join. */
  correlationId?: string;
  clock?: () => number;
  /** Deterministic sampling decision for tests. */
  sampleValue?: number;
}

/**
 * Entry point for a route. Resolves the current level (cached), applies
 * sampling, and returns either an ActiveTrace or a zero-cost NoopTrace.
 * Never throws.
 */
export async function startTrace(params: StartTraceParams): Promise<DebugTrace> {
  const clock = params.clock ?? Date.now;
  const correlationId = params.correlationId && params.correlationId.length > 0
    ? params.correlationId
    : cheapId(clock);
  try {
    const { level, sampleRate } = await resolveDebugConfig(clock());
    if (level === 'off') return new NoopTrace(correlationId);
    const roll = typeof params.sampleValue === 'number' ? params.sampleValue : Math.random() * 100;
    if (roll >= sampleRate) return new NoopTrace(correlationId);
    return new ActiveTrace(
      correlationId,
      params.endpoint,
      resolveConfigEnvironment(),
      params.userId ?? null,
      level,
      getSharedServiceClient(),
      clock,
    );
  } catch {
    return new NoopTrace(correlationId);
  }
}

function cheapId(clock: () => number): string {
  return `srv_${clock().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ── Client-reported timings ───────────────────────────────────────────────────

export interface ClientLogInput {
  endpoint: string;
  stage: string;
  correlationId?: string;
  durationMs?: number;
  status?: number;
  errorCode?: string | null;
  bytes?: number;
  detail?: Record<string, unknown>;
}

/**
 * Persists a single client-reported timing row (surface='client'). The device
 * is the only place that can see a request STALL (the "spinner forever" symptom
 * the server never learns about), so the client posts slow/stalled/errored
 * fetches here. Gated by the same level switch and fail-closed: when logging is
 * off, nothing is written. Never throws.
 */
export async function recordClientLog(input: ClientLogInput, userId: string | null): Promise<void> {
  try {
    const { level } = await resolveDebugConfig(Date.now());
    if (level === 'off') return;
    // Client rows are the raison d'être of this feature (spinner diagnosis), so
    // they emit at 'info' — visible whenever logging is on at all.
    if (LEVEL_RANK[level] < LEVEL_RANK.info) return;
    const client = getSharedServiceClient();
    await client.from('debug_request_logs').insert({
      environment: resolveConfigEnvironment(),
      surface: 'client',
      correlation_id: input.correlationId ?? null,
      endpoint: input.endpoint,
      stage: input.stage,
      level: 'info',
      status_code: input.status ?? null,
      error_code: input.errorCode ?? null,
      duration_ms: typeof input.durationMs === 'number' ? Math.round(input.durationMs) : null,
      db_ms: null,
      provider: null,
      bytes: typeof input.bytes === 'number' ? input.bytes : null,
      user_id: userId,
      detail: input.detail ?? null,
    });
  } catch {
    /* best-effort */
  }
}
