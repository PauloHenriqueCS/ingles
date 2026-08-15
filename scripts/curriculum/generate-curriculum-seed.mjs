// =============================================================================
// generate-curriculum-seed.mjs
//
// Reads the canonical curriculum source documents (committed under
// supabase/curriculum_source/) and generates the static seed migration
// supabase/migrations/20260815120100_seed_curriculum_english_v1.sql.
//
// This keeps the seed REPRODUCIBLE from data: re-running regenerates the exact
// same idempotent SQL. The code here is a build-time transformer — no pedagogical
// English knowledge is hardcoded; it only parses the data files.
//
//   node scripts/curriculum/generate-curriculum-seed.mjs
//
// Exits non-zero if the parsed recorte counts don't match the documented totals
// (A1 29 / A2 29 / B1 28 / B2 27 / C1 30 / C2 33 = 176).
// =============================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const srcDir = join(repoRoot, 'supabase', 'curriculum_source');
const recortesPath = join(srcDir, 'orodim_recortes_curriculo_A1_C2_V1_revisado.md');
const macroPath = join(srcDir, 'orodim_curriculo_revisado.md');
const outPath = join(repoRoot, 'supabase', 'migrations', '20260815120100_seed_curriculum_english_v1.sql');

const EXPECTED = { A1: 29, A2: 29, B1: 28, B2: 27, C1: 30, C2: 33 };
const LEARNING_LANGUAGE = 'en';
const INTERFACE_LANGUAGE = 'pt-BR';
const CURRICULUM_SLUG = 'orodim-english';
const CURRICULUM_VERSION = 1;

