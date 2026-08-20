import { describe, it, expect } from 'vitest';
import { ENTITLEMENT_MESSAGES } from './entitlement-messages';

describe('conversation exhaustion messages', () => {
  // Orodim keeps no conversation history/transcript, so no exhaustion message
  // may ever claim the conversation was "preserved" (regression for problem 6).
  it('never claims the conversation was preserved', () => {
    expect(ENTITLEMENT_MESSAGES.conversationMinutesExhausted).not.toMatch(/preservad/i);
    expect(ENTITLEMENT_MESSAGES.conversationTrialMinutesExhausted).not.toMatch(/preservad/i);
    expect(ENTITLEMENT_MESSAGES.conversationRecordingStoppedByBalance).not.toMatch(/preservad/i);
  });

  it('the paid-plan exhaustion message invites buying more minutes', () => {
    expect(ENTITLEMENT_MESSAGES.conversationMinutesExhausted).toMatch(/mais minutos/i);
  });

  it('the recording-stopped message is only about the balance, not history', () => {
    expect(ENTITLEMENT_MESSAGES.conversationRecordingStoppedByBalance).toMatch(/minutos/i);
  });
});
