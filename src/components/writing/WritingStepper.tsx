import { Check } from 'lucide-react';
import {
  WRITING_STEP_SLOTS,
  stepperSlotState,
  type WritingStep,
  type WritingStepSlot,
} from '../../domain/writing/writing-flow-steps';
import type { WritingUiStrings } from '../../i18n/writingUiStrings';

interface Props {
  current: WritingStep;
  /** The furthest slot the user has unlocked (from persisted evidence ∪ session progress). */
  furthest: WritingStepSlot;
  /** While improving, the central slot shows "Melhorar" instead of "Feedback". */
  improving: boolean;
  onNavigate: (slot: WritingStepSlot) => void;
  t: WritingUiStrings;
}

/**
 * Persistent 4-slot progress/navigation bar — Missão · Escrever · Feedback ·
 * Concluir. It communicates "estou nesta etapa, já concluí estas, e depois vem
 * aquilo": completed slots show a check and are tappable, the current slot is
 * highlighted, future/locked slots are neutral and non-interactive. The central
 * slot relabels to "Melhorar" while the optional improve sub-flow is active, so
 * the bar never grows past four slots. Pronúncia is NOT a slot — it is an extra
 * on the Concluído screen.
 */
export default function WritingStepper({ current, furthest, improving, onNavigate, t }: Props) {
  function labelFor(slot: WritingStepSlot): string {
    switch (slot) {
      case 'mission': return t.stepMission;
      case 'write': return t.stepWrite;
      case 'feedback': return improving ? t.stepImprove : t.stepFeedback;
      case 'done': return t.stepDone;
    }
  }

  return (
    <nav aria-label={t.stepperAria} className="w-full">
      <ol className="flex items-start">
        {WRITING_STEP_SLOTS.map((slot, i) => {
          const state = stepperSlotState(slot, current, furthest);
          const isCurrent = state === 'current';
          const isCompleted = state === 'completed';
          const isLocked = state === 'locked';
          const tappable = !isLocked && !isCurrent;

          const circleCls = isCurrent
            ? 'bg-blue-600 text-white ring-2 ring-blue-400/40'
            : isCompleted
            ? 'bg-green-600/90 text-white'
            : state === 'reachable'
            ? 'bg-slate-700 text-slate-300'
            : 'bg-slate-800 text-slate-600 border border-slate-700';

          const labelCls = isCurrent
            ? 'text-blue-300 font-semibold'
            : isLocked
            ? 'text-slate-600'
            : 'text-slate-400';

          return (
            <li key={slot} className="flex-1 flex flex-col items-center min-w-0">
              <div className="flex items-center w-full">
                {/* left connector — filled once this slot has been reached */}
                <span
                  className={`h-0.5 flex-1 ${i === 0 ? 'opacity-0' : isCompleted || isCurrent ? 'bg-blue-600/70' : 'bg-slate-700'}`}
                  aria-hidden="true"
                />
                <button
                  type="button"
                  onClick={() => tappable && onNavigate(slot)}
                  disabled={!tappable}
                  aria-current={isCurrent ? 'step' : undefined}
                  aria-label={`${labelFor(slot)}${isCompleted ? ' — concluída' : isCurrent ? ' — etapa atual' : isLocked ? ' — indisponível' : ''}`}
                  className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${circleCls} ${tappable ? 'cursor-pointer hover:brightness-110' : 'cursor-default'}`}
                >
                  {isCompleted ? <Check className="w-4 h-4" strokeWidth={2.5} aria-hidden="true" /> : i + 1}
                </button>
                {/* right connector — filled once this slot is completed */}
                <span
                  className={`h-0.5 flex-1 ${i === WRITING_STEP_SLOTS.length - 1 ? 'opacity-0' : isCompleted ? 'bg-blue-600/70' : 'bg-slate-700'}`}
                  aria-hidden="true"
                />
              </div>
              <button
                type="button"
                onClick={() => tappable && onNavigate(slot)}
                disabled={!tappable}
                tabIndex={-1}
                className={`mt-1 px-0.5 text-[11px] leading-tight text-center truncate max-w-full ${labelCls} ${tappable ? 'cursor-pointer' : 'cursor-default'}`}
              >
                {labelFor(slot)}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
