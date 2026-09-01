/**
 * STREAK-CELEBRATION PREVIEW LAB — dev-only page at `/dev/streak-celebration`.
 *
 * A self-contained playground to choose the visual variant + sound + haptics for
 * the future streak celebration WITHOUT touching streaks, the DB, or production.
 * Nothing here is wired into any real completion flow.
 */
import { useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Flame, Play, Sparkles, Trophy, Volume2 } from 'lucide-react';
import { StreakCelebrationOverlay } from './StreakCelebrationOverlay';
import { installStreakAudioUnlock, playStreakSound } from './streakCelebrationSound';
import { streakCopy } from './streakCelebrationCopy';
import {
  MILESTONE_PRESETS,
  type StreakCelebrationConfig,
  type StreakCelebrationType,
  type StreakSoundOption,
  type StreakVisualVariant,
} from './streakCelebrationTypes';

const TYPE_META: Record<StreakCelebrationType, { label: string; hint: string }> = {
  milestone: { label: 'Marco de sequência', hint: 'Atingiu um marco fixo (7, 14, 30…).' },
  personal_record: { label: 'Novo recorde pessoal', hint: 'Superou sua melhor sequência.' },
  both: { label: 'Marco + recorde', hint: 'Marco fixo E recorde no mesmo dia.' },
};

const VARIANT_META: Record<
  StreakVisualVariant,
  { label: string; desc: string; icon: typeof Flame }
> = {
  flame: { label: 'A · Chama / Energia', desc: 'Anel de sequência esmeralda + chama + faíscas.', icon: Flame },
  trophy: { label: 'B · Troféu / Recorde', desc: 'Troféu (Lottie reutilizado), ouro, premium.', icon: Trophy },
  orodim: { label: 'C · Orodim premium', desc: 'Aurora da marca, halos elegantes, crescimento.', icon: Sparkles },
};

