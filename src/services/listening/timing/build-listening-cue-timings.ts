import { tokenizeWithOffsets } from './normalize-listening-words';
import { estimateCueTimingsWithinSentence } from './estimate-listening-cue-timings';
import type {
  SentenceRow,
  CueRow,
  ListeningSentenceTiming,
  ListeningAlignedWord,
  ListeningCueTiming,
  ListeningSubtitleTimingConfig,
} from './listening-timing-types';

// ─── Assign aligned words to sentence text positions ─────────────────────────

interface WordWithOffset {
  aligned: ListeningAlignedWord;
  charStart: number;
  charEnd: number;
}

function wordsWithOffsets(
  sentence: SentenceRow,
  alignedWords: ListeningAlignedWord[],
): WordWithOffset[] {
  const tokens = tokenizeWithOffsets(sentence.text_en);
  const result: WordWithOffset[] = [];
  // aligned words excluding 'extra' events correspond positionally to tokens
  const canonicalAligned = alignedWords.filter(w => w.matchType !== 'extra');
  for (let i = 0; i < Math.min(tokens.length, canonicalAligned.length); i++) {
    result.push({
      aligned: canonicalAligned[i],
      charStart: tokens[i].start,
      charEnd: tokens[i].end,
    });
  }
  return result;
}

// ─── Find cue char range within combined sentence text ───────────────────────

function findCueRange(
  cueText: string,
  combinedText: string,
  searchFrom: number,
): { start: number; end: number } | null {
  const idx = combinedText.indexOf(cueText, searchFrom);
  if (idx !== -1) return { start: idx, end: idx + cueText.length };
  // Fallback: trim and search
  const trimmed = cueText.trim();
  const idx2 = combinedText.indexOf(trimmed, searchFrom);
  if (idx2 !== -1) return { start: idx2, end: idx2 + trimmed.length };
  return null;
}

// ─── Main builder ─────────────────────────────────────────────────────────────

