import { useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { consumeAccountSessionNotice } from '../lib/accountSessionCleanup';

type Mode = 'login' | 'signup' | 'forgot';
type State = 'idle' | 'loading' | 'error' | 'signup_sent';
type ForgotState = 'idle' | 'loading' | 'sent';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginPage() {
  // ResetPasswordPage sends users back here with ?forgot=1 when their link
  // has expired, so they land straight back on the request form.
  const [mode, setMode] = useState<Mode>(() => (
    new URLSearchParams(window.location.search).get('forgot') === '1' ? 'forgot' : 'login'
  ));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [state, setState] = useState<State>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotState, setForgotState] = useState<ForgotState>('idle');
  const [forgotError, setForgotError] = useState('');
  // Read once per mount so the message shows exactly once, right after the
  // redirect that follows a self-deletion, a mid-session block, or a
  // completed password reset.
  const [sessionNotice] = useState(() => consumeAccountSessionNotice());

  useEffect(() => {
    if (window.location.search.includes('forgot=')) {
      const url = new URL(window.location.href);
      url.searchParams.delete('forgot');
      window.history.replaceState(null, '', url.toString());
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) return;
    setState('loading');
    setErrorMsg('');

    if (mode === 'login') {
      const { error } = await supabase.auth.signInWithPassword({
        email: trimmedEmail,
        password,
      });
      if (error) {
        setErrorMsg(translateError(error.message));
        setState('error');
      }
      // On success, useAuth picks up the session change automatically
    } else {
      const { data, error } = await supabase.auth.signUp({
        email: trimmedEmail,
        password,
      });
      if (error) {
        setErrorMsg(translateError(error.message));
        setState('error');
      } else if (data.session) {
        // Auto-confirmed — useAuth will update and App.tsx will render the main view
      } else {
        setState('signup_sent');
      }
    }
  }

  function switchMode(next: Mode) {
    if (next === 'forgot') setForgotEmail(email.trim());
    setMode(next);
    setState('idle');
    setErrorMsg('');
    setForgotState('idle');
    setForgotError('');
  }

  async function handleForgotSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (forgotState === 'loading') return;

    const trimmedEmail = forgotEmail.trim();
    if (!EMAIL_PATTERN.test(trimmedEmail)) {
      setForgotError('Digite um email válido.');
      return;
    }

    setForgotState('loading');
    setForgotError('');

    try {
      const { error } = await supabase.auth.resetPasswordForEmail(trimmedEmail, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      // Never reveal whether the address is registered: only a rate-limit
      // response gets a distinct message, everything else — success or any
      // other Supabase-side error — shows the same neutral confirmation.
      if (error && /rate limit|for security purposes/i.test(error.message)) {
        setForgotError('Muitas tentativas. Aguarde um momento e tente novamente.');
        setForgotState('idle');
        return;
      }
      setForgotState('sent');
    } catch {
      setForgotError('Não foi possível enviar agora. Verifique sua conexão e tente novamente.');
      setForgotState('idle');
    }
  }

  if (state === 'signup_sent') {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <div className="max-w-sm w-full text-center space-y-4">
          <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-900/40 mx-auto">
            <Mail className="w-7 h-7 text-blue-400 shrink-0" strokeWidth={1.5} aria-hidden="true" />
          </div>
          <h1 className="text-xl font-bold text-slate-100">Confirme seu email</h1>
          <p className="text-slate-400 text-sm leading-relaxed">
            Enviamos um link de confirmação para{' '}
            <span className="text-slate-200 font-medium">{email.trim()}</span>.
            Clique no link para ativar sua conta.
          </p>
          <button
            onClick={() => switchMode('login')}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            Já confirmei → Fazer login
          </button>
        </div>
      </div>
    );
  }

  if (mode === 'forgot' && forgotState === 'sent') {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <div className="max-w-sm w-full text-center space-y-4">
          <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-900/40 mx-auto">
            <Mail className="w-7 h-7 text-blue-400 shrink-0" strokeWidth={1.5} aria-hidden="true" />
          </div>
          <h1 className="text-xl font-bold text-slate-100">Verifique seu email</h1>
          <p className="text-slate-400 text-sm leading-relaxed">
            Se esse email estiver cadastrado, você receberá um link para redefinir sua senha.
          </p>
          <button
            onClick={() => switchMode('login')}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            Voltar para o login
          </button>
        </div>
      </div>
    );
  }

  if (mode === 'forgot') {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <div className="max-w-sm w-full space-y-6">
          <div className="text-center space-y-1">
            <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-blue-900/40 mx-auto mb-2 overflow-hidden">
              <img
                src="/brand/lemon-header.png"
                alt=""
                className="w-7 h-7 object-cover object-left shrink-0"
                draggable={false}
              />
            </div>
            <h1 className="text-2xl font-bold text-slate-100">Lemon</h1>
            <p className="text-slate-400 text-sm">Recuperar senha</p>
          </div>

          <form onSubmit={handleForgotSubmit} className="space-y-4">
            <div>
              <label className="text-xs text-slate-400 block mb-1.5">Email</label>
              <input
                type="email"
                value={forgotEmail}
                onChange={(e) => { setForgotEmail(e.target.value); setForgotError(''); }}
                placeholder="seu@email.com"
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-slate-100 placeholder-slate-600 text-sm focus:outline-none focus:border-blue-500"
                autoFocus
                required
              />
            </div>

            {forgotError && <p className="text-xs text-red-400">{forgotError}</p>}

            <button
              type="submit"
              disabled={forgotState === 'loading'}
              className="w-full py-3 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {forgotState === 'loading' ? 'Enviando...' : 'Enviar link de recuperação'}
            </button>
          </form>

          <div className="text-center">
            <button
              onClick={() => switchMode('login')}
              className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
            >
              Voltar para o login
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <div className="max-w-sm w-full space-y-6">
        {sessionNotice === 'deleted' && (
          <div className="rounded-xl border border-slate-700 bg-slate-800/80 px-4 py-3 text-center">
            <p className="text-sm text-slate-200 font-medium">Sua conta foi excluída.</p>
            <p className="text-xs text-slate-400 mt-1">
              Seu acesso foi encerrado e você não receberá novas comunicações pelo Lemon.
            </p>
          </div>
        )}
        {sessionNotice === 'blocked' && (
          <div className="rounded-xl border border-slate-700 bg-slate-800/80 px-4 py-3 text-center">
            <p className="text-sm text-slate-300">Esta conta não está mais disponível.</p>
          </div>
        )}
        {sessionNotice === 'password_changed' && (
          <div className="rounded-xl border border-slate-700 bg-slate-800/80 px-4 py-3 text-center">
            <p className="text-sm text-slate-200 font-medium">Senha alterada com sucesso.</p>
            <p className="text-xs text-slate-400 mt-1">Faça login com sua nova senha.</p>
          </div>
        )}

        <div className="text-center space-y-1">
          <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-blue-900/40 mx-auto mb-2 overflow-hidden">
            <img
              src="/brand/lemon-header.png"
              alt=""
              className="w-7 h-7 object-cover object-left shrink-0"
              draggable={false}
            />
          </div>
          <h1 className="text-2xl font-bold text-slate-100">Lemon</h1>
          <p className="text-slate-400 text-sm">
            {mode === 'login' ? 'Entre na sua conta' : 'Crie sua conta'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs text-slate-400 block mb-1.5">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); if (state === 'error') setState('idle'); }}
              placeholder="seu@email.com"
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-slate-100 placeholder-slate-600 text-sm focus:outline-none focus:border-blue-500"
              autoFocus
              required
            />
          </div>

          <div>
            <label className="text-xs text-slate-400 block mb-1.5">Senha</label>
            <input
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); if (state === 'error') setState('idle'); }}
              placeholder="••••••••"
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-slate-100 placeholder-slate-600 text-sm focus:outline-none focus:border-blue-500"
              required
              minLength={6}
            />
            {mode === 'signup' && (
              <p className="text-xs text-slate-600 mt-1">Mínimo 6 caracteres</p>
            )}
            {mode === 'login' && (
              <div className="text-right mt-1.5">
                <button
                  type="button"
                  onClick={() => switchMode('forgot')}
                  className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                >
                  Esqueci minha senha?
                </button>
              </div>
            )}
          </div>

          {state === 'error' && (
            <p className="text-xs text-red-400">{errorMsg || 'Erro ao entrar. Tente novamente.'}</p>
          )}

          <button
            type="submit"
            disabled={state === 'loading'}
            className="w-full py-3 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {state === 'loading'
              ? (mode === 'login' ? 'Entrando...' : 'Criando conta...')
              : (mode === 'login' ? 'Entrar' : 'Criar conta')}
          </button>
        </form>

        <div className="text-center">
          {mode === 'login' ? (
            <p className="text-xs text-slate-500">
              Não tem conta?{' '}
              <button
                onClick={() => switchMode('signup')}
                className="text-blue-400 hover:text-blue-300 transition-colors"
              >
                Criar conta
              </button>
            </p>
          ) : (
            <p className="text-xs text-slate-500">
              Já tem conta?{' '}
              <button
                onClick={() => switchMode('login')}
                className="text-blue-400 hover:text-blue-300 transition-colors"
              >
                Fazer login
              </button>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function translateError(msg: string): string {
  if (/invalid login credentials/i.test(msg)) return 'Email ou senha incorretos.';
  if (/email not confirmed/i.test(msg)) return 'Confirme seu email antes de entrar.';
  if (/user already registered/i.test(msg)) return 'Este email já está cadastrado. Faça login.';
  if (/password should be at least/i.test(msg)) return 'A senha deve ter pelo menos 6 caracteres.';
  if (/rate limit/i.test(msg)) return 'Muitas tentativas. Aguarde um momento.';
  return msg;
}
