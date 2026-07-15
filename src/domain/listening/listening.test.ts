import { describe, it, expect } from 'vitest';
import {
  getSubtitleModeForAttempt,
  canAccessListeningBlock,
  isListeningEpisodeCompleted,
  getNextListeningProgressState,
  validateListeningActivityStructure,
  toPublicListeningQuestion,
} from './listening-domain';
import {
  validateListeningQuestion,
  validateListeningAttempt,
  validateProgressOwnership,
} from './listening-validation';
import {
  FIXTURE_EPISODE_ID,
  FIXTURE_BLOCK_1_ID,
  FIXTURE_BLOCK_2_ID,
  FIXTURE_QUESTION_1_ID,
  fixtureEpisode,
  fixtureBlock1,
  fixtureBlock2,
  fixtureQuestion1,
  fixtureQuestion2,
  fixtureSubtitlesEnBlock1,
  fixtureSubtitlesPtBlock1,
  fixtureSubtitlesEnBlock2,
  fixtureSubtitlesPtBlock2,
  fixtureActivity,
  makeProgress,
  makeActivityBlock,
} from './listening-fixtures';
import type { ListeningActivity, UserListeningAttempt } from './listening-types';

// ─── Grupo 1: getSubtitleModeForAttempt (casos 1–4) ──────────────────────────

describe('getSubtitleModeForAttempt', () => {
  it('tentativa 1 retorna none', () => {
    expect(getSubtitleModeForAttempt(1)).toBe('none');
  });

  it('tentativa 2 retorna en', () => {
    expect(getSubtitleModeForAttempt(2)).toBe('en');
  });

  it('tentativa 3 retorna pt-BR', () => {
    expect(getSubtitleModeForAttempt(3)).toBe('pt-BR');
  });

  it('tentativa 4 é rejeitada com RangeError', () => {
    expect(() => getSubtitleModeForAttempt(4)).toThrow(RangeError);
  });
});

// ─── Grupo 2: canAccessListeningBlock (casos 5–7) ────────────────────────────

describe('canAccessListeningBlock', () => {
  it('bloco 1 está disponível (progress nulo)', () => {
    expect(canAccessListeningBlock(null, 1)).toBe(true);
  });

  it('bloco 2 está bloqueado antes de o bloco 1 ser concluído', () => {
    const progress = makeProgress({ status: 'block_1_active', block1CompletedAt: null });
    expect(canAccessListeningBlock(progress, 2)).toBe(false);
  });

  it('bloco 2 é liberado após a conclusão do bloco 1', () => {
    const progress = makeProgress({
      status: 'block_1_completed',
      block1CompletedAt: '2026-07-15T09:00:00Z',
      block1CorrectAttempt: 1,
    });
    expect(canAccessListeningBlock(progress, 2)).toBe(true);
  });
});

// ─── Grupo 3: isListeningEpisodeCompleted (casos 8–9) ────────────────────────

describe('isListeningEpisodeCompleted', () => {
  it('episódio não conclui apenas com o bloco 1', () => {
    const progress = makeProgress({
      status: 'block_1_completed',
      block1CompletedAt: '2026-07-15T09:00:00Z',
      block1CorrectAttempt: 1,
    });
    expect(isListeningEpisodeCompleted(progress)).toBe(false);
  });

  it('episódio conclui com os dois blocos', () => {
    const progress = makeProgress({
      status: 'completed',
      block1CompletedAt: '2026-07-15T09:00:00Z',
      block1CorrectAttempt: 1,
      block2CompletedAt: '2026-07-15T09:10:00Z',
      block2CorrectAttempt: 2,
      completedAt: '2026-07-15T09:10:00Z',
    });
    expect(isListeningEpisodeCompleted(progress)).toBe(true);
  });
});

// ─── Grupo 4: validateListeningActivityStructure (casos 10–13, 15, 20) ───────

