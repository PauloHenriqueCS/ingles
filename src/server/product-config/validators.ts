// SERVER-ONLY: hand-rolled validators for each app_config_definitions value,
// matching the value_schema stored in the dashboard's catalog. Deliberately
// not using a schema library (zod is not a dependency in this repo) — same
// hand-rolled-allowlist convention already used everywhere else here
// (e.g. ALLOWED_VOICES in api/tts.ts).

import type {
  AudioAzureConfig,
  AudioOpenAiVoiceConfig,
  ConfigKey,
  FeatureToggleConfig,
  MaintenanceModeConfig,
  ProductConfigValues,
  SignupRegistrationConfig,
} from './types';

const AZURE_OUTPUT_FORMATS = new Set(['audio-16khz-128kbitrate-mono-mp3', 'audio-24khz-96kbitrate-mono-mp3']);
const OPENAI_VOICE_IDS = new Set(['coral', 'ash', 'alloy', 'ballad', 'echo', 'marin', 'sage', 'shimmer', 'verse']);
const MAINTENANCE_MODES = new Set(['off', 'banner', 'read_only', 'unavailable']);
const IANA_TIMEZONE_RE = /^[A-Za-z_]+\/[A-Za-z_]+(\/[A-Za-z_]+)?$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}
function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}
function isBoundedString(v: unknown, maxLen: number): v is string {
  return typeof v === 'string' && v.length <= maxLen;
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function validateSignupRegistration(v: unknown): SignupRegistrationConfig | null {
  if (!isRecord(v)) return null;
  if (!isBoolean(v.enabled)) return null;
  if (!isNullableString(v.startsAt)) return null;
  if (!isNullableString(v.endsAt)) return null;
  if (!isBoundedString(v.closedMessage, 500)) return null;
  if (typeof v.reason !== 'string') return null;
  return { enabled: v.enabled, startsAt: v.startsAt, endsAt: v.endsAt, closedMessage: v.closedMessage, reason: v.reason };
}

function validateMaintenanceMode(v: unknown): MaintenanceModeConfig | null {
  if (!isRecord(v)) return null;
  if (typeof v.mode !== 'string' || !MAINTENANCE_MODES.has(v.mode)) return null;
  if (!isBoundedString(v.title, 150)) return null;
  if (!isBoundedString(v.message, 1000)) return null;
  if (!isNullableString(v.startsAt)) return null;
  if (!isNullableString(v.endsAt)) return null;
  if (!isNullableString(v.statusUrl)) return null;
  if (!isStringArray(v.allowedAdminUserIds)) return null;
  return {
    mode: v.mode as MaintenanceModeConfig['mode'],
    title: v.title, message: v.message, startsAt: v.startsAt, endsAt: v.endsAt,
    statusUrl: v.statusUrl, allowedAdminUserIds: v.allowedAdminUserIds,
  };
}

function validateAudioAzure(v: unknown): AudioAzureConfig | null {
  if (!isRecord(v)) return null;
  if (typeof v.defaultVoiceName !== 'string' || v.defaultVoiceName.length === 0 || v.defaultVoiceName.length > 200) return null;
  if (typeof v.defaultLocale !== 'string' || !/^[a-z]{2}-[A-Z]{2}$/.test(v.defaultLocale)) return null;
  if (typeof v.outputFormat !== 'string' || !AZURE_OUTPUT_FORMATS.has(v.outputFormat)) return null;
  return {
    defaultVoiceName: v.defaultVoiceName,
    defaultLocale: v.defaultLocale,
    outputFormat: v.outputFormat as AudioAzureConfig['outputFormat'],
  };
}

function validateAudioOpenAiVoice(v: unknown): AudioOpenAiVoiceConfig | null {
  if (!isRecord(v)) return null;
  if (typeof v.defaultVoiceId !== 'string' || !OPENAI_VOICE_IDS.has(v.defaultVoiceId)) return null;
  return { defaultVoiceId: v.defaultVoiceId as AudioOpenAiVoiceConfig['defaultVoiceId'] };
}

function validateFeatureToggle(v: unknown): FeatureToggleConfig | null {
  if (!isRecord(v)) return null;
  if (!isBoolean(v.enabled)) return null;
  if (!isNullableString(v.startsAt)) return null;
  if (!isNullableString(v.endsAt)) return null;
  if (!isBoundedString(v.unavailableMessage, 500)) return null;
  if (typeof v.reason !== 'string') return null;
  return {
    enabled: v.enabled, startsAt: v.startsAt, endsAt: v.endsAt,
    unavailableMessage: v.unavailableMessage, reason: v.reason,
  };
}

function validateTimezone(v: unknown): string | null {
  if (typeof v !== 'string' || !IANA_TIMEZONE_RE.test(v)) return null;
  return v;
}

type ValidatorMap = { [K in ConfigKey]: (v: unknown) => ProductConfigValues[K] | null };

const VALIDATORS: ValidatorMap = {
  'signup.registration': validateSignupRegistration,
  'maintenance.mode': validateMaintenanceMode,
  'audio.azure': validateAudioAzure,
  'audio.openai_voice': validateAudioOpenAiVoice,
  'features.writing': validateFeatureToggle,
  'features.conversation': validateFeatureToggle,
  'features.pronunciation': validateFeatureToggle,
  'features.listening': validateFeatureToggle,
  'features.calendar': validateFeatureToggle,
  'features.evolution': validateFeatureToggle,
  'features.memory': validateFeatureToggle,
  'product.timezone': validateTimezone,
};

export type ValidateSnapshotResult =
  | { valid: true; values: ProductConfigValues }
  | { valid: false; failingKeys: ConfigKey[] };

// Whole-snapshot validation: if ANY known key is missing or malformed, the
// whole snapshot is rejected (not just that key) — simpler and safer than
// partial per-key fallback, and predictable for callers.
export function validateConfigValues(raw: Record<string, unknown>): ValidateSnapshotResult {
  const failingKeys: ConfigKey[] = [];
  const values = {} as ProductConfigValues;

  for (const key of Object.keys(VALIDATORS) as ConfigKey[]) {
    const validator = VALIDATORS[key];
    const result = validator(raw[key]);
    if (result === null) {
      failingKeys.push(key);
      continue;
    }
    (values as Record<ConfigKey, unknown>)[key] = result;
  }

  if (failingKeys.length > 0) return { valid: false, failingKeys };
  return { valid: true, values };
}
