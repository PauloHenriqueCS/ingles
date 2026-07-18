import { useState } from 'react';
import { BookOpen, ArrowDown, CheckCircle2, XCircle } from 'lucide-react';
import { EnglishDailyTheme, GrammarGuide, OptionalExercise } from '../types';
import CollapsibleBlock from './CollapsibleBlock';

interface Props {
  theme: EnglishDailyTheme;
  onSkipToWriting: () => void;
}

/**
 * "Antes de escrever" — teaches the mission's verb tense before the user
 * starts writing. Both the grammar guide and the exercises come from the
 * same AI call that generated the mission (see api/generate-theme.ts); no
 * extra request is made here. Either piece may be absent if the AI omitted
 * or malformed it — the section simply renders less, never blocking writing.
 */
export default function MissionGrammarGuide({ theme, onSkipToWriting }: Props) {
  const guide = theme.grammarGuide ?? null;
  const exercises = theme.optionalExercises ?? [];

  if (!guide && exercises.length === 0) return null;

  return (
    <div className="bg-slate-800 rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-4 pt-4 pb-2">
        <BookOpen className="w-4 h-4 shrink-0 text-slate-300" strokeWidth={2} aria-hidden="true" />
        <p className="text-sm font-semibold text-slate-100">Antes de escrever</p>
      </div>

      <div className="px-4 pb-4 space-y-4">
        {guide && <GrammarExplanation guide={guide} />}

        {exercises.length > 0 && (
          <CollapsibleBlock title="Praticar antes de escrever" badge="opcional" defaultOpen={false}>
            <div className="space-y-3 pt-1">
              {exercises.map((ex, i) => (
                <ExerciseCard key={ex.id || i} exercise={ex} index={i} />
              ))}
            </div>
          </CollapsibleBlock>
        )}

        <button
          type="button"
          onClick={onSkipToWriting}
          className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-700/60 transition-colors"
        >
          Ir direto para a escrita
          <ArrowDown className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

// ── Grammar explanation ────────────────────────────────────────────────────────

function GrammarExplanation({ guide }: { guide: GrammarGuide }) {
  return (
    <div className="rounded-xl bg-slate-700/40 border border-slate-600/50 px-4 py-3 space-y-4">
      <p className="text-sm font-bold text-slate-100">{guide.title}</p>

      <p className="text-sm text-slate-300 leading-relaxed">{guide.explanationPtBr}</p>

      {guide.usagePtBr.length > 0 && (
        <GuideSection title="Quando usar">
          <ul className="space-y-1.5">
            {guide.usagePtBr.map((item, i) => (
              <li key={i} className="flex gap-2 text-xs text-slate-300 leading-relaxed">
                <span className="text-slate-500 shrink-0">•</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </GuideSection>
      )}

      <GuideSection title="Estrutura">
        <div className="space-y-1.5">
          <StructureRow label="+" value={guide.structures.affirmative} />
          <StructureRow label="−" value={guide.structures.negative} />
          <StructureRow label="?" value={guide.structures.interrogative} />
        </div>
      </GuideSection>

      {guide.examples.length > 0 && (
        <GuideSection title="Exemplos">
          <div className="space-y-2.5">
            {guide.examples.map((ex, i) => (
              <div key={i} className="space-y-0.5">
                <p className="text-xs text-green-400 leading-relaxed">"{ex.english}"</p>
                <p className="text-xs text-slate-500 leading-relaxed">"{ex.portuguese}"</p>
              </div>
            ))}
          </div>
        </GuideSection>
      )}

      {guide.commonMistakes.length > 0 && (
        <GuideSection title="Erros comuns">
          <ul className="space-y-1.5">
            {guide.commonMistakes.map((m, i) => (
              <li key={i} className="flex gap-2 text-xs text-amber-300 leading-relaxed">
                <span className="text-amber-500 shrink-0">⚠</span>
                <span>{m}</span>
              </li>
            ))}
          </ul>
        </GuideSection>
      )}
    </div>
  );
}

function GuideSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">{title}</p>
      {children}
    </div>
  );
}

function StructureRow({ label, value }: { label: string; value: string }) {
  const color = label === '+' ? 'text-green-400' : label === '−' ? 'text-red-400' : 'text-blue-400';
  return (
    <div className="flex gap-3 items-start">
      <span className={`text-xs font-bold shrink-0 w-3 mt-0.5 ${color}`}>{label}</span>
      <span className="text-xs text-slate-300 font-mono leading-relaxed">{value}</span>
    </div>
  );
}

// ── Exercises ─────────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  fill_blank: 'Complete a frase',
  multiple_choice: 'Escolha a alternativa',
  transform_sentence: 'Transforme a frase',
  correct_error: 'Corrija o erro',
  translate: 'Traduza',
};

function normalizeAnswer(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:'"]/g, '')
    .replace(/\s+/g, ' ');
}

function ExerciseCard({ exercise, index }: { exercise: OptionalExercise; index: number }) {
  const [textAnswer, setTextAnswer] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);

  const isMultipleChoice = exercise.type === 'multiple_choice' && !!exercise.options?.length;
  const userAnswer = isMultipleChoice ? selected : textAnswer;
  const isCorrect = checked && normalizeAnswer(userAnswer ?? '') === normalizeAnswer(exercise.correctAnswer);

  function verify() {
    if (!userAnswer?.trim()) return;
    setChecked(true);
  }

  function retry() {
    setChecked(false);
    setTextAnswer('');
    setSelected(null);
  }

  return (
    <div className="rounded-lg bg-slate-700/30 border border-slate-600/30 px-3 py-3 space-y-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="px-1.5 py-0.5 rounded bg-slate-700 text-slate-400 text-[10px] font-medium uppercase tracking-wider">
          {index + 1}. {TYPE_LABELS[exercise.type] ?? exercise.type}
        </span>
      </div>
      <p className="text-xs text-slate-500 leading-relaxed">{exercise.instructionPtBr}</p>
      <p className="text-sm text-slate-200 leading-relaxed">{exercise.question}</p>

      {isMultipleChoice ? (
        <div className="flex flex-col gap-1.5">
          {exercise.options!.map((opt, i) => {
            const isSelected = selected === opt;
            const isRightAnswer = normalizeAnswer(opt) === normalizeAnswer(exercise.correctAnswer);
            const cls = checked
              ? isRightAnswer
                ? 'border-green-600 bg-green-900/20 text-green-300'
                : isSelected
                ? 'border-red-600 bg-red-900/20 text-red-300'
                : 'border-slate-600 text-slate-400'
              : isSelected
              ? 'border-blue-500 bg-blue-900/30 text-blue-200'
              : 'border-slate-600 text-slate-300 hover:border-slate-500';
            return (
              <button
                key={i}
                type="button"
                disabled={checked}
                onClick={() => setSelected(opt)}
                className={`text-left px-3 py-2 rounded-lg text-sm border transition-colors disabled:cursor-default ${cls}`}
              >
                {opt}
              </button>
            );
          })}
        </div>
      ) : (
        <input
          type="text"
          value={textAnswer}
          disabled={checked}
          onChange={(e) => setTextAnswer(e.target.value)}
          placeholder="Sua resposta..."
          className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500 disabled:opacity-60"
        />
      )}

      {!checked ? (
        <button
          type="button"
          onClick={verify}
          disabled={!userAnswer?.trim()}
          className="text-xs font-medium text-blue-400 hover:text-blue-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Verificar
        </button>
      ) : (
        <div className="space-y-1.5 pt-1 border-t border-slate-600/40">
          <p className={`text-xs font-medium flex items-center gap-1.5 pt-1.5 ${isCorrect ? 'text-green-400' : 'text-red-400'}`}>
            {isCorrect ? (
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
            ) : (
              <XCircle className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
            )}
            {isCorrect ? 'Correto!' : `Resposta correta: "${exercise.correctAnswer}"`}
          </p>
          <p className="text-xs text-slate-400 leading-relaxed">{exercise.explanationPtBr}</p>
          <button
            type="button"
            onClick={retry}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            Tentar novamente
          </button>
        </div>
      )}
    </div>
  );
}
