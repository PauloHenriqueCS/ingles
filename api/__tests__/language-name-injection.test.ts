/**
 * End-to-end proof of the language-resolution fix.
 *
 * ROOT CAUSE of the wrong/mixed-language regression: curriculum templates used
 * {{learning_language}} as the output-language directive, which the composer
 * filled with the RAW ISO code ("en"). "Generate a story in en" is a weak signal
 * and, next to interface-language curricular metadata, the model drifted into the
 * interface language (Portuguese).
 *
 * THE FIX: resolveActivityPrompt now resolves human-readable language NAMES from
 * public.languages and injects {{learning_language_name}} / {{interface_language_name}}
 * into EVERY template. This test drives the REAL resolveActivityPrompt (no mock of
 * the composer) through an in-memory Supabase and asserts the composed prompt
 * says "English" / "Brazilian Portuguese", never the bare code — for a
 * configurable language pair (no English-specific code path).
 */
import { describe, it, expect } from 'vitest';
import { resolveActivityPrompt } from '../_curriculum/curriculum-runtime';

interface Rows { [table: string]: any[] }

function makeClient(tables: Rows) {
  const db: Rows = {
    user_learning_paths: [], user_curriculum_preferences: [], user_curriculum_progress: [],
    curriculum_versions: [], curriculum_subtopics: [], curriculum_subtopic_i18n: [],
    curriculum_language_targets: [], curriculum_modules: [], curriculum_module_i18n: [],
    level_generation_rules: [], prompt_templates: [], languages: [], ...tables,
  };
  function makeQuery(table: string) {
    let rows = [...(db[table] ?? [])];
    let orderCol: string | null = null; let orderAsc = true;
    const q: any = {
      select() { return q; },
      eq(col: string, val: any) { rows = rows.filter((r) => r[col] === val); return q; },
      is(col: string, val: any) { rows = rows.filter((r) => (r[col] ?? null) === val); return q; },
      in(col: string, vals: any[]) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
      neq(col: string, val: any) { rows = rows.filter((r) => r[col] !== val); return q; },
      order(col: string, opts?: { ascending?: boolean }) { orderCol = col; orderAsc = opts?.ascending !== false; return q; },
      limit(n: number) { rows = applyOrder().slice(0, n); return q; },
      async maybeSingle() { const r = applyOrder(); return { data: r[0] ?? null, error: null }; },
      then(resolve: (v: any) => any) { return resolve({ data: applyOrder(), error: null }); },
      async upsert() { return { data: null, error: null }; },
    };
    function applyOrder() {
      if (!orderCol) return rows;
      const c = orderCol;
      return [...rows].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (orderAsc ? 1 : -1));
    }
    return q;
  }
  return { from(table: string) { return makeQuery(table); }, async rpc() { return { data: null, error: null }; } } as any;
}

const VER = 'ver-1';

/** Fixtures for one user pinned to a version, sitting on subtopic A1.M1.S1. */
function fixtures(opts: { learning: string; iface: string; languages: any[]; template: any }) {
  return {
    user_learning_paths: [{ user_id: 'u1', learning_language: opts.learning, interface_language: opts.iface, curriculum_version_id: VER, initial_level_code: 'A1', is_active: true }],
    curriculum_versions: [{ id: VER, curriculum_id: 'cur-1', version: 1, status: 'published' }],
    user_curriculum_preferences: [{ user_id: 'u1', curriculum_version_id: VER, learning_language: opts.learning, interface_language: opts.iface, practice_writing: true, practice_listening: false, practice_pronunciation: false, practice_conversation: false }],
    user_curriculum_progress: [{ user_id: 'u1', curriculum_version_id: VER, current_subtopic_id: 's1', current_module_id: 'm1', current_level_code: 'A1', status: 'active' }],
    curriculum_subtopics: [{ id: 's1', module_id: 'm1', curriculum_version_id: VER, subtopic_key: 'A1.M1.S1', level_code: 'A1', sort_order: 1, curriculum_modules: { module_key: 'A1.M1', sort_order: 1 } }],
    curriculum_subtopic_i18n: [{ subtopic_id: 's1', interface_language: opts.iface, capability: 'Cumprimentar e apresentar-se' }],
    curriculum_language_targets: [{ subtopic_id: 's1', kind: 'support', sort_order: 0, target_text: 'saudações' }],
    curriculum_modules: [{ id: 'm1', curriculum_version_id: VER, module_key: 'A1.M1', level_code: 'A1', sort_order: 1 }],
    curriculum_module_i18n: [{ module_id: 'm1', interface_language: opts.iface, title: 'Apresentações', capability: 'apresentar-se' }],
    prompt_templates: [opts.template],
    languages: opts.languages,
  };
}

const LANGS = [
  { code: 'en', english_name: 'English', native_name: 'English' },
  { code: 'pt-BR', english_name: 'Brazilian Portuguese', native_name: 'Português (Brasil)' },
  { code: 'es', english_name: 'Spanish', native_name: 'Español' },
];

function listeningTemplate(learning: string, iface: string) {
  return {
    template_key: 'listening.two_part_generate', learning_language: learning, interface_language: iface,
    version: 1, status: 'published', model: null, temperature: 0.8,
    required_placeholders: ['learning_language_name', 'level', 'subtopic_capability'],
    system_body: 'Generate a listening activity in {{learning_language_name}} at {{level}}. Capability: {{subtopic_capability}}. Explanations in {{interface_language_name}}.',
    user_body: 'Generate now.',
  };
}

describe('resolveActivityPrompt — injects human-readable language names (the fix)', () => {
  it('renders the learning language as a NAME ("English"), never the bare code "en"', async () => {
    const client = makeClient(fixtures({ learning: 'en', iface: 'pt-BR', languages: LANGS, template: listeningTemplate('en', 'pt-BR') }));
    const resolved = await resolveActivityPrompt(client, 'u1', {
      templateKey: 'listening.two_part_generate', activityType: 'listening',
    });
    expect(resolved.system).toContain('Generate a listening activity in English');
    expect(resolved.system).toContain('Explanations in Brazilian Portuguese');
    // The weak, ambiguous bare-code directive must be gone.
    expect(resolved.system).not.toContain('activity in en ');
    expect(resolved.system).not.toContain('in pt-BR');
  });

  it('is configurable: a Spanish learner gets "Spanish" from the SAME code path (no en-hardcode)', async () => {
    const client = makeClient(fixtures({ learning: 'es', iface: 'pt-BR', languages: LANGS, template: listeningTemplate('es', 'pt-BR') }));
    const resolved = await resolveActivityPrompt(client, 'u1', {
      templateKey: 'listening.two_part_generate', activityType: 'listening',
    });
    expect(resolved.system).toContain('Generate a listening activity in Spanish');
    expect(resolved.system).not.toContain('in es ');
  });

  it('degrades safely to the raw code when the language has no row (never throws)', async () => {
    const client = makeClient(fixtures({ learning: 'en', iface: 'pt-BR', languages: [], template: listeningTemplate('en', 'pt-BR') }));
    const resolved = await resolveActivityPrompt(client, 'u1', {
      templateKey: 'listening.two_part_generate', activityType: 'listening',
    });
    // No languages row → falls back to the code, but generation still works.
    expect(resolved.system).toContain('Generate a listening activity in en');
  });
});