export function buildListeningCueTimings(
  cues: CueRow[],
  sentences: SentenceRow[],
  sentenceTimings: ListeningSentenceTiming[],
  alignedWordsBySentence: Map<string, ListeningAlignedWord[]>,
  audioDurationMs: number,
  config: ListeningSubtitleTimingConfig,
): ListeningCueTiming[] {
  const sentenceMap = new Map(sentences.map(s => [s.sentence_key, s]));
  const timingMap = new Map(sentenceTimings.map(t => [t.sentenceKey, t]));

  const cuesToProcess = [...cues].sort((a, b) => a.cue_order - b.cue_order);
  const results: ListeningCueTiming[] = [];

  for (let cueIdx = 0; cueIdx < cuesToProcess.length; cueIdx++) {
    const cue = cuesToProcess[cueIdx];
    const srcKeys = cue.source_sentence_keys ?? [];

    // ── Gather all aligned words for this cue's sentences ────────────────────
    const cueSentences = srcKeys
      .map(k => sentenceMap.get(k))
      .filter(Boolean) as SentenceRow[];

    if (cueSentences.length === 0) {
      // No sentences found — use sentence timing boundaries as fallback
      const st = srcKeys.length > 0 ? timingMap.get(srcKeys[0]) : undefined;
      results.push({
        cueKey: cue.cue_key,
        cueOrder: cue.cue_order,
        startMs: st?.startMs ?? 0,
        endMs: st?.intervalEndMs ?? 0,
        sourceSentenceKeys: srcKeys,
        timingSource: 'sentence_bookmarks',
        confidence: 0.5,
      });
      continue;
    }

    // Build combined text of source sentences and find cue range
    const combinedText = cueSentences.map(s => s.text_en).join(' ');
    const cueRange = findCueRange(cue.text, combinedText, 0);

    // Build character-offset-annotated word list for combined sentences
    const allWordsWithOffsets: WordWithOffset[] = [];
    let offset = 0;
    for (const s of cueSentences) {
      const aligned = alignedWordsBySentence.get(s.sentence_key) ?? [];
      const wwo = wordsWithOffsets(s, aligned);
      allWordsWithOffsets.push(...wwo.map(w => ({
        ...w,
        charStart: w.charStart + offset,
        charEnd: w.charEnd + offset,
      })));
      offset += s.text_en.length + 1; // +1 for space separator
    }

    // Filter words that fall within the cue's char range
    let cueWords: ListeningAlignedWord[];
    if (cueRange) {
      cueWords = allWordsWithOffsets
        .filter(w => w.charStart >= cueRange.start && w.charStart < cueRange.end)
        .map(w => w.aligned);
    } else {
      // No range found — use all words from source sentences, divided by cue position
      const siblingsInSameSentence = cuesToProcess.filter(
        c => c.source_sentence_keys.some(k => srcKeys.includes(k)),
      );
      const siblingIdx = siblingsInSameSentence.findIndex(c => c.cue_key === cue.cue_key);
      const siblingCount = siblingsInSameSentence.length;
      const all = allWordsWithOffsets.map(w => w.aligned);
      const perCue = Math.ceil(all.length / siblingCount);
      cueWords = all.slice(siblingIdx * perCue, (siblingIdx + 1) * perCue);
    }

    // ── Determine timing from cue words ───────────────────────────────────────
    const timedWords = cueWords.filter(w => w.startMs !== null && w.endMs !== null);

    // Sentence timing boundaries for clamping
    const firstSentenceTiming = timingMap.get(srcKeys[0]);
    const lastSentenceTiming = timingMap.get(srcKeys[srcKeys.length - 1]);
    const hardStart = firstSentenceTiming?.startMs ?? 0;
    const hardEnd = lastSentenceTiming?.intervalEndMs ?? audioDurationMs;

    let rawStart: number;
    let rawEnd: number;
    let timingSource: ListeningCueTiming['timingSource'];
    let confidence: number;

    if (timedWords.length > 0) {
      rawStart = Math.min(...timedWords.map(w => w.startMs!));
      rawEnd = Math.max(...timedWords.map(w => w.endMs!));
      const alignedRatio = timedWords.length / Math.max(cueWords.length, 1);
      timingSource = alignedRatio >= 0.95 ? 'word_boundaries' : 'hybrid';
      confidence = alignedRatio >= 0.95 ? 1.0 : 0.9 * alignedRatio;
    } else {
      // Fallback: proportional estimation within sentence timing
      const est = estimateCueTimingsWithinSentence(
        cue,
        cuesToProcess.filter(c =>
          c.source_sentence_keys.some(k => srcKeys.includes(k)),
        ),
        firstSentenceTiming ?? { startMs: 0, intervalEndMs: audioDurationMs, spokenEndMs: audioDurationMs, sentenceKey: '', sentenceOrder: 0, timingConfidence: 0.5 },
      );
      rawStart = est.startMs;
      rawEnd = est.endMs;
      timingSource = 'fallback';
      confidence = est.confidence;
    }

    // Apply pre/post roll
    rawStart = Math.max(hardStart, rawStart - config.preRollMs);
    rawEnd = Math.min(hardEnd, rawEnd + config.postRollMs);

    // Clamp to audio duration
    rawStart = Math.max(0, rawStart);
    rawEnd = Math.min(audioDurationMs, rawEnd);

    // Ensure min duration
    if (rawEnd - rawStart < config.minCueDurationMs) {
      rawEnd = Math.min(audioDurationMs, rawStart + config.minCueDurationMs);
    }

    // Ensure end > start
    if (rawEnd <= rawStart) rawEnd = rawStart + config.minCueDurationMs;

    results.push({
      cueKey: cue.cue_key,
      cueOrder: cue.cue_order,
      startMs: rawStart,
      endMs: rawEnd,
      sourceSentenceKeys: srcKeys,
      timingSource,
      confidence,
    });
  }

  // ── Resolve overlaps (ensure no invalid overlaps) ─────────────────────────
  for (let i = 1; i < results.length; i++) {
    const prev = results[i - 1];
    const curr = results[i];
    if (curr.startMs < prev.endMs - config.maxOverlapMs) {
      results[i] = { ...curr, startMs: prev.endMs };
      if (results[i].endMs <= results[i].startMs) {
        results[i] = { ...results[i], endMs: results[i].startMs + config.minCueDurationMs };
      }
    }
  }

  return results;
}
