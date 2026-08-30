import { useState, type InputHTMLAttributes } from 'react';
import { Eye, EyeOff } from 'lucide-react';

/**
 * Password field with a show/hide toggle, shared across every auth form
 * (login, signup, and password reset) so the eye button behaves and looks
 * identical everywhere. Renders the same Orodim input styling as the plain
 * text/email inputs, plus room on the right for the toggle so the text never
 * runs under the icon and the field height stays fixed as it toggles.
 *
 * Everything except `type` is forwarded to the underlying <input>, so callers
 * keep passing value/onChange/placeholder/minLength/required/autoFocus/… as
 * usual. The toggle only swaps type between "password" and "text"; it never
 * touches the value, navigates, or submits the form (type="button").
 */
type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

const INPUT_CLASS =
  'w-full bg-slate-800 border border-slate-700 rounded-xl pl-4 pr-12 py-3 text-slate-100 placeholder-slate-600 text-sm focus:outline-none focus:border-blue-500';

export default function PasswordInput({ className, ...inputProps }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <input
        {...inputProps}
        type={visible ? 'text' : 'password'}
        className={className ?? INPUT_CLASS}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Ocultar senha' : 'Mostrar senha'}
        aria-pressed={visible}
        className="absolute inset-y-0 right-0 flex items-center justify-center w-11 rounded-r-xl text-slate-500 hover:text-slate-300 transition-colors focus:outline-none focus-visible:text-slate-200 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
      >
        {visible ? (
          <EyeOff className="w-[18px] h-[18px] shrink-0" strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <Eye className="w-[18px] h-[18px] shrink-0" strokeWidth={1.75} aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