describe('validateListeningActivityStructure', () => {
  it('episódio com apenas um bloco é inválido', () => {
    const activity: ListeningActivity = {
      ...fixtureActivity,
      blocks: [fixtureActivity.blocks[0]],
    };
    expect(() => validateListeningActivityStructure(activity)).toThrow(RangeError);
  });

  it('episódio com três blocos é inválido', () => {
    const activity: ListeningActivity = {
      ...fixtureActivity,
      blocks: [...fixtureActivity.blocks, fixtureActivity.blocks[1]],
    };
    expect(() => validateListeningActivityStructure(activity)).toThrow(RangeError);
  });

  it('ordens de bloco duplicadas são inválidas', () => {
    const duplicatedOrderBlock = {
      ...fixtureActivity.blocks[1],
      block: { ...fixtureBlock2, blockOrder: 1 as const },
    };
    const activity: ListeningActivity = {
      ...fixtureActivity,
      blocks: [fixtureActivity.blocks[0], duplicatedOrderBlock],
    };
    expect(() => validateListeningActivityStructure(activity)).toThrow(TypeError);
  });

  it('duas perguntas no mesmo bloco são inválidas', () => {
    // Dois ActivityBlocks apontando para o mesmo block.id (block 1).
    const sameBlock = {
      ...fixtureActivity.blocks[1],
      block: { ...fixtureBlock2, id: FIXTURE_BLOCK_1_ID, blockOrder: 2 as const },
    };
    const activity: ListeningActivity = {
      ...fixtureActivity,
      blocks: [fixtureActivity.blocks[0], sameBlock],
    };
    expect(() => validateListeningActivityStructure(activity)).toThrow(TypeError);
  });

  it('legenda com endMs <= startMs é inválida', () => {
    const badCue = {
      ...fixtureSubtitlesEnBlock1[0],
      startMs: 5000,
      endMs: 1000,
    };
    const activity: ListeningActivity = {
      ...fixtureActivity,
      blocks: [
        {
          ...fixtureActivity.blocks[0],
          subtitlesEn: [badCue],
        },
        fixtureActivity.blocks[1],
      ],
    };
    expect(() => validateListeningActivityStructure(activity)).toThrow(RangeError);
  });

  it('episódio publicado sem legendas em inglês é inválido', () => {
    const publishedEpisode = {
      ...fixtureEpisode,
      status: 'published' as const,
      publishedAt: '2026-07-15T08:00:00Z',
    };
    const activity: ListeningActivity = {
      ...fixtureActivity,
      episode: publishedEpisode,
      blocks: [
        { ...fixtureActivity.blocks[0], subtitlesEn: [] },
        fixtureActivity.blocks[1],
      ],
    };
    expect(() => validateListeningActivityStructure(activity)).toThrow(TypeError);
  });

  it('episódio publicado sem legendas em português é inválido', () => {
    const publishedEpisode = {
      ...fixtureEpisode,
      status: 'published' as const,
      publishedAt: '2026-07-15T08:00:00Z',
    };
    const publishedActivityBlock1 = makeActivityBlock(
      fixtureBlock1,
      fixtureQuestion1,
      fixtureSubtitlesEnBlock1,
      fixtureSubtitlesPtBlock1
    );
    const publishedActivityBlock2 = makeActivityBlock(
      fixtureBlock2,
      fixtureQuestion2,
      fixtureSubtitlesEnBlock2,
      fixtureSubtitlesPtBlock2
    );
    const activity: ListeningActivity = {
      episode: publishedEpisode,
      blocks: [
        { ...publishedActivityBlock1, subtitlesPt: [] },
        publishedActivityBlock2,
      ],
      progress: null,
    };
    expect(() => validateListeningActivityStructure(activity)).toThrow(TypeError);
  });
});

// ─── Grupo 5: toPublicListeningQuestion (caso 16) ────────────────────────────

describe('toPublicListeningQuestion', () => {
  it('pergunta pública não possui resposta correta', () => {
    const publicQ = toPublicListeningQuestion(fixtureQuestion1);
    expect(publicQ).not.toHaveProperty('correctOption');
    expect(publicQ).not.toHaveProperty('correct_option');
  });
});

// ─── Grupo 6: validateListeningQuestion (caso 14) ────────────────────────────

describe('validateListeningQuestion', () => {
  it('correct_option fora das alternativas é inválido', () => {
    const badQuestion = { ...fixtureQuestion1, correctOption: 99 };
    expect(() => validateListeningQuestion(badQuestion)).toThrow(RangeError);
  });
});

// ─── Grupo 7: validateListeningAttempt — modo de legenda (casos 17–18) ───────

