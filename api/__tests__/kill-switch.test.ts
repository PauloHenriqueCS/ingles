/**
 * Kill switch — comprehensive proof (P0 investigation, ingles-dashboad
 * 2026-07-23).
 *
 * The bug report was about the ADMIN DASHBOARD writing to the wrong table
 * (ai_gateway_configs.emergency_stop, which nothing here ever reads) instead
 * of ai_runtime_controls.runtime_status (what GatewayPolicyResolver resolves
 * and kill-switch.ts/gateway.ts actually check) — see
 * ingles-dashboad/supabase/migrations/20260723060000_kill_switch_runtime_controls_fix.sql
 * for that fix. This file proves the OTHER half of the P0 ask: that once
 * runtime_status is actually flipped, EVERY one of the 25 registered AI
 * features is blocked before any provider call, in every gateway_mode, and
 * that toggling back off restores normal operation — with no reliance on
 * hand-picking a subset of features.
 *
 * No real Supabase/OpenAI/Azure calls — same isolation as ai-gateway.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  executeAiGatewayCall,
  GatewayError,
  AI_FEATURE_KEYS,
  evaluateKillSwitch,
  type AiFeatureKey,
  type GatewayCallContext,
  type GatewayMode,
} from '../_ai-gateway/index';

import { createMockGatewayDeps } from './_ai-gateway-test-helpers';

function contextFor(featureKey: AiFeatureKey): GatewayCallContext {
  return {
    featureKey,
    provider: 'openai',
    actorType: 'user',
    executionLocation: 'backend',
    userId: 'user-123',
  };
}

// ── Pure function: every RuntimeStatus value ──────────────────────────────────

describe('evaluateKillSwitch — pure decision table', () => {
  it('enabled: never blocks', () => {
    expect(evaluateKillSwitch('enabled')).toEqual({ blocked: false });
  });

  it('disabled: blocks with FEATURE_DISABLED', () => {
    expect(evaluateKillSwitch('disabled')).toEqual({ blocked: true, reasonCode: 'FEATURE_DISABLED' });
  });

  it('cache_only: blocks with FEATURE_DISABLED (no response-cache layer to fall back to)', () => {
    expect(evaluateKillSwitch('cache_only')).toEqual({ blocked: true, reasonCode: 'FEATURE_DISABLED' });
  });

  it('maintenance: blocks with FEATURE_DISABLED', () => {
    expect(evaluateKillSwitch('maintenance')).toEqual({ blocked: true, reasonCode: 'FEATURE_DISABLED' });
  });

  it('circuit_open: blocks with CIRCUIT_OPEN', () => {
    expect(evaluateKillSwitch('circuit_open')).toEqual({ blocked: true, reasonCode: 'CIRCUIT_OPEN' });
  });

  it('paused_automatically: blocks with CIRCUIT_OPEN', () => {
    expect(evaluateKillSwitch('paused_automatically')).toEqual({ blocked: true, reasonCode: 'CIRCUIT_OPEN' });
  });
});

// ── Universal proof: all 25 registered features, in every gateway_mode ────────

describe('kill switch blocks every registered AI feature, in every gateway_mode', () => {
  const modes: GatewayMode[] = ['legacy', 'observe', 'enforce'];

  it('sanity: exactly 25 feature keys are exercised below', () => {
    expect(AI_FEATURE_KEYS).toHaveLength(25);
  });

  for (const mode of modes) {
    describe(`gateway_mode = ${mode}`, () => {
      for (const featureKey of AI_FEATURE_KEYS) {
        it(`${featureKey}: no provider call is made when runtime_status is disabled`, async () => {
          const { mockDeps, mockPolicyResolvePolicy, mockStartEvent, resetDefaults } = createMockGatewayDeps();
          resetDefaults();
          mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: mode, runtimeStatus: 'disabled' });

          const invoke = vi.fn().mockResolvedValue('should never be reached');

          await expect(
            executeAiGatewayCall(contextFor(featureKey), invoke, mockDeps as any),
          ).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });

          expect(invoke).not.toHaveBeenCalled();
          // A blocked attempt is never recorded as a usage event — it never
          // reached a provider, so it must not appear in ai_usage_events.
          expect(mockStartEvent).not.toHaveBeenCalled();
        });
      }
    });
  }
});

// ── Full OFF → ON → OFF cycle ─────────────────────────────────────────────────

describe('kill switch OFF → ON → OFF cycle', () => {
  it('AI works, then is fully blocked, then works again — for the same feature and context', async () => {
    const { mockDeps, mockPolicyResolvePolicy, resetDefaults } = createMockGatewayDeps();
    resetDefaults();

    const context = contextFor('writing.correct');
    const invoke = vi.fn().mockResolvedValue({ ok: true });

    // 1. OFF (enabled): call goes through.
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'legacy', runtimeStatus: 'enabled' });
    await expect(executeAiGatewayCall(context, invoke, mockDeps as any)).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledTimes(1);

    // 2. ON (disabled): call is blocked, provider is never reached.
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'legacy', runtimeStatus: 'disabled' });
    await expect(executeAiGatewayCall(context, invoke, mockDeps as any)).rejects.toBeInstanceOf(GatewayError);
    expect(invoke).toHaveBeenCalledTimes(1); // still 1 — no new call happened

    // 3. OFF again (enabled): normal operation resumes.
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'legacy', runtimeStatus: 'enabled' });
    await expect(executeAiGatewayCall(context, invoke, mockDeps as any)).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('same cycle in observe mode: blocked step still writes no usage event', async () => {
    const { mockDeps, mockPolicyResolvePolicy, mockStartEvent, resetDefaults } = createMockGatewayDeps();
    resetDefaults();

    const context = contextFor('listening.episode_generate_story');
    const invoke = vi.fn().mockResolvedValue({ ok: true });

    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    await executeAiGatewayCall(context, invoke, mockDeps as any);
    expect(mockStartEvent).toHaveBeenCalledTimes(1);

    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'disabled' });
    await expect(executeAiGatewayCall(context, invoke, mockDeps as any)).rejects.toBeInstanceOf(GatewayError);
    expect(mockStartEvent).toHaveBeenCalledTimes(1); // unchanged — no new event for the blocked call
    expect(invoke).toHaveBeenCalledTimes(1); // unchanged — invoke not called for the blocked call

    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    await executeAiGatewayCall(context, invoke, mockDeps as any);
    expect(mockStartEvent).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

// ── Representative per-category smoke: Conversation, Writing, Pronunciation, ──
// ── Listening/Story Generation, TTS — the categories named in the P0 report ──

describe('kill switch blocks one representative feature per product area', () => {
  const representative: AiFeatureKey[] = [
    'conversation.webrtc_connect',       // Conversation
    'writing.evaluate_rewrite',          // Writing
    'pronunciation.assess_text',         // Pronunciation
    'listening.story_session_generate',  // Story Generation
    'tts.synthesize',                    // TTS
  ];

  for (const featureKey of representative) {
    it(`${featureKey} is blocked with FEATURE_DISABLED and never invokes the provider`, async () => {
      const { mockDeps, mockPolicyResolvePolicy, resetDefaults } = createMockGatewayDeps();
      resetDefaults();
      mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'legacy', runtimeStatus: 'disabled' });

      const invoke = vi.fn();
      await expect(
        executeAiGatewayCall(contextFor(featureKey), invoke, mockDeps as any),
      ).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
      expect(invoke).not.toHaveBeenCalled();
    });
  }
});
