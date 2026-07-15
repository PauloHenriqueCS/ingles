import { describe, it, expect, vi } from 'vitest';
import {
  generateListeningQuestions,
  ListeningEpisodeNotContentReadyError,
  ListeningQuestionsAlreadyExistError,
  ListeningPublishedEpisodeImmutableError,
  ListeningQuestionCorrectionFailedError,
  GENERATOR_PROMPT_VERSION,
  VALIDATOR_PROMPT_VERSION,
} from './generate-listening-questions';
import type { AICallWithUsageFn } from './generate-listening-questions';
import {
  parseQuestionsJson,
  validateGeneratedQuestions,
  QuestionParseError,
  QuestionValidationError,
} from './validate-listening-questions';
import { toPublicListeningQuestion } from '../../domain/listening/listening-domain';
import { fixtureQuestion1 } from '../../domain/listening/listening-fixtures';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const EPISODE_ID = 'ep000000-0000-0000-0000-000000000001';
const BLOCK_1_ID = 'bl000000-0000-0000-0000-000000000001';
const BLOCK_2_ID = 'bl000000-0000-0000-0000-000000000002';

const SENTENCE_KEYS_B1 = new Set(['b1s01', 'b1s02', 'b1s03']);
const SENTENCE_KEYS_B2 = new Set(['b2s01', 'b2s02', 'b2s03']);

const DEFAULT_SENTENCE_MAP = new Map([
  [1, SENTENCE_KEYS_B1],
  [2, SENTENCE_KEYS_B2],
]);

function makeValidQuestion(
  questionOrder: 1 | 2,
  blockOrder: 1 | 2,
  overrides: Record<string, unknown> = {},
) {
  const prefix = `b${blockOrder}`;
  return {
    questionOrder,
    blockOrder,
    questionType: 'detail',
    prompt: `What happened in block ${blockOrder}?`,
    options: ['Option A', 'Option B', 'Option C'],
    correctOption: 0,
    explanationPt: 'Porque a opção A está correta.',
    evidenceSentenceKeys: [`${prefix}s01`],
    difficulty: 'appropriate',
    ...overrides,
  };
}

function makeValidRawResponse(
  q1Overrides: Record<string, unknown> = {},
  q2Overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: '1.0',
    episodeId: EPISODE_ID,
    cefrLevel: 'B1',
    questions: [
      makeValidQuestion(1, 1, q1Overrides),
      makeValidQuestion(2, 2, q2Overrides),
    ],
  };
}

function makeValidAIText(
  q1Overrides: Record<string, unknown> = {},
  q2Overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify(makeValidRawResponse(q1Overrides, q2Overrides));
}

function makeValidatorSuccessResponse(confidence = 0.95): string {
  return JSON.stringify({
    schemaVersion: '1.0',
    valid: true,
    confidence,
    checks: {
      answerSupported: true,
      singleCorrectOption: true,
      distractorsPlausible: true,
      levelAppropriate: true,
      evidenceValid: true,
      noExternalKnowledge: true,
      notAmbiguous: true,
    },
    issues: [],
    suggestedCorrection: null,
  });
}

function makeValidatorFailResponse(issues: string[] = ['Question is ambiguous']): string {
  return JSON.stringify({
    schemaVersion: '1.0',
    valid: false,
    confidence: 0.4,
    checks: {
      answerSupported: true,
      singleCorrectOption: true,
      distractorsPlausible: false,
      levelAppropriate: true,
      evidenceValid: true,
      noExternalKnowledge: true,
      notAmbiguous: false,
    },
    issues,
    suggestedCorrection: null,
  });
}

function makeUsage() {
  return { promptTokens: 100, completionTokens: 50, totalTokens: 150, durationMs: 500 };
}

function makeAI(responses: string[]): AICallWithUsageFn {
  let callCount = 0;
  return vi.fn(async () => {
    const text = responses[callCount] ?? responses[responses.length - 1];
    callCount++;
    return { text, usage: makeUsage(), requestId: null };
  });
}

