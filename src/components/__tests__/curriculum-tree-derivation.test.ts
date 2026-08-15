/**
 * Unit tests for the LOAD-BEARING macro-tree derivation that powers the
 * "Plano de ensino" experience: assembleCurriculumTree (in
 * api/_curriculum/route-handler.ts).
 *
 * This repo has no DOM/component test harness (vite.config.ts's vitest
 * environment is 'node', with no @testing-library/react or jsdom) — see
 * RewriteSection-wiring.test.ts for the established precedent. The status logic
 * that the spec's scenarios require ("A1 user sees A1 marked current", "B1 user
 * sees A1/A2 concluído", "future level modules read-only", "C2-completed with no
 * reset", "no recortes exposed") lives entirely in this pure function, so it is
 * verified here directly. Component wiring (badges, click-to-open, read-only) is
 * asserted statically in CurriculumPlanView-wiring.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  assembleCurriculumTree,
  type AssembleCurriculumTreeInput,
  type TreeLevelInput,
  type TreeModuleInput,
} from '../../../api/_curriculum/route-handler';

// ── Fixtures ─────────────────────────────────────────────────────────────────
// bandLabel is now RESOLVED FROM DATA (proficiency_band_i18n) in handleTree and
// passed to the pure assembler — no in-code band derivation (blocker 14).
const LEVELS: TreeLevelInput[] = [
  { code: 'A1', sortOrder: 1, label: 'A1', bandLabel: 'Iniciante' },
  { code: 'A2', sortOrder: 2, label: 'A2', bandLabel: 'Iniciante' },
  { code: 'B1', sortOrder: 3, label: 'B1', bandLabel: 'Intermediário' },
  { code: 'B2', sortOrder: 4, label: 'B2', bandLabel: 'Intermediário' },
  { code: 'C1', sortOrder: 5, label: 'C1', bandLabel: 'Avançado' },
  { code: 'C2', sortOrder: 6, label: 'C2', bandLabel: 'Avançado' },
];

// Two modules per level; module_key carries the level prefix.
const MODULE_DEFS: Array<[string, string]> = [
  ['A1', 'A1.SELFINTRO'], ['A1', 'A1.ROUTINE'],
  ['A2', 'A2.PAST'], ['A2', 'A2.PLANS'],
  ['B1', 'B1.OPINION'], ['B1', 'B1.WORK'],
  ['B2', 'B2.ARGUE'], ['B2', 'B2.MEDIA'],
  ['C1', 'C1.NUANCE'], ['C1', 'C1.ACADEMIC'],
  ['C2', 'C2.MASTERY'], ['C2', 'C2.STYLE'],
];

const MODULES: TreeModuleInput[] = MODULE_DEFS.map(([levelCode, moduleKey], i) => ({
  moduleKey,
  levelCode,
  title: `Título de ${moduleKey}`,
  sortOrder: (i % 2) + 1,
}));

function subtopicsByModule(): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const [, moduleKey] of MODULE_DEFS) m.set(moduleKey, [`${moduleKey}.S1`, `${moduleKey}.S2`]);
  return m;
}

/** All subtopic keys belonging to the given level codes. */
function completedThroughLevels(levelCodes: string[]): Set<string> {
  const set = new Set<string>();
  for (const [levelCode, moduleKey] of MODULE_DEFS) {
    if (levelCodes.includes(levelCode)) {
      set.add(`${moduleKey}.S1`);
      set.add(`${moduleKey}.S2`);
    }
  }
  return set;
}

function baseInput(overrides: Partial<AssembleCurriculumTreeInput>): AssembleCurriculumTreeInput {
  return {
    interfaceLanguage: 'pt-BR',
    status: 'active',
    levels: LEVELS,
    modules: MODULES,
    subtopicKeysByModule: subtopicsByModule(),
    completedSubtopicKeys: new Set<string>(),
    currentSubtopicKey: null,
    ...overrides,
  };
}

function levelByCode(tree: ReturnType<typeof assembleCurriculumTree>, code: string) {
  const lvl = tree.levels.find((l) => l.levelCode === code);
  if (!lvl) throw new Error(`level ${code} missing from tree`);
  return lvl;
}

// ── Band labels ──────────────────────────────────────────────────────────────

describe('band labels are passed through from data (blocker 14)', () => {
  it('the assembler surfaces the DATA-resolved band label per level (no in-code derivation)', () => {
    const tree = assembleCurriculumTree(baseInput({ currentSubtopicKey: 'A1.SELFINTRO.S1', completedSubtopicKeys: new Set() }));
    expect(levelByCode(tree, 'A1').band).toBe('Iniciante');
    expect(levelByCode(tree, 'B1').band).toBe('Intermediário');
    expect(levelByCode(tree, 'C1').band).toBe('Avançado');
  });
});

// ── A1 (brand-new) user ──────────────────────────────────────────────────────

