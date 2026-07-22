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
