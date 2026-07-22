import { useState } from 'react';
import { ArrowLeft, Settings as SettingsIcon, AlertTriangle } from 'lucide-react';
import DeleteAccountModal from './DeleteAccountModal';

interface Props {
  onBack: () => void;
  onAccountDeleted: () => void;
}

export default function SettingsView({ onBack, onAccountDeleted }: Props) {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      <header className="sticky top-0 bg-slate-800 border-b border-slate-700 px-4 py-3 z-10 flex items-center gap-3">
        <button
          onClick={onBack}
          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors"
          aria-label="Voltar"
        >
          <ArrowLeft className="w-4 h-4 shrink-0" />
        </button>
        <h1 className="text-base font-semibold text-slate-100">Configurações</h1>
      </header>

      <div className="flex-1 overflow-auto p-4 max-w-lg mx-auto w-full space-y-5 pb-10">
        <section className="bg-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2">
            <SettingsIcon className="w-4 h-4 text-slate-400 shrink-0" />
            <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Conta</p>
          </div>

          <div className="border border-red-900/40 bg-red-950/20 rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" aria-hidden="true" />
              <p className="text-sm font-medium text-slate-200">Excluir conta</p>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              Ao excluir sua conta, você perderá permanentemente o acesso ao Lemon. Sua assinatura será interrompida
              e você deixará de receber cobranças e comunicações.
            </p>
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="w-full sm:w-auto px-4 py-2.5 rounded-xl text-sm font-semibold bg-red-600 hover:bg-red-500 text-white transition-colors"
            >
              Excluir minha conta
            </button>
          </div>
        </section>
      </div>

      {modalOpen && (
        <DeleteAccountModal
          onCancel={() => setModalOpen(false)}
          onDeleted={() => {
            setModalOpen(false);
            onAccountDeleted();
          }}
        />
      )}
    </div>
  );
}
