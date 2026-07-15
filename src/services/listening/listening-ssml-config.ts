import type {
  ListeningVoiceConfig,
  ListeningSsmlConfig,
  ListeningSsmlPauseConfig,
  ListeningSsmlProsodyConfig,
} from './listening-ssml-types';

export const SSML_GENERATOR_VERSION = 'listening-ssml-generator-v1';
export const PRONUNCIATION_RULES_VERSION = 'pronunciation-rules-v0';

// Central voice configuration. Change here affects all generated SSMLs.
export const DEFAULT_VOICE_CONFIG: ListeningVoiceConfig = {
  locale: 'en-US',
  voiceName: 'en-US-AvaMultilingualNeural',
};

export const DEFAULT_PAUSE_CONFIG: ListeningSsmlPauseConfig = {
  paragraphBreakMs: 400,
  sceneBreakMs: 700,
  blockStartMs: 0,
};

// Conservative prosody: slight slowdown for clarity without sounding robotic.
export const DEFAULT_PROSODY_CONFIG: ListeningSsmlProsodyConfig = {
  rate: '-5%',
};

export const DEFAULT_SSML_CONFIG: ListeningSsmlConfig = {
  voice: DEFAULT_VOICE_CONFIG,
  pauses: DEFAULT_PAUSE_CONFIG,
  prosody: DEFAULT_PROSODY_CONFIG,
  pronunciationRules: [],
  generatorVersion: SSML_GENERATOR_VERSION,
  pronunciationRulesVersion: PRONUNCIATION_RULES_VERSION,
};
