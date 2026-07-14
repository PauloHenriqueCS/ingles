import { PenSquare, MessagesSquare } from 'lucide-react';
import type { View } from '../types';

interface Props {
  onNavigate: (v: View) => void;
  onStartPractice: () => void;
}

export default function HomePage({ onNavigate, onStartPractice }: Props) {
  return (
    <div className="p-4 pt-8 max-w-2xl mx-auto">

      {/* Page header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-100">O que você quer praticar hoje?</h1>
        <p className="text-slate-400 text-sm mt-2 leading-relaxed">
          Escolha uma atividade e continue sua evolução no inglês.
        </p>
      </div>

      {/* Activity cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

        {/* Card 1 — Writing + voice */}
        <button
          onClick={onStartPractice}
          className="group text-left bg-slate-800 border border-slate-700 hover:border-blue-600 hover:bg-slate-700/60 rounded-2xl p-6 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-900"
        >
          <div className="flex items-center justify-center w-14 h-14 rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 mb-5 shadow-lg shadow-blue-900/40">
            <PenSquare className="w-6 h-6 text-white shrink-0 transition-transform duration-150 group-hover:scale-105" strokeWidth={2} aria-hidden="true" />
          </div>

          <h2 className="text-base font-semibold text-slate-100 mb-2">
            Praticar escrita e voz
          </h2>
          <p className="text-sm text-slate-400 leading-relaxed mb-6">
            Receba uma missão, escreva seu texto, revise com a IA e treine sua pronúncia.
          </p>

          <span className="inline-flex items-center gap-1 text-sm font-medium text-blue-400 group-hover:text-blue-300 transition-colors">
            Começar prática
            <span aria-hidden="true">→</span>
          </span>
        </button>

        {/* Card 2 — AI conversation */}
        <button
          onClick={() => onNavigate('conversation')}
          className="group text-left bg-slate-800 border border-slate-700 hover:border-teal-600 hover:bg-slate-700/60 rounded-2xl p-6 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 focus:ring-offset-slate-900"
        >
          <div className="flex items-center justify-center w-14 h-14 rounded-xl bg-gradient-to-br from-teal-500 to-teal-700 mb-5 shadow-lg shadow-teal-900/40">
            <MessagesSquare className="w-6 h-6 text-white shrink-0 transition-transform duration-150 group-hover:scale-105" strokeWidth={2} aria-hidden="true" />
          </div>

          <h2 className="text-base font-semibold text-slate-100 mb-2">
            Conversar com IA
          </h2>
          <p className="text-sm text-slate-400 leading-relaxed mb-6">
            Pratique inglês falado em uma conversa natural com seu tutor virtual.
          </p>

          <span className="inline-flex items-center gap-1 text-sm font-medium text-teal-400 group-hover:text-teal-300 transition-colors">
            Iniciar conversa
            <span aria-hidden="true">→</span>
          </span>
        </button>

      </div>
    </div>
  );
}
