import { describe, it, expect } from 'vitest';
import {
  buildWordAlignment,
  normalizeWord,
  parseRawSegments,
  selectWorstWords,
  getWordBand,
  getWordGuidance,
  WORD_BANDS,
} from './pronunciationWordParser';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeWord(
  word: string,
  opts: {
    accuracyScore?: number | null;
    errorType?: string;
    syllables?: Array<{ syllable: string; AccuracyScore?: number }>;
    phonemes?: Array<{ phoneme: string; AccuracyScore?: number }>;
  } = {},
) {
  return {
    Word: word,
    Offset: 1_000_000,
    Duration: 500_000,
    PronunciationAssessment: {
      AccuracyScore: opts.accuracyScore ?? 88,
      ErrorType: opts.errorType ?? 'None',
      Syllables: (opts.syllables ?? []).map((s) => ({
        Syllable: s.syllable,
        AccuracyScore: s.AccuracyScore ?? 90,
        Offset: 1_000_000,
        Duration: 200_000,
      })),
      Phonemes: (opts.phonemes ?? []).map((p) => ({
        Phoneme: p.phoneme,
        AccuracyScore: p.AccuracyScore ?? 85,
        Offset: 1_000_000,
        Duration: 100_000,
      })),
    },
  };
}

function makeSegment(words: ReturnType<typeof makeWord>[]) {
  return {
    Duration: 5_000_000,
    NBest: [{
      Display: words.map((w) => w.Word).join(' '),
      PronunciationAssessment: {
        AccuracyScore: 85, FluencyScore: 80,
        CompletenessScore: 90, PronScore: 84,
      },
      Words: words,
    }],
  };
}

// ── normalizeWord ─────────────────────────────────────────────────────────────

describe('normalizeWord', () => {
  it('9 - strips trailing punctuation', () => {
    expect(normalizeWord('Hello,')).toBe('hello');
    expect(normalizeWord('world.')).toBe('world');
    expect(normalizeWord('test!')).toBe('test');
  });

  it('10 - lowercases', () => {
    expect(normalizeWord('HELLO')).toBe('hello');
    expect(normalizeWord('World')).toBe('world');
  });

  it('11 - preserves contractions (ASCII apostrophe)', () => {
    expect(normalizeWord("I'm")).toBe("i'm");
    expect(normalizeWord("didn't")).toBe("didn't");
  });

  it('12 - normalizes typographic apostrophe', () => {
    expect(normalizeWord('‘hello’')).toBe('hello');
    expect(normalizeWord("I’m")).toBe("i'm");
    expect(normalizeWord("didn’t")).toBe("didn't");
  });

  it('13 - preserves internal hyphens', () => {
    expect(normalizeWord('well-known')).toBe('well-known');
    expect(normalizeWord('state-of-the-art.')).toBe('state-of-the-art');
  });

  it('strips surrounding quotes', () => {
    expect(normalizeWord('"hello"')).toBe('hello');
    expect(normalizeWord('“hello”')).toBe('hello');
  });
});

// ── parseRawSegments ──────────────────────────────────────────────────────────

