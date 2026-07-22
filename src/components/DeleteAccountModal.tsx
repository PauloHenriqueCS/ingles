import { useRef, useState } from 'react';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import { deactivateAccount, DeactivateAccountError } from '../lib/accountDeletion';
import { DELETE_ACCOUNT_CONFIRMATION_PHRASE, isDeleteAccountConfirmationValid } from '../lib/deleteAccountConfirmation';

type Status = 'idle' | 'submitting' | 'error';

interface Props {
  onCancel: () => void;
  onDeleted: () => void;
}

export default function DeleteAccountModal({ onCancel, onDeleted }: Props) {
  const [confirmText, setConfirmText] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  // Belt-and-suspenders against a double submit racing past the `disabled`
  // attribute (e.g. Enter key + click firing in the same tick) — the
  // disabled button alone should already prevent this, but a second
  // in-flight guard costs nothing and closes that race entirely.
  const inFlightRef = useRef(false);

  const isSubmitting = status === 'submitting';
  const canConfirm = isDeleteAccountConfirmationValid(confirmText) && !isSubmitting;

  async function handleConfirm() {
    if (!canConfirm || inFlightRef.current) return;
    inFlightRef.current = true;
    setStatus('submitting');
    setErrorMessage('');
    try {
      await deactivateAccount();
      onDeleted();
    } catch (err) {
      setErrorMessage(
        err instanceof DeactivateAccountError
          ? err.message
          : 'Não foi possível concluir a exclusão da conta. Tente novamente.',
      );
      setStatus('error');
      inFlightRef.current = false;
    }
  }

  function handleCancel() {
    if (isSubmitting) return;
    onCancel();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="fixed inset-0 bg-black/70" onClick={handleCancel} aria-hidden="true" />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-account-title"
        className="relative w-full sm:max-w-md bg-slate-800 rounded-t-2xl sm:rounded-2xl border border-slate-700 shadow-2xl max-h-[90vh] overflow-y-auto"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex items-center justify-between px-5 pt-5">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-red-400 shrink-0" aria-hidden="true" />
            <h2 id="delete-account-title" className="text-base font-semibold text-slate-100">Excluir conta</h2>
          </div>
          <button
            onClick={handleCancel}
            disabled={isSubmitting}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-700 text-slate-400 hover:text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            aria-label="Fechar"
          >
            <X className="w-4 h-4 shrink-0" />
          </button>
        </div>

        <div className="px-5 pt-4 pb-5 space-y-4">
          <p className="text-sm text-slate-300 leading-relaxed">
            Sua conta deixará de ter acesso ao Lemon. Assinaturas e cobranças futuras serão bloqueadas, e você não
            receberá novas comunicações. Para confirmar, digite{' '}
            <span className="font-semibold text-slate-100">{DELETE_ACCOUNT_CONFIRMATION_PHRASE}</span>.
          </p>

          <ul className="text-xs text-slate-400 space-y-1.5 list-disc list-inside">
            <li>Seu acesso ao Lemon será encerrado imediatamente.</li>
            <li>Novas cobranças e renovações serão bloqueadas.</li>
            <li>Você deixará de receber e-mails, SMS, push e outras comunicações.</li>
          </ul>

          <div>
            <label htmlFor="delete-account-confirm" className="text-xs text-slate-400 block mb-1.5">
              Digite {DELETE_ACCOUNT_CONFIRMATION_PHRASE} para confirmar
            </label>
            <input
              id="delete-account-confirm"
              type="text"
              value={confirmText}
              onChange={(e) => {
                setConfirmText(e.target.value);
                if (status === 'error') setStatus('idle');
              }}
              disabled={isSubmitting}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-slate-100 placeholder-slate-600 text-sm focus:outline-none focus:border-red-500 disabled:opacity-60"
              placeholder={DELETE_ACCOUNT_CONFIRMATION_PHRASE}
            />
          </div>

          {status === 'error' && (
            <p className="text-xs text-red-400" role="alert">{errorMessage}</p>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={handleCancel}
              disabled={isSubmitting}
              className="flex-1 py-3 rounded-xl text-sm font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!canConfirm}
              className="flex-1 py-3 rounded-xl text-sm font-semibold bg-red-600 hover:bg-red-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
            >
              {isSubmitting && <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />}
              {isSubmitting ? 'Excluindo...' : 'Excluir conta permanentemente'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
