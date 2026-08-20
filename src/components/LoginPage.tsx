import { useEffect, useState } from 'react';
import { Mail, ArrowLeft } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { consumeAccountSessionNotice } from '../lib/accountSessionCleanup';
import { rememberAuthMethod } from '../lib/authMethodMemory';
import GoogleSignInButton from './GoogleSignInButton';
import { isGoogleSignInAvailable } from '../lib/googleAuth';
import AppleSignInButton from './AppleSignInButton';
import { isAppleSignInAvailable } from '../lib/appleAuth';

type Mode = 'login' | 'signup' | 'forgot';
// The screen leads with the method chooser; the traditional email/password
// form is only shown once the user picks "Continuar com e-mail". New social
// methods (e.g. Apple) slot into the chooser without touching this hierarchy.
type AuthView = 'chooser' | 'email';
type State = 'idle' | 'loading' | 'error' | 'signup_sent';
type ForgotState = 'idle' | 'loading' | 'sent';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginPage() {
  // ResetPasswordPage sends users back here with ?forgot=1 when their link has
  // expired — land straight on the email form's recovery view, skipping the
  // chooser.
  const startForgot = new URLSearchParams(window.location.search).get('forgot') === '1';
  const [authView, setAuthView] = useState<AuthView>(startForgot ? 'email' : 'chooser');
  const [mode, setMode] = useState<Mode>(startForgot ? 'forgot' : 'login');
  const [name, setName] = useState('');
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
  const [googleAvailable] = useState(() => isGoogleSignInAvailable());
  const [appleAvailable] = useState(() => isAppleSignInAvailable());

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
    const trimmedName = name.trim();
    if (!trimmedEmail || !password) return;
    if (mode === 'signup' && !trimmedName) return;
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
      } else {
        rememberAuthMethod('password');
      }
      // On success, useAuth picks up the session change automatically
    } else {
      const { data, error } = await supabase.auth.signUp({
        email: trimmedEmail,
        password,
        options: { data: { full_name: trimmedName } },
      });
      if (error) {
        setErrorMsg(translateError(error.message));
        setState('error');
      } else if (data.session) {
        // Auto-confirmed — useAuth will update and App.tsx will render the main view
        rememberAuthMethod('password');
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

  function enterEmail() {
    setAuthView('email');
    setMode('login');
    setState('idle');
    setErrorMsg('');
  }

  function backToChooser() {
    setAuthView('chooser');
    setMode('login');
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

  // ── Terminal screens ───────────────────────────────────────────────────────
  if (state === 'signup_sent') {
    return (
      <Shell>
        <div className="text-center space-y-4">
          <IconBadge />
          <h1 className="text-xl font-bold text-slate-100">Confirme seu email</h1>
          <p className="text-slate-400 text-sm leading-relaxed">
            Enviamos um link de confirmação para{' '}
            <span className="text-slate-200 font-medium">{email.trim()}</span>.
            Clique no link para ativar sua conta.
          </p>
          <button
            onClick={() => { setState('idle'); switchMode('login'); }}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            Já confirmei → Fazer login
          </button>
        </div>
      </Shell>
    );
  }

  if (mode === 'forgot' && forgotState === 'sent') {
    return (
      <Shell>
        <div className="text-center space-y-4">
          <IconBadge />
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
      </Shell>
    );
  }

  if (mode === 'forgot') {
    return (
      <Shell>
        <Brand subtitle="Recuperar senha" />
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
      </Shell>
    );
  }

  // ── Method chooser (initial screen) ─────────────────────────────────────────
  if (authView === 'chooser') {
    return (
      <Shell>
        <SessionNotice notice={sessionNotice} />
        <Brand subtitle="Pratique inglês. Evolua de verdade." emphasizeSubtitle />

        <div className="space-y-3">
          {/* Order: Apple first when offered (App Store guideline 4.8 — present
              Sign in with Apple as an equivalent, prominent option), then
              Google, then e-mail. */}
          {appleAvailable && <AppleSignInButton />}
          {googleAvailable && <GoogleSignInButton />}

          <button
            type="button"
            onClick={enterEmail}
            className="w-full flex items-center justify-center gap-3 py-3 rounded-xl text-sm font-medium bg-slate-800/40 border border-slate-600/50 text-slate-100 backdrop-blur-sm hover:bg-slate-700/50 transition-colors"
          >
            <Mail className="w-[18px] h-[18px] shrink-0" strokeWidth={1.75} aria-hidden="true" />
            Continuar com e-mail
          </button>
        </div>
      </Shell>
    );
  }

  // ── Email/password form (shown only after "Continuar com e-mail") ────────────
  return (
    <Shell>
      <button
        type="button"
        onClick={backToChooser}
        className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 transition-colors -mb-2"
      >
        <ArrowLeft className="w-4 h-4 shrink-0" aria-hidden="true" />
        Outras opções
      </button>

      <SessionNotice notice={sessionNotice} />
      <Brand subtitle={mode === 'login' ? 'Entre na sua conta' : 'Crie sua conta'} />

      <form onSubmit={handleSubmit} className="space-y-4">
        {mode === 'signup' && (
          <div>
            <label className="text-xs text-slate-400 block mb-1.5">Nome</label>
            <input
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); if (state === 'error') setState('idle'); }}
              placeholder="Seu nome"
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-slate-100 placeholder-slate-600 text-sm focus:outline-none focus:border-blue-500"
              autoComplete="name"
              autoFocus
              required
            />
          </div>
        )}

        <div>
          <label className="text-xs text-slate-400 block mb-1.5">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); if (state === 'error') setState('idle'); }}
            placeholder="seu@email.com"
            className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-slate-100 placeholder-slate-600 text-sm focus:outline-none focus:border-blue-500"
            autoFocus={mode === 'login'}
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
    </Shell>
  );
}

