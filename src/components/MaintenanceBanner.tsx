import { usePublicConfig } from '../hooks/usePublicConfig';

// maintenance.mode (Central de Configuração) — purely informational here.
// Real enforcement for 'read_only'/'unavailable' happens server-side in
// middleware.ts regardless of whether this banner renders; this only makes
// that state visible instead of the user hitting silent 503s.
export default function MaintenanceBanner() {
  const { config } = usePublicConfig();
  const maintenance = config?.['maintenance.mode'];
  if (!maintenance || maintenance.mode === 'off') return null;

  const tone =
    maintenance.mode === 'unavailable' ? 'bg-red-900/60 border-red-700 text-red-200'
    : maintenance.mode === 'read_only' ? 'bg-amber-900/60 border-amber-700 text-amber-200'
    : 'bg-slate-800 border-slate-600 text-slate-200'; // 'banner'

  return (
    <div className={`border-b px-4 py-2 text-xs text-center mt-14 ${tone}`} role="status">
      {maintenance.title ? <strong className="mr-1">{maintenance.title}</strong> : null}
      {maintenance.message || 'O aplicativo está em manutenção.'}
    </div>
  );
}
