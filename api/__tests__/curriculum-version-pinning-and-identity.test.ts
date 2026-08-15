/**
 * Blocker 4 (version pinning) + blockers 8/10 (curricular identity) at the
 * runtime-glue level, with an in-memory mock Supabase client.
 *
 *  - A user already pinned to V1 STAYS on V1 even after V2 is published.
 *  - A brand-new user bootstraps onto the published version.
 *  - Multiple prefs rows (one per version) never crash (no `.maybeSingle()` by
 *    user_id alone) — the most-recently-used path wins.
 *  - recordCurricularPractice records against the ACTIVITY'S recorte identity,
 *    never the current pointer, and ignores a foreign-version activity.
 */
import { describe, it, expect, vi } from 'vitest';
import { ensureUserCurriculum, recordCurricularPractice, recordCurricularPracticeFromIdentity } from '../_curriculum/curriculum-runtime';

// ── Tiny in-memory Supabase mock ────────────────────────────────────────────
interface Tables {
  user_curriculum_preferences: any[];
  curriculum_versions: any[];
  curricula: any[];
  curriculum_subtopics: any[];
  curriculum_modules: any[];
  user_curriculum_progress: any[];
  english_learning_memory: any[];
  user_subtopic_modality_progress: any[];
  [k: string]: any[];
}

function makeClient(tables: Partial<Tables>, onRpc?: (name: string, args: any) => any) {
  const db: Tables = {
    user_learning_paths: [], user_curriculum_preferences: [], curriculum_versions: [], curricula: [],
    curriculum_subtopics: [], curriculum_modules: [], user_curriculum_progress: [],
    english_learning_memory: [], user_subtopic_modality_progress: [], ...tables,
  } as Tables;

  const upserts: Array<{ table: string; row: any }> = [];

  function makeQuery(table: string) {
    let rows = [...(db[table] ?? [])];
    let orderCol: string | null = null;
    let orderAsc = true;
    const q: any = {
      select() { return q; },
      eq(col: string, val: any) { rows = rows.filter((r) => r[col] === val); return q; },
      is(col: string, val: any) { rows = rows.filter((r) => (r[col] ?? null) === val); return q; },
      in(col: string, vals: any[]) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
      order(col: string, opts?: { ascending?: boolean }) { orderCol = col; orderAsc = opts?.ascending !== false; return q; },
      limit(n: number) { rows = applyOrder().slice(0, n); return q; },
      async maybeSingle() { const r = applyOrder(); return { data: r[0] ?? null, error: null }; },
      async single() { const r = applyOrder(); return { data: r[0] ?? null, error: r[0] ? null : { message: 'no row' } }; },
      then(resolve: (v: any) => any) { return resolve({ data: applyOrder(), error: null }); },
      async upsert(row: any) { upserts.push({ table, row }); (db[table] as any[]).push(row); return { data: null, error: null }; },
      async update(_row: any) { return { data: null, error: null, eq() { return this; } }; },
    };
    function applyOrder() {
      if (!orderCol) return rows;
      const c = orderCol;
      return [...rows].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (orderAsc ? 1 : -1));
    }
    return q;
  }

  return {
    _upserts: upserts,
    from(table: string) { return makeQuery(table); },
    async rpc(name: string, args: any) { return { data: onRpc ? onRpc(name, args) : null, error: null }; },
  } as any;
}