// ── Shared presentational pieces (unchanged Orodim visual language) ────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen flex items-center justify-center p-4 overflow-hidden bg-[#010817]">
      <AuroraBackground />
      <div className="relative z-10 max-w-sm w-full space-y-6">{children}</div>
    </div>
  );
}

/**
 * Aurora-borealis login backdrop. Built as a layered DOM composition (not a
 * single flat gradient): a deep-navy base, two bright diagonal teal/cyan
 * streaks sweeping toward the top-right, a wide ambient haze and a curved
 * "cradle" that wraps the logo's lower-left, a sparse particle field, and a
 * dark floor that keeps the tagline/buttons area clean. Pure CSS, no raster
 * image, no animation. Purely decorative → aria-hidden.
 *
 * Geometry is expressed in vw/%/rotate so the same silhouette holds across
 * phone aspect ratios; the parent clips overflow so nothing bleeds sideways.
 */
function AuroraBackground() {
  return (
    <div aria-hidden className="oaur pointer-events-none absolute inset-0 overflow-hidden">
      <style>{AURORA_CSS}</style>
      <div className="oaur-haze" />
      <div className="oaur-glow" />
      <div className="oaur-core" />
      <div className="oaur-core2" />
      <div className="oaur-second" />
      <div className="oaur-curl" />
      <div className="oaur-stars" />
      <div className="oaur-floor" />
    </div>
  );
}

