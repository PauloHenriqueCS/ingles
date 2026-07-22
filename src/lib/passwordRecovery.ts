import { supabase } from './supabase';

type Listener = () => void;

let recoveryActive = false;
const listeners = new Set<Listener>();

// Subscribed at module load time — before any component can mount — so this
// never races the Supabase client's own async detection of recovery tokens
// in the URL on first page load. Missing that race would mean a fresh,
// valid recovery link intermittently reads as invalid.
supabase.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') {
    recoveryActive = true;
    listeners.forEach((listener) => listener());
  }
});

export function isPasswordRecoveryActive(): boolean {
  return recoveryActive;
}

export function subscribeToPasswordRecovery(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
