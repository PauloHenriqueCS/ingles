/**
 * Static assertions for the pronunciation metric "?" explanations:
 *  - the shared PronunciationScoreSummary shows a MetricInfoTip for all four
 *    metrics AND still renders the score values (presentation-only change);
 *  - BOTH pronunciation surfaces (the writing-flow result + the standalone
 *    "Treinar pronúncia" activity) go through that shared component, so neither
 *    can diverge;
 *  - MetricInfoTip is a real "?" button that opens by click/tap (not hover, no
 *    native `title`) and closes on outside tap / Escape.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const src = (name: string) => readFileSync(resolve(__dirname, '..', name), 'utf8');
const summarySrc = src('PronunciationScoreSummary.tsx');
const tipSrc = src('MetricInfoTip.tsx');
const resultSrc = src('PronunciationResult.tsx');
const trainingSrc = src('PronunciationTrainingView.tsx');

describe('PronunciationScoreSummary — the shared metrics card', () => {
  it('renders a MetricInfoTip ("?") for each of the four metrics', () => {
    for (const key of ['accuracy', 'fluency', 'completeness', 'prosody']) {
      expect(summarySrc).toMatch(new RegExp(`metric=\\{m\\.${key}\\}`));
    }
    // one <MetricInfoTip> inside the shared ScoreRow → one per metric row.
    expect(summarySrc).toMatch(/<MetricInfoTip/);
    expect(summarySrc).toMatch(/import MetricInfoTip from '\.\/MetricInfoTip'/);
    expect(summarySrc).toMatch(/pronunciationMetricStrings/);
  });

  it('still shows the numeric scores and recognized text (presentation-only)', () => {
    expect(summarySrc).toMatch(/value\.toFixed\(0\)/);
    expect(summarySrc).toMatch(/result\.accuracyScore/);
    expect(summarySrc).toMatch(/result\.fluencyScore/);
    expect(summarySrc).toMatch(/result\.completenessScore/);
    expect(summarySrc).toMatch(/result\.prosodyScore/);
    expect(summarySrc).toMatch(/Texto reconhecido/);
  });

  it('passes each metric its OWN explanation + an accessible "Entender <métrica>" label', () => {
    expect(summarySrc).toMatch(/buttonLabel=\{`\$\{understandPrefix\} \$\{metric\.title\}`\}/);
    expect(summarySrc).toMatch(/description=\{metric\.description\}/);
  });
});

describe('both pronunciation flows use the shared summary (no duplication)', () => {
  it('writing-flow result renders PronunciationScoreSummary', () => {
    expect(resultSrc).toMatch(/import PronunciationScoreSummary from '\.\/PronunciationScoreSummary'/);
    expect(resultSrc).toMatch(/<PronunciationScoreSummary/);
  });
  it('standalone "Treinar pronúncia" renders PronunciationScoreSummary', () => {
    expect(trainingSrc).toMatch(/import PronunciationScoreSummary from '\.\/PronunciationScoreSummary'/);
    expect(trainingSrc).toMatch(/<PronunciationScoreSummary/);
  });
});

describe('MetricInfoTip — accessible, mobile-first "?"', () => {
  it('is a "?" button (NOT an info "i"), opened by click/tap and toggled', () => {
    expect(tipSrc).toMatch(/onClick=\{\(\) => setOpen/);         // click/tap opens
    expect(tipSrc).toMatch(/>\s*\?\s*</);                        // literal "?" glyph
    expect(tipSrc).not.toMatch(/lucide-react/);                  // not an icon lib "i"
  });
  it('does NOT rely on hover or the native title attribute', () => {
    expect(tipSrc).not.toMatch(/onMouseEnter|onMouseOver|onMouseLeave/);
    expect(tipSrc).not.toMatch(/\btitle=/);                      // no native browser tooltip
  });
  it('closes on outside tap and Escape', () => {
    expect(tipSrc).toMatch(/pointerdown/);
    expect(tipSrc).toMatch(/e\.key === 'Escape'/);
  });
  it('is an accessible dialog affordance (aria-label + haspopup + expanded)', () => {
    expect(tipSrc).toMatch(/aria-label=\{buttonLabel\}/);
    expect(tipSrc).toMatch(/aria-haspopup="dialog"/);
    expect(tipSrc).toMatch(/aria-expanded=\{open\}/);
    expect(tipSrc).toMatch(/role="dialog"/);
  });
});
