import { describe, it, expect } from 'vitest';
import {
  TRANSLATION_SYSTEM_PROMPT,
  CORRECTION_SYSTEM_PROMPT,
  buildTranslationBatchUserPrompt,
} from './build-subtitle-translation-prompt';
import type { EnglishCueDraft } from './listening-subtitle-schema';

function makeCue(cueKey: string, text: string): EnglishCueDraft {
  return { cueKey, cueOrder: 1, blockOrder: 1, sourceSentenceKeys: [`b1s${cueKey}`], text };
}

// ── System prompt content — anti-omission/identity rules the live failures pointed to ──

describe('TRANSLATION_SYSTEM_PROMPT', () => {
  it('does not tell the model to keep translations "concise" (the old wording plausibly licensed dropping short beats)', () => {
    expect(TRANSLATION_SYSTEM_PROMPT.toLowerCase()).not.toContain('concise');
  });

  it('explicitly forbids dropping short/trivial cues (a real observed defect: a dropped "Anna nods.")', () => {
    expect(TRANSLATION_SYSTEM_PROMPT.toLowerCase()).toContain('trivial');
    expect(TRANSLATION_SYSTEM_PROMPT).toMatch(/gesture/i);
  });

  it('instructs preserving gender/pronoun referents using context (a real observed defect: eles/elas mismatch)', () => {
    expect(TRANSLATION_SYSTEM_PROMPT.toLowerCase()).toContain('gender');
    expect(TRANSLATION_SYSTEM_PROMPT.toLowerCase()).toContain('pronoun');
  });

  it('instructs never combining or splitting cueKeys, and never translating the cueKey itself', () => {
    expect(TRANSLATION_SYSTEM_PROMPT.toLowerCase()).toContain('combine');
    expect(TRANSLATION_SYSTEM_PROMPT).toMatch(/translate the cuekey/i);
  });

  it('requires JSON output', () => {
    expect(TRANSLATION_SYSTEM_PROMPT).toContain('valid JSON');
  });
});

describe('CORRECTION_SYSTEM_PROMPT', () => {
  it('is a distinct prompt from the validator/evaluation prompt (a real prior bug reused the evaluator prompt for corrections)', () => {
    expect(CORRECTION_SYSTEM_PROMPT).not.toContain('linguistic quality reviewer');
    expect(CORRECTION_SYSTEM_PROMPT.toLowerCase()).toContain('correcting');
  });

  it('forbids a correction from introducing a new omission while fixing the stated problem', () => {
    expect(CORRECTION_SYSTEM_PROMPT.toLowerCase()).toContain('omission');
  });
});

// ── buildTranslationBatchUserPrompt — using real (anonymized) content from failed episodes ──

describe('buildTranslationBatchUserPrompt', () => {
  const baseInput = {
    episodeId: 'ep-1',
    title: 'A New City',
    synopsis: 'A short story about moving to a new city.',
    cefrLevel: 'A1' as const,
    blockOrder: 1 as const,
    blockTextEn: 'Anna is very excited. Today is her first day in the new city.',
  };

  it('lists every cue in the batch with its cueKey', () => {
    const cues = [makeCue('b1-c020', 'Anna smiles.'), makeCue('b1-c054', 'Anna nods.')];
    const prompt = buildTranslationBatchUserPrompt({ ...baseInput, cues, batchIndex: 0, batchCount: 1 });
    expect(prompt).toContain('[b1-c020]');
    expect(prompt).toContain('Anna smiles.');
    expect(prompt).toContain('[b1-c054]');
    expect(prompt).toContain('Anna nods.');
  });

  it('includes preceding/following cue text as explicit context, marked as not to be translated', () => {
    const cues = [makeCue('b1-c020', 'Anna smiles.')];
    const prompt = buildTranslationBatchUserPrompt({
      ...baseInput,
      cues,
      precedingCueText: 'The park has green grass and big trees.',
      followingCueText: '"This city is very nice," she says to herself.',
      batchIndex: 1,
      batchCount: 3,
    });
    expect(prompt).toContain('The park has green grass and big trees.');
    expect(prompt).toContain('This city is very nice');
    expect(prompt.toLowerCase()).toContain('context only');
  });

  it('does not include preceding/following context lines when not provided (first/last batch of a block)', () => {
    const cues = [makeCue('b1-c001', 'Anna is very excited.')];
    const prompt = buildTranslationBatchUserPrompt({ ...baseInput, cues, batchIndex: 0, batchCount: 1 });
    expect(prompt).not.toContain('immediately BEFORE');
    expect(prompt).not.toContain('immediately AFTER');
  });

  it('states the batch position when there is more than one batch for the block', () => {
    const cues = [makeCue('b1-c021', 'Maria nods.')];
    const prompt = buildTranslationBatchUserPrompt({ ...baseInput, cues, batchIndex: 1, batchCount: 4 });
    expect(prompt).toContain('batch 2 of 4');
  });

  it('does not mention batching when the whole block fits in one batch', () => {
    const cues = [makeCue('b1-c001', 'Anna is very excited.')];
    const prompt = buildTranslationBatchUserPrompt({ ...baseInput, cues, batchIndex: 0, batchCount: 1 });
    expect(prompt.toLowerCase()).not.toContain('batch 1 of 1');
  });

  it('the JSON response template has exactly one placeholder entry per cue, keyed by cueKey', () => {
    const cues = [makeCue('b1-c019', 'the Botanical Garden and the Opera House'), makeCue('b1-c020', 'They are famous.')];
    const prompt = buildTranslationBatchUserPrompt({ ...baseInput, cues, batchIndex: 0, batchCount: 1 });
    const jsonMatch = prompt.match(/\{[\s\S]*\}/);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch![0]);
    expect(parsed.cues).toHaveLength(2);
    expect(parsed.cues.map((c: { cueKey: string }) => c.cueKey)).toEqual(['b1-c019', 'b1-c020']);
  });

  it('includes the full block text as context, separately from the cues to translate', () => {
    const cues = [makeCue('b1-c001', 'Anna is very excited.')];
    const prompt = buildTranslationBatchUserPrompt({ ...baseInput, cues, batchIndex: 0, batchCount: 1 });
    expect(prompt).toContain(baseInput.blockTextEn);
    expect(prompt.toLowerCase()).toContain('do not translate this');
  });
});