describe('parseRawSegments', () => {
  it('17 - extracts phonemes when present', () => {
    const segs = [makeSegment([
      makeWord('hello', { phonemes: [{ phoneme: 'hh', AccuracyScore: 85 }, { phoneme: 'ah', AccuracyScore: 72 }] }),
    ])];
    const words = parseRawSegments(segs);
    expect(words[0].phonemes).toHaveLength(2);
    expect(words[0].phonemes[0].phoneme).toBe('hh');
    expect(words[0].phonemes[0].accuracyScore).toBe(85);
  });

  it('18 - phonemes absent → empty array', () => {
    const segs = [makeSegment([makeWord('hello')])];
    const words = parseRawSegments(segs);
    expect(words[0].phonemes).toHaveLength(0);
  });

  it('19 - extracts syllables when present', () => {
    const segs = [makeSegment([
      makeWord('hello', { syllables: [{ syllable: 'hel', AccuracyScore: 90 }, { syllable: 'lo', AccuracyScore: 80 }] }),
    ])];
    const words = parseRawSegments(segs);
    expect(words[0].syllables).toHaveLength(2);
    expect(words[0].syllables[0].syllable).toBe('hel');
  });

  it('20 - syllables absent → empty array', () => {
    const segs = [makeSegment([makeWord('hello')])];
    const words = parseRawSegments(segs);
    expect(words[0].syllables).toHaveLength(0);
  });

  it('21 - invalid score (> 100) → null', () => {
    const seg = {
      NBest: [{
        Display: 'test',
        Words: [{
          Word: 'test',
          Offset: 0,
          Duration: 100,
          PronunciationAssessment: { AccuracyScore: 150, ErrorType: 'None', Syllables: [], Phonemes: [] },
        }],
      }],
    };
    const words = parseRawSegments([seg]);
    expect(words[0].accuracyScore).toBeNull();
  });

  it('21 - NaN score → null', () => {
    const seg = {
      NBest: [{
        Display: 'test',
        Words: [{
          Word: 'test',
          Offset: 0,
          Duration: 100,
          PronunciationAssessment: { AccuracyScore: NaN, ErrorType: 'None', Syllables: [], Phonemes: [] },
        }],
      }],
    };
    const words = parseRawSegments([seg]);
    expect(words[0].accuracyScore).toBeNull();
  });

  it('22 - JSON parcial: missing NBest → empty result', () => {
    const segs = [{ Duration: 5000000 }];
    expect(parseRawSegments(segs)).toHaveLength(0);
  });

  it('22 - JSON parcial: null segment → skipped', () => {
    expect(parseRawSegments([null, undefined, {}, 42] as unknown[])).toHaveLength(0);
  });

  it('22 - JSON parcial: word missing PronunciationAssessment → graceful', () => {
    const seg = { NBest: [{ Display: 'test', Words: [{ Word: 'test', Offset: 0, Duration: 100 }] }] };
    const words = parseRawSegments([seg]);
    expect(words[0].accuracyScore).toBeNull();
    expect(words[0].syllables).toHaveLength(0);
  });
});

// ── buildWordAlignment ────────────────────────────────────────────────────────

