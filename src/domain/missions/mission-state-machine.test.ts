/**
 * Task 11 — Canonical mission state machine tests
 * 64 mandatory tests covering:
 * - MissionStatus constants and helpers (10)
 * - State machine transitions — allowed (16)
 * - State machine transitions — forbidden (18)
 * - Transition reasons and sources (4)
 * - Mission types and public DTO (8)
 * - Feature flags (8)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ALL_MISSION_STATUSES,
  ACTIVE_MISSION_STATUSES,
  TERMINAL_MISSION_STATUSES,
  CONTENT_IMMUTABLE_STATUSES,
  isMissionActive,
  isMissionTerminal,
  isContentImmutable,
  canBeSuperseded,
} from './mission-status';
import {
  canTransitionMissionStatus,
  getValidTransitionsFrom,
  isTerminalStatus,
} from './mission-transitions';
import {
  buildPublicWritingMissionDTO,
  toPublicMissionStatusDTO,
} from './mission-public-dto';
import type { WritingMission } from './mission-types';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeMission(overrides: Partial<WritingMission> = {}): WritingMission {
  return {
    id: 'mission-1',
    userId: 'user-1',
    skill: 'writing',
    status: 'generated',
    mode: 'normal',
    title: 'Test Mission',
    promptPtBR: 'Write a message to a friend.',
    level: 'B1',
    difficulty: 'medium',
    generatedAt: '2026-07-15T00:00:00Z',
    ...overrides,
  };
}

// ─── MissionStatus constants and helpers (10) ────────────────────────────────

describe('MissionStatus', () => {
  it('ALL_MISSION_STATUSES contains exactly 8 statuses', () => {
    expect(ALL_MISSION_STATUSES).toHaveLength(8);
  });

  it('ACTIVE_MISSION_STATUSES contains accepted and started', () => {
    expect(ACTIVE_MISSION_STATUSES.has('accepted')).toBe(true);
    expect(ACTIVE_MISSION_STATUSES.has('started')).toBe(true);
    expect(ACTIVE_MISSION_STATUSES.size).toBe(2);
  });

  it('TERMINAL_MISSION_STATUSES contains 5 statuses', () => {
    expect(TERMINAL_MISSION_STATUSES.size).toBe(5);
    expect(TERMINAL_MISSION_STATUSES.has('completed')).toBe(true);
    expect(TERMINAL_MISSION_STATUSES.has('skipped')).toBe(true);
    expect(TERMINAL_MISSION_STATUSES.has('superseded')).toBe(true);
    expect(TERMINAL_MISSION_STATUSES.has('expired')).toBe(true);
    expect(TERMINAL_MISSION_STATUSES.has('cancelled')).toBe(true);
  });

  it('CONTENT_IMMUTABLE_STATUSES does not include generated or superseded', () => {
    expect(CONTENT_IMMUTABLE_STATUSES.has('generated')).toBe(false);
    expect(CONTENT_IMMUTABLE_STATUSES.has('superseded')).toBe(false);
    expect(CONTENT_IMMUTABLE_STATUSES.has('expired')).toBe(false);
  });

  it('isMissionActive returns true for accepted and started', () => {
    expect(isMissionActive('accepted')).toBe(true);
    expect(isMissionActive('started')).toBe(true);
  });

  it('isMissionActive returns false for all other statuses', () => {
    expect(isMissionActive('generated')).toBe(false);
    expect(isMissionActive('completed')).toBe(false);
    expect(isMissionActive('skipped')).toBe(false);
    expect(isMissionActive('superseded')).toBe(false);
    expect(isMissionActive('expired')).toBe(false);
    expect(isMissionActive('cancelled')).toBe(false);
  });

  it('isMissionTerminal returns true for all terminal statuses', () => {
    expect(isMissionTerminal('completed')).toBe(true);
    expect(isMissionTerminal('skipped')).toBe(true);
    expect(isMissionTerminal('superseded')).toBe(true);
    expect(isMissionTerminal('expired')).toBe(true);
    expect(isMissionTerminal('cancelled')).toBe(true);
  });

  it('isMissionTerminal returns false for non-terminal statuses', () => {
    expect(isMissionTerminal('generated')).toBe(false);
    expect(isMissionTerminal('accepted')).toBe(false);
    expect(isMissionTerminal('started')).toBe(false);
  });

  it('isContentImmutable returns true for accepted, started, completed, skipped, cancelled', () => {
    expect(isContentImmutable('accepted')).toBe(true);
    expect(isContentImmutable('started')).toBe(true);
    expect(isContentImmutable('completed')).toBe(true);
    expect(isContentImmutable('skipped')).toBe(true);
    expect(isContentImmutable('cancelled')).toBe(true);
  });

  it('canBeSuperseded returns true only for generated', () => {
    expect(canBeSuperseded('generated')).toBe(true);
    expect(canBeSuperseded('accepted')).toBe(false);
    expect(canBeSuperseded('started')).toBe(false);
    expect(canBeSuperseded('completed')).toBe(false);
  });
});

// ─── Allowed transitions (16) ────────────────────────────────────────────────

describe('canTransitionMissionStatus — allowed', () => {
  it('generated → accepted', () => {
    expect(canTransitionMissionStatus({ from: 'generated', to: 'accepted' }).allowed).toBe(true);
  });

  it('generated → superseded', () => {
    expect(canTransitionMissionStatus({ from: 'generated', to: 'superseded' }).allowed).toBe(true);
  });

  it('generated → expired', () => {
    expect(canTransitionMissionStatus({ from: 'generated', to: 'expired' }).allowed).toBe(true);
  });

  it('generated → cancelled', () => {
    expect(canTransitionMissionStatus({ from: 'generated', to: 'cancelled' }).allowed).toBe(true);
  });

  it('accepted → started', () => {
    expect(canTransitionMissionStatus({ from: 'accepted', to: 'started' }).allowed).toBe(true);
  });

  it('accepted → skipped', () => {
    expect(canTransitionMissionStatus({ from: 'accepted', to: 'skipped' }).allowed).toBe(true);
  });

  it('accepted → cancelled', () => {
    expect(canTransitionMissionStatus({ from: 'accepted', to: 'cancelled' }).allowed).toBe(true);
  });

  it('accepted → accepted (idempotent self-transition)', () => {
    expect(canTransitionMissionStatus({ from: 'accepted', to: 'accepted' }).allowed).toBe(true);
  });

  it('started → completed', () => {
    expect(canTransitionMissionStatus({ from: 'started', to: 'completed' }).allowed).toBe(true);
  });

  it('started → skipped', () => {
    expect(canTransitionMissionStatus({ from: 'started', to: 'skipped' }).allowed).toBe(true);
  });

  it('started → cancelled', () => {
    expect(canTransitionMissionStatus({ from: 'started', to: 'cancelled' }).allowed).toBe(true);
  });

  it('started → started (idempotent self-transition)', () => {
    expect(canTransitionMissionStatus({ from: 'started', to: 'started' }).allowed).toBe(true);
  });

  it('getValidTransitionsFrom(generated) returns 4 targets', () => {
    const targets = getValidTransitionsFrom('generated');
    expect(targets).toHaveLength(4);
    expect(targets).toContain('accepted');
    expect(targets).toContain('superseded');
    expect(targets).toContain('expired');
    expect(targets).toContain('cancelled');
  });

  it('getValidTransitionsFrom(accepted) returns 4 targets (including self)', () => {
    const targets = getValidTransitionsFrom('accepted');
    expect(targets).toHaveLength(4);
    expect(targets).toContain('accepted');
    expect(targets).toContain('started');
  });

  it('getValidTransitionsFrom(completed) returns empty array', () => {
    expect(getValidTransitionsFrom('completed')).toHaveLength(0);
  });

  it('isTerminalStatus returns true for all terminal statuses', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('skipped')).toBe(true);
    expect(isTerminalStatus('superseded')).toBe(true);
    expect(isTerminalStatus('expired')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
  });
});

// ─── Forbidden transitions (18) ──────────────────────────────────────────────

describe('canTransitionMissionStatus — forbidden', () => {
  it('generated → completed', () => {
    const result = canTransitionMissionStatus({ from: 'generated', to: 'completed' });
    expect(result.allowed).toBe(false);
    expect(result.rejectionReason).toContain('generated');
  });

  it('generated → started', () => {
    expect(canTransitionMissionStatus({ from: 'generated', to: 'started' }).allowed).toBe(false);
  });

  it('generated → skipped', () => {
    expect(canTransitionMissionStatus({ from: 'generated', to: 'skipped' }).allowed).toBe(false);
  });

  it('accepted → completed (must pass through started)', () => {
    expect(canTransitionMissionStatus({ from: 'accepted', to: 'completed' }).allowed).toBe(false);
  });

  it('accepted → generated', () => {
    expect(canTransitionMissionStatus({ from: 'accepted', to: 'generated' }).allowed).toBe(false);
  });

  it('accepted → superseded', () => {
    expect(canTransitionMissionStatus({ from: 'accepted', to: 'superseded' }).allowed).toBe(false);
  });

  it('accepted → expired', () => {
    expect(canTransitionMissionStatus({ from: 'accepted', to: 'expired' }).allowed).toBe(false);
  });

  it('started → accepted', () => {
    expect(canTransitionMissionStatus({ from: 'started', to: 'accepted' }).allowed).toBe(false);
  });

  it('started → generated', () => {
    expect(canTransitionMissionStatus({ from: 'started', to: 'generated' }).allowed).toBe(false);
  });

  it('started → superseded', () => {
    expect(canTransitionMissionStatus({ from: 'started', to: 'superseded' }).allowed).toBe(false);
  });

  it('started → expired', () => {
    expect(canTransitionMissionStatus({ from: 'started', to: 'expired' }).allowed).toBe(false);
  });

  it('completed → started', () => {
    expect(canTransitionMissionStatus({ from: 'completed', to: 'started' }).allowed).toBe(false);
  });

  it('completed → accepted', () => {
    expect(canTransitionMissionStatus({ from: 'completed', to: 'accepted' }).allowed).toBe(false);
  });

  it('completed → generated', () => {
    expect(canTransitionMissionStatus({ from: 'completed', to: 'generated' }).allowed).toBe(false);
  });

  it('skipped → completed', () => {
    expect(canTransitionMissionStatus({ from: 'skipped', to: 'completed' }).allowed).toBe(false);
  });

  it('superseded → accepted', () => {
    expect(canTransitionMissionStatus({ from: 'superseded', to: 'accepted' }).allowed).toBe(false);
  });

  it('expired → accepted', () => {
    expect(canTransitionMissionStatus({ from: 'expired', to: 'accepted' }).allowed).toBe(false);
  });

  it('cancelled → accepted', () => {
    expect(canTransitionMissionStatus({ from: 'cancelled', to: 'accepted' }).allowed).toBe(false);
  });
});

// ─── Transition reasons and sources (4) ──────────────────────────────────────

describe('MissionTransitionReasonCode', () => {
  it('canTransitionMissionStatus accepts an optional reason without error', () => {
    const result = canTransitionMissionStatus({
      from: 'generated',
      to: 'accepted',
      reason: 'user_accepted',
    });
    expect(result.allowed).toBe(true);
  });

  it('canTransitionMissionStatus returns rejectionReason string on failure', () => {
    const result = canTransitionMissionStatus({ from: 'completed', to: 'started' });
    expect(result.allowed).toBe(false);
    expect(typeof result.rejectionReason).toBe('string');
    expect(result.rejectionReason!.length).toBeGreaterThan(0);
  });

  it('getValidTransitionsFrom returns empty array for all terminal statuses', () => {
    const terminals = ['completed', 'skipped', 'superseded', 'expired', 'cancelled'] as const;
    for (const s of terminals) {
      expect(getValidTransitionsFrom(s)).toHaveLength(0);
    }
  });

  it('isTerminalStatus returns false for non-terminal statuses', () => {
    expect(isTerminalStatus('generated')).toBe(false);
    expect(isTerminalStatus('accepted')).toBe(false);
    expect(isTerminalStatus('started')).toBe(false);
  });
});

// ─── Mission types and public DTO (8) ────────────────────────────────────────

describe('buildPublicWritingMissionDTO', () => {
  it('includes id, status, mode, and snapshot', () => {
    const mission = makeMission({ status: 'accepted', acceptedAt: '2026-07-15T01:00:00Z' });
    const dto = buildPublicWritingMissionDTO(mission);
    expect(dto.id).toBe('mission-1');
    expect(dto.status).toBe('accepted');
    expect(dto.mode).toBe('normal');
    expect(dto.snapshot.title).toBe('Test Mission');
    expect(dto.snapshot.promptPtBR).toBe('Write a message to a friend.');
    expect(dto.snapshot.level).toBe('B1');
    expect(dto.snapshot.difficulty).toBe('medium');
  });

  it('includes acceptedAt when present', () => {
    const mission = makeMission({ status: 'accepted', acceptedAt: '2026-07-15T01:00:00Z' });
    const dto = buildPublicWritingMissionDTO(mission);
    expect(dto.acceptedAt).toBe('2026-07-15T01:00:00Z');
  });

  it('does not include internalSnapshot in the DTO', () => {
    const mission = makeMission({
      internalSnapshot: { planId: 'plan-1', fallbackUsed: true },
    });
    const dto = buildPublicWritingMissionDTO(mission);
    expect((dto as Record<string, unknown>).internalSnapshot).toBeUndefined();
  });

  it('includes suggestedWords and supportSentences when present', () => {
    const mission = makeMission({
      suggestedWords: ['email', 'attach'],
      supportSentences: ['Please find attached...'],
    });
    const dto = buildPublicWritingMissionDTO(mission);
    expect(dto.snapshot.suggestedWords).toEqual(['email', 'attach']);
    expect(dto.snapshot.supportSentences).toEqual(['Please find attached...']);
  });

  it('snapshot.mode matches mission.mode', () => {
    const mission = makeMission({ mode: 'diagnostic' });
    const dto = buildPublicWritingMissionDTO(mission);
    expect(dto.snapshot.mode).toBe('diagnostic');
  });

  it('toPublicMissionStatusDTO returns only id and status', () => {
    const mission = makeMission({ status: 'completed', completedAt: '2026-07-15T02:00:00Z' });
    const dto = toPublicMissionStatusDTO(mission);
    expect(dto.id).toBe('mission-1');
    expect(dto.status).toBe('completed');
    expect(Object.keys(dto)).toHaveLength(2);
  });

  it('startedAt is included when mission is started', () => {
    const mission = makeMission({ status: 'started', startedAt: '2026-07-15T01:30:00Z' });
    const dto = buildPublicWritingMissionDTO(mission);
    expect(dto.startedAt).toBe('2026-07-15T01:30:00Z');
  });

  it('completedAt is included when mission is completed', () => {
    const mission = makeMission({ status: 'completed', completedAt: '2026-07-15T02:00:00Z' });
    const dto = buildPublicWritingMissionDTO(mission);
    expect(dto.completedAt).toBe('2026-07-15T02:00:00Z');
  });
});

// ─── Feature flags (8) ───────────────────────────────────────────────────────

describe('CanonicalMissionStateV1 feature flags', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.CANONICAL_WRITING_MISSION_STATE_V1;
  });

  afterEach(() => {
    process.env.CANONICAL_WRITING_MISSION_STATE_V1 = originalEnv.CANONICAL_WRITING_MISSION_STATE_V1;
  });

  it('getCanonicalMissionStateMode returns off by default', async () => {
    const { getCanonicalMissionStateMode } = await import('../../lib/writingMissionFeatureFlags');
    expect(getCanonicalMissionStateMode()).toBe('off');
  });

  it('getCanonicalMissionStateMode returns shadow when set to shadow', async () => {
    process.env.CANONICAL_WRITING_MISSION_STATE_V1 = 'shadow';
    const mod = await import('../../lib/writingMissionFeatureFlags');
    expect(mod.getCanonicalMissionStateMode()).toBe('shadow');
  });

  it('getCanonicalMissionStateMode returns enabled when set to enabled', async () => {
    process.env.CANONICAL_WRITING_MISSION_STATE_V1 = 'enabled';
    const mod = await import('../../lib/writingMissionFeatureFlags');
    expect(mod.getCanonicalMissionStateMode()).toBe('enabled');
  });

  it('isCanonicalMissionStateEnabled returns false when off', async () => {
    const mod = await import('../../lib/writingMissionFeatureFlags');
    expect(mod.isCanonicalMissionStateEnabled()).toBe(false);
  });

  it('isCanonicalMissionStateEnabled returns true when shadow', async () => {
    process.env.CANONICAL_WRITING_MISSION_STATE_V1 = 'shadow';
    const mod = await import('../../lib/writingMissionFeatureFlags');
    expect(mod.isCanonicalMissionStateEnabled()).toBe(true);
  });

  it('isCanonicalMissionStateShadow returns true only in shadow mode', async () => {
    process.env.CANONICAL_WRITING_MISSION_STATE_V1 = 'shadow';
    const mod = await import('../../lib/writingMissionFeatureFlags');
    expect(mod.isCanonicalMissionStateShadow()).toBe(true);
    expect(mod.isCanonicalMissionStateFullyActive()).toBe(false);
  });

  it('isCanonicalMissionStateFullyActive returns true only in enabled mode', async () => {
    process.env.CANONICAL_WRITING_MISSION_STATE_V1 = 'enabled';
    const mod = await import('../../lib/writingMissionFeatureFlags');
    expect(mod.isCanonicalMissionStateFullyActive()).toBe(true);
    expect(mod.isCanonicalMissionStateShadow()).toBe(false);
  });

  it('unknown flag value falls back to off', async () => {
    process.env.CANONICAL_WRITING_MISSION_STATE_V1 = 'true';
    const mod = await import('../../lib/writingMissionFeatureFlags');
    expect(mod.getCanonicalMissionStateMode()).toBe('off');
  });
});
