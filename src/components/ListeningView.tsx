import { useState, useEffect, useRef, useMemo } from 'react';
import {
  Headphones, Play, Pause, RotateCcw, ArrowLeft,
  Check, X, AlertCircle, Trophy, RefreshCw, Lock,
  ScrollText, Rewind, Clock, Loader2,
} from 'lucide-react';
import { useListeningAudioPlayer } from '../hooks/useListeningAudioPlayer';
import { useListeningSubtitles } from '../hooks/useListeningSubtitles';
import {
  getEpisodeSession,
  getPublishedEpisodes,
  markPlaybackCompleted,
  submitAnswer,
  refreshAudioUrl,
  getTodayListening,
  generateListeningStory,
  verifyStoryAnswer,
  ListeningApiError,
  type EpisodeSessionResponse,
  type SubmitAnswerResult,
  type PublishedEpisode,
  type ListeningStoryData,
  type StoryAnswerResult,
} from '../lib/listeningApi';
import type { PublicSubtitleCue, SessionBlockInfo } from '../services/listening/execution/listening-execution-types';

// ── Types ─────────────────────────────────────────────────────────────────────

type Phase =
  | 'loading'
  | 'prompt'
  | 'generating'
  | 'selecting'
  | 'intro'
  | 'error'
  | 'ready_to_play'
  | 'playing'
  | 'paused'
  | 'marking'
  | 'question'
  | 'submitting'
  | 'correct'
  | 'wrong'
  | 'cycle_failed'
  | 'done';

type Speed = 0.75 | 0.90 | 1.00 | 1.10 | 1.25;
const SPEEDS: Speed[] = [0.75, 0.90, 1.00, 1.10, 1.25];


type SubtitleChoice = 'en' | 'pt-BR' | 'both';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}


// Deterministic color from speaker name
const SPEAKER_PALETTE = ['#c084fc', '#4ade80', '#f59e0b', '#60a5fa', '#f87171', '#34d399', '#fb923c', '#a78bfa'];
function getSpeakerColor(speaker: string | null | undefined): string {
  if (!speaker) return '#94a3b8';
  if (speaker.toLowerCase().includes('narrat')) return '#94a3b8';
  const hash = speaker.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return SPEAKER_PALETTE[hash % SPEAKER_PALETTE.length];
}

// ── Waveform ──────────────────────────────────────────────────────────────────

function Waveform({ playing }: { playing: boolean }) {
  const heights = [35, 60, 80, 55, 70, 45, 85, 50, 65, 40, 75, 55, 30, 70, 85, 50, 65, 45, 80, 55, 70, 40, 60, 75, 50, 35, 65, 55];
  return (
    <>
      <style>{`@keyframes bar-wave{0%,100%{transform:scaleY(1)}50%{transform:scaleY(0.2)}}`}</style>
      <div className="flex items-end justify-center gap-0.5 h-14 px-2">
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
              opacity: playing ? 0.7 + (i % 3) * 0.1 : 0.15,
              transition: 'opacity 0.4s',
            }}
          />
        ))}
      </div>
    </>
  );
}

// ── AutoAdvance countdown ─────────────────────────────────────────────────────

