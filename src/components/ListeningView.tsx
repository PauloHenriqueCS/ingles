import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Headphones, Play, Pause, RotateCcw, ChevronRight, ArrowLeft,
  Check, X, Clock, AlertCircle, Trophy, RefreshCw, Volume2,
} from 'lucide-react';
import { useListeningAudioPlayer } from '../hooks/useListeningAudioPlayer';
import { useListeningSubtitles } from '../hooks/useListeningSubtitles';
import {
  getEpisodeSession,
  getPublishedEpisodes,
  markPlaybackCompleted,
  submitAnswer,
  refreshAudioUrl,
  ListeningApiError,
  type EpisodeSessionResponse,
  type SubmitAnswerResult,
  type PublishedEpisode,
} from '../lib/listeningApi';
import type { PublicSubtitleCue, SessionBlockInfo } from '../services/listening/execution/listening-execution-types';

type Phase =
  | 'loading'
  | 'selecting'        // no episodeId provided — show episode list
  | 'error'
  | 'ready_to_play'
  | 'playing'
  | 'paused'
  | 'marking'          // calling POST /playback-completed
  | 'question'
  | 'submitting'
  | 'correct'
  | 'wrong'            // wrong answer (not last)
  | 'cycle_failed'     // 3 wrong answers
  | 'done';

type Speed = 0.75 | 0.90 | 1.00 | 1.10 | 1.25;
const SPEEDS: Speed[] = [0.75, 0.90, 1.00, 1.10, 1.25];

function formatSpeed(s: Speed): string {
  return s === 1.00 ? '1×' : `${s}×`;
}

function fmtMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function Waveform({ playing }: { playing: boolean }) {
  const heights = [35, 60, 80, 55, 70, 45, 85, 50, 65, 40, 75, 55, 30, 70, 85, 50, 65, 45, 80, 55, 70, 40, 60, 75, 50, 35, 65, 55];
  return (
    <>
      <style>{`@keyframes bar-wave{0%,100%{transform:scaleY(1)}50%{transform:scaleY(0.25)}}`}</style>
      <div className="flex items-end justify-center gap-0.5 h-16 px-2">
        {heights.map((h, i) => (
          <div
            key={i}
            style={{
              width: '5px',
              height: `${h}%`,
              background: 'rgb(168,85,247)',
              borderRadius: '3px',
              transformOrigin: 'bottom',
              animation: playing
                ? `bar-wave ${0.55 + (i % 5) * 0.13}s ease-in-out ${i * 0.035}s infinite`
                : 'none',
              opacity: playing ? 0.75 + (i % 3) * 0.08 : 0.2,
              transition: 'opacity 0.3s',
            }}
          />
        ))}
      </div>
    </>
  );
}

interface Props {
  onBack: () => void;
  episodeId?: string;
}

