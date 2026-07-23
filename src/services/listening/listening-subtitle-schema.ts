// Raw types from the AI translation response

export interface RawTranslatedCue {
  cueKey: string;
  sourceSentenceKeys: string[];
  textPtBr: string;
}

export interface RawTranslatedBlock {
  blockOrder: number;
  cues: RawTranslatedCue[];
}

export interface RawTranslationResponse {
  schemaVersion: string;
  episodeId: string;
  blocks: RawTranslatedBlock[];
}

// Validated types after deterministic validation

export interface ValidatedTranslatedCue {
  cueKey: string;
  cueOrder: number;
  blockOrder: 1 | 2;
  sourceSentenceKeys: string[];
  textEn: string;
  textPtBr: string;
}

// AI semantic (quality-only) validation result — per cue, not per block.
// Identity/count/order/number-preservation are the deterministic layer's job
// (validateTranslationDeterministic); this layer only judges meaning
// fidelity, naturalness, and invented/omitted content.

export interface CueQualityResult {
  cueKey: string;
  valid: boolean;
  /** Specific reason(s) — empty when valid is true. */
  issues: string[];
}

export interface SubtitleQualityValidationResult {
  schemaVersion: string;
  /** true only when every requested cueKey was present in the response and valid. */
  overallValid: boolean;
  cueResults: CueQualityResult[];
}

// English cue built from sentences (pre-translation)
export interface EnglishCueDraft {
  cueKey: string;
  cueOrder: number;
  blockOrder: 1 | 2;
  sourceSentenceKeys: string[];
  text: string;
}

// ─── Sentence-level (canonical) translation ────────────────────────────────
// A "sentence group" is one or more cues that share an original sentence —
// see group-cues-by-sentence.ts. Multi-cue groups are translated as ONE
// coherent unit (a single canonical pt-BR sentence) and then segmented back
// across their cueKeys, instead of each cue being translated independently.

export interface RawSentenceGroupSegment {
  cueKey: string;
  textPtBr: string;
}

/**
 * Raw (unvalidated) shape of one multi-cue sentence group in a
 * batch-translation response. Quality review of a group's
 * canonicalTranslation reuses the existing per-cue CueQualityResult/
 * SubtitleQualityValidationResult above — the group's canonical text is
 * presented to the validator as one "virtual" cue (keyed by its first real
 * cueKey), so no dedicated group-level result type is needed: the model is
 * never asked to judge the group's fragments separately from the whole
 * sentence they belong to.
 */
export interface RawSentenceGroup {
  cueKeys: string[];
  canonicalTranslation: string;
  segments: RawSentenceGroupSegment[];
}
