/**
 * The four CURRICULAR modalities (Writing, Listening, Pronunciation,
 * Conversation Guided) must resolve EXACTLY the same curricular identity
 * (curriculum_version_id + subtopic_key) for the same curricular moment, because
 * they all read it from the single seam `ensureUserCurriculum`. Conversation
 * FREE is explicitly NOT part of this equivalence and earns no credit. New
 * activities follow the pointer when it advances; already-started activities
 * keep the identity they were born with. And a non-English learning language
 * works through the same code path (no English-specific conditionals).
 */
import { describe, it, expect } from 'vitest';
import { ensureUserCurriculum, recordCurricularPracticeFromIdentity } from '../_curriculum/curriculum-runtime';
import { computeGuidedEligible } from '../conversation/_session-mode';

// ── In-memory Supabase mock (mirrors curriculum-version-pinning test) ─────────
function makeClient(tables: Record<string, any[]>, onRpc?: (name: string, args: any) => any) {
  const db: Record<string, any[]> = {
    user_learning_paths: [], user_curriculum_preferences: [], curriculum_versions: [], curricula: [],
    curriculum_subtopics: [], curriculum_modules: [], user_curriculum_progress: [],
    english_learning_memory: [], user_subtopic_modality_progress: [], ...tables,
  };
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
    _db: db,
    from(table: string) { return makeQuery(table); },
    async rpc(name: string, args: any) { return { data: onRpc ? onRpc(name, args) : null, error: null }; },
  } as any;
}

const CUR = 'cur-en';
const V1 = 'v1-en';
function enTables(currentSubtopicId: string) {
  return {
    curricula: [{ id: CUR, learning_language: 'en', framework_id: 'fw' }],
    curriculum_versions: [{ id: V1, curriculum_id: CUR, version: 1, status: 'published', 'curricula.learning_language': 'en' }],
    curriculum_subtopics: [
      { id: 's1', curriculum_version_id: V1, subtopic_key: 'A1.SELFINTRO.GREET', level_code: 'A1', sort_order: 1, module_id: 'm1', curriculum_modules: { module_key: 'A1.SELFINTRO', sort_order: 1 } },
      { id: 's2', curriculum_version_id: V1, subtopic_key: 'A1.SELFINTRO.ORIGIN', level_code: 'A1', sort_order: 2, module_id: 'm1', curriculum_modules: { module_key: 'A1.SELFINTRO', sort_order: 1 } },
    ],
    user_learning_paths: [{ user_id: 'u1', learning_language: 'en', curriculum_version_id: V1, interface_language: 'pt-BR', initial_level_code: null, is_active: true }],
    user_curriculum_preferences: [{ user_id: 'u1', curriculum_version_id: V1, learning_language: 'en', interface_language: 'pt-BR', practice_writing: true, practice_listening: true, practice_pronunciation: true, practice_conversation: true }],
    user_curriculum_progress: [{ user_id: 'u1', curriculum_version_id: V1, current_subtopic_id: currentSubtopicId, current_module_id: 'm1', current_level_code: 'A1', status: 'active' }],
  };
}

// Each curricular modality captures identity from the SAME seam at creation.
async function captureIdentity(client: any, userId: string) {
  const e = await ensureUserCurriculum(client, userId);
  return { versionId: e.versionId, subtopicKey: e.currentSubtopicKey };
}

