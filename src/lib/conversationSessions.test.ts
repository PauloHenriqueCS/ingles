import { describe, it, expect } from 'vitest';
import { isConversationGoalMet } from './conversationSessions';

describe('isConversationGoalMet', () => {
  it('is false below the goal', () => {
    expect(isConversationGoalMet(10 * 60, 15)).toBe(false);
  });
  it('is true exactly at the goal', () => {
    expect(isConversationGoalMet(15 * 60, 15)).toBe(true);
  });
  it('is true above the goal', () => {
    expect(isConversationGoalMet(20 * 60, 15)).toBe(true);
  });
  it('is false at zero seconds with any positive goal', () => {
    expect(isConversationGoalMet(0, 15)).toBe(false);
  });
});
