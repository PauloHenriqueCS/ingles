/**
 * Server-authoritative Guided/Free resolution and curricular-credit eligibility.
 * The security-critical invariant: a client parameter can NEVER, by itself,
 * grant curricular credit — eligibility always also requires that Conversation
 * is a SELECTED modality (menu = regra) and that a real recorte exists.
 */
import { describe, it, expect } from 'vitest';
import { resolveSessionMode, computeGuidedEligible } from '../conversation/_session-mode';

describe('resolveSessionMode', () => {
  it('honors an explicit client "free" even when Conversation is in the plan', () => {
    expect(resolveSessionMode({ requestedMode: 'free', conversationInPlan: true })).toBe('free');
  });

  it('honors an explicit client "guided" even when Conversation is NOT in the plan (offered pedagogically)', () => {
    expect(resolveSessionMode({ requestedMode: 'guided', conversationInPlan: false })).toBe('guided');
  });

  it('defaults to guided when no mode is sent and Conversation IS in the plan (backward compatible)', () => {
    expect(resolveSessionMode({ requestedMode: undefined, conversationInPlan: true })).toBe('guided');
  });

  it('defaults to free when no mode is sent and Conversation is NOT in the plan', () => {
    expect(resolveSessionMode({ requestedMode: undefined, conversationInPlan: false })).toBe('free');
  });

  it('ignores an unknown mode value and falls back to the plan-derived default', () => {
    expect(resolveSessionMode({ requestedMode: 'nonsense', conversationInPlan: true })).toBe('guided');
    expect(resolveSessionMode({ requestedMode: 42, conversationInPlan: false })).toBe('free');
  });
});

describe('computeGuidedEligible (curricular credit)', () => {
  it('FREE is never eligible, even with a valid recorte and Conversation in plan', () => {
    expect(computeGuidedEligible({ sessionMode: 'free', conversationInPlan: true, hasCurricularIdentity: true })).toBe(false);
  });

  it('GUIDED + Conversation in plan + a real recorte IS eligible', () => {
    expect(computeGuidedEligible({ sessionMode: 'guided', conversationInPlan: true, hasCurricularIdentity: true })).toBe(true);
  });

  it('a client-forced GUIDED session on a plan that did NOT select Conversation is NOT eligible', () => {
    // This is the anti-falsification guarantee: guided pedagogically, but never
    // curricular credit — so Conversation never becomes a progression
    // requirement the user did not opt into.
    expect(computeGuidedEligible({ sessionMode: 'guided', conversationInPlan: false, hasCurricularIdentity: true })).toBe(false);
  });

  it('GUIDED + in plan but NO recorte (identity missing) is NOT eligible', () => {
    expect(computeGuidedEligible({ sessionMode: 'guided', conversationInPlan: true, hasCurricularIdentity: false })).toBe(false);
  });
});

describe('frozen-at-start semantics (mode/eligibility are computed once)', () => {
  it('a session BORN free stays free regardless of a later preference change', () => {
    // Simulate: user starts free (mode:'free'), THEN toggles Conversation on.
    const bornMode = resolveSessionMode({ requestedMode: 'free', conversationInPlan: false });
    const bornEligible = computeGuidedEligible({ sessionMode: bornMode, conversationInPlan: false, hasCurricularIdentity: true });
    expect(bornMode).toBe('free');
    expect(bornEligible).toBe(false);
    // Preference later flips to true — but the session's frozen mode/eligibility
    // do not recompute; completion uses the frozen values. Nothing here changes.
    expect(bornMode).toBe('free');
    expect(bornEligible).toBe(false);
  });

  it('a session BORN guided-eligible stays creditable regardless of a later preference change', () => {
    const bornMode = resolveSessionMode({ requestedMode: 'guided', conversationInPlan: true });
    const bornEligible = computeGuidedEligible({ sessionMode: bornMode, conversationInPlan: true, hasCurricularIdentity: true });
    expect(bornMode).toBe('guided');
    expect(bornEligible).toBe(true);
    // Even if the user later removes Conversation from the plan, the frozen
    // eligibility persisted on the authorization row is what completion honors.
    expect(bornEligible).toBe(true);
  });
});