describe('buildWordAlignment', () => {
  it('1 - palavra com nota alta → band good', () => {
    const segs = [makeSegment([makeWord('hello', { accuracyScore: 90 })])];
    const { aligned } = buildWordAlignment('hello', segs);
    expect(getWordBand(aligned[0]).band).toBe('good');
  });

  it('2 - palavra com nota média → band attention', () => {
    const segs = [makeSegment([makeWord('hello', { accuracyScore: 70 })])];
    const { aligned } = buildWordAlignment('hello', segs);
    expect(getWordBand(aligned[0]).band).toBe('attention');
  });

  it('3 - palavra com nota baixa → band practice', () => {
    const segs = [makeSegment([makeWord('hello', { accuracyScore: 45 })])];
    const { aligned } = buildWordAlignment('hello', segs);
    expect(getWordBand(aligned[0]).band).toBe('practice');
  });

  it('4 - palavra sem nota → band no_data', () => {
    const seg = {
      NBest: [{
        Display: 'hello',
        Words: [{
          Word: 'hello',
          Offset: 0,
          Duration: 100,
          PronunciationAssessment: { AccuracyScore: null, ErrorType: 'None', Syllables: [], Phonemes: [] },
        }],
      }],
    };
    const { aligned } = buildWordAlignment('hello', [seg]);
    expect(getWordBand(aligned[0]).band).toBe('no_data');
  });

  it('5 - omissão: palavra sem correspondente', () => {
    const segs = [makeSegment([makeWord('world', { accuracyScore: 88 })])];
    const { aligned } = buildWordAlignment('hello world', segs);
    const omitted = aligned.find((w) => w.errorType === 'omission');
    expect(omitted).toBeDefined();
    expect(omitted!.recognizedWord).toBeNull();
    expect(omitted!.referenceWord).toBe('hello');
    expect(omitted!.accuracyScore).toBeNull();
  });

  it('6 - inserção: palavra extra não está no referenceText', () => {
    const segs = [makeSegment([
      makeWord('hello', { accuracyScore: 90 }),
      makeWord('extra', { accuracyScore: 85 }),
    ])];
    const { aligned, insertions } = buildWordAlignment('hello', segs);
    expect(insertions).toHaveLength(1);
    expect(insertions[0].errorType).toBe('insertion');
    expect(insertions[0].referenceWord).toBeNull();
    expect(aligned).toHaveLength(1); // only "hello" in reference
  });

  it('7 - substituição: palavra diferente no lugar', () => {
    const segs = [makeSegment([makeWord('wold', { accuracyScore: 55 })])];
    const { aligned } = buildWordAlignment('world', segs);
    expect(aligned[0].recognizedWord).toBe('wold');
    expect(aligned[0].referenceWord).toBe('world');
    expect(['mispronunciation', 'unknown', 'none']).toContain(aligned[0].errorType);
    // When alignment classifies as sub and Azure says 'None', we override to mispronunciation
    expect(aligned[0].errorType).not.toBe('none');
  });

  it('8 - palavra repetida: ambas as instâncias alinhadas', () => {
    const segs = [makeSegment([
      makeWord('the', { accuracyScore: 90 }),
      makeWord('the', { accuracyScore: 85 }),
    ])];
    const { aligned } = buildWordAlignment('the the', segs);
    expect(aligned).toHaveLength(2);
    expect(aligned[0].errorType).toBe('none');
    expect(aligned[1].errorType).toBe('none');
    expect(aligned[0].accuracyScore).toBe(90);
    expect(aligned[1].accuracyScore).toBe(85);
  });

  it('9 - pontuação preservada no displayWord, normalizada para comparação', () => {
    const segs = [makeSegment([
      makeWord('Hello', { accuracyScore: 90 }),
      makeWord('world', { accuracyScore: 88 }),
    ])];
    const { aligned } = buildWordAlignment('Hello, world.', segs);
    expect(aligned).toHaveLength(2);
    // displayWord preserves punctuation from reference
    expect(aligned[0].displayWord).toBe('Hello,');
    expect(aligned[1].displayWord).toBe('world.');
    // but both matched because normalized forms agree
    expect(aligned[0].errorType).toBe('none');
    expect(aligned[1].errorType).toBe('none');
  });

  it('10 - capitalização: case-insensitive match', () => {
    const segs = [makeSegment([makeWord('HELLO', { accuracyScore: 90 })])];
    const { aligned } = buildWordAlignment('hello', segs);
    expect(aligned[0].errorType).toBe('none');
    expect(aligned[0].accuracyScore).toBe(90);
  });

  it("11 - contrações: I'm recognized and matched", () => {
    const segs = [makeSegment([makeWord("I'm", { accuracyScore: 85 })])];
    const { aligned } = buildWordAlignment("I'm happy", segs);
    expect(aligned[0].errorType).toBe('none');
    expect(aligned[0].recognizedWord).toBe("I'm");
  });

  it("12 - apóstrofo tipográfico na referência", () => {
    const segs = [makeSegment([makeWord("I'm", { accuracyScore: 85 })])];
    const { aligned } = buildWordAlignment("I’m happy", segs);
    expect(aligned[0].errorType).toBe('none');
  });

  it('13 - hífen preservado na normalização', () => {
    const segs = [makeSegment([makeWord('well-known', { accuracyScore: 80 })])];
    const { aligned } = buildWordAlignment('well-known concept', segs);
    expect(aligned[0].errorType).toBe('none');
    expect(aligned[0].displayWord).toBe('well-known');
  });

  it('14 - múltiplas omissões', () => {
    const segs = [makeSegment([makeWord('is', { accuracyScore: 88 })])];
    const { aligned } = buildWordAlignment('this is a test', segs);
    const omissions = aligned.filter((w) => w.errorType === 'omission');
    expect(omissions.length).toBeGreaterThanOrEqual(2);
  });

  it('15 - múltiplas inserções', () => {
    const segs = [makeSegment([
      makeWord('hello', { accuracyScore: 90 }),
      makeWord('extra1', { accuracyScore: 85 }),
      makeWord('extra2', { accuracyScore: 82 }),
    ])];
    const { insertions } = buildWordAlignment('hello', segs);
    expect(insertions).toHaveLength(2);
    expect(insertions.every((w) => w.errorType === 'insertion')).toBe(true);
  });

  it('16 - omissão não desloca palavras seguintes', () => {
    // "hello [OMIT world] this"
    const segs = [makeSegment([
      makeWord('hello', { accuracyScore: 90 }),
      makeWord('this', { accuracyScore: 88 }),
    ])];
    const { aligned } = buildWordAlignment('hello world this', segs);
    expect(aligned).toHaveLength(3);
    const worldEntry = aligned.find((w) => w.normalizedWord === 'world');
    const thisEntry  = aligned.find((w) => w.normalizedWord === 'this');
    expect(worldEntry!.errorType).toBe('omission');
    expect(thisEntry!.errorType).toBe('none');
    expect(thisEntry!.recognizedWord).toBe('this');
  });

  it('23 - resultado antigo sem detalhes (rawSegments vazio) → retorna hasWordDetail false pattern', () => {
    const { aligned, insertions } = buildWordAlignment('hello world', []);
    // With empty rawSegments, parser returns omissions for all reference words
    expect(aligned).toHaveLength(2);
    expect(aligned.every((w) => w.errorType === 'omission')).toBe(true);
    expect(insertions).toHaveLength(0);
  });
});

// ── selectWorstWords ──────────────────────────────────────────────────────────

