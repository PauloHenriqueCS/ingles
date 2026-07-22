import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { isPasswordRecoveryActive, subscribeToPasswordRecovery } from '../lib/passwordRecovery';
import { endSessionAfterPasswordReset } from '../lib/accountSessionCleanup';

type Status = 'checking' | 'ready' | 'invalid';

// Generous enough to cover the network round-trip the client makes while
// processing recovery tokens from the URL, but short enough that a stale or
// tampered link doesn't leave the user staring at a spinner forever.
const RECOVERY_WAIT_TIMEOUT_MS = 8000;

export default function ResetPasswordPage() {
  const [status, setStatus] = useState<Status>('checking');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // Expired/used/invalid recovery links come back as an error in the hash
    // (e.g. #error=access_denied&error_code=otp_expired) rather than a
    // PASSWORD_RECOVERY event, so that event would never fire for them.
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    if (hashParams.get('error') || hashParams.get('error_code')) {
      window.history.replaceState(null, '', window.location.pathname);
      setStatus('invalid');
      return;
    }

    // Defensive fallback in case this project's Auth is ever switched to the
    // PKCE flow for email links, which redirects with ?code= instead of a
    // token hash — mirrors the exchange already done in AuthCallback.tsx.
    const code = new URLSearchParams(window.location.search).get('code');
    if (code) {
      let cancelled = false;
      supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
        if (cancelled) return;
        const url = new URL(window.location.href);
        url.searchParams.delete('code');
        window.history.replaceState(null, '', url.toString());
        setStatus(error ? 'invalid' : 'ready');
      });
      return () => { cancelled = true; };
    }

    if (isPasswordRecoveryActive()) {
      setStatus('ready');
      return;
    }

    let cancelled = false;
    const unsubscribe = subscribeToPasswordRecovery(() => {
      if (!cancelled) setStatus('ready');
    });
    const timeout = window.setTimeout(() => {
      if (!cancelled) setStatus((current) => (current === 'checking' ? 'invalid' : current));
    }, RECOVERY_WAIT_TIMEOUT_MS);

    return () => {
      cancelled = true;
      unsubscribe();
      window.clearTimeout(timeout);
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setFormError('');

    if (password.length < 8) {
      setFormError('A senha deve ter pelo menos 8 caracteres.');
      return;
    }
    if (password !== confirmPassword) {
      setFormError('As senhas não coincidem.');
      return;
    }

    setSubmitting(true);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setSubmitting(false);
      setFormError(translateUpdateError(error.message));
      return;
    }

    await endSessionAfterPasswordReset();
    window.location.replace('/');
  }

  function backToLogin() {
    window.location.href = '/';
  }

  function requestNewLink() {
    window.location.href = '/?forgot=1';
  }

  if (status === 'checking') {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-slate-400 text-sm">Verificando link...</p>
        </div>
      </div>
    );
  }

  if (status === 'invalid') {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <div className="max-w-sm w-full text-center space-y-4">
          <h1 className="text-xl font-bold text-slate-100">Link inválido ou expirado</h1>
          <p className="text-slate-400 text-sm leading-relaxed">
            Este link de recuperação não é mais válido. Solicite um novo para redefinir sua senha.
          </p>
          <button
            onClick={requestNewLink}
            className="w-full py-3 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            Solicitar novo link
          </button>
          <button
            onClick={backToLogin}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            Voltar para o login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <div className="max-w-sm w-full space-y-6">
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-bold text-slate-100">Nova senha</h1>
          <p className="text-slate-400 text-sm">Escolha uma nova senha para sua conta</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs text-slate-400 block mb-1.5">Nova senha</label>
            <input
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setFormError(''); }}
              placeholder="••••••••"
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-slate-100 placeholder-slate-600 text-sm focus:outline-none focus:border-blue-500"
              autoFocus
              required
              minLength={8}
            />
            <p className="text-xs text-slate-600 mt-1">Mínimo 8 caracteres</p>
          </div>

          <div>
            <label className="text-xs text-slate-400 block mb-1.5">Confirmar nova senha</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => { setConfirmPassword(e.target.value); setFormError(''); }}
              placeholder="••••••••"
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-slate-100 placeholder-slate-600 text-sm focus:outline-none focus:border-blue-500"
              required
              minLength={8}
            />
          </div>

          {formError && <p className="text-xs text-red-400">{formError}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="w-full py-3 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? 'Salvando...' : 'Salvar nova senha'}
          </button>
        </form>

        <div className="text-center">
          <button
            onClick={backToLogin}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            Voltar para o login
          </button>
        </div>
      </div>
    </div>
  );
}

function translateUpdateError(msg: string): string {
  if (/at least \d+ characters?/i.test(msg)) return 'A senha deve ter pelo menos 8 caracteres.';
  if (/different from the old password/i.test(msg)) return 'A nova senha deve ser diferente da senha atual.';
  if (/session missing|not authenticated/i.test(msg)) return 'Sua sessão de recuperação expirou. Solicite um novo link.';
  if (/rate limit/i.test(msg)) return 'Muitas tentativas. Aguarde um momento e tente novamente.';
  return 'Não foi possível atualizar sua senha agora. Tente novamente.';
}
