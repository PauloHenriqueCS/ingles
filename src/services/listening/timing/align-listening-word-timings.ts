import { normalizeListeningWord, tokenizeText } from './normalize-listening-words';
import type {
  ListeningAlignedWord,
  ListeningAlignmentResult,
  WordTimingRow,
} from './listening-timing-types';

// ─── Cost constants ───────────────────────────────────────────────────────────

const COST_EXACT = 0;
const COST_NORMALIZED = 0.1;
const COST_SUB = 1.0;
const COST_DEL = 1.0;   // canonical word with no Azure match
const COST_INS = 0.5;   // Azure event with no canonical word

// ─── Alignment op types ───────────────────────────────────────────────────────

type Op = 'match' | 'sub' | 'del' | 'ins';

interface AlignOp {
  op: Op;
  ci: number | null;  // canonical index
  ai: number | null;  // azure index
}

// ─── Wagner-Fischer with traceback ────────────────────────────────────────────

function pairCost(a: string, b: string): number {
  if (a === b) return COST_EXACT;
  if (normalizeListeningWord(a) === normalizeListeningWord(b)) return COST_NORMALIZED;
  return COST_SUB;
}

function wagnerFischer(canonical: string[], azure: string[]): AlignOp[] {
  const m = canonical.length;
  const n = azure.length;

  // dp[i][j] = min cost to align canonical[0..i-1] with azure[0..j-1]
  const dp: number[][] = [];
  for (let i = 0; i <= m; i++) {
    dp[i] = new Array(n + 1).fill(0);
    dp[i][0] = i * COST_DEL;
  }
  for (let j = 1; j <= n; j++) dp[0][j] = j * COST_INS;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const sub = dp[i - 1][j - 1] + pairCost(canonical[i - 1], azure[j - 1]);
      const del = dp[i - 1][j] + COST_DEL;
      const ins = dp[i][j - 1] + COST_INS;
      dp[i][j] = Math.min(sub, del, ins);
    }
  }

  // Traceback (prefer match > del > ins for ties)
  const ops: AlignOp[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const cost = pairCost(canonical[i - 1], azure[j - 1]);
      if (Math.abs(dp[i][j] - (dp[i - 1][j - 1] + cost)) < 1e-9) {
        ops.unshift({ op: cost === 0 ? 'match' : 'sub', ci: i - 1, ai: j - 1 });
        i--; j--;
        continue;
      }
    }
    if (i > 0 && Math.abs(dp[i][j] - (dp[i - 1][j] + COST_DEL)) < 1e-9) {
      ops.unshift({ op: 'del', ci: i - 1, ai: null });
      i--;
    } else {
      ops.unshift({ op: 'ins', ci: null, ai: j - 1 });
      j--;
    }
  }

  return ops;
}

// ─── Post-process split contractions and merged words ────────────────────────

