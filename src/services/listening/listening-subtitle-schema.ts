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

// AI semantic validation result

export interface SubtitleAIValidationChecks {
  meaningPreserved: boolean;
  noAddedInformation: boolean;
  noMissingInformation: boolean;
  ptBrNatural: boolean;
  namesPreserved: boolean;
  numbersPreserved: boolean;
  cueAlignmentValid: boolean;
}

export interface SubtitleAIValidationResult {
  schemaVersion: string;
  valid: boolean;
  confidence: number;
  checks: SubtitleAIValidationChecks;
  issues: string[];
  correctedTextPtBr: Record<string, string> | null;
}

// English cue built from sentences (pre-translation)
export interface EnglishCueDraft {
  cueKey: string;
  cueOrder: number;
  blockOrder: 1 | 2;
  sourceSentenceKeys: string[];
  text: string;
}