const SOUND_META: Record<StreakSoundOption, { label: string; hint: string }> = {
  discreet: { label: 'Curta e discreta', hint: 'activity-complete.mp3 (existente)' },
  achievement: { label: 'Conquista mais forte', hint: 'day-complete.mp3 (existente)' },
  premium: { label: 'Premium / elegante', hint: 'premium-chime.mp3 (novo, isolado)' },
  none: { label: 'Sem som', hint: '—' },
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-slate-400">{title}</h3>
      {children}
    </section>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border px-3 py-2 text-sm font-medium transition ${
        active
          ? 'border-emerald-500 bg-emerald-500/15 text-emerald-200'
          : 'border-slate-700 bg-slate-800/50 text-slate-300 hover:border-slate-600'
      }`}
    >
      {children}
    </button>
  );
}

export function StreakCelebrationLab() {
  const [type, setType] = useState<StreakCelebrationType>('milestone');
  const [variant, setVariant] = useState<StreakVisualVariant>('flame');
  const [sound, setSound] = useState<StreakSoundOption>('achievement');
  const [days, setDays] = useState(7);
  const [previousBest, setPreviousBest] = useState(14);
  const [autoDismiss, setAutoDismiss] = useState(true);
  const [simulateReduced, setSimulateReduced] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [replayKey, setReplayKey] = useState(0);

  useEffect(() => {
    installStreakAudioUnlock();
  }, []);

  const config: StreakCelebrationConfig = { type, variant, sound, days, previousBest };
  const copy = streakCopy(type, days, previousBest);

  const play = () => {
    setReplayKey((k) => k + 1);
    setPlaying(true);
  };

  const quick = (patch: Partial<StreakCelebrationConfig>) => {
    if (patch.type) setType(patch.type);
    if (patch.days) setDays(patch.days);
    if (typeof patch.previousBest === 'number') setPreviousBest(patch.previousBest);
    setReplayKey((k) => k + 1);
    setPlaying(true);
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100">
      <div className="mx-auto max-w-2xl px-4 py-6">
        {/* Header */}
        <div className="mb-4 flex items-center gap-3">
          <img src="/brand/lemon-logo.png" alt="Orodim" className="h-8 w-auto" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
          <div>
            <h1 className="text-lg font-bold">Laboratório de celebração de sequência</h1>
            <p className="text-xs text-slate-400">Preview isolado · escolha visual, som e haptics</p>
          </div>
          <span className="ml-auto rounded-full bg-amber-500/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-amber-300">
            Dev
          </span>
        </div>

        {/* Isolation notice */}
        <div className="mb-5 rounded-xl border border-slate-800 bg-slate-800/40 px-4 py-3 text-xs text-slate-400">
          Página de laboratório. <span className="text-slate-300">Não</span> detecta streak real, não
          altera banco, não persiste nada e não dispara em nenhum fluxo do app. Serve só para
          comparar opções.
        </div>

        <div className="space-y-4">
          {/* Tipo */}
          <Section title="Tipo">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {(Object.keys(TYPE_META) as StreakCelebrationType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(t)}
                  className={`rounded-xl border p-3 text-left transition ${
                    type === t ? 'border-emerald-500 bg-emerald-500/15' : 'border-slate-700 bg-slate-800/50 hover:border-slate-600'
                  }`}
                >
                  <div className="text-sm font-semibold text-slate-100">{TYPE_META[t].label}</div>
                  <div className="mt-0.5 text-xs text-slate-400">{TYPE_META[t].hint}</div>
                </button>
              ))}
            </div>
          </Section>

          {/* Variante visual */}
          <Section title="Variante visual">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {(Object.keys(VARIANT_META) as StreakVisualVariant[]).map((v) => {
                const Icon = VARIANT_META[v].icon;
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setVariant(v)}
                    className={`rounded-xl border p-3 text-left transition ${
                      variant === v ? 'border-emerald-500 bg-emerald-500/15' : 'border-slate-700 bg-slate-800/50 hover:border-slate-600'
                    }`}
                  >
                    <Icon size={20} className="mb-1.5 text-slate-200" />
                    <div className="text-sm font-semibold text-slate-100">{VARIANT_META[v].label}</div>
                    <div className="mt-0.5 text-xs text-slate-400">{VARIANT_META[v].desc}</div>
                  </button>
                );
              })}
            </div>
          </Section>

          {/* Som */}
          <Section title="Som">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(Object.keys(SOUND_META) as StreakSoundOption[]).map((s) => (
                <div
                  key={s}
                  className={`flex items-center justify-between rounded-xl border px-3 py-2 transition ${
                    sound === s ? 'border-emerald-500 bg-emerald-500/15' : 'border-slate-700 bg-slate-800/50'
                  }`}
                >
                  <button type="button" onClick={() => setSound(s)} className="flex-1 text-left">
                    <div className="text-sm font-medium text-slate-100">{SOUND_META[s].label}</div>
                    <div className="text-xs text-slate-500">{SOUND_META[s].hint}</div>
                  </button>
                  {s !== 'none' && (
                    <button
                      type="button"
                      onClick={() => playStreakSound(s)}
                      aria-label={`Ouvir ${SOUND_META[s].label}`}
                      className="ml-2 flex h-8 w-8 items-center justify-center rounded-full bg-slate-700 text-slate-200 hover:bg-slate-600"
                    >
                      <Volume2 size={15} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </Section>

          {/* Sequência */}
          <Section title="Sequência (dias)">
            <div className="flex flex-wrap gap-2">
              {MILESTONE_PRESETS.map((d) => (
                <Chip key={d} active={days === d} onClick={() => setDays(d)}>
                  {d}
                </Chip>
              ))}
              <label className="ml-auto flex items-center gap-2 text-xs text-slate-400">
                Personalizado
                <input
                  type="number"
                  min={1}
                  value={days}
                  onChange={(e) => setDays(Math.max(1, Number(e.target.value) || 1))}
                  className="w-20 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-sm text-slate-100"
                />
              </label>
            </div>
            {(type === 'personal_record' || type === 'both') && (
              <label className="mt-3 flex items-center gap-2 text-xs text-slate-400">
                Recorde anterior (para a copy)
                <input
                  type="number"
                  min={0}
                  value={previousBest}
                  onChange={(e) => setPreviousBest(Math.max(0, Number(e.target.value) || 0))}
                  className="w-20 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-sm text-slate-100"
                />
              </label>
            )}
          </Section>

          {/* Opções */}
          <Section title="Opções">
            <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input type="checkbox" checked={autoDismiss} onChange={(e) => setAutoDismiss(e.target.checked)} className="accent-emerald-500" />
                Fechar automaticamente
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input type="checkbox" checked={simulateReduced} onChange={(e) => setSimulateReduced(e.target.checked)} className="accent-emerald-500" />
                Simular reduced motion
              </label>
            </div>
          </Section>

          {/* Copy preview */}
          <Section title="Copy resultante (exemplo)">
            <div className="text-xs uppercase tracking-widest text-amber-300">{copy.eyebrow}</div>
            <div className="text-base font-bold text-slate-100">{copy.title}</div>
            <div className="text-sm text-slate-400">{copy.subtitle}</div>
          </Section>

          {/* Quick actions */}
          <Section title="Testes rápidos">
            <div className="flex flex-wrap gap-2">
              <Chip active={false} onClick={() => quick({ type: 'milestone', days: 7 })}>
                Testar 7 dias
              </Chip>
              <Chip active={false} onClick={() => quick({ type: 'milestone', days: 30 })}>
                Testar 30 dias
              </Chip>
              <Chip active={false} onClick={() => quick({ type: 'personal_record', days: 18, previousBest: 14 })}>
                Testar novo recorde
              </Chip>
              <Chip active={false} onClick={() => quick({ type: 'both', days: 30, previousBest: 22 })}>
                Testar marco + recorde
              </Chip>
            </div>
          </Section>
        </div>

        {/* Play */}
        <button
          type="button"
          onClick={play}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-3.5 text-base font-bold text-slate-950 shadow-lg transition hover:from-emerald-400 hover:to-teal-400"
        >
          <Play size={18} /> Reproduzir
        </button>
      </div>

      {/* Overlay */}
      <AnimatePresence>
        {playing && (
          <StreakCelebrationOverlay
            key={replayKey}
            config={config}
            autoDismiss={autoDismiss}
            reducedOverride={simulateReduced ? true : undefined}
            onClose={() => setPlaying(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