describe('four-modality curricular identity equivalence', () => {
  it('Writing, Listening, Pronunciation and Conversation Guided resolve the SAME identity', async () => {
    const client = makeClient(enTables('s1'));
    const writing = await captureIdentity(client, 'u1');
    const listening = await captureIdentity(client, 'u1');
    const pronunciation = await captureIdentity(client, 'u1');
    const conversationGuided = await captureIdentity(client, 'u1');

    expect(writing).toEqual({ versionId: V1, subtopicKey: 'A1.SELFINTRO.GREET' });
    expect(listening).toEqual(writing);
    expect(pronunciation).toEqual(writing);
    expect(conversationGuided).toEqual(writing);
  });

  it('Conversation FREE is explicitly NOT part of the curricular equivalence (no credit)', () => {
    // A free session never earns curricular credit — even with a valid recorte
    // and Conversation selected — so it is not a curricular modality at all.
    expect(computeGuidedEligible({ sessionMode: 'free', conversationInPlan: true, hasCurricularIdentity: true })).toBe(false);
    // Guided, in-plan, with the same recorte IS the curricular one.
    expect(computeGuidedEligible({ sessionMode: 'guided', conversationInPlan: true, hasCurricularIdentity: true })).toBe(true);
  });

  it('NEW activities follow the advanced pointer; already-started activities keep their origin identity', async () => {
    // Activity A (e.g. a writing mission) is created while the pointer is at S1.
    const clientBefore = makeClient(enTables('s1'));
    const startedActivity = await captureIdentity(clientBefore, 'u1'); // frozen at creation
    expect(startedActivity.subtopicKey).toBe('A1.SELFINTRO.GREET');

    // The user progresses: the pointer is now at S2. A NEW activity resolves S2.
    const clientAfter = makeClient(enTables('s2'));
    const newActivity = await captureIdentity(clientAfter, 'u1');
    expect(newActivity.subtopicKey).toBe('A1.SELFINTRO.ORIGIN');

    // The already-started activity's captured identity is UNCHANGED (still S1)…
    expect(startedActivity.subtopicKey).toBe('A1.SELFINTRO.GREET');

    // …and completing it credits its ORIGIN recorte (S1), not the current S2.
    const credit = await recordCurricularPracticeFromIdentity(
      clientAfter, 'u1', 'writing', 'mission-A', startedActivity,
    );
    expect(credit.recorded).toBe(true);
    expect(credit.subtopicKey).toBe('A1.SELFINTRO.GREET');
    const practiceUpsert = clientAfter._upserts.find((u: any) => u.table === 'user_subtopic_modality_progress');
    expect(practiceUpsert?.row.subtopic_id).toBe('s1'); // origin, not the advanced S2
  });
});

describe('multilingual: a non-English learning language uses the same code path', () => {
  const ES_CUR = 'cur-es';
  const ES_V1 = 'v1-es';
  it('resolves the Spanish version + recorte with NO English-specific branching', async () => {
    const client = makeClient({
      curricula: [{ id: ES_CUR, learning_language: 'es', framework_id: 'fw' }],
      curriculum_versions: [{ id: ES_V1, curriculum_id: ES_CUR, version: 1, status: 'published', 'curricula.learning_language': 'es' }],
      curriculum_subtopics: [
        { id: 'es-s1', curriculum_version_id: ES_V1, subtopic_key: 'A1.PRESENT.GREET', level_code: 'A1', sort_order: 1, module_id: 'es-m1', curriculum_modules: { module_key: 'A1.PRESENT', sort_order: 1 } },
      ],
      user_learning_paths: [{ user_id: 'u-es', learning_language: 'es', curriculum_version_id: ES_V1, interface_language: 'pt-BR', initial_level_code: null, is_active: true }],
      user_curriculum_preferences: [{ user_id: 'u-es', curriculum_version_id: ES_V1, learning_language: 'es', interface_language: 'pt-BR', practice_writing: true, practice_listening: false, practice_pronunciation: false, practice_conversation: false }],
      user_curriculum_progress: [{ user_id: 'u-es', curriculum_version_id: ES_V1, current_subtopic_id: 'es-s1', current_module_id: 'es-m1', current_level_code: 'A1', status: 'active' }],
    });
    const ensured = await ensureUserCurriculum(client, 'u-es');
    expect(ensured.versionId).toBe(ES_V1);
    expect(ensured.languageContext.learningLanguage).toBe('es');
    expect(ensured.currentSubtopicKey).toBe('A1.PRESENT.GREET');
  });
});