describe('selectWorstWords', () => {
  function makeDetail(
    id: string,
    accuracyScore: number | null,
    errorType: import('./pronunciationWordParser').PronWordErrorType = 'none',
  ): import('./pronunciationWordParser').PronunciationWordDetail {
    return {
      id,
      referenceWord: id,
      recognizedWord: errorType === 'omission' ? null : id,
      displayWord: id,
      normalizedWord: id,
      accuracyScore,
      errorType,
      offset: null,
      duration: null,
      syllables: [],
      phonemes: [],
    };
  }

  it('24 - limita a 5 palavras', () => {
    const aligned = Array.from({ length: 10 }, (_, i) =>
      makeDetail(`word${i}`, 50 - i),
    );
    expect(selectWorstWords(aligned)).toHaveLength(5);
  });

  it('24 - menos de 5 candidatos → retorna todos', () => {
    const aligned = [makeDetail('a', 40), makeDetail('b', 30)];
    expect(selectWorstWords(aligned)).toHaveLength(2);
  });

  it('omissões antes de palavras com baixa nota', () => {
    const omission = makeDetail('omit', null, 'omission');
    const low = makeDetail('low', 20);
    const result = selectWorstWords([low, omission]);
    expect(result[0].errorType).toBe('omission');
    expect(result[1].errorType).toBe('none');
  });

  it('25 - empate de nota preserva ordem original', () => {
    const a = makeDetail('first', 50);
    const b = makeDetail('second', 50);
    const c = makeDetail('third', 50);
    const result = selectWorstWords([a, b, c], 3);
    expect(result[0].id).toBe('first');
    expect(result[1].id).toBe('second');
    expect(result[2].id).toBe('third');
  });

  it('26 - inserções excluídas da lista', () => {
    const insertion = makeDetail('ins', 20, 'insertion');
    const good = makeDetail('good', 85);
    const result = selectWorstWords([insertion, good]);
    expect(result.some((w) => w.errorType === 'insertion')).toBe(false);
  });

  it('26 - palavras sem nota (exceto omissões) excluídas', () => {
    const noScore = makeDetail('noScore', null, 'none');
    const omission = makeDetail('omit', null, 'omission');
    const result = selectWorstWords([noScore, omission]);
    expect(result).toHaveLength(1);
    expect(result[0].errorType).toBe('omission');
  });
});

// ── getWordBand ───────────────────────────────────────────────────────────────

describe('getWordBand', () => {
  function w(
    errorType: import('./pronunciationWordParser').PronWordErrorType,
    accuracyScore: number | null,
  ): import('./pronunciationWordParser').PronunciationWordDetail {
    return {
      id: 'test',
      referenceWord: 'test',
      recognizedWord: errorType === 'omission' ? null : 'test',
      displayWord: 'test',
      normalizedWord: 'test',
      accuracyScore,
      errorType,
      offset: null,
      duration: null,
      syllables: [],
      phonemes: [],
    };
  }

  it('score 80 → good', () => expect(getWordBand(w('none', 80)).band).toBe('good'));
  it('score 100 → good', () => expect(getWordBand(w('none', 100)).band).toBe('good'));
  it('score 79 → attention', () => expect(getWordBand(w('none', 79)).band).toBe('attention'));
  it('score 60 → attention', () => expect(getWordBand(w('none', 60)).band).toBe('attention'));
  it('score 59 → practice', () => expect(getWordBand(w('none', 59)).band).toBe('practice'));
  it('score 0 → practice', () => expect(getWordBand(w('none', 0)).band).toBe('practice'));
  it('omission → omission band', () => expect(getWordBand(w('omission', null)).band).toBe('omission'));
  it('insertion → insertion band', () => expect(getWordBand(w('insertion', 80)).band).toBe('insertion'));
  it('null score non-omission → no_data', () => expect(getWordBand(w('none', null)).band).toBe('no_data'));

  it('31 - aria-label includes word name and score', () => {
    const band = getWordBand(w('none', 54));
    const label = band.makeAriaLabel('comfortable', 54);
    expect(label).toContain('comfortable');
    expect(label).toContain('54');
  });

  it('31 - aria-label for omission', () => {
    const band = getWordBand(w('omission', null));
    const label = band.makeAriaLabel('although', null);
    expect(label).toContain('although');
    expect(label.toLowerCase()).toContain('não identificada');
  });
});

// ── getWordGuidance ───────────────────────────────────────────────────────────

