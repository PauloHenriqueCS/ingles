/** The user must type this exact string (no trimming, no case-folding) to
 *  enable the destructive "Excluir conta permanentemente" button. */
export const DELETE_ACCOUNT_CONFIRMATION_PHRASE = 'EXCLUIR';

export function isDeleteAccountConfirmationValid(input: string): boolean {
  return input === DELETE_ACCOUNT_CONFIRMATION_PHRASE;
}
