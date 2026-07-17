/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Typed catalog of the 25 AI feature keys registered in ai_features.
 * Must match the database exactly: any divergence is a bug.
 */

import { GatewayError } from './errors';

export const AI_FEATURE_KEYS = [
  // Conversation
  'conversation.preview_tts',
  'conversation.create_session',
  'conversation.webrtc_connect',
  'conversation.realtime_usage',
  // Writing
  'writing.correct',
  'writing.correct_review',
  'writing.compare_rewrite',
  'writing.correct_v2_text',
  'writing.generate_topic',
  'writing.explain_grammar',
  'writing.evaluate_rewrite',
  // Pronunciation
  'pronunciation.generate_text',
  'pronunciation.get_azure_token',
  'pronunciation.start_assessment',
  'pronunciation.assess_text',
  // TTS
  'tts.synthesize',
  // Listening — story sessions
  'listening.story_session_generate',
  'listening.story_session_tts',
  // Listening — two-part pipeline
  'listening.two_part_generate',
  'listening.two_part_tts',
  // Listening — episode pipeline
  'listening.episode_generate_story',
  'listening.episode_generate_questions',
  'listening.episode_translate_synopsis',
  'listening.episode_translate_subtitles',
  'listening.episode_synthesize_audio',
] as const;

export type AiFeatureKey = (typeof AI_FEATURE_KEYS)[number];

export type ExecutionLocation = 'backend' | 'frontend' | 'mixed' | 'system';

export interface FeatureMeta {
  isBillable: boolean;
  executionLocation: ExecutionLocation;
}

export const FEATURE_METADATA: Readonly<Record<AiFeatureKey, FeatureMeta>> = {
  'conversation.preview_tts':             { isBillable: true,  executionLocation: 'backend'  },
  'conversation.create_session':          { isBillable: false, executionLocation: 'backend'  },
  'conversation.webrtc_connect':          { isBillable: false, executionLocation: 'frontend' },
  'conversation.realtime_usage':          { isBillable: true,  executionLocation: 'mixed'    },
  'writing.correct':                      { isBillable: true,  executionLocation: 'backend'  },
  'writing.correct_review':               { isBillable: true,  executionLocation: 'backend'  },
  'writing.compare_rewrite':              { isBillable: true,  executionLocation: 'backend'  },
  'writing.correct_v2_text':              { isBillable: true,  executionLocation: 'backend'  },
  'writing.generate_topic':               { isBillable: true,  executionLocation: 'backend'  },
  'writing.explain_grammar':              { isBillable: true,  executionLocation: 'backend'  },
  'writing.evaluate_rewrite':             { isBillable: true,  executionLocation: 'backend'  },
  'pronunciation.generate_text':          { isBillable: true,  executionLocation: 'backend'  },
  'pronunciation.get_azure_token':        { isBillable: false, executionLocation: 'backend'  },
  'pronunciation.start_assessment':       { isBillable: false, executionLocation: 'backend'  },
  'pronunciation.assess_text':            { isBillable: true,  executionLocation: 'frontend' },
  'tts.synthesize':                       { isBillable: true,  executionLocation: 'backend'  },
  'listening.story_session_generate':     { isBillable: true,  executionLocation: 'system'   },
  'listening.story_session_tts':          { isBillable: true,  executionLocation: 'system'   },
  'listening.two_part_generate':          { isBillable: true,  executionLocation: 'system'   },
  'listening.two_part_tts':              { isBillable: true,  executionLocation: 'system'   },
  'listening.episode_generate_story':     { isBillable: true,  executionLocation: 'system'   },
  'listening.episode_generate_questions': { isBillable: true,  executionLocation: 'system'   },
  'listening.episode_translate_synopsis': { isBillable: true,  executionLocation: 'system'   },
  'listening.episode_translate_subtitles':{ isBillable: true,  executionLocation: 'system'   },
  'listening.episode_synthesize_audio':   { isBillable: true,  executionLocation: 'system'   },
};

const FEATURE_KEY_SET: ReadonlySet<string> = new Set(AI_FEATURE_KEYS);

export function isValidFeatureKey(key: string): key is AiFeatureKey {
  return FEATURE_KEY_SET.has(key);
}

export function assertFeatureKey(key: string): AiFeatureKey {
  if (!isValidFeatureKey(key)) {
    throw new GatewayError('AI_GATEWAY_UNKNOWN_FEATURE', `Unknown AI feature key: "${key}"`);
  }
  return key;
}

export function getFeatureMeta(key: AiFeatureKey): FeatureMeta {
  return FEATURE_METADATA[key];
}