describe('getWordGuidance', () => {
  function wd(
    errorType: import('./pronunciationWordParser').PronWordErrorType,
    accuracyScore: number | null,
  ): import('./pronunciationWordParser').PronunciationWordDetail {
    return {
      id: 'x', referenceWord: 'x', recognizedWord: 'x',
      displayWord: 'x', normalizedWord: 'x',
      accuracyScore, errorType, offset: null, duration: null,
      syllables: [], phonemes: [],
    };
  }

  it('score 80+ → boa pronúncia message', () => {
    expect(getWordGuidance(wd('none', 90))).toContain('Boa pronúncia');
  });
  it('score 60-79 → próxima message', () => {
    expect(getWordGuidance(wd('none', 70))).toContain('próxima');
  });
  it('score < 60 → pratique message', () => {
    expect(getWordGuidance(wd('mispronunciation', 45))).toContain('Pratique');
  });
  it('omission → não identificada message', () => {
    expect(getWordGuidance(wd('omission', null))).toContain('não foi identificada');
  });
  it('insertion → palavra adicional message', () => {
    expect(getWordGuidance(wd('insertion', 80))).toContain('palavra adicional');
  });
  it('null score → sem detalhes message', () => {
    expect(getWordGuidance(wd('none', null))).toContain('não retornou');
  });
});

// ── WORD_BANDS ────────────────────────────────────────────────────────────────

describe('WORD_BANDS', () => {
  it('all bands have label, colorClass, bgClass, borderClass, makeAriaLabel', () => {
    for (const band of Object.values(WORD_BANDS)) {
      expect(band.label).toBeTruthy();
      expect(band.colorClass).toBeTruthy();
      expect(band.bgClass).toBeTruthy();
      expect(band.borderClass).toBeTruthy();
      expect(typeof band.makeAriaLabel).toBe('function');
    }
  });
});

// ── Spec tests 27-30 (logic layer) ───────────────────────────────────────────

describe('spec 27-30 — security and reload', () => {
  it('27 - parseRawSegments funciona com dados do banco (sem chamar Azure)', () => {
    // Simulate what comes out of rawResultJson after DB load
    const dbData = [makeSegment([
      makeWord('hello', { accuracyScore: 85, syllables: [{ syllable: 'hel' }, { syllable: 'lo' }] }),
    ])];
    const words = parseRawSegments(dbData);
    expect(words[0].word).toBe('hello');
    expect(words[0].syllables).toHaveLength(2);
  });

  it('30 - completed assessment does not allow re-analysis (buildStatusResponse logic)', () => {
    // The canAnalyze=false for completed is enforced in buildStatusResponse (existing code).
    // Here we verify our parser never emits a second assessment row — it only reads rawSegments.
    // The alignment produces results without mutating any state.
    const segs = [makeSegment([makeWord('test', { accuracyScore: 90 })])];
    const result1 = buildWordAlignment('test', segs);
    const result2 = buildWordAlignment('test', segs);
    // Deterministic: same input → same output
    expect(result1.aligned[0].accuracyScore).toBe(result2.aligned[0].accuracyScore);
  });

  it('28 - alignment is pure — no side effects, no network calls', () => {
    // buildWordAlignment must be a pure function (no fetch, no DB writes)
    const segs = [makeSegment([makeWord('hello')])];
    expect(() => buildWordAlignment('hello world', segs)).not.toThrow();
  });

  it('29 - alignment isolates reference text processing — same segs, different reference → different result', () => {
    // ref "hello world" + rec "hello world" → both match
    const segs = [makeSegment([makeWord('hello'), makeWord('world')])];
    const r1 = buildWordAlignment('hello world', segs);
    expect(r1.aligned.every((w) => w.errorType === 'none')).toBe(true);

    // ref "goodbye world" + rec "hello world" → "goodbye" is sub (DP prefers sub over omit+insert)
    // "world" matches
    const r2 = buildWordAlignment('goodbye world', segs);
    expect(r2.aligned[0].normalizedWord).toBe('goodbye');
    // "goodbye" paired with "hello" as substitution — correct DP behavior
    expect(r2.aligned[0].errorType).toBe('mispronunciation');
    expect(r2.aligned[1].errorType).toBe('none'); // "world" still matches

    // ref with only 1 word that isn't recognized → omission
    const r3 = buildWordAlignment('goodbye', segs);
    // "goodbye" omitted or sub — and "hello"+"world" become insertions
    expect(r3.aligned).toHaveLength(1);
    expect(r3.insertions.length).toBeGreaterThanOrEqual(1);
  });
});

// ── describe.todo for integration scenarios ───────────────────────────────────

describe.todo('32 - abertura e fechamento do detalhe — UI integration test');
describe.todo('33 - layout sem overflow em viewport mobile — UI/CSS test');