describe('validateListeningAttempt — modo de legenda', () => {
  function makeAttempt(overrides: Partial<UserListeningAttempt> = {}): UserListeningAttempt {
    return {
      id: 'atm-0000-0000-0000-000000000001',
      userId: 'u1000000-0000-0000-0000-000000000001',
      episodeId: FIXTURE_EPISODE_ID,
      blockId: FIXTURE_BLOCK_1_ID,
      questionId: FIXTURE_QUESTION_1_ID,
      attemptCycle: 1,
      attemptNumber: 1,
      selectedOption: 0,
      isCorrect: null,
      subtitleMode: 'none',
      playbackRate: 1.0,
      answeredAt: '2026-07-15T09:00:00Z',
      createdAt: '2026-07-15T09:00:00Z',
      ...overrides,
    };
  }

  it('tentativa 2 sem legenda em inglês é inválida', () => {
    const attempt = makeAttempt({ attemptNumber: 2, subtitleMode: 'none' });
    expect(() => validateListeningAttempt(attempt)).toThrow(TypeError);
  });

  it('tentativa 3 sem legenda em português é inválida', () => {
    const attempt = makeAttempt({ attemptNumber: 3, subtitleMode: 'en' });
    expect(() => validateListeningAttempt(attempt)).toThrow(TypeError);
  });
});

// ─── Grupo 8: validateProgressOwnership (caso 19) ────────────────────────────

describe('validateProgressOwnership', () => {
  it('usuário não consegue acessar progresso de outro usuário', () => {
    const progress = makeProgress({ userId: 'user-A-0000-0000-0000-000000000001' });
    expect(() =>
      validateProgressOwnership(progress, 'user-B-0000-0000-0000-000000000002')
    ).toThrow(TypeError);
  });
});

// ─── Grupo 9: getNextListeningProgressState ────────────────────────────────────

describe('getNextListeningProgressState', () => {
  it('bloco 1 concluído → status block_1_completed', () => {
    const progress = makeProgress({ status: 'block_1_active' });
    expect(getNextListeningProgressState(progress, 1)).toBe('block_1_completed');
  });

  it('bloco 2 concluído → status completed', () => {
    const progress = makeProgress({
      status: 'block_2_active',
      block1CompletedAt: '2026-07-15T09:00:00Z',
      block1CorrectAttempt: 1,
      currentBlock: 2,
    });
    expect(getNextListeningProgressState(progress, 2)).toBe('completed');
  });

  it('bloco 2 não pode ser concluído sem o bloco 1', () => {
    const progress = makeProgress({ status: 'not_started', block1CompletedAt: null });
    expect(() => getNextListeningProgressState(progress, 2)).toThrow(TypeError);
  });
});

// ─── Grupo 10: Estrutura da atividade — caso base válido ──────────────────────

describe('validateListeningActivityStructure — caso base válido', () => {
  it('atividade com dois blocos bem formados não lança erro', () => {
    expect(() => validateListeningActivityStructure(fixtureActivity)).not.toThrow();
  });
});

// ─── Grupo 11: fixtureActivity — integridade básica ───────────────────────────

describe('fixtureActivity — integridade básica', () => {
  it('episódio tem exatamente 2 blocos', () => {
    expect(fixtureActivity.blocks.length).toBe(2);
  });

  it('ordens dos blocos são 1 e 2', () => {
    const orders = fixtureActivity.blocks.map(b => b.block.blockOrder).sort();
    expect(orders).toEqual([1, 2]);
  });

  it('cada bloco tem exatamente uma pergunta pública sem correctOption', () => {
    for (const ab of fixtureActivity.blocks) {
      expect(ab.question).not.toHaveProperty('correctOption');
    }
  });

  it('legendas em inglês e português estão presentes para cada bloco', () => {
    expect(fixtureActivity.blocks[0].subtitlesEn.length).toBeGreaterThan(0);
    expect(fixtureActivity.blocks[0].subtitlesPt.length).toBeGreaterThan(0);
    expect(fixtureActivity.blocks[1].subtitlesEn.length).toBeGreaterThan(0);
    expect(fixtureActivity.blocks[1].subtitlesPt.length).toBeGreaterThan(0);
  });

  it('timestamps das legendas são válidos (endMs > startMs)', () => {
    const allCues = [
      ...fixtureSubtitlesEnBlock1,
      ...fixtureSubtitlesPtBlock1,
      ...fixtureSubtitlesEnBlock2,
      ...fixtureSubtitlesPtBlock2,
    ];
    for (const cue of allCues) {
      expect(cue.endMs).toBeGreaterThan(cue.startMs);
    }
  });
});
