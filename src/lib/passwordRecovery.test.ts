import { describe, it, expect, vi } from 'vitest';

const { mockOnAuthStateChange, callbackHolder } = vi.hoisted(() => {
  const holder: { current: ((event: string) => void) | null } = { current: null };
  return {
    callbackHolder: holder,
    mockOnAuthStateChange: vi.fn((cb: (event: string) => void) => {
      holder.current = cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    }),
  };
});

vi.mock('./supabase', () => ({
  supabase: { auth: { onAuthStateChange: mockOnAuthStateChange } },
}));

import { isPasswordRecoveryActive, subscribeToPasswordRecovery } from './passwordRecovery';

function fireAuthEvent(event: string) {
  callbackHolder.current?.(event);
}

// `recoveryActive` is deliberately a module-level singleton (mirrors real
// usage: once a recovery link is detected, it stays active for the page's
// lifetime), so these tests share state and run in a fixed order.
describe('passwordRecovery', () => {
  it('subscribes to Supabase auth state changes as soon as the module loads', () => {
    expect(mockOnAuthStateChange).toHaveBeenCalledTimes(1);
  });

  it('is not active before any PASSWORD_RECOVERY event is observed', () => {
    expect(isPasswordRecoveryActive()).toBe(false);
  });

  it('ignores unrelated auth events', () => {
    fireAuthEvent('SIGNED_IN');
    expect(isPasswordRecoveryActive()).toBe(false);
  });

  it('notifies subscribers and flips active once PASSWORD_RECOVERY fires', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToPasswordRecovery(listener);

    fireAuthEvent('PASSWORD_RECOVERY');

    expect(isPasswordRecoveryActive()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('stops notifying a listener after it unsubscribes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToPasswordRecovery(listener);
    unsubscribe();

    fireAuthEvent('PASSWORD_RECOVERY');

    expect(listener).not.toHaveBeenCalled();
  });

  it('does not replay the event to a listener subscribed after it already fired', () => {
    const listener = vi.fn();
    subscribeToPasswordRecovery(listener);

    expect(listener).not.toHaveBeenCalled();
    expect(isPasswordRecoveryActive()).toBe(true);
  });
});
