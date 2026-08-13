import { useState } from 'react';
import { signInWithGoogle } from '../lib/googleAuth';

/**
 * "Continuar com Google" — the only social button today. Kept as a standalone,
 * self-contained component (manages its own loading + error) so a future
 * AppleSignInButton can sit beside it with the same shape, and so the whole
 * social block is one import in LoginPage. Uses the official multi-color Google
 * "G" mark and Google-compliant styling (light button, per brand guidelines),
 * which reads correctly on the app's dark background without a redesign.
 */

type Props = {
  /** Disable while another auth action (e.g. the email/password form) is busy. */
  disabled?: boolean;
  /** Notifies the parent when this button starts/stops its own async work. */
  onBusyChange?: (busy: boolean) => void;
};

export default function GoogleSignInButton({ disabled = false, onBusyChange }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleClick() {
    if (loading || disabled) return;
    setError('');
    setLoading(true);
    onBusyChange?.(true);
    try {
      const result = await signInWithGoogle();
      // ok:true → native session picked up by useAuth, or web redirect under way.
      // 'cancelled' → user backed out; stay silent. Anything else → surface it.
      if (!result.ok && result.reason !== 'cancelled') {
        setError(translateGoogleError(result));
      }
    } finally {
      setLoading(false);
      onBusyChange?.(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={loading || disabled}
        className="w-full flex items-center justify-center gap-3 py-3 rounded-xl text-sm font-medium bg-white text-[#1f1f1f] hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        <GoogleGMark />
        {loading ? 'Conectando...' : 'Continuar com Google'}
      </button>
      {error && <p className="text-xs text-red-400 text-center">{error}</p>}
    </div>
  );
}

function translateGoogleError(result: { reason: string; message: string }): string {
  switch (result.reason) {
    case 'unavailable':
      return 'Login com Google indisponível nesta versão do app. Atualize o app.';
    case 'network':
      return 'Falha de conexão. Verifique sua internet e tente novamente.';
    case 'invalid_token':
      return 'Não foi possível validar sua conta Google. Tente novamente.';
    default:
      return 'Não foi possível entrar com o Google. Tente novamente.';
  }
}

/** Official Google "G" logo (4-color), inlined so it ships with no network
 *  dependency and honors the CSP. Do not recolor or distort — brand guideline. */
function GoogleGMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className="shrink-0">
      <path
        fill="#4285F4"
        d="M17.64 9.2045c0-.6382-.0573-1.2518-.1636-1.8409H9v3.4814h4.8436c-.2086 1.125-.8427 2.0782-1.7959 2.7164v2.2582h2.9086c1.7018-1.5668 2.6836-3.874 2.6836-6.6151z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.4673-.806 5.9564-2.1805l-2.9086-2.2582c-.8059.54-1.8368.859-3.0478.859-2.344 0-4.3282-1.5832-5.036-3.7104H.9573v2.3318C2.4382 15.9832 5.4818 18 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.71c-.18-.54-.2823-1.1168-.2823-1.71s.1023-1.17.2823-1.71V4.9582H.9573C.3477 6.1732 0 7.5477 0 9c0 1.4523.3477 2.8268.9573 4.0418L3.964 10.71z"
      />
      <path
        fill="#EA4335"
        d="M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.346l2.5813-2.5814C15.4632.8918 13.426 0 9 0 5.4818 0 2.4382 2.0168.9573 4.9582L3.964 7.29C4.6718 5.1627 6.656 3.5795 9 3.5795z"
      />
    </svg>
  );
}
