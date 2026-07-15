import type {
  ListeningSentenceTiming,
  ListeningCueTiming,
  ListeningSubtitleTimingConfig,
} from './listening-timing-types';

export interface ListeningTimingValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateListeningTimings(
  sentenceTimings: ListeningSentenceTiming[],
  enCueTimings: ListeningCueTiming[],
  ptCueTimings: ListeningCueTiming[],
  audioDurationMs: number,
  config: ListeningSubtitleTimingConfig,
): ListeningTimingValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── Sentence timing checks ────────────────────────────────────────────────
  for (const st of sentenceTimings) {
    if (st.startMs < 0)
      errors.push(`Sentence ${st.sentenceKey}: startMs < 0 (${st.startMs})`);
    if (st.spokenEndMs < st.startMs)
      errors.push(`Sentence ${st.sentenceKey}: spokenEndMs < startMs`);
    if (st.intervalEndMs < st.spokenEndMs)
      errors.push(`Sentence ${st.sentenceKey}: intervalEndMs < spokenEndMs`);
    if (st.intervalEndMs > audioDurationMs + 500)
      warnings.push(`Sentence ${st.sentenceKey}: intervalEndMs exceeds audio duration`);
  }

  // Check sentence ordering
  for (let i = 1; i < sentenceTimings.length; i++) {
    if (sentenceTimings[i].startMs < sentenceTimings[i - 1].startMs)
      errors.push(`Sentences not in order at index ${i}`);
  }

  // ── EN cue checks ─────────────────────────────────────────────────────────
  for (const cue of enCueTimings) {
    if (cue.startMs < 0)
      errors.push(`EN cue ${cue.cueKey}: startMs < 0`);
    if (cue.endMs <= cue.startMs)
      errors.push(`EN cue ${cue.cueKey}: endMs <= startMs`);
    if (cue.endMs > audioDurationMs + 200)
      errors.push(`EN cue ${cue.cueKey}: endMs exceeds audio duration`);
    if (cue.confidence < 0 || cue.confidence > 1)
      errors.push(`EN cue ${cue.cueKey}: invalid confidence ${cue.confidence}`);
  }

  // Check EN cue ordering and overlaps
  for (let i = 1; i < enCueTimings.length; i++) {
    const prev = enCueTimings[i - 1];
    const curr = enCueTimings[i];
    if (curr.startMs < prev.startMs)
      errors.push(`EN cues not in order: ${curr.cueKey} before ${prev.cueKey}`);
    const overlap = prev.endMs - curr.startMs;
    if (overlap > config.maxOverlapMs)
      errors.push(
        `EN cue overlap ${prev.cueKey}→${curr.cueKey}: ${overlap}ms exceeds ${config.maxOverlapMs}ms`,
      );
    const gap = curr.startMs - prev.endMs;
    if (gap > 800)
      warnings.push(`EN cue gap ${prev.cueKey}→${curr.cueKey}: ${gap}ms`);
  }

  // ── PT cue checks — must mirror EN ───────────────────────────────────────
  const enByCueKey = new Map(enCueTimings.map(c => [c.cueKey, c]));
  const ptByCueKey = new Map(ptCueTimings.map(c => [c.cueKey, c]));

  for (const en of enCueTimings) {
    const pt = ptByCueKey.get(en.cueKey);
    if (!pt) {
      errors.push(`PT cue missing for EN cue ${en.cueKey}`);
      continue;
    }
    if (pt.startMs !== en.startMs || pt.endMs !== en.endMs)
      errors.push(
        `PT cue ${en.cueKey} times differ from EN (EN: ${en.startMs}-${en.endMs}, PT: ${pt.startMs}-${pt.endMs})`,
      );
  }

  for (const pt of ptCueTimings) {
    if (!enByCueKey.has(pt.cueKey))
      errors.push(`PT cue ${pt.cueKey} has no corresponding EN cue`);
  }

  return { valid: errors.length === 0, errors, warnings };
}