describe('A1 user — sees A1..C2 with A1 marked current (SEU NÍVEL)', () => {
  const tree = assembleCurriculumTree(
    baseInput({ currentSubtopicKey: 'A1.SELFINTRO.S1', completedSubtopicKeys: new Set() }),
  );

  it('exposes the whole ladder A1..C2 in order', () => {
    expect(tree.levels.map((l) => l.levelCode)).toEqual(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
  });

  it('A1 is the current level and everything else is future', () => {
    expect(levelByCode(tree, 'A1').status).toBe('current');
    for (const code of ['A2', 'B1', 'B2', 'C1', 'C2']) {
      expect(levelByCode(tree, code).status).toBe('future');
    }
    expect(tree.currentLevelCode).toBe('A1');
  });

  it('inside A1 the current module is the one holding the current recorte', () => {
    const a1 = levelByCode(tree, 'A1');
    expect(a1.modules.find((m) => m.moduleKey === 'A1.SELFINTRO')?.status).toBe('current');
    expect(a1.modules.find((m) => m.moduleKey === 'A1.ROUTINE')?.status).toBe('future');
  });

  it('carries band labels for every level', () => {
    expect(levelByCode(tree, 'A1').band).toBe('Iniciante');
    expect(levelByCode(tree, 'B1').band).toBe('Intermediário');
    expect(levelByCode(tree, 'C1').band).toBe('Avançado');
  });
});

// ── B1 user ──────────────────────────────────────────────────────────────────

describe('B1 user — A1/A2 Concluído, B1 current, later levels future', () => {
  const tree = assembleCurriculumTree(
    baseInput({
      currentSubtopicKey: 'B1.OPINION.S1',
      completedSubtopicKeys: completedThroughLevels(['A1', 'A2']),
    }),
  );

  it('A1 and A2 are completed, B1 is current', () => {
    expect(levelByCode(tree, 'A1').status).toBe('completed');
    expect(levelByCode(tree, 'A2').status).toBe('completed');
    expect(levelByCode(tree, 'B1').status).toBe('current');
    expect(tree.currentLevelCode).toBe('B1');
  });

  it('B2, C1, C2 remain future', () => {
    for (const code of ['B2', 'C1', 'C2']) {
      expect(levelByCode(tree, code).status).toBe('future');
    }
  });

  it('B1 shows its modules with the current module current (Você está aqui)', () => {
    const b1 = levelByCode(tree, 'B1');
    expect(b1.modules.map((m) => m.moduleKey)).toEqual(['B1.OPINION', 'B1.WORK']);
    expect(b1.modules.find((m) => m.moduleKey === 'B1.OPINION')?.status).toBe('current');
    expect(b1.modules.find((m) => m.moduleKey === 'B1.WORK')?.status).toBe('future');
  });

  it('module nodes expose ONLY moduleKey/title/status — never recortes, counts or ids', () => {
    for (const level of tree.levels) {
      for (const mod of level.modules) {
        expect(Object.keys(mod).sort()).toEqual(['moduleKey', 'status', 'title']);
        // No recorte/subtopic key ever leaks into a displayable field.
        expect(mod.title).not.toMatch(/\.S\d/);
        expect(JSON.stringify(mod)).not.toMatch(/\.S1|\.S2/);
      }
    }
  });
});

// ── Viewing a future level (C1) is read-only ─────────────────────────────────

describe('future level (C1) is viewable read-only and does not change the user level', () => {
  const input = baseInput({
    currentSubtopicKey: 'B1.OPINION.S1',
    completedSubtopicKeys: completedThroughLevels(['A1', 'A2']),
  });
  const tree = assembleCurriculumTree(input);

  it('C1 is present with its modules, all future, none current', () => {
    const c1 = levelByCode(tree, 'C1');
    expect(c1.status).toBe('future');
    expect(c1.modules.length).toBeGreaterThan(0);
    expect(c1.modules.every((m) => m.status === 'future')).toBe(true);
  });

  it('assembling the tree is pure — it never mutates the caller inputs (no progress change)', () => {
    const before = input.currentSubtopicKey;
    assembleCurriculumTree(input);
    expect(input.currentSubtopicKey).toBe(before);
    expect(tree.currentLevelCode).toBe('B1'); // still B1 after "viewing" C1
  });
});

// ── C2 completed ─────────────────────────────────────────────────────────────

describe('curriculum_completed — whole curriculum concluded, C2, no reset', () => {
  const tree = assembleCurriculumTree(
    baseInput({
      status: 'curriculum_completed',
      currentSubtopicKey: null,
      completedSubtopicKeys: completedThroughLevels(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']),
    }),
  );

  it('every level is completed', () => {
    for (const code of ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']) {
      expect(levelByCode(tree, code).status).toBe('completed');
    }
  });

  it('the current level is C2 (no reset to A1)', () => {
    expect(tree.status).toBe('curriculum_completed');
    expect(tree.currentLevelCode).toBe('C2');
  });

  it('no level or module is marked current', () => {
    expect(tree.levels.some((l) => l.status === 'current')).toBe(false);
    expect(tree.levels.flatMap((l) => l.modules).some((m) => m.status === 'current')).toBe(false);
  });
});