const AURORA_CSS = `
.oaur{background:radial-gradient(120% 90% at 50% 40%,#031B34 0%,#02152A 42%,#010A1C 72%,#010817 100%);}
.oaur > div{position:absolute;pointer-events:none;}
.oaur-haze{
  left:58%;top:26%;width:180vw;height:52vh;
  transform:translate(-50%,-50%) rotate(-29deg);
  background:linear-gradient(to bottom,transparent 0%,rgba(20,120,150,.09) 42%,rgba(25,150,170,.15) 50%,rgba(20,120,150,.09) 58%,transparent 100%);
  -webkit-mask-image:linear-gradient(to right,transparent 0%,#000 42%,#000 86%,transparent 100%);
          mask-image:linear-gradient(to right,transparent 0%,#000 42%,#000 86%,transparent 100%);
  filter:blur(44px);opacity:.9;
}
.oaur-glow{
  left:62%;top:26%;width:150vw;height:180px;
  transform:translate(-50%,-50%) rotate(-30deg);
  border-radius:60% 40% 70% 30% / 50% 70% 30% 50%;
  background:linear-gradient(to bottom,transparent 0%,rgba(21,134,196,.08) 34%,rgba(25,200,197,.20) 50%,rgba(22,160,200,.10) 66%,transparent 100%);
  -webkit-mask-image:linear-gradient(to right,transparent 6%,#000 50%,#000 86%,transparent 100%);
          mask-image:linear-gradient(to right,transparent 6%,#000 50%,#000 86%,transparent 100%);
  filter:blur(34px);opacity:.75;
}
.oaur-core{
  left:64%;top:24%;width:150vw;height:46px;
  transform:translate(-50%,-50%) rotate(-30deg);
  background:linear-gradient(to bottom,transparent 0%,rgba(30,210,190,.04) 24%,rgba(58,240,222,.72) 50%,rgba(40,205,228,.24) 70%,transparent 100%);
  -webkit-mask-image:linear-gradient(to right,transparent 16%,#000 58%,#000 84%,transparent 100%);
          mask-image:linear-gradient(to right,transparent 16%,#000 58%,#000 84%,transparent 100%);
  filter:blur(10px);opacity:1;
}
.oaur-core2{
  left:56%;top:35%;width:146vw;height:40px;
  transform:translate(-50%,-50%) rotate(-31deg);
  background:linear-gradient(to bottom,transparent 0%,rgba(30,200,205,.04) 26%,rgba(46,228,218,.50) 50%,rgba(30,185,218,.18) 70%,transparent 100%);
  -webkit-mask-image:linear-gradient(to right,transparent 12%,#000 46%,#000 82%,transparent 100%);
          mask-image:linear-gradient(to right,transparent 12%,#000 46%,#000 82%,transparent 100%);
  filter:blur(13px);opacity:.88;
}
.oaur-second{
  left:82%;top:44%;width:100vw;height:90px;
  transform:translate(-50%,-50%) rotate(-27deg);
  border-radius:70% 30% 60% 40% / 40% 60% 40% 60%;
  background:linear-gradient(to bottom,transparent 0%,rgba(22,187,212,.10) 42%,rgba(39,227,209,.22) 52%,rgba(22,150,190,.08) 62%,transparent 100%);
  -webkit-mask-image:linear-gradient(to right,transparent 12%,#000 52%,#000 86%,transparent 100%);
          mask-image:linear-gradient(to right,transparent 12%,#000 52%,#000 86%,transparent 100%);
  filter:blur(22px);opacity:.55;
}
.oaur-curl{
  left:33%;top:58%;width:54vw;height:124px;
  transform:translate(-50%,-50%) rotate(-64deg);
  border-radius:85% 15% 50% 50% / 65% 35% 65% 35%;
  background:linear-gradient(to bottom,transparent 0%,rgba(25,185,205,.16) 44%,rgba(34,215,200,.28) 55%,transparent 100%);
  -webkit-mask-image:linear-gradient(to right,transparent 0%,#000 52%,transparent 100%);
          mask-image:linear-gradient(to right,transparent 0%,#000 52%,transparent 100%);
  filter:blur(26px);opacity:.6;
}
.oaur-stars{
  inset:0;opacity:.6;filter:blur(.2px);
  background-image:
    radial-gradient(1.4px 1.4px at 20% 22%,rgba(255,255,255,.9),transparent),
    radial-gradient(1px 1px at 68% 16%,rgba(210,240,255,.7),transparent),
    radial-gradient(1.2px 1.2px at 82% 30%,rgba(255,255,255,.8),transparent),
    radial-gradient(1px 1px at 44% 12%,rgba(210,240,255,.6),transparent),
    radial-gradient(1.3px 1.3px at 88% 46%,rgba(255,255,255,.7),transparent),
    radial-gradient(1px 1px at 14% 40%,rgba(210,240,255,.5),transparent),
    radial-gradient(1.5px 1.5px at 58% 26%,rgba(255,255,255,.85),transparent),
    radial-gradient(1px 1px at 74% 8%,rgba(210,240,255,.55),transparent);
}
.oaur-floor{
  left:0;right:0;bottom:0;top:auto;width:auto;height:52%;
  background:linear-gradient(to bottom,transparent 0%,rgba(1,10,24,.55) 42%,#010817 88%);
}
`;

function Brand({
  subtitle,
  emphasizeSubtitle = false,
}: {
  subtitle: string;
  /** Render the subtitle as a bold, slightly larger brand tagline (chooser
   *  screen only). Functional subtitles on the email/forgot screens stay small
   *  and muted. */
  emphasizeSubtitle?: boolean;
}) {
  return (
    <div className="text-center space-y-1">
      <img
        src="/brand/orodim-logo.png"
        alt=""
        className="w-28 h-28 object-contain mx-auto mb-3"
        draggable={false}
      />
      <h1 className="text-2xl font-bold text-slate-100">Orodim</h1>
      <p
        className={
          emphasizeSubtitle
            ? 'text-slate-300 text-base font-bold'
            : 'text-slate-400 text-sm'
        }
      >
        {subtitle}
      </p>
    </div>
  );
}

function IconBadge() {
  return (
    <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-900/40 mx-auto">
      <Mail className="w-7 h-7 text-blue-400 shrink-0" strokeWidth={1.5} aria-hidden="true" />
    </div>
  );
}

function SessionNotice({ notice }: { notice: ReturnType<typeof consumeAccountSessionNotice> }) {
  if (!notice) return null;
  if (notice === 'deleted') {
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-800/80 px-4 py-3 text-center">
        <p className="text-sm text-slate-200 font-medium">Sua conta foi excluída.</p>
        <p className="text-xs text-slate-400 mt-1">
          Seu acesso foi encerrado e você não receberá novas comunicações pelo Orodim.
        </p>
      </div>
    );
  }
  if (notice === 'blocked') {
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-800/80 px-4 py-3 text-center">
        <p className="text-sm text-slate-300">Esta conta não está mais disponível.</p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/80 px-4 py-3 text-center">
      <p className="text-sm text-slate-200 font-medium">Senha alterada com sucesso.</p>
      <p className="text-xs text-slate-400 mt-1">Faça login com sua nova senha.</p>
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
