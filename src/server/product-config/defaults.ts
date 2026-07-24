import type { ProductConfigValues } from './types';

// Mirrors app_config_definitions.default_value exactly (seeded in
// ingles-dashboad's supabase/migrations/20260717800000_product_config_center.sql),
// which was itself written from an inventory of these same hardcoded values —
// so this fallback is behaviorally identical to what the app does today with
// no config service at all.
export const SAFE_DEFAULTS: ProductConfigValues = {
  'signup.registration': {
    enabled: true,
    startsAt: null,
    endsAt: null,
    closedMessage: 'Novos cadastros estão temporariamente indisponíveis. Tente novamente em breve.',
    reason: '',
  },
  'maintenance.mode': {
    mode: 'off',
    title: '',
    message: '',
    startsAt: null,
    endsAt: null,
    statusUrl: null,
    allowedAdminUserIds: [],
  },
  'audio.azure': {
    defaultVoiceName: 'en-US-AvaMultilingualNeural',
    defaultLocale: 'en-US',
    outputFormat: 'audio-16khz-128kbitrate-mono-mp3',
  },
  'audio.openai_voice': {
    defaultVoiceId: 'coral',
  },
  'features.writing': {
    enabled: true, startsAt: null, endsAt: null,
    unavailableMessage: 'A funcionalidade de escrita está temporariamente indisponível.',
    reason: '',
  },
  'features.conversation': {
    enabled: true, startsAt: null, endsAt: null,
    unavailableMessage: 'A funcionalidade de conversação está temporariamente indisponível.',
    reason: '',
  },
  'features.pronunciation': {
    enabled: true, startsAt: null, endsAt: null,
    unavailableMessage: 'A funcionalidade de pronúncia está temporariamente indisponível.',
    reason: '',
  },
  'features.listening': {
    enabled: true, startsAt: null, endsAt: null,
    unavailableMessage: 'A funcionalidade de listening está temporariamente indisponível.',
    reason: '',
  },
  'features.calendar': {
    enabled: true, startsAt: null, endsAt: null,
    unavailableMessage: 'O calendário está temporariamente indisponível.',
    reason: '',
  },
  'features.evolution': {
    enabled: true, startsAt: null, endsAt: null,
    unavailableMessage: 'A tela de evolução está temporariamente indisponível.',
    reason: '',
  },
  'features.memory': {
    enabled: true, startsAt: null, endsAt: null,
    unavailableMessage: 'O módulo de memória está temporariamente indisponível.',
    reason: '',
  },
  'product.timezone': 'America/Sao_Paulo',
};