// ─── Mock Supabase builder ────────────────────────────────────────────────────

interface MockSupabaseOptions {
  episodeStatus?: string;
  episodePublished?: boolean;
  existingQuestions?: Array<{ question_order: number; validation_status: string | null; generator_prompt_version: string | null }>;
  blockTextEn?: string;
  insertQuestionError?: boolean;
}

function makeSupabase(opts: MockSupabaseOptions = {}) {
  const episodeStatus = opts.episodeStatus ?? 'content_ready';
  const existingQuestions = opts.existingQuestions ?? [];

  const episodeRow = {
    id: EPISODE_ID,
    title: 'Test Episode',
    synopsis: 'A test story.',
    cefr_level: 'B1',
    status: episodeStatus,
  };

  const blockRows = [
    { id: BLOCK_1_ID, block_order: 1, text_en: 'Block one text.' },
    { id: BLOCK_2_ID, block_order: 2, text_en: 'Block two text.' },
  ];
  // blockRows also serves the select('id, block_order, text_en') query

  const sentenceRows = [
    { block_id: BLOCK_1_ID, sentence_key: 'b1s01', text_en: 'Block one text.', sentence_order: 1 },
    { block_id: BLOCK_2_ID, sentence_key: 'b2s01', text_en: 'Block two text.', sentence_order: 1 },
  ];

  const insertedIds: string[] = [];

  return {
    from: (table: string) => {
      return {
        select: (_fields: string) => ({
          eq: (col: string, val: string) => ({
            single: () => {
              if (table === 'listening_episodes') {
                return Promise.resolve({ data: episodeRow, error: null });
              }
              return Promise.resolve({ data: null, error: { message: 'Not found' } });
            },
            order: () => {
              if (table === 'listening_blocks') return Promise.resolve({ data: blockRows, error: null });
              if (table === 'listening_sentences') return Promise.resolve({ data: sentenceRows, error: null });
              return Promise.resolve({ data: [], error: null });
            },
          }),
          in: (_col: string, _vals: string[]) => ({
            order: () => Promise.resolve({ data: sentenceRows, error: null }),
          }),
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        }),
        insert: (data: unknown) => ({
          select: () => ({
            single: () => {
              if (opts.insertQuestionError) {
                return Promise.resolve({ data: null, error: { message: 'Insert failed' } });
              }
              const id = `q-${Date.now()}-${Math.random()}`;
              insertedIds.push(id);
              return Promise.resolve({ data: { id }, error: null });
            },
          }),
          error: null,
        }),
        delete: () => ({
          eq: () => Promise.resolve({ error: null }),
          in: () => Promise.resolve({ error: null }),
        }),
        update: (_data: unknown) => ({
          eq: () => Promise.resolve({ error: null }),
        }),
        // For .eq().single() on blocks text_en (separate query)
        eq: (_col: string, _val: string) => ({
          single: () => {
            if (table === 'listening_episodes') {
              return Promise.resolve({ data: episodeRow, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          },
          order: () => {
            if (table === 'listening_blocks') return Promise.resolve({ data: blockRows, error: null });
            return Promise.resolve({ data: existingQuestions, error: null });
          },
        }),
      };
    },
    _insertedIds: insertedIds,
  };
}

// ─── Grupo 1: validação determinística — estrutura ────────────────────────────

describe('validateGeneratedQuestions — estrutura básica', () => {
  // Caso 1: gera exatamente duas perguntas
  it('aceita exatamente duas perguntas válidas', () => {
    const raw = makeValidRawResponse();
    const [q1, q2] = validateGeneratedQuestions(raw, DEFAULT_SENTENCE_MAP);
    expect(q1.questionOrder).toBe(1);
    expect(q2.questionOrder).toBe(2);
  });

  // Caso 2: uma pergunta por bloco
  it('gera uma pergunta para cada bloco', () => {
    const raw = makeValidRawResponse();
    const [q1, q2] = validateGeneratedQuestions(raw, DEFAULT_SENTENCE_MAP);
    expect(q1.blockOrder).toBe(1);
    expect(q2.blockOrder).toBe(2);
  });

  // Caso 3: rejeita apenas uma pergunta
  it('rejeita quando há apenas uma pergunta', () => {
    const raw = { ...makeValidRawResponse(), questions: [makeValidQuestion(1, 1)] };
    expect(() => validateGeneratedQuestions(raw, DEFAULT_SENTENCE_MAP)).toThrow(QuestionValidationError);
  });

  // Caso 4: rejeita três perguntas
  it('rejeita quando há três perguntas', () => {
    const raw = {
      ...makeValidRawResponse(),
      questions: [makeValidQuestion(1, 1), makeValidQuestion(2, 2), makeValidQuestion(1, 1)],
    };
    expect(() => validateGeneratedQuestions(raw, DEFAULT_SENTENCE_MAP)).toThrow(QuestionValidationError);
  });

  // Caso 5: rejeita duas perguntas no mesmo bloco
  it('rejeita duas perguntas vinculadas ao mesmo bloco', () => {
    const raw = {
      ...makeValidRawResponse(),
      questions: [makeValidQuestion(1, 1), makeValidQuestion(2, 1)],
    };
    expect(() => validateGeneratedQuestions(raw, DEFAULT_SENTENCE_MAP)).toThrow(QuestionValidationError);
  });

  // Caso 6: rejeita ordem duplicada
  it('rejeita ordens de perguntas duplicadas', () => {
    const raw = {
      ...makeValidRawResponse(),
      questions: [makeValidQuestion(1, 1), makeValidQuestion(1, 2)],
    };
    expect(() => validateGeneratedQuestions(raw, DEFAULT_SENTENCE_MAP)).toThrow(QuestionValidationError);
  });
});

// ─── Grupo 2: validação determinística — alternativas ─────────────────────────

describe('validateGeneratedQuestions — alternativas', () => {
  // Caso 7: rejeita menos de três alternativas
  it('rejeita menos de três alternativas', () => {
    const raw = makeValidRawResponse({ options: ['A', 'B'] });
    expect(() => validateGeneratedQuestions(raw, DEFAULT_SENTENCE_MAP)).toThrow(QuestionValidationError);
  });

  // Caso 8: rejeita mais de três alternativas
  it('rejeita mais de três alternativas', () => {
    const raw = makeValidRawResponse({ options: ['A', 'B', 'C', 'D'] });
    expect(() => validateGeneratedQuestions(raw, DEFAULT_SENTENCE_MAP)).toThrow(QuestionValidationError);
  });

  // Caso 9: rejeita alternativas duplicadas
  it('rejeita alternativas duplicadas após normalização', () => {
    const raw = makeValidRawResponse({ options: ['Option A', 'Option A', 'Option B'] });
    expect(() => validateGeneratedQuestions(raw, DEFAULT_SENTENCE_MAP)).toThrow(QuestionValidationError);
  });

  // Caso 10: rejeita correctOption fora da faixa
  it('rejeita correctOption fora da faixa 0-2', () => {
    const raw = makeValidRawResponse({ correctOption: 5 });
    expect(() => validateGeneratedQuestions(raw, DEFAULT_SENTENCE_MAP)).toThrow(QuestionValidationError);
  });

  it('rejeita correctOption negativo', () => {
    const raw = makeValidRawResponse({ correctOption: -1 });
    expect(() => validateGeneratedQuestions(raw, DEFAULT_SENTENCE_MAP)).toThrow(QuestionValidationError);
  });

  it('rejeita opção "all of the above"', () => {
    const raw = makeValidRawResponse({ options: ['Option A', 'Option B', 'all of the above'] });
    expect(() => validateGeneratedQuestions(raw, DEFAULT_SENTENCE_MAP)).toThrow(QuestionValidationError);
  });

  it('rejeita opção "none of the above"', () => {
    const raw = makeValidRawResponse({ options: ['Option A', 'Option B', 'none of the above'] });
    expect(() => validateGeneratedQuestions(raw, DEFAULT_SENTENCE_MAP)).toThrow(QuestionValidationError);
  });
});

// ─── Grupo 3: validação determinística — evidências ──────────────────────────

describe('validateGeneratedQuestions — evidências', () => {
  // Caso 11: rejeita evidência inexistente
  it('rejeita sentence key que não existe no banco', () => {
    const raw = makeValidRawResponse({ evidenceSentenceKeys: ['b1s99'] });
    expect(() => validateGeneratedQuestions(raw, DEFAULT_SENTENCE_MAP)).toThrow(QuestionValidationError);
  });

  // Caso 12: rejeita evidência do bloco errado
  it('rejeita evidence de bloco diferente do bloco da pergunta', () => {
    const raw = makeValidRawResponse({ evidenceSentenceKeys: ['b2s01'] }); // Q1 usando chave do bloco 2
    expect(() => validateGeneratedQuestions(raw, DEFAULT_SENTENCE_MAP)).toThrow(QuestionValidationError);
  });

  // Caso 13: pergunta 1 não utiliza frases do bloco 2
  it('pergunta 1 não pode ter evidência do bloco 2', () => {
    const raw = makeValidRawResponse({ evidenceSentenceKeys: ['b2s01'] });
    expect(() => validateGeneratedQuestions(raw, DEFAULT_SENTENCE_MAP)).toThrow(QuestionValidationError);
  });

  // Caso 14: pergunta 2 utiliza evidência do bloco 2
  it('pergunta 2 pode usar evidência do bloco 2', () => {
    const raw = makeValidRawResponse({}, { evidenceSentenceKeys: ['b2s01', 'b2s02'] });
    expect(() => validateGeneratedQuestions(raw, DEFAULT_SENTENCE_MAP)).not.toThrow();
  });

  it('rejeita array de evidências vazio', () => {
    const raw = makeValidRawResponse({ evidenceSentenceKeys: [] });
    expect(() => validateGeneratedQuestions(raw, DEFAULT_SENTENCE_MAP)).toThrow(QuestionValidationError);
  });
});

// ─── Grupo 4: validação determinística — qualidade ───────────────────────────

describe('validateGeneratedQuestions — qualidade', () => {
  // Caso 15: rejeita pergunta ambígua (resposta no enunciado)
  it('rejeita pergunta que contém a resposta no enunciado', () => {
    const raw = makeValidRawResponse({
      prompt: 'Why did she choose Option A?',
      options: ['Option A', 'Option B', 'Option C'],
      correctOption: 0,
    });
    expect(() => validateGeneratedQuestions(raw, DEFAULT_SENTENCE_MAP)).toThrow(QuestionValidationError);
  });

  it('aceita pergunta com prompt não contendo a resposta', () => {
    const raw = makeValidRawResponse({
      prompt: 'What did she do first?',
      options: ['She called the office', 'She left early', 'She stayed home'],
      correctOption: 0,
    });
    expect(() => validateGeneratedQuestions(raw, DEFAULT_SENTENCE_MAP)).not.toThrow();
  });
});

// ─── Grupo 5: parseQuestionsJson ─────────────────────────────────────────────

describe('parseQuestionsJson', () => {
  it('faz parse de JSON válido', () => {
    const result = parseQuestionsJson(JSON.stringify({ questions: [] }));
    expect(result).toEqual({ questions: [] });
  });

  it('extrai JSON de resposta com texto extra', () => {
    const raw = 'Here is the JSON:\n' + JSON.stringify({ questions: [] }) + '\nDone.';
    const result = parseQuestionsJson(raw);
    expect(result).toEqual({ questions: [] });
  });

  it('lança QuestionParseError para texto sem JSON', () => {
    expect(() => parseQuestionsJson('not json at all %%')).toThrow(QuestionParseError);
  });
});

// ─── Grupo 6: validação por IA — confiança ────────────────────────────────────

describe('generateListeningQuestions — validação de confiança por IA', () => {
  // Caso 23: aceita confiança >= limite
  it('aceita questões com confiança igual ao limite mínimo', async () => {
    const ai = makeAI([
      makeValidAIText(),        // gerador
      makeValidatorSuccessResponse(0.85), // validador Q1
      makeValidatorSuccessResponse(0.90), // validador Q2
    ]);
    const result = await generateListeningQuestions(
      { episodeId: EPISODE_ID, dryRun: true, minConfidence: 0.85 },
      ai,
    );
    expect(result.questionCount).toBe(2);
    expect(result.questions[0].validationConfidence).toBeGreaterThanOrEqual(0.85);
  });

  // Caso 24: rejeita confiança abaixo do limite
  it('tenta correção quando confiança está abaixo do limite', async () => {
    const ai = makeAI([
      makeValidAIText(),                    // gerador
      makeValidatorFailResponse(),           // validador Q1 — falha
      makeValidatorSuccessResponse(0.95),    // validador Q2 — ok
      makeValidAIText(),                     // correção
      makeValidatorSuccessResponse(0.95),   // re-validação Q1 — ok
      makeValidatorSuccessResponse(0.95),   // re-validação Q2 — ok
    ]);
    const result = await generateListeningQuestions(
      { episodeId: EPISODE_ID, dryRun: true, minConfidence: 0.85 },
      ai,
    );
    expect(result.validationStatus).toBe('valid');
    expect(ai).toHaveBeenCalledTimes(6);
  });
});

// ─── Grupo 7: correção ─────────────────────────────────────────────────────────

describe('generateListeningQuestions — correção', () => {
  // Caso 25: executa uma correção quando permitido
  it('executa exatamente uma correção quando a validação inicial falha', async () => {
    const ai = makeAI([
      makeValidAIText(),                   // gerador
      makeValidatorFailResponse(),          // validador Q1 — falha
      makeValidatorSuccessResponse(),       // validador Q2 — ok
      makeValidAIText(),                   // correção (1 chamada)
      makeValidatorSuccessResponse(),      // re-validador Q1
      makeValidatorSuccessResponse(),      // re-validador Q2
    ]);
    await generateListeningQuestions({ episodeId: EPISODE_ID, dryRun: true }, ai);
    // 1 gerador + 2 validadores + 1 correção + 2 re-validadores = 6 chamadas
    expect(ai).toHaveBeenCalledTimes(6);
  });

  // Caso 26: não executa correções infinitas
  it('lança ListeningQuestionCorrectionFailedError quando correção também falha', async () => {
    const ai = makeAI([
      makeValidAIText(),                   // gerador
      makeValidatorFailResponse(),          // validador Q1 — falha
      makeValidatorSuccessResponse(),       // validador Q2 — ok
      makeValidAIText(),                   // correção
      makeValidatorFailResponse(),          // re-validador Q1 — ainda falha
      makeValidatorSuccessResponse(),       // re-validador Q2
    ]);
    await expect(
      generateListeningQuestions({ episodeId: EPISODE_ID, dryRun: true }, ai)
    ).rejects.toThrow(ListeningQuestionCorrectionFailedError);
    // 1 gerador + 2 validadores + 1 correção + 2 re-validadores = 6 chamadas
    expect(ai).toHaveBeenCalledTimes(6);
  });
});

// ─── Grupo 8: dry-run ─────────────────────────────────────────────────────────

describe('generateListeningQuestions — dry-run', () => {
  // Caso 31: dry-run não persiste
  it('dry-run retorna resultado sem chamar banco', async () => {
    const ai = makeAI([
      makeValidAIText(),
      makeValidatorSuccessResponse(),
      makeValidatorSuccessResponse(),
    ]);
    const mockSupabase = { from: vi.fn() };
    const result = await generateListeningQuestions(
      { episodeId: EPISODE_ID, dryRun: true },
      ai,
      mockSupabase as unknown as Parameters<typeof generateListeningQuestions>[2],
    );
    expect(result.questionCount).toBe(2);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });
});

// ─── Grupo 9: tipos públicos ──────────────────────────────────────────────────

describe('toPublicListeningQuestion — campos privados (casos 32–34)', () => {
  // Caso 32: tipo público não contém resposta correta
  it('não contém correctOption', () => {
    const pub = toPublicListeningQuestion(fixtureQuestion1);
    expect(pub).not.toHaveProperty('correctOption');
    expect(pub).not.toHaveProperty('correct_option');
  });

  // Caso 33: tipo público não contém explicação privada
  it('não contém explanationPt antes de responder', () => {
    const pub = toPublicListeningQuestion(fixtureQuestion1);
    expect(pub).not.toHaveProperty('explanationPt');
    expect(pub).not.toHaveProperty('explanation_pt');
  });

  // Caso 34: tipo público não contém evidências
  it('não contém evidenceSentenceKeys', () => {
    const pub = toPublicListeningQuestion(fixtureQuestion1);
    expect(pub).not.toHaveProperty('evidenceSentenceKeys');
    expect(pub).not.toHaveProperty('evidence_sentence_keys');
  });

  it('não contém campos de validação interna', () => {
    const pub = toPublicListeningQuestion(fixtureQuestion1);
    expect(pub).not.toHaveProperty('validationNotes');
    expect(pub).not.toHaveProperty('validationStatus');
    expect(pub).not.toHaveProperty('generatorPromptVersion');
    expect(pub).not.toHaveProperty('validatorPromptVersion');
    expect(pub).not.toHaveProperty('questionType');
    expect(pub).not.toHaveProperty('difficulty');
  });

  it('contém apenas campos públicos esperados', () => {
    const pub = toPublicListeningQuestion(fixtureQuestion1);
    const keys = Object.keys(pub).sort();
    expect(keys).toEqual(['blockId', 'episodeId', 'id', 'maxAttempts', 'optionsJson', 'prompt', 'questionOrder'].sort());
  });
});

// ─── Grupo 10: medição de tokens (casos 35–37) ────────────────────────────────

describe('generateListeningQuestions — medição de tokens', () => {
  // Caso 35: tokens de geração são registrados
  it('registra uso de tokens na etapa de geração', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ai = makeAI([
      makeValidAIText(),
      makeValidatorSuccessResponse(),
      makeValidatorSuccessResponse(),
    ]);
    await generateListeningQuestions({ episodeId: EPISODE_ID, dryRun: true }, ai);

    const calls = errSpy.mock.calls.map(c => {
      try { return JSON.parse(c[0] as string); } catch { return null; }
    }).filter(Boolean);

    const genLog = calls.find((c: Record<string, unknown>) =>
      c.stage === 'listening_question_generation'
    );
    expect(genLog).toBeDefined();
    expect(genLog?.episodeId).toBe(EPISODE_ID);
    expect(typeof genLog?.promptTokens).toBe('number');
    errSpy.mockRestore();
  });

  // Caso 36: tokens de validação são registrados
  it('registra uso de tokens nas etapas de validação', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ai = makeAI([
      makeValidAIText(),
      makeValidatorSuccessResponse(),
      makeValidatorSuccessResponse(),
    ]);
    await generateListeningQuestions({ episodeId: EPISODE_ID, dryRun: true }, ai);

    const calls = errSpy.mock.calls.map(c => {
      try { return JSON.parse(c[0] as string); } catch { return null; }
    }).filter(Boolean);

    const valLogs = calls.filter((c: Record<string, unknown>) =>
      c.stage === 'listening_question_validation'
    );
    expect(valLogs.length).toBe(2); // uma por pergunta
    errSpy.mockRestore();
  });

  // Caso 37: respostas corretas não aparecem em logs
  it('não registra o índice da resposta correta nos logs de tokens', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ai = makeAI([
      makeValidAIText({ correctOption: 2 }),
      makeValidatorSuccessResponse(),
      makeValidatorSuccessResponse(),
    ]);
    await generateListeningQuestions({ episodeId: EPISODE_ID, dryRun: true }, ai);

    for (const call of errSpy.mock.calls) {
      const msg = call[0] as string;
      if (msg.includes('listening_question')) {
        expect(msg).not.toContain('"correctOption"');
        expect(msg).not.toContain('"correct_option"');
      }
    }
    errSpy.mockRestore();
  });
});