const esc = (s) => (s == null ? null : String(s).replace(/'/g, "''").trim());
const q = (s) => (s == null ? 'NULL' : `'${esc(s)}'`);

// ---------- parse macro doc: module capability by (level, title) ----------
function parseMacro(text) {
  const lines = text.split(/\r?\n/);
  const byLevelTitle = new Map(); // key `${level}::${title}` -> capability
  let level = null;
  let currentTitle = null;
  for (const line of lines) {
    const lvl = line.match(/^#\s+Currículo\s+([A-C][12])\s*$/);
    if (lvl) { level = lvl[1]; currentTitle = null; continue; }
    const mod = line.match(/^##\s+Módulo\s+\d+\s+—\s+(.+?)\s*(?:\*\*\[.*\]\*\*)?\s*$/);
    if (mod && level) {
      // strip trailing " **[ajuste...]**" markers already handled by regex group; also strip inline markers
      currentTitle = mod[1].replace(/\s*\*\*\[[^\]]*\]\*\*\s*$/, '').trim();
      continue;
    }
    const cap = line.match(/^Capacidade:\s*(.+?)\s*$/);
    if (cap && level && currentTitle) {
      const key = `${level}::${normalize(currentTitle)}`;
      if (!byLevelTitle.has(key)) byLevelTitle.set(key, cap[1].replace(/\.$/, '').trim());
      currentTitle = null; // only first capability line per module
    }
  }
  return byLevelTitle;
}

const normalize = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

// ---------- parse recortes doc ----------
function parseRecortes(text) {
  const lines = text.split(/\r?\n/);
  let level = null;
  const modules = []; // {key, level, sortOrder, title, subtopics:[{key, capability, support}]}
  let currentModule = null;
  let currentSub = null;
  let moduleOrderByLevel = {};
  let subOrderByModule = {};
  const transversal = [];

  let section = 'main';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const lvl = line.match(/^#\s+([A-C][12])\s+—\s+\d+\s+recortes/);
    if (lvl) { level = lvl[1]; moduleOrderByLevel[level] = 0; currentModule = null; currentSub = null; section = 'main'; continue; }

    if (/^#\s+Conteúdos transversais/.test(line)) { section = 'transversal'; currentModule = null; currentSub = null; continue; }
    if (/^#\s+Principais fusões/.test(line) || /^#\s+Observação final/.test(line)) { section = 'end'; continue; }

    if (section === 'transversal') {
      const t = line.match(/^-\s+`(TRANS\.[A-Z0-9_]+)`\s+—\s+(.+?)\s*$/);
      if (t) {
        const desc = t[2].replace(/\.$/, '').trim();
        let minLevel = null;
        const ml = desc.match(/a partir do\s+([A-C][12])/i);
        if (ml) minLevel = ml[1].toUpperCase();
        transversal.push({ key: t[1], label: labelForTransversal(t[1]), description: desc, minLevel, sortOrder: transversal.length + 1 });
      }
      continue;
    }

    if (section !== 'main') continue;

    // module header: "## A1.SELFINTRO — Falar sobre si mesmo"
    const mod = line.match(/^##\s+([A-C][12]\.[A-Z0-9_]+)\s+—\s+(.+?)\s*$/);
    if (mod && level && mod[1].startsWith(level + '.')) {
      moduleOrderByLevel[level] += 1;
      currentModule = {
        key: mod[1],
        level,
        sortOrder: moduleOrderByLevel[level],
        title: mod[2].trim(),
        subtopics: [],
      };
      subOrderByModule[currentModule.key] = 0;
      modules.push(currentModule);
      currentSub = null;
      continue;
    }

    // subtopic header: "### `A1.SELFINTRO.GREET_INTRODUCE`"
    const sub = line.match(/^###\s+`([^`]+)`\s*$/);
    if (sub && currentModule) {
      subOrderByModule[currentModule.key] += 1;
      currentSub = { key: sub[1].trim(), level, sortOrder: subOrderByModule[currentModule.key], capability: null, support: null };
      currentModule.subtopics.push(currentSub);
      continue;
    }

    // capability / support lines
    const cap = line.match(/^\*\*Capacidade:\*\*\s*(.+?)\s*$/);
    if (cap && currentSub) { currentSub.capability = cap[1].replace(/\.$/, '').trim(); continue; }
    const sup = line.match(/^\*\*Suporte linguístico:\*\*\s*(.+?)\s*$/);
    if (sup && currentSub) { currentSub.support = sup[1].replace(/\.$/, '').trim(); continue; }
  }

  return { modules, transversal };
}

function labelForTransversal(key) {
  // Human label derived from key; kept generic (interface_language pt-BR seed).
  const map = {
    'TRANS.ARTICLES': 'Artigos',
    'TRANS.PREPOSITIONS': 'Preposições',
    'TRANS.QUANTIFIERS': 'Quantificadores',
    'TRANS.QUESTIONS': 'Formação de perguntas',
    'TRANS.PHRASAL': 'Phrasal verbs',
    'TRANS.L1_INTERFERENCE': 'Interferência do português',
  };
  return map[key] || key;
}

// split "Second Conditional, would" -> ["Second Conditional", "would"]
function splitTargets(support) {
  if (!support) return [];
  return support
    .split(',')
    .map((s) => s.trim().replace(/\.$/, ''))
    .filter(Boolean);
}

// ---------- main ----------
const recortesText = readFileSync(recortesPath, 'utf8');
const macroText = readFileSync(macroPath, 'utf8');

const { modules, transversal } = parseRecortes(recortesText);
const macroCaps = parseMacro(macroText);

// counts per level
const counts = {};
for (const m of modules) {
  counts[m.level] = (counts[m.level] || 0) + m.subtopics.length;
}
let total = 0;
let ok = true;
for (const lvl of Object.keys(EXPECTED)) {
  const got = counts[lvl] || 0;
  total += got;
  if (got !== EXPECTED[lvl]) { ok = false; console.error(`COUNT MISMATCH ${lvl}: expected ${EXPECTED[lvl]}, got ${got}`); }
}
console.log('Recorte counts per level:', counts, 'total:', total);
console.log('Modules parsed:', modules.length, 'Transversal topics:', transversal.length);

// validate unique subtopic keys
const seen = new Set();
for (const m of modules) for (const s of m.subtopics) {
  if (seen.has(s.key)) { ok = false; console.error('DUPLICATE subtopic key:', s.key); }
  seen.add(s.key);
  if (!s.capability) { ok = false; console.error('MISSING capability for', s.key); }
}

if (!ok || total !== 176) {
  console.error(`FAILED validation. total=${total} (expected 176). Aborting seed generation.`);
  process.exit(1);
}

// ---------- emit SQL ----------
const out = [];
out.push(`-- =============================================================================`);
out.push(`-- MIGRATION: 20260815120100_seed_curriculum_english_v1`);
out.push(`-- Projeto: Orodim`);
out.push(`--`);
out.push(`-- Aplicada automaticamente por deploy-production.yml / homologation.yml.`);
out.push(`-- Não aplicar manualmente no SQL Editor.`);
out.push(`--`);
out.push(`-- GERADO por scripts/curriculum/generate-curriculum-seed.mjs a partir de`);
out.push(`-- supabase/curriculum_source/*.md (fonte de verdade do currículo). NÃO editar`);
out.push(`-- à mão — regenerar rodando o script. Idempotente (ON CONFLICT DO UPDATE).`);
out.push(`--`);
out.push(`-- Carrega o currículo inglês V1: 6 níveis, ${modules.length} módulos, ${total} recortes`);
out.push(`-- internos (A1 ${counts.A1}/A2 ${counts.A2}/B1 ${counts.B1}/B2 ${counts.B2}/C1 ${counts.C1}/C2 ${counts.C2}) e ${transversal.length} conteúdos transversais.`);
out.push(`-- learning_language=${LEARNING_LANGUAGE}, interface_language(i18n)=${INTERFACE_LANGUAGE}.`);
out.push(`-- =============================================================================`);
out.push('');

// languages (available options; only what we need + a few ready-to-use codes)
out.push(`-- Idiomas disponíveis (papel definido por quem referencia). Nenhum é "a língua base".`);
const langs = [
  ['pt-BR', 'Brazilian Portuguese', 'Português (Brasil)'],
  ['en', 'English', 'English'],
  ['es', 'Spanish', 'Español'],
  ['fr', 'French', 'Français'],
  ['it', 'Italian', 'Italiano'],
  ['de', 'German', 'Deutsch'],
];
for (const [code, en, native] of langs) {
  out.push(`INSERT INTO public.languages (code, english_name, native_name) VALUES (${q(code)}, ${q(en)}, ${q(native)})`);
  out.push(`  ON CONFLICT (code) DO UPDATE SET english_name=EXCLUDED.english_name, native_name=EXCLUDED.native_name, updated_at=now();`);
}
out.push('');

// framework + levels
out.push(`-- Framework de proficiência (CEFR é UM framework — dado, não hardcode).`);
out.push(`INSERT INTO public.proficiency_frameworks (id, label, description) VALUES ('CEFR','CEFR','Common European Framework of Reference')`);
out.push(`  ON CONFLICT (id) DO UPDATE SET label=EXCLUDED.label, description=EXCLUDED.description;`);
['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].forEach((lvl, idx) => {
  out.push(`INSERT INTO public.proficiency_levels (framework_id, code, sort_order, label) VALUES ('CEFR', ${q(lvl)}, ${idx + 1}, ${q(lvl)})`);
  out.push(`  ON CONFLICT (framework_id, code) DO UPDATE SET sort_order=EXCLUDED.sort_order, label=EXCLUDED.label;`);
});
out.push('');

// curriculum + version
out.push(`-- Currículo + versão publicada.`);
out.push(`INSERT INTO public.curricula (slug, learning_language, framework_id, title)`);
out.push(`  VALUES (${q(CURRICULUM_SLUG)}, ${q(LEARNING_LANGUAGE)}, 'CEFR', 'Orodim English (A1–C2)')`);
out.push(`  ON CONFLICT (slug) DO UPDATE SET learning_language=EXCLUDED.learning_language, framework_id=EXCLUDED.framework_id, title=EXCLUDED.title, updated_at=now();`);
out.push(`INSERT INTO public.curriculum_versions (curriculum_id, version, status, published_at, notes)`);
out.push(`  SELECT c.id, ${CURRICULUM_VERSION}, 'published', now(), 'English V1 (176 recortes)' FROM public.curricula c WHERE c.slug=${q(CURRICULUM_SLUG)}`);
out.push(`  ON CONFLICT (curriculum_id, version) DO UPDATE SET status=EXCLUDED.status, notes=EXCLUDED.notes, updated_at=now();`);
out.push('');

// big DO block
out.push(`DO $seed$`);
out.push(`DECLARE`);
out.push(`  v_ver uuid;`);
out.push(`  v_mod uuid;`);
out.push(`  v_sub uuid;`);
out.push(`BEGIN`);
out.push(`  SELECT cv.id INTO v_ver FROM public.curriculum_versions cv`);
out.push(`    JOIN public.curricula c ON c.id = cv.curriculum_id`);
out.push(`    WHERE c.slug=${q(CURRICULUM_SLUG)} AND cv.version=${CURRICULUM_VERSION};`);
out.push(`  IF v_ver IS NULL THEN RAISE EXCEPTION 'curriculum version not found for seed'; END IF;`);
out.push('');

for (const m of modules) {
  const capKey = `${m.level}::${normalize(m.title)}`;
  const moduleCapability = macroCaps.get(capKey) || null;
  out.push(`  -- MODULE ${m.key}`);
  out.push(`  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)`);
  out.push(`    VALUES (v_ver, ${q(m.key)}, ${q(m.level)}, ${m.sortOrder})`);
  out.push(`    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order`);
  out.push(`    RETURNING id INTO v_mod;`);
  out.push(`  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)`);
  out.push(`    VALUES (v_mod, ${q(INTERFACE_LANGUAGE)}, ${q(m.title)}, ${q(moduleCapability)})`);
  out.push(`    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;`);
  for (const s of m.subtopics) {
    out.push(`  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)`);
    out.push(`    VALUES (v_ver, v_mod, ${q(s.key)}, ${q(s.level)}, ${s.sortOrder})`);
    out.push(`    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order`);
    out.push(`    RETURNING id INTO v_sub;`);
    out.push(`  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)`);
    out.push(`    VALUES (v_sub, ${q(INTERFACE_LANGUAGE)}, ${q(s.capability)})`);
    out.push(`    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;`);
    const targets = splitTargets(s.support);
    targets.forEach((t, idx) => {
      out.push(`  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)`);
      out.push(`    VALUES (v_sub, 'support', ${idx}, ${q(t)})`);
      out.push(`    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;`);
    });
  }
  out.push('');
}

// transversal
out.push(`  -- TRANSVERSAL TOPICS (fora da sequência obrigatória; não bloqueiam progressão)`);
for (const t of transversal) {
  out.push(`  DECLARE v_trans uuid; BEGIN`);
  out.push(`  INSERT INTO public.curriculum_transversal_topics (curriculum_version_id, topic_key, min_level_code, sort_order)`);
  out.push(`    VALUES (v_ver, ${q(t.key)}, ${q(t.minLevel)}, ${t.sortOrder})`);
  out.push(`    ON CONFLICT (curriculum_version_id, topic_key) DO UPDATE SET min_level_code=EXCLUDED.min_level_code, sort_order=EXCLUDED.sort_order`);
  out.push(`    RETURNING id INTO v_trans;`);
  out.push(`  INSERT INTO public.curriculum_transversal_topic_i18n (topic_id, interface_language, label, description)`);
  out.push(`    VALUES (v_trans, ${q(INTERFACE_LANGUAGE)}, ${q(t.label)}, ${q(t.description)})`);
  out.push(`    ON CONFLICT (topic_id, interface_language) DO UPDATE SET label=EXCLUDED.label, description=EXCLUDED.description;`);
  out.push(`  END;`);
}
out.push('');
out.push(`END`);
out.push(`$seed$;`);
out.push('');
out.push(`-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.`);
out.push('');

writeFileSync(outPath, out.join('\n'), 'utf8');
console.log('Seed written to', outPath);
console.log('OK — 176 recortes generated.');
