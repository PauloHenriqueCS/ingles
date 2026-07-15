export type ListeningSsmlStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface ListeningVoiceConfig {
  locale: string;
  voiceName: string;
}

export interface ListeningPronunciationRule {
  sourceText: string;
  replacementType: 'phoneme' | 'say-as' | 'sub';
  value: string;
  alphabet?: string;
}

export interface ListeningSsmlPauseConfig {
  paragraphBreakMs: number;
  sceneBreakMs: number;
  blockStartMs: number;
}

export interface ListeningSsmlProsodyConfig {
  rate: string;
}

export interface ListeningSsmlConfig {
  voice: ListeningVoiceConfig;
  pauses: ListeningSsmlPauseConfig;
  prosody: ListeningSsmlProsodyConfig | null;
  pronunciationRules: ListeningPronunciationRule[];
  generatorVersion: string;
  pronunciationRulesVersion: string;
}

export interface ListeningBlockSsmlResult {
  blockId: string;
  blockOrder: 1 | 2;
  sentenceCount: number;
  bookmarkCount: number;
  ssmlVersion: number;
  contentHash: string;
  ssml: string;
}

export interface GenerateListeningSsmlInput {
  episodeId: string;
  forceRegeneration?: boolean;
  dryRun?: boolean;
}

export interface GenerateListeningSsmlResult {
  episodeId: string;
  voiceName: string;
  locale: string;
  blocks: [ListeningBlockSsmlResult, ListeningBlockSsmlResult];
  status: 'ready';
  generatorVersion: string;
}

export interface ListeningSsmlBookmarkValidation {
  valid: boolean;
  expectedCount: number;
  actualCount: number;
  missing: string[];
  duplicated: string[];
  unexpected: string[];
  outOfOrder: string[];
}

export interface ListeningSsmlMetadata {
  blockOrder: 1 | 2;
  sentenceCount: number;
  bookmarkCount: number;
  estimatedWordCount: number;
  voiceName: string;
  locale: string;
  generatorVersion: string;
  contentHash: string;
}