// ─── Grupo 11: erros de estado do episódio ───────────────────────────────────

describe('generateListeningQuestions — estado do episódio', () => {
  // Caso 29: não regenera perguntas válidas sem force
  it('retorna resultado existente sem regenerar quando perguntas válidas já existem', async () => {
    const ai = makeAI([makeValidAIText(), makeValidatorSuccessResponse(), makeValidatorSuccessResponse()]);

    // Mock supabase with existing valid questions
    const existingQs = [
      { question_order: 1, validation_status: 'valid', generator_prompt_version: GENERATOR_PROMPT_VERSION },
      { question_order: 2, validation_status: 'valid', generator_prompt_version: GENERATOR_PROMPT_VERSION },
    ];

    const supabase = {
      from: (table: string) => ({
        select: (_fields: string) => ({
          eq: (_col: string, _val: string) => ({
            single: () => Promise.resolve({
              data: { id: EPISODE_ID, title: 'Test', synopsis: null, cefr_level: 'B1', status: 'content_ready' },
              error: null,
            }),
            order: () => Promise.resolve({
              data: table === 'listening_questions' ? existingQs : [],
              error: null,
            }),
          }),
          in: (_col: string, _vals: string[]) => ({
            order: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
        update: (_d: unknown) => ({
          eq: () => Promise.resolve({ error: null }),
        }),
        delete: () => ({
          eq: () => Promise.resolve({ error: null }),
        }),
        insert: (_d: unknown) => ({
          select: () => ({
            single: () => Promise.resolve({ data: { id: 'q-new' }, error: null }),
          }),
        }),
      }),
    };

    const result = await generateListeningQuestions(
      { episodeId: EPISODE_ID, forceRegeneration: false },
      ai,
      supabase as unknown as Parameters<typeof generateListeningQuestions>[2],
    );

    expect(result.questionCount).toBe(2);
    // AI should NOT have been called (returned from idempotency check)
    expect(ai).not.toHaveBeenCalled();
  });

  // Caso 30: não altera episódio publicado
  it('lança ListeningPublishedEpisodeImmutableError para episódio publicado', async () => {
    const ai = makeAI([makeValidAIText()]);

    const supabase = {
      from: (_table: string) => ({
        select: (_fields: string) => ({
          eq: (_col: string, _val: string) => ({
            single: () => Promise.resolve({
              data: { id: EPISODE_ID, title: 'Test', synopsis: null, cefr_level: 'B1', status: 'published' },
              error: null,
            }),
          }),
        }),
      }),
    };

    await expect(
      generateListeningQuestions(
        { episodeId: EPISODE_ID },
        ai,
        supabase as unknown as Parameters<typeof generateListeningQuestions>[2],
      )
    ).rejects.toThrow(ListeningPublishedEpisodeImmutableError);
    expect(ai).not.toHaveBeenCalled();
  });
});

// ─── Grupo 12: estados de episódio com banco ──────────────────────────────────

describe('generateListeningQuestions — validações de estado com banco', () => {
  it('lança ListeningEpisodeNotContentReadyError para episódio em draft', async () => {
    const ai = makeAI([]);
    const supabase = {
      from: (_table: string) => ({
        select: (_f: string) => ({
          eq: (_c: string, _v: string) => ({
            single: () => Promise.resolve({
              data: { id: EPISODE_ID, title: 'T', synopsis: null, cefr_level: 'B1', status: 'draft' },
              error: null,
            }),
          }),
        }),
      }),
    };
    await expect(
      generateListeningQuestions(
        { episodeId: EPISODE_ID },
        ai,
        supabase as unknown as Parameters<typeof generateListeningQuestions>[2],
      )
    ).rejects.toThrow(ListeningEpisodeNotContentReadyError);
  });

  it('lança ListeningQuestionsAlreadyExistError quando perguntas existem sem force', async () => {
    const ai = makeAI([]);
    const supabase = {
      from: (table: string) => ({
        select: (_f: string) => ({
          eq: (_c: string, _v: string) => ({
            single: () => Promise.resolve({
              data: { id: EPISODE_ID, title: 'T', synopsis: null, cefr_level: 'B1', status: 'content_ready' },
              error: null,
            }),
            order: () => Promise.resolve({
              data: table === 'listening_questions'
                ? [{ question_order: 1, validation_status: 'invalid', generator_prompt_version: null }]
                : [],
              error: null,
            }),
          }),
          in: (_c: string, _v: string[]) => ({
            order: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
        update: (_d: unknown) => ({ eq: () => Promise.resolve({ error: null }) }),
        delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
        insert: (_d: unknown) => ({
          select: () => ({ single: () => Promise.resolve({ data: { id: 'x' }, error: null }) }),
        }),
      }),
    };
    await expect(
      generateListeningQuestions(
        { episodeId: EPISODE_ID, forceRegeneration: false },
        ai,
        supabase as unknown as Parameters<typeof generateListeningQuestions>[2],
      )
    ).rejects.toThrow(ListeningQuestionsAlreadyExistError);
  });
});

// ─── Grupo 13: idempotência ───────────────────────────────────────────────────

describe('generateListeningQuestions — idempotência', () => {
  it('versões de prompt são constantes e não vazias', () => {
    expect(GENERATOR_PROMPT_VERSION).toBe('listening-question-generator-v1');
    expect(VALIDATOR_PROMPT_VERSION).toBe('listening-question-validator-v1');
  });
});

// ─── Grupo 14: tipos de pergunta por nível ───────────────────────────────────

describe('validateGeneratedQuestions — tipos de pergunta', () => {
  // Caso 20: aceita pergunta de detalhe para A1
  it('aceita questionType "detail" (válido para A1)', () => {
    const raw = makeValidRawResponse({ questionType: 'detail' });
    expect(() => validateGeneratedQuestions(raw, DEFAULT_SENTENCE_MAP)).not.toThrow();
  });

  // Caso 21: A1 permite tipos simples
  it('aceita questionType "sequence" (válido para qualquer nível)', () => {
    const raw = makeValidRawResponse({ questionType: 'sequence' });
    expect(() => validateGeneratedQuestions(raw, DEFAULT_SENTENCE_MAP)).not.toThrow();
  });

  // Caso 22: aceita inferência simples
  it('aceita questionType "simple_inference"', () => {
    const raw = makeValidRawResponse({ questionType: 'simple_inference' });
    expect(() => validateGeneratedQuestions(raw, DEFAULT_SENTENCE_MAP)).not.toThrow();
  });

  it('rejeita questionType desconhecido', () => {
    const raw = makeValidRawResponse({ questionType: 'invalid_type' });
    expect(() => validateGeneratedQuestions(raw, DEFAULT_SENTENCE_MAP)).toThrow(QuestionValidationError);
  });
});