function AutoAdvanceBar({ durationMs, onDone }: { durationMs: number; onDone: () => void }) {
  const [pct, setPct] = useState(100);
  const startRef = useRef(Date.now());
  const cbRef = useRef(onDone);
  cbRef.current = onDone;

  useEffect(() => {
    startRef.current = Date.now();
    const raf = requestAnimationFrame(function tick() {
      const elapsed = Date.now() - startRef.current;
      const remaining = Math.max(0, 100 - (elapsed / durationMs) * 100);
      setPct(remaining);
      if (elapsed >= durationMs) {
        cbRef.current();
        return;
      }
      requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [durationMs]);

  return (
    <div className="h-0.5 bg-slate-700 rounded-full overflow-hidden mt-3">
      <div
        className="h-full bg-purple-500 rounded-full transition-none"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

const GENERATION_PROGRESS = [
  'Criando a história...',
  'Preparando o áudio...',
  'Quase pronto...',
];

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  onBack: () => void;
  episodeId?: string;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ListeningView({ onBack, episodeId: propEpisodeId }: Props) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [episodeId, setEpisodeId] = useState<string | null>(propEpisodeId ?? null);
  const [, setAssignmentId] = useState<string | null>(null);
  const [episodeData, setEpisodeData] = useState<EpisodeSessionResponse | null>(null);
  const [blockIdx, setBlockIdx] = useState<0 | 1>(0);
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [lastResult, setLastResult] = useState<SubmitAnswerResult | null>(null);
  const [speed, setSpeed] = useState<Speed>(1.00);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [episodes, setEpisodes] = useState<PublishedEpisode[]>([]);
  const [loadingEpisodes, setLoadingEpisodes] = useState(!propEpisodeId);
  const [listError, setListError] = useState(false);
  const [subtitleChoice, setSubtitleChoice] = useState<SubtitleChoice>('pt-BR');
  const [transcriptUnlocked, setTranscriptUnlocked] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [storyData, setStoryData] = useState<ListeningStoryData | null>(null);
  const [currentPartIdx, setCurrentPartIdx] = useState<0 | 1>(0);
  const [attemptsByPart, setAttemptsByPart] = useState<[number, number]>([0, 0]);
  const [showPartTranscript, setShowPartTranscript] = useState(false);
  const [storySelectedOption, setStorySelectedOption] = useState<number | null>(null);
  const [storyResult, setStoryResult] = useState<StoryAnswerResult | null>(null);
  const [storyGenerating, setStoryGenerating] = useState(false);
  const [storyMode, setStoryMode] = useState(false);
  const [progressMsgIdx, setProgressMsgIdx] = useState(0);

  const player = useListeningAudioPlayer();
  const urlRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrongTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Active block data ───────────────────────────────────────────────────────
  const block: SessionBlockInfo | null = episodeData?.blocks[blockIdx] ?? null;
  const session = block?.session ?? null;
  const subtitleMode = session?.subtitleMode ?? 'none';

  // Determine which cues to show based on mode and user choice
  const enCues: PublicSubtitleCue[] = block?.subtitles?.en ?? [];
  const ptCues: PublicSubtitleCue[] = block?.subtitles?.ptBr ?? [];

  const showEnSubs = subtitleMode !== 'none' && (subtitleMode === 'en' || subtitleChoice === 'en' || subtitleChoice === 'both');
  const showPtSubs = subtitleMode === 'pt-BR' && (subtitleChoice === 'pt-BR' || subtitleChoice === 'both');

  const isPlayerPhase = phase === 'ready_to_play' || phase === 'playing' || phase === 'paused' || phase === 'marking';
  const subtitlesActive = subtitleMode !== 'none' && (isPlayerPhase);

  const activeCueEn = useListeningSubtitles(enCues, player.audioRef, subtitlesActive && showEnSubs);
  const activeCuePt = useListeningSubtitles(ptCues, player.audioRef, subtitlesActive && showPtSubs);

  // Speaker for the active cue (prefer EN for speaker identification)
  const activeSpeaker = activeCueEn?.speaker ?? activeCuePt?.speaker ?? null;

  // ── Apply speed ─────────────────────────────────────────────────────────────
  const { setRate: playerSetRate } = player;
  useEffect(() => { playerSetRate(speed); }, [speed, playerSetRate]);

  // ── Progress messages cycling during story generation ────────────────────────
  useEffect(() => {
    if (phase !== 'generating') return;
    setProgressMsgIdx(0);
    const id = setInterval(() => setProgressMsgIdx(i => (i + 1) % GENERATION_PROGRESS.length), 3500);
    return () => clearInterval(id);
  }, [phase]);

  // ── Load session ────────────────────────────────────────────────────────────
  async function loadSession(epId: string, skipIntro = false) {
    setPhase('loading');
    setSelectedOption(null);
    setLastResult(null);
    try {
      const data = await getEpisodeSession(epId);
      setEpisodeData(data);

      if (data.progress?.completedAt) {
        setTranscriptUnlocked(true);
        setPhase('done');
        return;
      }

      const idx = data.blocks.findIndex(b => !b.completed && !b.locked);
      if (idx === -1) {
        setTranscriptUnlocked(true);
        setPhase('done');
        return;
      }

      const activeBlock = data.blocks[idx as 0 | 1];
      if (!activeBlock) {
        setErrorMsg('Dados do episódio incompletos.');
        setPhase('error');
        return;
      }
      setBlockIdx(idx as 0 | 1);

      const sess = activeBlock.session;
      if (!sess || !activeBlock.audio) {
        setErrorMsg('Dados do episódio incompletos.');
        setPhase('error');
        return;
      }

      player.load(activeBlock.audio.url, activeBlock.audio.durationMs);
      scheduleUrlRefresh(sess.sessionId, activeBlock.audio.expiresAt);
      player.setOnEnded(() => handleAudioEnded(sess.sessionId));

      if (sess.status === 'awaiting_answer') {
        setPhase('question');
      } else {
        setPhase(skipIntro ? 'ready_to_play' : 'intro');
      }
    } catch (err) {
      const msg = err instanceof ListeningApiError ? err.message : 'Erro ao carregar episódio.';
      setErrorMsg(msg);
      setPhase('error');
    }
  }

  async function handleAudioEnded(sessionId: string) {
    setPhase('marking');
    try {
      await markPlaybackCompleted(sessionId);
    } catch {
      // idempotent on backend
    }
    setPhase('question');
  }

  const { setOnEnded: playerSetOnEnded } = player;
  useEffect(() => {
    if (!session?.sessionId) return;
    const sid = session.sessionId;
    playerSetOnEnded(() => handleAudioEnded(sid));
  }, [session?.sessionId, playerSetOnEnded]);

  useEffect(() => {
    if (propEpisodeId) {
      loadSession(propEpisodeId);
    } else {
      loadTodaySession();
    }
  }, []); // only on mount

  async function loadTodaySession() {
    setPhase('loading');
    try {
      const result = await getTodayListening();
      if (result.status === 'empty_inventory') {
        setStoryMode(true);
        setPhase('prompt');
        return;
      }
      setAssignmentId(result.assignmentId);
      setEpisodeId(result.episodeId);
      setEpisodeData(result.session);

      const data = result.session;
      if (data.progress?.completedAt) {
        setTranscriptUnlocked(true);
        setPhase('done');
        return;
      }
      const idx = data.blocks.findIndex((b: any) => !b.completed && !b.locked);
      if (idx === -1) {
        setTranscriptUnlocked(true);
        setPhase('done');
        return;
      }
      const activeBlock = data.blocks[idx as 0 | 1];
      if (!activeBlock || !activeBlock.session || !activeBlock.audio) {
        setErrorMsg('Dados do episódio incompletos.');
        setPhase('error');
        return;
      }
      setBlockIdx(idx as 0 | 1);
      const sess = activeBlock.session;
      player.load(activeBlock.audio.url, activeBlock.audio.durationMs);
      scheduleUrlRefresh(sess.sessionId, activeBlock.audio.expiresAt);
      player.setOnEnded(() => handleAudioEnded(sess.sessionId));
      if (sess.status === 'awaiting_answer') {
        setPhase('question');
      } else {
        setPhase('intro');
      }
    } catch (err) {
      const msg = err instanceof ListeningApiError ? err.message : 'Erro ao carregar listening do dia.';
      setErrorMsg(msg);
      setPhase('error');
    }
  }

  async function handleStartGeneration() {
    if (storyGenerating) return;
    setStoryGenerating(true);
    setStoryData(null);
    setStoryResult(null);
    setCurrentPartIdx(0);
    setAttemptsByPart([0, 0]);
    setShowPartTranscript(false);
    setStorySelectedOption(null);
    setPhase('generating');
    try {
      const data = await generateListeningStory();
      setStoryData(data);
      player.load(data.parts[0].audioUrl);
      player.setOnEnded(() => setPhase('question'));
      setPhase('intro');
    } catch (err) {
      if (err instanceof ListeningApiError) {
        console.error('[listening] generation failed', { status: err.status, code: err.code });
      } else {
        console.error('[listening] generation failed', err);
      }
      setErrorMsg('Não conseguimos preparar sua história. Tente novamente.');
      setPhase('error');
    } finally {
      setStoryGenerating(false);
    }
  }

  function handleStoryAdvance() {
    if (!storyData) return;
    const part2 = storyData.parts[1];
    player.load(part2.audioUrl);
    player.setOnEnded(() => setPhase('question'));
    setCurrentPartIdx(1);
    setStorySelectedOption(null);
    setShowPartTranscript(false);
    setStoryResult(null);
    setPhase('ready_to_play');
  }

  async function handleStorySubmit() {
    if (storySelectedOption === null || !storyData || phase === 'submitting') return;
    const part = storyData.parts[currentPartIdx];
    setPhase('submitting');
    try {
      const result = await verifyStoryAnswer({
        answerToken: part.answerToken,
        selectedOption: storySelectedOption,
      });
      setStoryResult(result);

      if (result.correct) {
        if (currentPartIdx === 0) {
          setPhase('correct'); // show success + "Continuar para a Parte 2" button
        } else {
          setPhase('done');
        }
        return;
      }

      // Wrong answer
      const curAttempts = attemptsByPart[currentPartIdx];
      const newCount = curAttempts + 1;
      const newAttempts: [number, number] = [
        currentPartIdx === 0 ? newCount : attemptsByPart[0],
        currentPartIdx === 1 ? newCount : attemptsByPart[1],
      ];
      setAttemptsByPart(newAttempts);

      if (newCount >= 2) {
        // Second wrong: show correct answer then allow advancing
        setPhase('cycle_failed');
      } else {
        // First wrong: show transcript + replay same part
        setShowPartTranscript(true);
        setStorySelectedOption(null);
        player.setOnEnded(() => setPhase('question'));
        player.restart();
        setPhase('playing');
      }
    } catch (err) {
      if (err instanceof ListeningApiError) {
        console.error('[listening] verify failed', { status: err.status, code: err.code });
      } else {
        console.error('[listening] verify failed', err);
      }
      setErrorMsg('Erro ao verificar resposta. Tente novamente.');
      setPhase('error');
    }
  }

  async function loadEpisodeList() {
    setLoadingEpisodes(true);
    setListError(false);
    setPhase('selecting');
    try {
      const list = await getPublishedEpisodes();
      if (list.length === 1) {
        setEpisodeId(list[0].id);
      } else {
        setEpisodes(list);
      }
    } catch {
      setListError(true);
      setEpisodes([]);
    } finally {
      setLoadingEpisodes(false);
    }
  }

  // ── URL refresh ─────────────────────────────────────────────────────────────
  function scheduleUrlRefresh(sessionId: string, expiresAt: string) {
    if (urlRefreshTimerRef.current) clearTimeout(urlRefreshTimerRef.current);
    const msLeft = new Date(expiresAt).getTime() - Date.now() - 5 * 60 * 1000;
    if (msLeft <= 0) { doUrlRefresh(sessionId, expiresAt); return; }
    urlRefreshTimerRef.current = setTimeout(() => doUrlRefresh(sessionId, expiresAt), msLeft);
  }

  async function doUrlRefresh(sessionId: string, _prev: string) {
    try {
      const info = await refreshAudioUrl(sessionId);
      player.updateUrl(info.url);
      scheduleUrlRefresh(sessionId, info.expiresAt);
    } catch { /* silent */ }
  }

  // ── Submit answer ───────────────────────────────────────────────────────────
  async function handleSubmit() {
    if (selectedOption === null || !session || !block) return;
    setPhase('submitting');
    try {
      const result = await submitAnswer({
        sessionId: session.sessionId,
        questionId: block.question!.id,
        selectedOption,
        submissionId: crypto.randomUUID(),
        playbackRate: speed,
      });
      setLastResult(result);
      if (result.correct) {
        if (result.episodeCompleted) {
          setTranscriptUnlocked(true);
          setPhase('done');
        } else {
          setPhase('correct');
        }
      } else if (result.sessionStatus === 'abandoned') {
        setPhase('cycle_failed');
      } else {
        setPhase('wrong');
        wrongTimerRef.current = setTimeout(() => {
          if (episodeId) loadSession(episodeId, true);
        }, 2500);
      }
    } catch (err) {
      const msg = err instanceof ListeningApiError ? err.message : 'Erro ao enviar resposta.';
      setErrorMsg(msg);
      setPhase('error');
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (urlRefreshTimerRef.current) clearTimeout(urlRefreshTimerRef.current);
      if (wrongTimerRef.current) clearTimeout(wrongTimerRef.current);
    };
  }, []);

  // ── Play ────────────────────────────────────────────────────────────────────
  async function handlePlay() {
    setPhase('playing');
    await player.play();
  }

  // ── Derived ─────────────────────────────────────────────────────────────────
  const { currentTimeMs, durationMs } = player.state;
  const pct = durationMs > 0 ? Math.min((currentTimeMs / durationMs) * 100, 100) : 0;

  // ── Full transcript text (all blocks, en cues) ───────────────────────────────
  const transcriptLines = useMemo(() => {
    if (!episodeData) return [];
    const lines: Array<{ speaker: string | null; text: string; lang: 'en' | 'pt' }> = [];
    for (const b of episodeData.blocks) {
      for (const cue of b.subtitles?.en ?? []) {
        lines.push({ speaker: cue.speaker ?? null, text: cue.text, lang: 'en' });
      }
    }
    return lines;
  }, [episodeData]);

  // ── Render: header ───────────────────────────────────────────────────────────
  function renderHeader() {
    return (
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800 sticky top-0 bg-slate-900/95 backdrop-blur z-10">
        <button
          onClick={onBack}
          className="p-2 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
          aria-label="Voltar"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-200 truncate">
            {episodeData?.title ?? 'Listening'}
          </p>
        </div>
        {episodeData && (
          <span className="text-xs font-semibold text-purple-400 shrink-0 px-2 py-0.5 rounded-full bg-purple-600/15 border border-purple-500/20">
            {episodeData.cefrLevel}
          </span>
        )}
      </div>
    );
  }

  // ── Render: loading ──────────────────────────────────────────────────────────
  function renderLoading() {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <div className="w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-slate-500 text-sm">Carregando...</p>
      </div>
    );
  }

  // ── Render: error ────────────────────────────────────────────────────────────
  function renderError() {
    const retryFn = storyMode
      ? handleStartGeneration
      : episodeId
      ? () => loadSession(episodeId)
      : propEpisodeId
      ? undefined
      : loadTodaySession;
    return (
      <div className="p-6 max-w-lg mx-auto text-center pt-10">
        <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
        <p className="text-sm text-slate-400 mb-6">{errorMsg || 'Erro ao carregar.'}</p>
        {retryFn && (
          <button
            onClick={retryFn}
            className="w-full py-3 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold transition-colors"
          >
            Tentar novamente
          </button>
        )}
      </div>
    );
  }

  // ── Render: prompt ───────────────────────────────────────────────────────────
  function renderPrompt() {
    return (
      <div className="p-6 max-w-lg mx-auto pt-10 space-y-6">
        <div className="bg-slate-800 border border-slate-700 rounded-2xl p-8 text-center space-y-5">
          <div className="w-20 h-20 rounded-full bg-purple-600/20 border-2 border-purple-500/30 flex items-center justify-center mx-auto">
            <Headphones className="w-10 h-10 text-purple-400" />
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-bold text-slate-100">Listening de hoje</h2>
            <p className="text-sm text-slate-400 leading-relaxed">
              Uma nova história será criada especialmente para o seu nível.
            </p>
          </div>
          <button
            onClick={handleStartGeneration}
            disabled={storyGenerating}
            className="w-full py-4 rounded-xl bg-purple-600 hover:bg-purple-500 active:bg-purple-700 disabled:opacity-60 text-white font-semibold text-base transition-colors shadow-lg shadow-purple-900/30 flex items-center justify-center gap-2"
          >
            {storyGenerating ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                Iniciando...
              </>
            ) : (
              <>
                <Headphones className="w-5 h-5" />
                Preparar minha história
              </>
            )}
          </button>
        </div>
      </div>
    );
  }

  // ── Render: generating ───────────────────────────────────────────────────────
  function renderGenerating() {
    const msg = GENERATION_PROGRESS[progressMsgIdx];
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-5">
        <div className="w-14 h-14 rounded-full bg-purple-600/20 border border-purple-500/30 flex items-center justify-center">
          <Loader2 className="w-7 h-7 text-purple-400 animate-spin" />
        </div>
        <div className="text-center space-y-1.5">
          <p className="text-sm font-semibold text-slate-200 transition-all">{msg}</p>
          <p className="text-xs text-slate-500">Isso pode levar até 1 minuto.</p>
        </div>
        <div className="flex gap-1.5 mt-1">
          {GENERATION_PROGRESS.map((_, i) => (
            <div
              key={i}
              className={`w-1.5 h-1.5 rounded-full transition-colors duration-500 ${
                i === progressMsgIdx ? 'bg-purple-400' : 'bg-slate-700'
              }`}
            />
          ))}
        </div>
      </div>
    );
  }

  // ── Render: selecting ────────────────────────────────────────────────────────
  function renderSelecting() {
    if (loadingEpisodes) {
      return (
        <div className="p-4 pt-6 max-w-lg mx-auto space-y-3">
          {[0, 1].map(i => (
            <div key={i} className="bg-slate-800 border border-slate-700 rounded-2xl p-5 animate-pulse">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-slate-700 shrink-0" />
                <div className="flex-1 space-y-2.5">
                  <div className="h-3.5 bg-slate-700 rounded w-2/3" />
                  <div className="h-3 bg-slate-700 rounded w-full" />
                  <div className="h-3 bg-slate-700 rounded w-4/5" />
                  <div className="flex gap-2 pt-1">
                    <div className="h-5 w-10 bg-slate-700 rounded-full" />
                    <div className="h-5 w-16 bg-slate-700 rounded-full" />
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      );
    }

    if (listError) {
      return (
        <div className="p-6 max-w-lg mx-auto pt-8 space-y-5">
          <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6 text-center space-y-4">
            <div className="w-14 h-14 rounded-full bg-red-900/20 border border-red-700/30 flex items-center justify-center mx-auto">
              <AlertCircle className="w-7 h-7 text-red-400" />
            </div>
            <div>
              <p className="font-semibold text-slate-200">Não foi possível carregar o Listening.</p>
              <p className="text-sm text-slate-500 mt-1.5 leading-relaxed">Verifique sua conexão e tente novamente.</p>
            </div>
            <button
              onClick={loadEpisodeList}
              className="w-full py-3 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold transition-colors flex items-center justify-center gap-2"
            >
              <RefreshCw className="w-4 h-4" />
              Tentar novamente
            </button>
          </div>
        </div>
      );
    }

    if (episodes.length === 0) {
      return (
        <div className="p-6 max-w-lg mx-auto pt-8 space-y-5">
          <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6 text-center space-y-5">
            <div className="w-16 h-16 rounded-full bg-purple-600/15 border border-purple-500/25 flex items-center justify-center mx-auto">
              <Headphones className="w-8 h-8 text-purple-400/70" />
            </div>
            <div>
              <p className="font-semibold text-slate-100">Seu próximo Listening está sendo preparado</p>
              <p className="text-sm text-slate-500 mt-2 leading-relaxed">
                Ainda não há um episódio disponível para o seu nível.
                <br />
                Tente novamente em alguns instantes.
              </p>
            </div>
            <button
              onClick={propEpisodeId ? loadEpisodeList : loadTodaySession}
              className="w-full py-3 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-200 font-medium transition-colors"
            >
              Tentar novamente
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="p-4 pt-6 max-w-lg mx-auto space-y-3">
        {episodes.map(ep => (
          <button
            key={ep.id}
            onClick={() => setEpisodeId(ep.id)}
            className="w-full text-left bg-slate-800 border border-slate-700 hover:border-purple-500/60 rounded-2xl p-5 transition-all group"
          >
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-purple-600/20 border border-purple-500/30 flex items-center justify-center shrink-0 mt-0.5 group-hover:bg-purple-600/30 transition-colors">
                <Headphones className="w-5 h-5 text-purple-400" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold text-slate-100 mb-1 leading-snug">{ep.title}</h3>
                {ep.synopsis && (
                  <p className="text-xs text-slate-500 leading-relaxed line-clamp-2 mb-2">{ep.synopsis}</p>
                )}
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-purple-300 px-2 py-0.5 rounded-full bg-purple-600/15 border border-purple-500/20">
                    {ep.cefrLevel}
                  </span>
                  {ep.estimatedDurationSeconds > 0 && (
                    <span className="flex items-center gap-1 text-xs text-slate-500">
                      <Clock className="w-3 h-3" />
                      {Math.round(ep.estimatedDurationSeconds / 60)} min
                    </span>
                  )}
                </div>
              </div>
            </div>
          </button>
        ))}
      </div>
    );
  }

  // ── Render: intro ────────────────────────────────────────────────────────────
  function renderIntro() {
    if (storyData) {
      return (
        <div className="p-5 max-w-lg mx-auto space-y-5 pt-6">
          <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6 space-y-5">
            <div className="space-y-2">
              <h2 className="text-xl font-bold text-slate-100 leading-snug">{storyData.title}</h2>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-purple-300 px-2.5 py-1 rounded-full bg-purple-600/20 border border-purple-500/30">
                  {storyData.level}
                </span>
                <span className="flex items-center gap-1.5 text-xs text-slate-500 px-2.5 py-1 rounded-full bg-slate-700/60 border border-slate-600/40">
                  2 partes
                </span>
                <span className="flex items-center gap-1.5 text-xs text-slate-500 px-2.5 py-1 rounded-full bg-slate-700/60 border border-slate-600/40">
                  <Clock className="w-3 h-3" />
                  ~10 min
                </span>
              </div>
            </div>
            {storyData.summary && (
              <div className="border-t border-slate-700 pt-4">
                <p className="text-sm text-slate-300 leading-relaxed">{storyData.summary}</p>
              </div>
            )}
            <div className="border-t border-slate-700 pt-4 space-y-2">
              <p className="text-xs text-slate-500 font-medium uppercase tracking-wide">Como funciona</p>
              <ul className="space-y-1.5 text-xs text-slate-400">
                <li className="flex items-start gap-2">
                  <span className="text-purple-400 mt-0.5">•</span>
                  Ouça cada parte e responda uma pergunta de compreensão
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-purple-400 mt-0.5">•</span>
                  Após um erro, o texto aparece e você reouve a mesma parte
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-purple-400 mt-0.5">•</span>
                  Após dois erros, a resposta correta é revelada
                </li>
              </ul>
            </div>
          </div>
          <button
            onClick={() => setPhase('ready_to_play')}
            className="w-full py-4 rounded-2xl bg-purple-600 hover:bg-purple-500 active:bg-purple-700 text-white font-semibold text-base transition-colors shadow-lg shadow-purple-900/30 flex items-center justify-center gap-2"
          >
            <Headphones className="w-5 h-5" />
            Começar a ouvir
          </button>
        </div>
      );
    }

    const ep = episodeData;
    if (!ep) return null;
    const durationMin = ep.actualDurationSeconds
      ? Math.ceil(ep.actualDurationSeconds / 60)
      : ep.estimatedDurationSeconds
      ? Math.ceil(ep.estimatedDurationSeconds / 60)
      : null;

    return (
      <div className="p-5 max-w-lg mx-auto space-y-5 pt-6">
        {/* Episode card */}
        <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6 space-y-5">
          {/* Title */}
          <div className="space-y-2">
            <h2 className="text-xl font-bold text-slate-100 leading-snug">{ep.title}</h2>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-purple-300 px-2.5 py-1 rounded-full bg-purple-600/20 border border-purple-500/30">
                {ep.cefrLevel}
              </span>
              {durationMin && (
                <span className="flex items-center gap-1.5 text-xs text-slate-500 px-2.5 py-1 rounded-full bg-slate-700/60 border border-slate-600/40">
                  <Clock className="w-3 h-3" />
                  {durationMin} min
                </span>
              )}
              <span className="flex items-center gap-1.5 text-xs text-slate-500 px-2.5 py-1 rounded-full bg-slate-700/60 border border-slate-600/40">
                2 perguntas
              </span>
            </div>
          </div>

          {/* Synopsis */}
          {ep.synopsis ? (
            <div className="border-t border-slate-700 pt-4">
              <p className="text-sm text-slate-300 leading-relaxed">{ep.synopsis}</p>
            </div>
          ) : null}

          {/* What to expect */}
          <div className="border-t border-slate-700 pt-4 space-y-2">
            <p className="text-xs text-slate-500 font-medium uppercase tracking-wide">Como funciona</p>
            <ul className="space-y-1.5 text-xs text-slate-400">
              <li className="flex items-start gap-2">
                <span className="text-purple-400 mt-0.5">•</span>
                Ouça a história e responda uma pergunta de compreensão por bloco
              </li>
              <li className="flex items-start gap-2">
                <span className="text-purple-400 mt-0.5">•</span>
                Se errar, você poderá ouvir novamente — com legendas
              </li>
            </ul>
          </div>
        </div>

        <button
          onClick={() => setPhase('ready_to_play')}
          className="w-full py-4 rounded-2xl bg-purple-600 hover:bg-purple-500 active:bg-purple-700 text-white font-semibold text-base transition-colors shadow-lg shadow-purple-900/30 flex items-center justify-center gap-2"
        >
          <Headphones className="w-5 h-5" />
          Começar a ouvir
        </button>
      </div>
    );
  }

  // ── Render: subtitle area ─────────────────────────────────────────────────────
  function renderSubtitleArea() {
    if (subtitleMode === 'none') return null;
    const hasCue = activeCueEn || activeCuePt;
    const color = getSpeakerColor(activeSpeaker);

    return (
      <div className="mt-4 pt-4 border-t border-slate-700 min-h-[68px]">
        {/* Subtitle choice (attempt 3 only) */}
        {subtitleMode === 'pt-BR' && (
          <div className="flex gap-1.5 mb-3">
            {(['en', 'pt-BR', 'both'] as SubtitleChoice[]).map(c => (
              <button
                key={c}
                onClick={() => setSubtitleChoice(c)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                  subtitleChoice === c
                    ? 'bg-purple-600/40 border border-purple-500/50 text-purple-300'
                    : 'bg-slate-700/50 border border-slate-600/30 text-slate-500 hover:text-slate-300'
                }`}
              >
                {c === 'en' ? 'Inglês' : c === 'pt-BR' ? 'Português' : 'Ambos'}
              </button>
            ))}
          </div>
        )}

        {/* Active cue(s) */}
        {hasCue ? (
          <div className="space-y-1.5">
            {activeSpeaker && (
              <div className="flex items-center gap-1.5">
                <div className="w-1 h-3 rounded-full shrink-0" style={{ background: color }} />
                <span className="text-xs font-medium" style={{ color }}>{activeSpeaker}</span>
              </div>
            )}
            {activeCueEn && showEnSubs && (
              <p className="text-sm text-slate-100 leading-relaxed">{activeCueEn.text}</p>
            )}
            {activeCuePt && showPtSubs && (
              <p className={`text-sm leading-relaxed ${showEnSubs ? 'text-slate-400' : 'text-slate-100'}`}>
                {activeCuePt.text}
              </p>
            )}
          </div>
        ) : (
          phase === 'playing' && (
            <p className="text-xs text-slate-600 italic">Aguardando...</p>
          )
        )}
      </div>
    );
  }

  // ── Render: player ────────────────────────────────────────────────────────────
  function renderPlayer() {
    const playing = phase === 'playing';
    const isMarking = phase === 'marking';
    const isReady = phase === 'ready_to_play';

    return (
      <div className="p-4 pt-3 max-w-lg mx-auto space-y-4">
        {/* Block + attempt context */}
        {storyData ? (
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500 font-medium">Parte {currentPartIdx + 1} de 2</span>
            {showPartTranscript && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-amber-900/30 border border-amber-700/30 text-amber-400 font-medium">
                Reouvindo com legenda
              </span>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500 font-medium">Bloco {blockIdx + 1} de 2</span>
            {session && session.currentAttempt > 1 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-amber-900/30 border border-amber-700/30 text-amber-400 font-medium">
                Tentativa {session.currentAttempt}/3
              </span>
            )}
          </div>
        )}

        {/* Waveform + progress + subtitles */}
        <div className="bg-slate-800 border border-slate-700 rounded-2xl py-5 px-4">
          <Waveform playing={playing} />

          <div className="mt-3">
            <div className="h-1 bg-slate-700 rounded-full overflow-hidden mb-1.5">
              <div
                className="h-full bg-purple-500 rounded-full transition-all duration-100"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-slate-600">
              <span>{fmtMs(currentTimeMs)}</span>
              <span>{durationMs > 0 ? fmtMs(durationMs) : '--:--'}</span>
            </div>
          </div>

          {renderSubtitleArea()}
        </div>

        {/* Controls */}
        {isMarking ? (
          <div className="flex items-center justify-center py-2 gap-2 text-slate-500">
            <div className="w-4 h-4 border-2 border-slate-600 border-t-purple-500 rounded-full animate-spin" />
            <span className="text-xs">Processando...</span>
          </div>
        ) : (
          <div className="flex items-center justify-center gap-6">
            {/* Back 10s */}
            <button
              onClick={() => player.seekBack(10)}
              className="flex flex-col items-center gap-1 text-slate-400 hover:text-slate-200 transition-colors"
              title="Voltar 10 segundos"
            >
              <div className="w-10 h-10 rounded-full bg-slate-800 hover:bg-slate-700 flex items-center justify-center transition-colors relative">
                <Rewind className="w-4 h-4" />
                <span className="absolute bottom-0.5 right-0 text-[9px] font-bold text-slate-400 leading-none">10</span>
              </div>
              <span className="text-xs text-slate-600">-10s</span>
            </button>

            {/* Play / Pause */}
            {isReady || !playing ? (
              <button
                onClick={handlePlay}
                className="w-16 h-16 rounded-full bg-purple-600 hover:bg-purple-500 active:bg-purple-700 text-white flex items-center justify-center transition-colors shadow-lg shadow-purple-900/40"
                aria-label="Reproduzir"
              >
                <Play className="w-7 h-7 translate-x-0.5" />
              </button>
            ) : (
              <button
                onClick={() => { player.pause(); setPhase('paused'); }}
                className="w-16 h-16 rounded-full bg-purple-600 hover:bg-purple-500 active:bg-purple-700 text-white flex items-center justify-center transition-colors shadow-lg shadow-purple-900/40"
                aria-label="Pausar"
              >
                <Pause className="w-7 h-7" />
              </button>
            )}

            {/* Replay block */}
            <button
              onClick={() => { player.restart(); setPhase('ready_to_play'); }}
              className="flex flex-col items-center gap-1 text-slate-400 hover:text-slate-200 transition-colors"
              title="Reouvir bloco"
            >
              <div className="w-10 h-10 rounded-full bg-slate-800 hover:bg-slate-700 flex items-center justify-center transition-colors">
                <RotateCcw className="w-4 h-4" />
              </div>
              <span className="text-xs text-slate-600">Reouvir</span>
            </button>
          </div>
        )}

        {/* Speed */}
        <div className="flex items-center justify-center gap-2">
          {SPEEDS.map(s => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors min-w-[44px] ${
                speed === s
                  ? 'bg-purple-600 text-white'
                  : 'bg-slate-800 text-slate-500 hover:bg-slate-700 hover:text-slate-300'
              }`}
            >
              {s === 1.00 ? '1×' : `${s}×`}
            </button>
          ))}
        </div>

        {/* Story transcript (shown after first wrong answer) */}
        {storyData && showPartTranscript && (
          <div className="bg-slate-800/60 border border-amber-700/20 rounded-xl p-4 space-y-2">
            <p className="text-xs text-amber-400/80 font-medium uppercase tracking-wide">
              Texto — Parte {currentPartIdx + 1}
            </p>
            <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-line">
              {storyData.parts[currentPartIdx].text}
            </p>
          </div>
        )}

        {/* Transcript button */}
        {!storyData && (
          <button
            onClick={() => transcriptUnlocked && setShowTranscript(true)}
            disabled={!transcriptUnlocked}
            className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border text-xs font-medium transition-colors ${
              transcriptUnlocked
                ? 'border-slate-600 text-slate-300 hover:bg-slate-800 hover:border-slate-500'
                : 'border-slate-700/50 text-slate-600 cursor-not-allowed'
            }`}
          >
            {transcriptUnlocked ? (
              <ScrollText className="w-3.5 h-3.5" />
            ) : (
              <Lock className="w-3.5 h-3.5" />
            )}
            {transcriptUnlocked ? 'Transcrição' : 'Disponível ao concluir a atividade'}
          </button>
        )}
      </div>
    );
  }

  // ── Render: question ──────────────────────────────────────────────────────────
  function renderQuestion() {
    if (storyData) {
      const part = storyData.parts[currentPartIdx];
      const q = part.question;
      const isSubmitting = phase === 'submitting';
      const curAttempts = attemptsByPart[currentPartIdx];

      return (
        <div className="p-4 pt-4 max-w-lg mx-auto space-y-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-purple-400 font-medium">Parte {currentPartIdx + 1} de 2</span>
            {curAttempts > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-amber-900/30 border border-amber-700/30 text-amber-400">
                Tentativa {curAttempts + 1} de 2
              </span>
            )}
          </div>

          <h3 className="text-base font-semibold text-slate-100 leading-snug">{q.prompt}</h3>

          <div className="space-y-3">
            {q.options.map((opt: string, i: number) => {
              const isSelected = storySelectedOption === i;
              return (
                <button
                  key={i}
                  onClick={() => !isSubmitting && setStorySelectedOption(i)}
                  disabled={isSubmitting}
                  className={`w-full text-left px-4 py-3.5 rounded-xl border text-sm transition-all ${
                    isSelected
                      ? 'bg-purple-700/25 border-purple-500 text-slate-100'
                      : 'bg-slate-800 border-slate-700 hover:border-purple-500/50 hover:bg-slate-700/50 text-slate-200'
                  } ${isSubmitting ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <span className="font-bold text-purple-400 mr-2">{String.fromCharCode(65 + i)}.</span>
                  {opt}
                </button>
              );
            })}
          </div>

          <button
            onClick={handleStorySubmit}
            disabled={storySelectedOption === null || isSubmitting}
            className="w-full py-4 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold transition-colors flex items-center justify-center gap-2"
          >
            {isSubmitting ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Verificando...
              </>
            ) : (
              'Confirmar resposta'
            )}
          </button>

          <button
            onClick={() => { player.restart(); setPhase('ready_to_play'); }}
            className="w-full py-2.5 text-xs text-slate-600 hover:text-slate-400 transition-colors"
          >
            Ouvir novamente
          </button>

          {showPartTranscript && (
            <div className="pt-2 border-t border-slate-700">
              <div className="bg-slate-800/60 border border-amber-700/20 rounded-xl p-4">
                <p className="text-xs text-amber-400/80 font-medium mb-2 uppercase tracking-wide">
                  Texto — Parte {currentPartIdx + 1}
                </p>
                <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-line">{part.text}</p>
              </div>
            </div>
          )}
        </div>
      );
    }

    const q = block?.question;
    if (!q) return null;
    const isSubmitting = phase === 'submitting';

    return (
      <div className="p-4 pt-4 max-w-lg mx-auto">
        <div className="flex items-center gap-2 mb-4">
          <span className="text-xs text-purple-400 font-medium">Bloco {blockIdx + 1}/2</span>
          {session && session.currentAttempt > 1 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-900/30 border border-amber-700/30 text-amber-400">
              Tentativa {session.currentAttempt}/3
            </span>
          )}
        </div>

        <h3 className="text-base font-semibold text-slate-100 leading-snug mb-5">{q.prompt}</h3>

        <div className="space-y-3 mb-5">
          {q.options.map((opt, i) => {
            const isSelected = selectedOption === i;
            return (
              <button
                key={i}
                onClick={() => !isSubmitting && setSelectedOption(i)}
                disabled={isSubmitting}
                className={`w-full text-left px-4 py-3.5 rounded-xl border text-sm transition-all ${
                  isSelected
                    ? 'bg-purple-700/25 border-purple-500 text-slate-100'
                    : 'bg-slate-800 border-slate-700 hover:border-purple-500/50 hover:bg-slate-700/50 text-slate-200'
                } ${isSubmitting ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <span className="font-bold text-purple-400 mr-2">{String.fromCharCode(65 + i)}.</span>
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
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Verificando...
            </>
          ) : (
            'Confirmar resposta'
          )}
        </button>

        <button
          onClick={() => setPhase(player.state.isEnded ? 'ready_to_play' : 'paused')}
          className="w-full mt-2 py-2.5 text-xs text-slate-600 hover:text-slate-400 transition-colors"
        >
          Ouvir novamente
        </button>
      </div>
    );
  }

  // ── Render: correct ──────────────────────────────────────────────────────────
  function renderCorrect() {
    if (storyData) {
      return (
        <div className="p-6 max-w-lg mx-auto pt-8 space-y-5">
          <div className="text-center space-y-3">
            <div className="w-14 h-14 rounded-full bg-emerald-900/40 border border-emerald-600/40 flex items-center justify-center mx-auto">
              <Check className="w-7 h-7 text-emerald-400" />
            </div>
            <div>
              <p className="text-lg font-bold text-emerald-300">Correto!</p>
              <p className="text-sm text-slate-400 mt-0.5">Parte 1 concluída.</p>
            </div>
          </div>

          {storyResult?.explanationPt && (
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
              <p className="text-xs text-slate-500 font-medium mb-1.5">Explicação</p>
              <p className="text-sm text-slate-300 leading-relaxed">{storyResult.explanationPt}</p>
            </div>
          )}

          <button
            onClick={handleStoryAdvance}
            className="w-full py-4 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold transition-colors flex items-center justify-center gap-2"
          >
            <Headphones className="w-5 h-5" />
            Continuar para a Parte 2
          </button>
        </div>
      );
    }

    const explanation = lastResult?.explanationPt;
    const advance = () => {
      if (lastResult?.episodeCompleted || blockIdx === 1) {
        setTranscriptUnlocked(true);
        setPhase('done');
      } else if (episodeId) {
        loadSession(episodeId, true);
      }
    };

    return (
      <div className="p-6 max-w-lg mx-auto pt-8 space-y-5">
        <div className="text-center space-y-3">
          <div className="w-14 h-14 rounded-full bg-emerald-900/40 border border-emerald-600/40 flex items-center justify-center mx-auto">
            <Check className="w-7 h-7 text-emerald-400" />
          </div>
          <div>
            <p className="text-lg font-bold text-emerald-300">Correto!</p>
            <p className="text-sm text-slate-400 mt-0.5">
              {blockIdx === 0 ? 'Bloco 1 concluído.' : 'Episódio concluído!'}
            </p>
          </div>
        </div>

        {explanation && (
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
            <p className="text-xs text-slate-500 font-medium mb-1.5">Explicação</p>
            <p className="text-sm text-slate-300 leading-relaxed">{explanation}</p>
          </div>
        )}

        <AutoAdvanceBar durationMs={3500} onDone={advance} />
        <p className="text-xs text-slate-600 text-center">Continuando automaticamente...</p>
      </div>
    );
  }

  // ── Render: wrong ────────────────────────────────────────────────────────────
  function renderWrong() {
    const nextMode = lastResult?.nextSubtitleMode;
    return (
      <div className="p-6 max-w-lg mx-auto text-center pt-8 space-y-4">
        <div className="w-14 h-14 rounded-full bg-red-900/40 border border-red-600/40 flex items-center justify-center mx-auto">
          <X className="w-7 h-7 text-red-400" />
        </div>
        <div>
          <p className="text-lg font-bold text-red-300">Incorreto</p>
          <p className="text-sm text-slate-400 mt-1">
            {nextMode === 'en' && 'Ouça novamente — desta vez com legendas em inglês.'}
            {nextMode === 'pt-BR' && 'Ouça novamente — desta vez com legendas.'}
            {!nextMode && 'Ouça novamente.'}
          </p>
        </div>
        <div className="flex items-center justify-center gap-2 text-xs text-slate-600">
          <div className="w-3.5 h-3.5 border-2 border-slate-700 border-t-purple-600 rounded-full animate-spin" />
          Preparando...
        </div>
      </div>
    );
  }

  // ── Render: cycle_failed ──────────────────────────────────────────────────────
  function renderCycleFailed() {
    if (storyData) {
      const part = storyData.parts[currentPartIdx];
      const correctIndex = storyResult?.correctOption ?? null;
      const isLastPart = currentPartIdx === 1;

      const advance = () => {
        if (isLastPart) {
          setPhase('done');
        } else {
          handleStoryAdvance();
        }
      };

      return (
        <div className="p-4 pt-6 max-w-lg mx-auto space-y-4">
          <div className="flex items-center gap-3 p-4 rounded-xl bg-red-900/20 border border-red-700/30">
            <AlertCircle className="w-5 h-5 text-red-400 shrink-0" />
            <div>
              <p className="font-semibold text-sm text-red-300">Duas tentativas usadas</p>
              <p className="text-xs text-slate-500 mt-0.5">Parte {currentPartIdx + 1} de 2.</p>
            </div>
          </div>

          {correctIndex !== null && (
            <div className="space-y-2">
              <p className="text-xs text-slate-500 font-medium">Resposta correta:</p>
              {part.question.options.map((opt: string, i: number) => {
                const isCorrect = i === correctIndex;
                return (
                  <div
                    key={i}
                    className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-sm ${
                      isCorrect
                        ? 'bg-emerald-900/25 border-emerald-600/40 text-emerald-200'
                        : 'bg-slate-800 border-slate-700 text-slate-600'
                    }`}
                  >
                    <span className="font-semibold shrink-0">{String.fromCharCode(65 + i)}.</span>
                    <span className="flex-1">{opt}</span>
                    {isCorrect && <Check className="w-4 h-4 text-emerald-400 shrink-0" />}
                  </div>
                );
              })}
            </div>
          )}

          {storyResult?.explanationPt && (
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
              <p className="text-xs text-slate-500 font-medium mb-1">Explicação</p>
              <p className="text-sm text-slate-300 leading-relaxed">{storyResult.explanationPt}</p>
            </div>
          )}

          <button
            onClick={advance}
            className="w-full py-4 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold transition-colors flex items-center justify-center gap-2"
          >
            {isLastPart ? (
              <>
                <Trophy className="w-5 h-5" />
                Concluir atividade
              </>
            ) : (
              <>
                <Headphones className="w-5 h-5" />
                Continuar para a Parte 2
              </>
            )}
          </button>
        </div>
      );
    }

    const correctIndex = lastResult?.correctOption ?? null;
    const q = block?.question;
    const explanation = lastResult?.explanationPt;
    const restart = () => { if (episodeId) loadSession(episodeId, true); };

    return (
      <div className="p-4 pt-6 max-w-lg mx-auto space-y-4">
        <div className="flex items-center gap-3 p-4 rounded-xl bg-red-900/20 border border-red-700/30">
          <AlertCircle className="w-5 h-5 text-red-400 shrink-0" />
          <div>
            <p className="font-semibold text-sm text-red-300">Ciclo esgotado</p>
            <p className="text-xs text-slate-500 mt-0.5">3 tentativas usadas.</p>
          </div>
        </div>

        {q && correctIndex !== null && (
          <div className="space-y-2">
            <p className="text-xs text-slate-500 font-medium">Resposta correta:</p>
            {q.options.map((opt, i) => {
              const isCorrect = i === correctIndex;
              return (
                <div
                  key={i}
                  className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-sm ${
                    isCorrect
                      ? 'bg-emerald-900/25 border-emerald-600/40 text-emerald-200'
                      : 'bg-slate-800 border-slate-700 text-slate-600'
                  }`}
                >
                  <span className="font-semibold shrink-0">{String.fromCharCode(65 + i)}.</span>
                  <span className="flex-1">{opt}</span>
                  {isCorrect && <Check className="w-4 h-4 text-emerald-400 shrink-0" />}
                </div>
              );
            })}
          </div>
        )}

        {explanation && (
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
            <p className="text-xs text-slate-500 font-medium mb-1">Explicação</p>
            <p className="text-sm text-slate-300 leading-relaxed">{explanation}</p>
          </div>
        )}

        <AutoAdvanceBar durationMs={5000} onDone={restart} />
        <p className="text-xs text-slate-600 text-center">Iniciando novo ciclo...</p>

        <button
          onClick={restart}
          className="w-full py-3 rounded-xl bg-purple-600/20 hover:bg-purple-600/30 border border-purple-600/30 text-purple-300 text-sm font-medium transition-colors flex items-center justify-center gap-2"
        >
          <RefreshCw className="w-4 h-4" />
          Novo ciclo agora
        </button>
      </div>
    );
  }

  // ── Render: done ──────────────────────────────────────────────────────────────
  function renderDone() {
    if (storyData) {
      return (
        <div className="p-6 max-w-lg mx-auto text-center pt-10 space-y-5">
          <div className="w-20 h-20 rounded-full bg-purple-600/20 border-2 border-purple-500/40 flex items-center justify-center mx-auto">
            <Trophy className="w-10 h-10 text-purple-400" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-slate-100">Atividade concluída!</h2>
            <p className="text-sm text-slate-400 mt-2">
              Você completou "{storyData.title}".
            </p>
          </div>

          <button
            onClick={handleStartGeneration}
            disabled={storyGenerating}
            className="w-full py-4 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-60 text-white font-semibold transition-colors flex items-center justify-center gap-2"
          >
            {storyGenerating ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                Gerando...
              </>
            ) : (
              <>
                <RefreshCw className="w-5 h-5" />
                Nova história
              </>
            )}
          </button>

          <button
            onClick={onBack}
            className="w-full py-3.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium transition-colors"
          >
            Voltar
          </button>
        </div>
      );
    }

    return (
      <div className="p-6 max-w-lg mx-auto text-center pt-10 space-y-5">
        <div className="w-20 h-20 rounded-full bg-purple-600/20 border-2 border-purple-500/40 flex items-center justify-center mx-auto">
          <Trophy className="w-10 h-10 text-purple-400" />
        </div>
        <div>
          <h2 className="text-2xl font-bold text-slate-100">Episódio concluído!</h2>
          <p className="text-sm text-slate-400 mt-2">
            Você completou "{episodeData?.title ?? 'este episódio'}".
          </p>
        </div>

        {transcriptLines.length > 0 && (
          <button
            onClick={() => setShowTranscript(true)}
            className="w-full py-4 rounded-xl border border-purple-500/40 bg-purple-600/15 hover:bg-purple-600/25 text-purple-300 font-semibold transition-colors flex items-center justify-center gap-2"
          >
            <ScrollText className="w-5 h-5" />
            Ver transcrição completa
          </button>
        )}

        <button
          onClick={onBack}
          className="w-full py-3.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium transition-colors"
        >
          Voltar
        </button>
      </div>
    );
  }

  // ── Render: transcript modal ──────────────────────────────────────────────────
  function renderTranscriptModal() {
    if (!showTranscript) return null;
    return (
      <div
        className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/80"
        onClick={() => setShowTranscript(false)}
      >
        <div
          className="bg-slate-900 border border-slate-700 w-full sm:max-w-lg max-h-[85vh] rounded-t-2xl sm:rounded-2xl flex flex-col"
          onClick={e => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
            <p className="text-sm font-semibold text-slate-100">Transcrição — {episodeData?.title}</p>
            <button onClick={() => setShowTranscript(false)} className="text-slate-500 hover:text-slate-300 text-lg leading-none">✕</button>
          </div>
          <div className="overflow-auto p-5 space-y-3">
            {transcriptLines.map((line, i) => {
              const color = getSpeakerColor(line.speaker);
              return (
                <div key={i} className="flex gap-3">
                  {line.speaker && (
                    <div className="flex flex-col items-center gap-1 shrink-0 pt-0.5">
                      <div className="w-0.5 flex-1 rounded-full" style={{ background: color, minHeight: '100%' }} />
                    </div>
                  )}
                  <div>
                    {line.speaker && (
                      <p className="text-xs font-semibold mb-0.5" style={{ color }}>{line.speaker}</p>
                    )}
                    <p className="text-sm text-slate-300 leading-relaxed">{line.text}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // ── Main render ───────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 pb-8">
      {renderHeader()}

      <div>
        {phase === 'loading' && renderLoading()}
        {phase === 'prompt' && renderPrompt()}
        {phase === 'generating' && renderGenerating()}
        {phase === 'selecting' && renderSelecting()}
        {phase === 'intro' && renderIntro()}
        {phase === 'error' && renderError()}
        {isPlayerPhase && renderPlayer()}
        {(phase === 'question' || phase === 'submitting') && renderQuestion()}
        {phase === 'correct' && renderCorrect()}
        {phase === 'wrong' && renderWrong()}
        {phase === 'cycle_failed' && renderCycleFailed()}
        {phase === 'done' && renderDone()}
      </div>

      {renderTranscriptModal()}
    </div>
  );
}