// Shared fixture: two English versions V1 (published earlier) and V2 (latest).
const V1 = 'v1-uuid';
const V2 = 'v2-uuid';
const CUR = 'cur-uuid';
function baseTables(extra: Partial<Tables> = {}): Partial<Tables> {
  return {
    curricula: [{ id: CUR, learning_language: 'en', framework_id: 'fw' }],
    curriculum_versions: [
      { id: V1, curriculum_id: CUR, version: 1, status: 'published', 'curricula.learning_language': 'en' },
      { id: V2, curriculum_id: CUR, version: 2, status: 'published', 'curricula.learning_language': 'en' },
    ],
    // Ordered subtopics for BOTH versions (same keys, different ids).
    curriculum_subtopics: [
      { id: 's1-v1', curriculum_version_id: V1, subtopic_key: 'A1.M1.S1', level_code: 'A1', sort_order: 1, module_id: 'm1-v1', curriculum_modules: { module_key: 'A1.M1', sort_order: 1 } },
      { id: 's2-v1', curriculum_version_id: V1, subtopic_key: 'A1.M1.S2', level_code: 'A1', sort_order: 2, module_id: 'm1-v1', curriculum_modules: { module_key: 'A1.M1', sort_order: 1 } },
      { id: 's1-v2', curriculum_version_id: V2, subtopic_key: 'A1.M1.S1', level_code: 'A1', sort_order: 1, module_id: 'm1-v2', curriculum_modules: { module_key: 'A1.M1', sort_order: 1 } },
    ],
    ...extra,
  };
}

function activePath(userId: string, versionId: string, lang = 'en', initialLevel: string | null = null) {
  return { user_id: userId, learning_language: lang, curriculum_version_id: versionId, interface_language: 'pt-BR', initial_level_code: initialLevel, is_active: true };
}
function prefsRow(userId: string, versionId: string) {
  return { user_id: userId, curriculum_version_id: versionId, learning_language: 'en', interface_language: 'pt-BR', practice_writing: true, practice_listening: false, practice_pronunciation: false, practice_conversation: false };
}

describe('version pinning via explicit active learning path (blocker 1/4)', () => {
  it('a user whose ACTIVE PATH points at V1 stays on V1 even though V2 is the latest published', async () => {
    const client = makeClient(baseTables({
      user_learning_paths: [activePath('u1', V1)],
      user_curriculum_preferences: [prefsRow('u1', V1)],
      user_curriculum_progress: [{ user_id: 'u1', curriculum_version_id: V1, current_subtopic_id: 's2-v1', current_module_id: 'm1-v1', current_level_code: 'A1', status: 'active' }],
    }));
    const ensured = await ensureUserCurriculum(client, 'u1');
    expect(ensured.versionId).toBe(V1);              // NOT V2 (never "latest published")
    expect(ensured.currentSubtopicKey).toBe('A1.M1.S2'); // pinned progress preserved
  });

  it('a brand-new user bootstraps: creates an explicit active path on the published version', async () => {
    const client = makeClient(baseTables());
    const ensured = await ensureUserCurriculum(client, 'new-user');
    expect(ensured.versionId).toBe(V2); // latest published at bootstrap
    // The authority created is an active LEARNING PATH (not inferred by updated_at).
    expect(client._upserts.some((u: any) => u.table === 'user_learning_paths' && u.row.curriculum_version_id === V2 && u.row.is_active === true)).toBe(true);
  });

  it('the active path is authoritative even if a stale prefs row for a different version exists', async () => {
    const client = makeClient(baseTables({
      user_learning_paths: [activePath('u2', V1)],
      user_curriculum_preferences: [prefsRow('u2', V1), prefsRow('u2', V2)],
      user_curriculum_progress: [{ user_id: 'u2', curriculum_version_id: V1, current_subtopic_id: 's1-v1', current_module_id: 'm1-v1', current_level_code: 'A1', status: 'active' }],
    }));
    const ensured = await ensureUserCurriculum(client, 'u2');
    expect(ensured.versionId).toBe(V1); // the active path, not any updated_at heuristic
  });

  it('editing preferences (a V1 prefs row) never changes the pinned version', async () => {
    const client = makeClient(baseTables({
      user_learning_paths: [activePath('u3', V1)],
      user_curriculum_preferences: [prefsRow('u3', V1)],
      user_curriculum_progress: [{ user_id: 'u3', curriculum_version_id: V1, current_subtopic_id: 's1-v1', current_module_id: 'm1-v1', current_level_code: 'A1', status: 'active' }],
    }));
    const ensured = await ensureUserCurriculum(client, 'u3');
    expect(ensured.versionId).toBe(V1);
    expect(ensured.curriculumId).toBe(CUR); // structural data from the pinned version
  });
});

