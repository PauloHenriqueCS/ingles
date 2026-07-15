// Raw types: exactly as returned by the AI (snake_case JSON)

export interface RawStorySentence {
  sentence_key: string;
  sentence_order: number;
  paragraph_order: number;
  speaker: string | null;
  text_en: string;
}

export interface RawStoryQuestion {
  question_order: number;
  prompt: string;
  options_json: string[];
  correct_option: number;
  explanation_pt: string;
}

export interface RawStoryBlock {
  block_order: number;
  text_en: string;
  translation_pt: string;
  sentences: RawStorySentence[];
  question: RawStoryQuestion;
}

export interface RawStoryResponse {
  title: string;
  synopsis: string;
  blocks: RawStoryBlock[];
}

// Validated types: camelCase, narrowed, guaranteed structure

export interface ValidatedSentence {
  sentenceKey: string;
  sentenceOrder: number;
  paragraphOrder: number;
  speaker: string | null;
  textEn: string;
}

export interface ValidatedQuestion {
  questionOrder: 1 | 2;
  prompt: string;
  optionsJson: string[];
  correctOption: number;
  explanationPt: string;
}

export interface ValidatedBlock {
  blockOrder: 1 | 2;
  textEn: string;
  translationPt: string;
  wordCount: number;
  sentences: ValidatedSentence[];
  question: ValidatedQuestion;
}

export interface ValidatedStory {
  title: string;
  synopsis: string;
  cefrLevel: string;
  blocks: [ValidatedBlock, ValidatedBlock];
}