export default function ListeningView({ onBack, episodeId: propEpisodeId }: Props) {
  const [phase, setPhase] = useState<Phase>(propEpisodeId ? 'loading' : 'selecting');
  const [episodeId, setEpisodeId] = useState<string | null>(propEpisodeId ?? null);
  const [episodeData, setEpisodeData] = useState<EpisodeSessionResponse | null>(null);
  const [blockIdx, setBlockIdx] = useState<0 | 1>(0);
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [lastResult, setLastResult] = useState<SubmitAnswerResult | null>(null);
  const [speed, setSpeed] = useState<Speed>(1.00);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [episodes, setEpisodes] = useState<PublishedEpisode[]>([]);
  const [loadingEpisodes, setLoadingEpisodes] = useState(false);

  const player = useListeningAudioPlayer();
  const urlRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrongTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Determine active block data
  const block: SessionBlockInfo | null = episodeData?.blocks[blockIdx] ?? null;
  const session = block?.session ?? null;
  const subtitleMode = session?.subtitleMode ?? 'none';
  const cues: PublicSubtitleCue[] =
    subtitleMode === 'none'
      ? []
      : subtitleMode === 'en'
      ? (block?.subtitles?.en ?? [])
      : (block?.subtitles?.ptBr ?? []);

  const subtitlesEnabled = subtitleMode !== 'none' && (phase === 'playing' || phase === 'paused' || phase === 'marking');
  const activeCue = useListeningSubtitles(cues, player.audioRef, subtitlesEnabled);

  // ── Apply speed to audio when it changes ──────────────────────────────────
  useEffect(() => {
    player.setRate(speed);
  }, [speed, player.setRate]);

  // ── Load episode session ───────────────────────────────────────────────────
  const loadSession = useCallback(async (epId: string) => {
    setPhase('loading');
    setSelectedOption(null);
    setLastResult(null);
    try {
      const data = await getEpisodeSession(epId);
      setEpisodeData(data);

      // Determine which block is active
      if (data.progress?.completedAt) {
        setPhase('done');
        return;
      }

      const idx = data.blocks.findIndex(b => !b.completed && !b.locked);
      if (idx === -1) {
        setPhase('done');
        return;
      }

      const activeBlock = data.blocks[idx];
      const bIdx = idx as 0 | 1;
      setBlockIdx(bIdx);

      const sess = activeBlock.session;
      if (!sess || !activeBlock.audio) {
        setErrorMsg('Dados do episódio incompletos.');
        setPhase('error');
        return;
      }

      // Load audio
      player.load(activeBlock.audio.url, activeBlock.audio.durationMs);
      scheduleUrlRefresh(sess.sessionId, activeBlock.audio.expiresAt);

      // Register ended callback
      player.setOnEnded(() => handleAudioEnded(sess.sessionId));

      // If session is already awaiting_answer (e.g. page refresh), skip to question
      if (sess.status === 'awaiting_answer') {
        setPhase('question');
      } else {
        setPhase('ready_to_play');
      }
    } catch (err) {
      const msg = err instanceof ListeningApiError ? err.message : 'Erro ao carregar episódio.';
      setErrorMsg(msg);
      setPhase('error');
    }
  }, [player]);

  // ── Handle audio ended ─────────────────────────────────────────────────────
  async function handleAudioEnded(sessionId: string) {
    setPhase('marking');
    try {
      await markPlaybackCompleted(sessionId);
      setPhase('question');
    } catch {
      // If marking fails, still show question (idempotent on backend)
      setPhase('question');
    }
  }

  // ── Register ended callback whenever session changes ───────────────────────
  useEffect(() => {
    if (!session?.sessionId) return;
    const sid = session.sessionId;
    player.setOnEnded(() => handleAudioEnded(sid));
  }, [session?.sessionId]);

  // ── Initial load ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (episodeId) {
      loadSession(episodeId);
    } else {
      loadEpisodeList();
    }
  }, [episodeId]);

  async function loadEpisodeList() {
    setLoadingEpisodes(true);
    try {
      const list = await getPublishedEpisodes();
      if (list.length === 1) {
        // Auto-select single episode
        setEpisodeId(list[0].id);
      } else {
        setEpisodes(list);
        setPhase('selecting');
      }
    } catch {
      setEpisodes([]);
      setPhase('selecting');
    } finally {
      setLoadingEpisodes(false);
    }
  }

  // ── URL refresh scheduling ─────────────────────────────────────────────────
  function scheduleUrlRefresh(sessionId: string, expiresAt: string) {
    if (urlRefreshTimerRef.current) clearTimeout(urlRefreshTimerRef.current);
    const msLeft = new Date(expiresAt).getTime() - Date.now() - 5 * 60 * 1000;
    if (msLeft <= 0) {
      doUrlRefresh(sessionId, expiresAt);
      return;
    }
    urlRefreshTimerRef.current = setTimeout(() => doUrlRefresh(sessionId, expiresAt), msLeft);
  }

  async function doUrlRefresh(sessionId: string, _prevExpiresAt: string) {
    try {
      const info = await refreshAudioUrl(sessionId);
      player.updateUrl(info.url);
      scheduleUrlRefresh(sessionId, info.expiresAt);
    } catch {
      // Silently ignore — user will encounter error on next play attempt
    }
  }

  // ── Submit answer ──────────────────────────────────────────────────────────
  async function handleSubmit() {
    if (selectedOption === null || !session || !block) return;
    const submissionId = crypto.randomUUID();
    setPhase('submitting');

    try {
      const result = await submitAnswer({
        sessionId: session.sessionId,
        questionId: block.question!.id,
        selectedOption,
        submissionId,
        playbackRate: speed,
      });

      setLastResult(result);

      if (result.correct) {
        if (result.episodeCompleted) {
          setPhase('done');
        } else {
          setPhase('correct');
        }
      } else if (result.sessionStatus === 'abandoned') {
        setPhase('cycle_failed');
      } else {
        // Wrong but more attempts available
        setPhase('wrong');
        wrongTimerRef.current = setTimeout(() => {
          if (episodeId) loadSession(episodeId);
        }, 2500);
      }
    } catch (err) {
      const msg = err instanceof ListeningApiError ? err.message : 'Erro ao enviar resposta.';
      setErrorMsg(msg);
      setPhase('error');
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (urlRefreshTimerRef.current) clearTimeout(urlRefreshTimerRef.current);
      if (wrongTimerRef.current) clearTimeout(wrongTimerRef.current);
    };
  }, []);

  // ── Play handler ───────────────────────────────────────────────────────────
  async function handlePlay() {
    setPhase('playing');
    await player.play();
  }

  // ── Navigate back within the view ─────────────────────────────────────────
  function handleBack() {
    if (phase === 'question' || phase === 'wrong' || phase === 'correct' || phase === 'cycle_failed') {
      // Go back to player (allow re-listen before answering)
      setPhase(player.state.isPlaying ? 'playing' : player.state.isEnded ? 'ready_to_play' : 'paused');
    } else {
      onBack();
    }
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const { currentTimeMs, durationMs } = player.state;
  const pct = durationMs > 0 ? Math.min((currentTimeMs / durationMs) * 100, 100) : 0;
  const isPlayerPhase = phase === 'ready_to_play' || phase === 'playing' || phase === 'paused' || phase === 'marking';

  // ── Subtitle mode label ───────────────────────────────────────────────────
  function subtitleBadge() {
    if (subtitleMode === 'none') return null;
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${
        subtitleMode === 'en'
          ? 'bg-blue-900/40 border-blue-600/40 text-blue-300'
          : 'bg-teal-900/40 border-teal-600/40 text-teal-300'
      }`}>
        <Volume2 className="w-3 h-3" />
        {subtitleMode === 'en' ? 'Legendas: Inglês' : 'Legendas: Português'}
      </span>
    );
  }

  // ── Attempt badge ─────────────────────────────────────────────────────────
  function attemptBadge() {
    if (!session || session.currentAttempt === 1) return null;
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-900/40 border border-amber-600/40 text-amber-300">
        Tentativa {session.currentAttempt}/3
      </span>
    );
  }

  // ── Header ────────────────────────────────────────────────────────────────
  function renderHeader() {
    const showBack = phase !== 'loading' && phase !== 'selecting';
    return (
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800 sticky top-0 bg-slate-900/95 backdrop-blur z-10">
        <button
          onClick={showBack ? handleBack : onBack}
          className="p-2 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
          aria-label="Voltar"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Headphones className="w-4 h-4 text-purple-400 shrink-0" />
          <span className="text-sm font-medium text-slate-300 truncate">
            {episodeData?.title ?? 'Listening'}
          </span>
        </div>
        {episodeData && (
          <span className="text-xs text-purple-400 font-medium shrink-0">{episodeData.cefrLevel}</span>
        )}
      </div>
    );
  }

  // ── Loading ───────────────────────────────────────────────────────────────
  function renderLoading() {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <div className="w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-slate-400 text-sm">Carregando episódio...</p>
      </div>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  function renderError() {
    return (
      <div className="p-6 max-w-lg mx-auto text-center pt-10">
        <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
        <h2 className="text-lg font-semibold text-slate-100 mb-2">Algo deu errado</h2>
        <p className="text-sm text-slate-400 mb-6">{errorMsg || 'Erro ao carregar o episódio.'}</p>
        {episodeId && (
          <button
            onClick={() => loadSession(episodeId)}
            className="w-full py-3 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold transition-colors"
          >
            Tentar novamente
          </button>
        )}
      </div>
    );
  }

  // ── Episode selector ──────────────────────────────────────────────────────
  function renderSelecting() {
    if (loadingEpisodes) return renderLoading();
    if (episodes.length === 0) {
      return (
        <div className="p-6 max-w-lg mx-auto text-center pt-10">
          <Headphones className="w-12 h-12 text-slate-600 mx-auto mb-4" />
          <p className="text-slate-400 text-sm">Nenhum episódio disponível no momento.</p>
        </div>
      );
    }
    return (
      <div className="p-4 pt-6 max-w-lg mx-auto">
        <h2 className="text-lg font-semibold text-slate-100 mb-1">Escolha um episódio</h2>
        <p className="text-sm text-slate-400 mb-5">Episódios disponíveis para praticar</p>
        <div className="space-y-3">
          {episodes.map(ep => (
            <button
              key={ep.id}
              onClick={() => setEpisodeId(ep.id)}
              className="w-full text-left bg-slate-800 border border-slate-700 hover:border-purple-500 rounded-xl p-4 transition-all"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold text-slate-100 mb-1">{ep.title}</h3>
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <span className="px-2 py-0.5 rounded-full bg-purple-600/20 border border-purple-500/30 text-purple-300 font-medium">
                      {ep.cefrLevel}
                    </span>
                    {ep.estimatedDurationSeconds && (
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {Math.round(ep.estimatedDurationSeconds / 60)}min
                      </span>
                    )}
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── Player ────────────────────────────────────────────────────────────────
  function renderPlayer() {
    const isReadyToPlay = phase === 'ready_to_play';
    const isMarking = phase === 'marking';
    const playing = phase === 'playing';

    return (
      <div className="p-4 pt-2 max-w-lg mx-auto">
        {/* Block indicator */}
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-medium text-slate-500">
            Bloco {(blockIdx + 1)}/2
          </span>
          <div className="flex items-center gap-2">
            {attemptBadge()}
            {subtitleBadge()}
          </div>
        </div>

        {/* Waveform + progress */}
        <div className="bg-slate-800 border border-slate-700 rounded-2xl py-5 px-4 mb-4">
          <Waveform playing={playing} />

          <div className="mt-4">
            <div className="flex justify-between text-xs text-slate-500 mb-1.5">
              <span>{fmtMs(currentTimeMs)}</span>
              <span>{durationMs > 0 ? fmtMs(durationMs) : '--:--'}</span>
            </div>
            <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-purple-500 rounded-full transition-all duration-100"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>

          {/* Subtitle cue */}
          {subtitleMode !== 'none' && (
            <div className="mt-4 pt-4 border-t border-slate-700 min-h-[56px] flex items-center">
              {activeCue ? (
                <p className="text-sm text-slate-100 leading-relaxed italic">
                  "{activeCue.text}"
                </p>
              ) : (
                <p className="text-xs text-slate-600 italic">
                  {playing ? 'Aguardando legenda...' : ''}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Controls */}
        {isMarking ? (
          <div className="flex items-center justify-center py-4 gap-2 text-slate-400">
            <div className="w-4 h-4 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm">Salvando...</span>
          </div>
        ) : (
          <div className="flex items-center justify-center gap-4 mb-5">
            <button
              onClick={() => { player.restart(); if (!isReadyToPlay) setPhase('ready_to_play'); }}
              className="p-3 rounded-full bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors"
              title="Reiniciar"
            >
              <RotateCcw className="w-5 h-5" />
            </button>

            {isReadyToPlay ? (
              <button
                onClick={handlePlay}
                className="p-5 rounded-full bg-purple-600 hover:bg-purple-500 text-white transition-colors shadow-lg shadow-purple-900/40"
                aria-label="Reproduzir"
              >
                <Play className="w-7 h-7" />
              </button>
            ) : playing ? (
              <button
                onClick={() => { player.pause(); setPhase('paused'); }}
                className="p-5 rounded-full bg-purple-600 hover:bg-purple-500 text-white transition-colors shadow-lg shadow-purple-900/40"
                aria-label="Pausar"
              >
                <Pause className="w-7 h-7" />
              </button>
            ) : (
              <button
                onClick={handlePlay}
                className="p-5 rounded-full bg-purple-600 hover:bg-purple-500 text-white transition-colors shadow-lg shadow-purple-900/40"
                aria-label="Continuar"
              >
                <Play className="w-7 h-7" />
              </button>
            )}

            <div className="w-11 h-11" /> {/* spacer */}
          </div>
        )}

        {/* Speed control */}
        <div className="flex items-center justify-center gap-2">
          {SPEEDS.map(s => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                speed === s
                  ? 'bg-purple-600 text-white'
                  : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
              }`}
            >
              {formatSpeed(s)}
            </button>
          ))}
        </div>

        {/* Ready to play — context hint */}
        {isReadyToPlay && subtitleMode !== 'none' && (
          <div className={`mt-5 rounded-xl p-3 text-center text-xs border ${
            subtitleMode === 'en'
              ? 'bg-blue-900/20 border-blue-700/30 text-blue-300'
              : 'bg-teal-900/20 border-teal-700/30 text-teal-300'
          }`}>
            {subtitleMode === 'en'
              ? 'Desta vez você ouvirá com legendas em inglês.'
              : 'Desta vez você ouvirá com legendas em português.'}
          </div>
        )}
      </div>
    );
  }

  // ── Question ──────────────────────────────────────────────────────────────
  function renderQuestion() {
    const q = block?.question;
    if (!q) return null;
    const isSubmitting = phase === 'submitting';

    return (
      <div className="p-4 pt-4 max-w-lg mx-auto">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-purple-400">Bloco {blockIdx + 1}/2 — Pergunta</span>
          {attemptBadge()}
        </div>

        <h3 className="text-base font-semibold text-slate-100 leading-snug mb-5">{q.prompt}</h3>

        <div className="space-y-3 mb-6">
          {q.options.map((opt, i) => {
            const isSelected = selectedOption === i;
            return (
              <button
                key={i}
                onClick={() => !isSubmitting && setSelectedOption(i)}
                disabled={isSubmitting}
                className={`w-full text-left px-4 py-3.5 rounded-xl border text-sm transition-all ${
                  isSelected
                    ? 'bg-purple-700/30 border-purple-500 text-slate-100'
                    : 'bg-slate-800 border-slate-700 hover:border-purple-500/60 hover:bg-slate-700/60 text-slate-200'
                } ${isSubmitting ? 'opacity-60 cursor-not-allowed' : ''}`}
              >
                <span className="font-semibold text-purple-400 mr-2">{String.fromCharCode(65 + i)}.</span>
                {opt}
              </button>
            );
          })}
        </div>

        <button
          onClick={handleSubmit}
          disabled={selectedOption === null || isSubmitting}
          className="w-full py-4 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold transition-colors flex items-center justify-center gap-2"
        >
          {isSubmitting ? (
            <>
              <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              Verificando...
            </>
          ) : (
            'Confirmar resposta'
          )}
        </button>

        <button
          onClick={() => setPhase(player.state.isEnded ? 'ready_to_play' : 'paused')}
          className="w-full mt-3 py-2.5 text-xs text-slate-500 hover:text-slate-400 transition-colors"
        >
          Ouvir novamente antes de responder
        </button>
      </div>
    );
  }

  // ── Correct answer ────────────────────────────────────────────────────────
  function renderCorrect() {
    const explanation = lastResult?.explanationPt;
    const blockDone = blockIdx === 0;

    return (
      <div className="p-6 max-w-lg mx-auto text-center pt-8">
        <div className="w-16 h-16 rounded-full bg-emerald-900/40 border border-emerald-600/50 flex items-center justify-center mx-auto mb-5">
          <Check className="w-8 h-8 text-emerald-400" />
        </div>
        <h2 className="text-xl font-bold text-emerald-300 mb-2">Correto!</h2>

        {blockDone ? (
          <p className="text-sm text-slate-400 mb-4">
            Bloco 1 concluído! Continue para o bloco 2.
          </p>
        ) : (
          <p className="text-sm text-slate-400 mb-4">
            Parabéns! Você completou este episódio.
          </p>
        )}

        {explanation && (
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-6 text-left">
            <p className="text-xs text-slate-500 font-medium mb-1">Explicação</p>
            <p className="text-sm text-slate-300 leading-relaxed">{explanation}</p>
          </div>
        )}

        <button
          onClick={() => {
            if (lastResult?.episodeCompleted) {
              setPhase('done');
            } else if (episodeId) {
              // Reload session to get block 2
              loadSession(episodeId);
            }
          }}
          className="w-full py-4 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold transition-colors flex items-center justify-center gap-2"
        >
          {blockDone ? (
            <>
              Continuar para o bloco 2
              <ChevronRight className="w-5 h-5" />
            </>
          ) : (
            <>
              <Trophy className="w-5 h-5" />
              Concluído!
            </>
          )}
        </button>
      </div>
    );
  }

  // ── Wrong answer (not last attempt) ───────────────────────────────────────
  function renderWrong() {
    const nextAttempt = lastResult?.nextAttempt;
    const nextMode = lastResult?.nextSubtitleMode;

    return (
      <div className="p-6 max-w-lg mx-auto text-center pt-8">
        <div className="w-16 h-16 rounded-full bg-red-900/40 border border-red-600/50 flex items-center justify-center mx-auto mb-5">
          <X className="w-8 h-8 text-red-400" />
        </div>
        <h2 className="text-xl font-bold text-red-300 mb-2">Incorreto</h2>
        <p className="text-sm text-slate-400 mb-3">
          {nextAttempt
            ? `Tentativa ${nextAttempt}/3`
            : 'Mais uma chance!'}
          {nextMode === 'en' && ' — ouça novamente com legendas em inglês.'}
          {nextMode === 'pt-BR' && ' — ouça novamente com legendas em português.'}
          {!nextMode && ' — ouça novamente.'}
        </p>
        <div className="flex items-center justify-center gap-2 text-xs text-slate-500">
          <div className="w-4 h-4 border-2 border-slate-600 border-t-purple-500 rounded-full animate-spin" />
          <span>Preparando nova tentativa...</span>
        </div>
      </div>
    );
  }

  // ── Cycle failed (3 wrong answers) ────────────────────────────────────────
  function renderCycleFailed() {
    const correctIndex = lastResult?.correctOption ?? null;
    const q = block?.question;
    const explanation = lastResult?.explanationPt;

    return (
      <div className="p-4 pt-6 max-w-lg mx-auto">
        <div className="flex items-center gap-3 p-4 rounded-xl bg-red-900/30 border border-red-700/40 mb-5">
          <AlertCircle className="w-6 h-6 text-red-400 shrink-0" />
          <div>
            <p className="font-semibold text-sm text-red-300">Ciclo esgotado</p>
            <p className="text-xs text-slate-400 mt-0.5">Você usou as 3 tentativas deste ciclo.</p>
          </div>
        </div>

        {q && correctIndex !== null && (
          <div className="mb-5">
            <p className="text-xs text-slate-500 font-medium mb-3">Resposta correta:</p>
            <div className="space-y-2">
              {q.options.map((opt, i) => {
                const isCorrect = i === correctIndex;
                return (
                  <div
                    key={i}
                    className={`flex items-start gap-3 px-4 py-3 rounded-xl border text-sm ${
                      isCorrect
                        ? 'bg-emerald-900/30 border-emerald-600/50 text-emerald-200'
                        : 'bg-slate-800 border-slate-700 text-slate-500'
                    }`}
                  >
                    <span className="font-semibold shrink-0">{String.fromCharCode(65 + i)}.</span>
                    <span className="flex-1">{opt}</span>
                    {isCorrect && <Check className="w-4 h-4 ml-auto shrink-0 text-emerald-400 mt-0.5" />}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {explanation && (
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-6">
            <p className="text-xs text-slate-500 font-medium mb-1">Explicação</p>
            <p className="text-sm text-slate-300 leading-relaxed">{explanation}</p>
          </div>
        )}

        <button
          onClick={() => { if (episodeId) loadSession(episodeId); }}
          className="w-full py-4 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold transition-colors flex items-center justify-center gap-2"
        >
          <RefreshCw className="w-4 h-4" />
          Começar novo ciclo
        </button>

        <button
          onClick={onBack}
          className="w-full mt-3 py-3 text-sm text-slate-500 hover:text-slate-400 transition-colors"
        >
          Sair
        </button>
      </div>
    );
  }

  // ── Episode done ──────────────────────────────────────────────────────────
  function renderDone() {
    return (
      <div className="p-6 max-w-lg mx-auto text-center pt-10">
        <div className="w-20 h-20 rounded-full bg-purple-600/20 border-2 border-purple-500/50 flex items-center justify-center mx-auto mb-6">
          <Trophy className="w-10 h-10 text-purple-400" />
        </div>
        <h2 className="text-2xl font-bold text-slate-100 mb-2">Episódio concluído!</h2>
        <p className="text-sm text-slate-400 mb-8">
          Você completou todos os blocos de "{episodeData?.title ?? 'este episódio'}".
        </p>
        <button
          onClick={onBack}
          className="w-full py-4 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold transition-colors"
        >
          Voltar ao início
        </button>
      </div>
    );
  }

  // ── Main render ───────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 pb-8">
      {renderHeader()}

      <div>
        {phase === 'loading' && renderLoading()}
        {phase === 'selecting' && renderSelecting()}
        {phase === 'error' && renderError()}
        {isPlayerPhase && renderPlayer()}
        {(phase === 'question' || phase === 'submitting') && renderQuestion()}
        {phase === 'correct' && renderCorrect()}
        {phase === 'wrong' && renderWrong()}
        {phase === 'cycle_failed' && renderCycleFailed()}
        {phase === 'done' && renderDone()}
      </div>
    </div>
  );
}