function postProcess(ops: AlignOp[], canonical: string[], azure: string[]): AlignOp[] {
  const result = ops.slice();

  // Forward pass: detect split contractions (canonical del + consecutive azure ins → one split match)
  for (let i = 0; i < result.length; i++) {
    const op = result[i];
    if (op.op !== 'del' || op.ci === null) continue;

    const cWord = normalizeListeningWord(canonical[op.ci]);

    // Collect consecutive ins ops after this del
    const insIdxs: number[] = [];
    for (let j = i + 1; j < result.length && insIdxs.length < 4; j++) {
      if (result[j].op !== 'ins' || result[j].ai === null) break;
      insIdxs.push(j);
    }

    if (insIdxs.length < 2) continue;

    for (let len = 2; len <= insIdxs.length; len++) {
      const combined = insIdxs
        .slice(0, len)
        .map(idx => normalizeListeningWord(azure[result[idx].ai!]))
        .join('');
      if (combined === cWord || combined.replace(/'/g, '') === cWord.replace(/'/g, '')) {
        // Reclassify: replace del + ins...ins with a single 'split' pseudo-match
        result[i] = { op: 'match', ci: op.ci, ai: result[insIdxs[0]].ai };
        (result[i] as AlignOp & { isSplit?: true; splitEndAi?: number }).isSplit = true;
        (result[i] as AlignOp & { isSplit?: true; splitEndAi?: number }).splitEndAi =
          result[insIdxs[len - 1]].ai!;
        for (let k = len - 1; k >= 1; k--) result.splice(insIdxs[k], 1);
        break;
      }
    }
  }

  // Forward pass: detect merged words (consecutive canonical del + single azure ins → merged)
  for (let i = 0; i < result.length; i++) {
    if (result[i].op !== 'del' || result[i].ci === null) continue;
    const delIdxs: number[] = [i];
    for (let j = i + 1; j < result.length && delIdxs.length < 4; j++) {
      if (result[j].op !== 'del' || result[j].ci === null) break;
      delIdxs.push(j);
    }
    if (delIdxs.length < 2) continue;
    const nextIdx = i + delIdxs.length;
    if (nextIdx >= result.length || result[nextIdx].op !== 'ins' || result[nextIdx].ai === null) continue;

    const combined = delIdxs
      .map(idx => normalizeListeningWord(canonical[result[idx].ci!]))
      .join('');
    const azureWord = normalizeListeningWord(azure[result[nextIdx].ai!]);
    if (combined === azureWord || combined.replace(/'/g, '') === azureWord) {
      result[i] = { op: 'match', ci: result[i].ci, ai: result[nextIdx].ai };
      (result[i] as AlignOp & { isMerged?: true }).isMerged = true;
      for (let k = delIdxs.length; k >= 1; k--) result.splice(i + k, 1);
    }
  }

  return result;
}

// ─── Word endMs helper ────────────────────────────────────────────────────────

function resolveEndMs(event: WordTimingRow): number | null {
  if (event.end_ms !== null && event.end_ms !== undefined) return event.end_ms;
  if (event.duration_ms !== null && event.duration_ms !== undefined)
    return event.start_ms + event.duration_ms;
  return null;
}

// ─── Main alignment function ──────────────────────────────────────────────────

export function alignListeningWordTimings(
  canonicalText: string,
  wordEvents: WordTimingRow[],
): ListeningAlignmentResult {
  const canonical = tokenizeText(canonicalText);

  if (canonical.length === 0 && wordEvents.length === 0) {
    return {
      words: [],
      metrics: {
        canonicalWordCount: 0, azureEventCount: 0, alignedWordCount: 0,
        exactMatchCount: 0, normalizedMatchCount: 0, missingWordCount: 0,
        extraEventCount: 0, alignmentRate: 1.0,
      },
    };
  }

  const azureTexts = wordEvents.map(e => e.text);
  const rawOps = wagnerFischer(canonical, azureTexts);
  const ops = postProcess(rawOps, canonical, azureTexts);

  const aligned: ListeningAlignedWord[] = [];
  let canonicalOrder = 0;

  for (const op of ops) {
    const extOp = op as AlignOp & { isSplit?: boolean; isMerged?: boolean; splitEndAi?: number };

    if (op.op === 'match' || op.op === 'sub') {
      const event = op.ai !== null ? wordEvents[op.ai] : null;
      let matchType: ListeningAlignedWord['matchType'];
      if (extOp.isSplit) matchType = 'split';
      else if (extOp.isMerged) matchType = 'merged';
      else if (op.op === 'match') matchType = 'exact';
      else {
        const cn = normalizeListeningWord(canonical[op.ci!]);
        const an = event ? normalizeListeningWord(event.text) : '';
        matchType = cn === an ? 'normalized' : 'normalized';
      }

      // For split words, use end of the last split event
      let endMs = event ? resolveEndMs(event) : null;
      if (extOp.isSplit && extOp.splitEndAi !== undefined) {
        const lastSplitEvent = wordEvents[extOp.splitEndAi];
        endMs = resolveEndMs(lastSplitEvent);
      }

      aligned.push({
        canonicalWord: canonical[op.ci!],
        azureText: event?.text ?? '',
        canonicalOrder: canonicalOrder++,
        eventOrder: op.ai,
        startMs: event?.start_ms ?? null,
        endMs,
        matchType,
      });
    } else if (op.op === 'del') {
      aligned.push({
        canonicalWord: canonical[op.ci!],
        azureText: '',
        canonicalOrder: canonicalOrder++,
        eventOrder: null,
        startMs: null,
        endMs: null,
        matchType: 'missing',
      });
    } else {
      // ins — extra Azure event
      const event = wordEvents[op.ai!];
      aligned.push({
        canonicalWord: '',
        azureText: event.text,
        canonicalOrder: canonicalOrder++,
        eventOrder: op.ai,
        startMs: event.start_ms,
        endMs: resolveEndMs(event),
        matchType: 'extra',
      });
    }
  }

  const canonicalWordCount = canonical.length;
  const azureEventCount = wordEvents.length;
  const alignedWordCount = aligned.filter(
    w => w.matchType !== 'missing' && w.matchType !== 'extra',
  ).length;
  const exactMatchCount = aligned.filter(w => w.matchType === 'exact').length;
  const normalizedMatchCount = aligned.filter(
    w => w.matchType === 'normalized' || w.matchType === 'split' || w.matchType === 'merged',
  ).length;
  const missingWordCount = aligned.filter(w => w.matchType === 'missing').length;
  const extraEventCount = aligned.filter(w => w.matchType === 'extra').length;
  const alignmentRate =
    canonicalWordCount > 0 ? alignedWordCount / canonicalWordCount : 1.0;

  return {
    words: aligned,
    metrics: {
      canonicalWordCount,
      azureEventCount,
      alignedWordCount,
      exactMatchCount,
      normalizedMatchCount,
      missingWordCount,
      extraEventCount,
      alignmentRate,
    },
  };
}
