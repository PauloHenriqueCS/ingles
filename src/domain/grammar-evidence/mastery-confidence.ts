export interface MasteryConfidenceInput {
  weightedSuccessScore: number;    // sum of positive evidence weights
  weightedErrorScore: number;      // sum of absolute negative evidence weights (positive number)
  independentUses: number;
  distinctContexts: number;
  retentionSuccesses: number;
  retentionFailures: number;
  evidenceCount: number;
  lastEvidenceAgeDays: number;     // days since last evidence (0 = very recent)
  evidenceVersion?: string;
}

export const CURRENT_CONFIDENCE_VERSION = 'v1';

export function calculateGrammarMasteryConfidence(input: MasteryConfidenceInput): number {
  const {
    weightedSuccessScore,
    weightedErrorScore,
    independentUses,
    distinctContexts,
    retentionSuccesses,
    retentionFailures,
    evidenceCount,
    lastEvidenceAgeDays,
  } = input;

  // base = weightedSuccessScore / max(1, weightedSuccessScore + weightedErrorScore)
  const totalAbsoluteEvidence = Math.max(1, weightedSuccessScore + weightedErrorScore);
  const base = weightedSuccessScore / totalAbsoluteEvidence;

  // volumeBonus = min(0.15, evidenceCount * 0.015)
  const volumeBonus = Math.min(0.15, evidenceCount * 0.015);

  // independenceBonus = min(0.10, independentUses * 0.03)
  const independenceBonus = Math.min(0.10, independentUses * 0.03);

  // diversityBonus = min(0.10, distinctContexts * 0.03)
  const diversityBonus = Math.min(0.10, distinctContexts * 0.03);

  // retentionFactor = 1.0 if no retention data
  //   else (retentionSuccesses + 0.5) / (retentionSuccesses + retentionFailures + 0.5)
  let retentionFactor: number;
  if (retentionSuccesses === 0 && retentionFailures === 0) {
    retentionFactor = 1.0;
  } else {
    retentionFactor = (retentionSuccesses + 0.5) / (retentionSuccesses + retentionFailures + 0.5);
  }

  // recencyDecay = Math.exp(-lastEvidenceAgeDays / 90)
  //   cap: if lastEvidenceAgeDays === 0, decay = 1.0
  const recencyDecay = lastEvidenceAgeDays === 0
    ? 1.0
    : Math.exp(-lastEvidenceAgeDays / 90);

  // raw = (base + volumeBonus + independenceBonus + diversityBonus) * retentionFactor * recencyDecay
  const raw = (base + volumeBonus + independenceBonus + diversityBonus) * retentionFactor * recencyDecay;

  // clamp to [0, 1]
  return Math.min(1, Math.max(0, raw));
}
