// SERVER-ONLY: shapes for the published product configuration (dashboard's
// app_config_definitions catalog). Mirrors the 12 real definition keys —
// never add a key here that doesn't exist in app_config_definitions.

export type ConfigEnvironment = 'development' | 'staging' | 'production';

export interface SignupRegistrationConfig {
  enabled: boolean;
  startsAt: string | null;
  endsAt: string | null;
  closedMessage: string;
  reason: string;
}

export type MaintenanceMode = 'off' | 'banner' | 'read_only' | 'unavailable';

export interface MaintenanceModeConfig {
  mode: MaintenanceMode;
  title: string;
  message: string;
  startsAt: string | null;
  endsAt: string | null;
  statusUrl: string | null;
  allowedAdminUserIds: string[];
}

export type AzureOutputFormat = 'audio-16khz-128kbitrate-mono-mp3' | 'audio-24khz-96kbitrate-mono-mp3';

export interface AudioAzureConfig {
  defaultVoiceName: string;
  defaultLocale: string;
  outputFormat: AzureOutputFormat;
}

export type OpenAiVoiceId = 'coral' | 'ash' | 'alloy' | 'ballad' | 'echo' | 'marin' | 'sage' | 'shimmer' | 'verse';

export interface AudioOpenAiVoiceConfig {
  defaultVoiceId: OpenAiVoiceId;
}

export interface FeatureToggleConfig {
  enabled: boolean;
  startsAt: string | null;
  endsAt: string | null;
  unavailableMessage: string;
  reason: string;
}

export interface ProductConfigValues {
  'signup.registration': SignupRegistrationConfig;
  'maintenance.mode': MaintenanceModeConfig;
  'audio.azure': AudioAzureConfig;
  'audio.openai_voice': AudioOpenAiVoiceConfig;
  'features.writing': FeatureToggleConfig;
  'features.conversation': FeatureToggleConfig;
  'features.pronunciation': FeatureToggleConfig;
  'features.listening': FeatureToggleConfig;
  'features.calendar': FeatureToggleConfig;
  'features.evolution': FeatureToggleConfig;
  'features.memory': FeatureToggleConfig;
  'product.timezone': string;
}

export type ConfigKey = keyof ProductConfigValues;

// exposure = 'public' in app_config_definitions — safe to ship to the browser.
// audio.azure / audio.openai_voice are exposure = 'server_only' and must
// never appear in a response the frontend can read.
export const PUBLIC_CONFIG_KEYS: ConfigKey[] = [
  'signup.registration',
  'maintenance.mode',
  'features.writing',
  'features.conversation',
  'features.pronunciation',
  'features.listening',
  'features.calendar',
  'features.evolution',
  'features.memory',
  'product.timezone',
];

export const SERVER_ONLY_CONFIG_KEYS: ConfigKey[] = ['audio.azure', 'audio.openai_voice'];

export type ConfigSource = 'db' | 'fallback_no_version' | 'fallback_error' | 'fallback_invalid_schema';

export interface ResolvedProductConfig {
  environment: ConfigEnvironment;
  values: ProductConfigValues;
  versionNumber: number;
  configHash: string;
  usingFallback: boolean;
  schemaValid: boolean;
  source: ConfigSource;
  loadedAt: number;
  error?: string;
}