describe('level is per-language path, not a global english level (blocker 8)', () => {
  it('a NEW learning path never inherits a level: bootstrap English uses the legacy English level once', async () => {
    // english_learning_memory says B2; the bootstrap English path preserves it.
    const client = makeClient(baseTables({
      english_learning_memory: [{ user_id: 'u4', current_level: 'B2', created_at: '2026-01-01' }],
    }));
    const ensured = await ensureUserCurriculum(client, 'u4');
    // The created active path stored initial_level_code = 'B2' (legacy preservation).
    const pathUpsert = client._upserts.find((u: any) => u.table === 'user_learning_paths');
    expect(pathUpsert?.row.initial_level_code).toBe('B2');
  });
});

describe('curricular identity on record (blockers 8/10)', () => {
  function pinnedClient(currentSubtopicId: string) {
    const rpcCalls: any[] = [];
    const client = makeClient(baseTables({
      user_learning_paths: [activePath('u1', V1)],
      user_curriculum_preferences: [{ user_id: 'u1', curriculum_version_id: V1, learning_language: 'en', interface_language: 'pt-BR', practice_writing: true, practice_listening: true, practice_pronunciation: false, practice_conversation: false }],
      user_curriculum_progress: [{ user_id: 'u1', curriculum_version_id: V1, current_subtopic_id: currentSubtopicId, current_module_id: 'm1-v1', current_level_code: 'A1', status: 'active' }],
    }), (name, args) => { rpcCalls.push({ name, args }); return [{ current_subtopic_id: currentSubtopicId, status: 'active' }]; });
    return { client, rpcCalls };
  }

  it('records the practice on the ACTIVITY recorte (A1.M1.S1), even though the pointer is now A1.M1.S2', async () => {
    const { client, rpcCalls } = pinnedClient('s2-v1'); // current pointer = S2
    const res = await recordCurricularPracticeFromIdentity(client, 'u1', 'writing', 'review-1', { versionId: V1, subtopicKey: 'A1.M1.S1' });
    expect(res.recorded).toBe(true);
    expect(res.subtopicKey).toBe('A1.M1.S1'); // the activity's recorte, not current S2
    const practiceUpsert = client._upserts.find((u: any) => u.table === 'user_subtopic_modality_progress');
    expect(practiceUpsert?.row.subtopic_id).toBe('s1-v1'); // upserted on S1, not the current S2
    expect(rpcCalls.some((c: any) => c.name === 'resync_curriculum_progress' && c.args.p_curriculum_version_id === V1)).toBe(true);
  });

  it('ignores a foreign-version activity (never crosses versions)', async () => {
    const { client } = pinnedClient('s1-v1');
    const res = await recordCurricularPracticeFromIdentity(client, 'u1', 'writing', 'review-1', { versionId: V2, subtopicKey: 'A1.M1.S1' });
    expect(res.recorded).toBe(false);
    expect(client._upserts.some((u: any) => u.table === 'user_subtopic_modality_progress')).toBe(false);
  });

  it('recordCurricularPractice (instantaneous) records against the current recorte', async () => {
    const { client } = pinnedClient('s1-v1');
    const res = await recordCurricularPractice(client, 'u1', 'writing', 'review-1');
    expect(res.recorded).toBe(true);
    expect(res.subtopicKey).toBe('A1.M1.S1');
  });

  it('identity-required path with a NULL identity grants NO credit — never falls back to current (blocker 5)', async () => {
    const { client } = pinnedClient('s1-v1');
    const res = await recordCurricularPracticeFromIdentity(client, 'u1', 'listening', 'story-1', null);
    expect(res.recorded).toBe(false);
    expect(client._upserts.some((u: any) => u.table === 'user_subtopic_modality_progress')).toBe(false);
  });

  it('identity-required path with a missing subtopicKey grants NO credit', async () => {
    const { client } = pinnedClient('s1-v1');
    const res = await recordCurricularPracticeFromIdentity(client, 'u1', 'listening', 'story-1', { versionId: V1, subtopicKey: '' });
    expect(res.recorded).toBe(false);
    expect(client._upserts.some((u: any) => u.table === 'user_subtopic_modality_progress')).toBe(false);
  });
});
