import { useState } from 'react';
import { supabase } from '../lib/supabase';

type State = 'idle' | 'loading' | 'sent' | 'error';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<State>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    setState('loading');
    setErrorMsg('');

    const redirectTo = `${window.location.origin}/auth/callback`;
    const { error } = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: { emailRedirectTo: redirectTo },
    });

    if (error) {
      setErrorMsg(error.message);
      setState('error');
    } else {
      setState('sent');
    }
  }

  if (state === 'sent') {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <div className="max-w-sm w-full text-center space-y-4">
          <div className="text-4xl">📬</div>
          <h1 className="text-xl font-bold text-slate-100">Verifique seu email</h1>
          <p className="text-slate-400 text-sm leading-relaxed">
            Enviamos um link de acesso para{' '}
            <span className="text-slate-200 font-medium">{email.trim()}</span>.
            Clique no link para entrar no app.
          </p>
          <button
            onClick={() => setState('idle')}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            Usar outro email
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <div className="max-w-sm w-full space-y-6">
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-bold text-slate-100">English Writing</h1>
          <p className="text-slate-400 text-sm">Entre com seu email para acessar</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs text-slate-400 block mb-1.5">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="seu@email.com"
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-slate-100 placeholder-slate-600 text-sm focus:outline-none focus:border-blue-500"
              autoFocus
              required
            />
          </div>

          {state === 'error' && (
            <p className="text-xs text-red-400">
              {errorMsg || 'Erro ao enviar o link. Tente novamente.'}
            </p>
          )}

          <button
            type="submit"
            disabled={state === 'loading'}
            className="w-full py-3 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {state === 'loading' ? 'Enviando...' : 'Enviar link de acesso'}
          </button>
        </form>

        <p className="text-center text-xs text-slate-600">
          Sem senha. Você recebe um link de acesso por email.
        </p>
      </div>
    </div>
  );
}
