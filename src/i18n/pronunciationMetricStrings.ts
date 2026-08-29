/**
 * Plain-language explanations for the four Azure pronunciation sub-scores, shown
 * behind a "?" next to each metric name. Centralized here so BOTH surfaces that
 * render the metrics — the standalone "Treinar pronúncia" activity and the
 * writing-flow pronunciation — read the SAME text (via the shared
 * PronunciationScoreSummary component) and can never diverge.
 *
 * Follows the project's i18n pattern (see homeUiStrings.ts): one object per
 * supported interface language + a resolver that falls back to pt-BR. The
 * pronunciation UI is currently pt-BR only, so callers may omit the language and
 * get pt-BR — but the English copy is ready for when the area is localized.
 */

export type PronunciationMetricKey = 'accuracy' | 'fluency' | 'completeness' | 'prosody';

export interface MetricExplanation {
  /** The metric name shown as the row label. */
  title: string;
  /** Short, non-technical explanation shown in the "?" popover. */
  description: string;
}

export interface PronunciationMetricStrings {
  accuracy: MetricExplanation;
  fluency: MetricExplanation;
  completeness: MetricExplanation;
  prosody: MetricExplanation;
  /** Prefix for the "?" button's accessible label, e.g. "Entender Precisão". */
  understandPrefix: string;
  /** Screen-reader label for the popover close affordance / region. */
  explanationLabel: string;
}

const PT_BR: PronunciationMetricStrings = {
  accuracy: {
    title: 'Precisão',
    description: 'Mostra o quanto você pronunciou corretamente os sons e as palavras do texto.',
  },
  fluency: {
    title: 'Fluência',
    description: 'Mostra se você falou de forma contínua e natural, com poucas pausas ou hesitações.',
  },
  completeness: {
    title: 'Completude',
    description:
      'Mostra quanto do texto esperado você realmente falou, identificando palavras que foram puladas ou não reconhecidas. Uma nota baixa aqui não significa que você pronunciou mal — indica que parte do conteúdo não foi falada ou reconhecida.',
  },
  prosody: {
    title: 'Prosódia',
    description: 'Mostra o quão natural sua fala soou, considerando entonação, ritmo e ênfase nas palavras.',
  },
  understandPrefix: 'Entender',
  explanationLabel: 'Explicação da métrica',
};

const EN: PronunciationMetricStrings = {
  accuracy: {
    title: 'Accuracy',
    description: 'Shows how correctly you pronounced the sounds and words in the text.',
  },
  fluency: {
    title: 'Fluency',
    description: 'Shows whether you spoke continuously and naturally, with few pauses or hesitations.',
  },
  completeness: {
    title: 'Completeness',
    description:
      'Shows how much of the expected text you actually said, identifying words that were skipped or not recognized. A low score here does not mean you pronounced badly — it means part of the content was not spoken or recognized.',
  },
  prosody: {
    title: 'Prosody',
    description: 'Shows how natural your speech sounded based on intonation, rhythm, and word stress.',
  },
  understandPrefix: 'Understand',
  explanationLabel: 'Metric explanation',
};

const STRINGS: Record<string, PronunciationMetricStrings> = { 'pt-BR': PT_BR, en: EN };

/** Resolves the metric explanations for an interface language (falls back to pt-BR). */
export function pronunciationMetricStrings(interfaceLanguage?: string | null): PronunciationMetricStrings {
  const code = (interfaceLanguage ?? '').trim();
  return STRINGS[code] ?? STRINGS[code.split('-')[0]] ?? PT_BR;
}

/** Stable order the metrics are displayed in. */
export const PRONUNCIATION_METRIC_ORDER: PronunciationMetricKey[] = ['accuracy', 'fluency', 'completeness', 'prosody'];
