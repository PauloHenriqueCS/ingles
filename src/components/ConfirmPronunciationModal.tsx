import { useEffect, useRef } from 'react';

interface Props {
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmPronunciationModal({ onConfirm, onCancel }: Props) {
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmBtnRef.current?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70"
        onClick={onCancel}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        className="relative w-full max-w-md bg-slate-900 rounded-2xl p-6 space-y-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle for mobile */}
        <div className="flex justify-center mb-1 sm:hidden">
          <div className="w-10 h-1 rounded-full bg-slate-600" aria-hidden="true" />
        </div>

        <h2 id="confirm-modal-title" className="text-base font-semibold text-slate-100">
          Enviar gravação para análise?
        </h2>

        <p className="text-sm text-slate-300 leading-relaxed">
          Esta será a avaliação oficial desta versão do texto. Depois que o resultado for
          concluído, não será possível enviar outra gravação para a mesma versão.
        </p>

        <ul className="text-xs text-slate-400 space-y-1 list-disc list-inside leading-relaxed">
          <li>A gravação será enviada ao serviço Azure Speech para avaliação.</li>
          <li>O processo pode levar alguns segundos.</li>
          <li>Se houver uma falha técnica recuperável, a avaliação não será consumida definitivamente.</li>
        </ul>

        <div className="flex flex-col-reverse sm:flex-row gap-2 pt-2">
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2 focus:ring-offset-slate-900 min-h-[44px]"
          >
            Cancelar
          </button>
          <button
            ref={confirmBtnRef}
            onClick={onConfirm}
            className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-900 min-h-[44px]"
          >
            Confirmar e analisar
          </button>
        </div>
      </div>
    </div>
  );
}
