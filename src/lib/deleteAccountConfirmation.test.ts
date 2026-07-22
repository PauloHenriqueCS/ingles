import { describe, it, expect } from 'vitest';
import { isDeleteAccountConfirmationValid, DELETE_ACCOUNT_CONFIRMATION_PHRASE } from './deleteAccountConfirmation';

describe('isDeleteAccountConfirmationValid', () => {
  it('is false for an empty string', () => {
    expect(isDeleteAccountConfirmationValid('')).toBe(false);
  });

  it('is false while the phrase is only partially typed', () => {
    expect(isDeleteAccountConfirmationValid('EXCLU')).toBe(false);
  });

  it('is true only for an exact match', () => {
    expect(isDeleteAccountConfirmationValid(DELETE_ACCOUNT_CONFIRMATION_PHRASE)).toBe(true);
  });

  it('is false for a lowercase or mixed-case match — must be typed exactly', () => {
    expect(isDeleteAccountConfirmationValid('excluir')).toBe(false);
    expect(isDeleteAccountConfirmationValid('Excluir')).toBe(false);
  });

  it('is false with surrounding whitespace', () => {
    expect(isDeleteAccountConfirmationValid(' EXCLUIR ')).toBe(false);
  });

  it('is false for a different word entirely', () => {
    expect(isDeleteAccountConfirmationValid('DELETE')).toBe(false);
  });
});
