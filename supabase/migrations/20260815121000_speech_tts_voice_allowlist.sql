-- =============================================================================
-- MIGRATION: 20260815121000_speech_tts_voice_allowlist
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml
-- (supabase db push). Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO: tornar a ALLOWLIST de vozes TTS data-driven por idioma-alvo, fechando
-- o último ponto em que /api/tts dependia de uma allowlist global só de inglês
-- (DEFAULT_ENGLISH_VOICE + ALLOWED_VOICES en-US no código). A partir daqui, cada
-- idioma configura suas próprias vozes permitidas em public.languages; o runtime
-- valida a voz pedida pelo cliente contra essa lista + um formato seguro de token
-- Azure (defesa contra injeção SSML). Inglês V1 recebe as 4 vozes já usadas.
--
-- COMPATIBILIDADE: aditivo, idempotente. Não apaga dados. Preserva RLS/grants.
-- =============================================================================

-- 1. Coluna de allowlist de vozes por idioma (a voz default continua em
--    default_tts_voice e é SEMPRE permitida, mesmo se esta lista ficar vazia).
ALTER TABLE public.languages
  ADD COLUMN IF NOT EXISTS allowed_tts_voices text[] NOT NULL DEFAULT '{}';

-- 2. Semeia as vozes do inglês (as mesmas quatro vetadas que viviam no código).
--    Idempotente: reescreve a lista para 'en'. A linha 'en' já existe
--    (20260815120100) e tem speech_locale/default_tts_voice (20260815120800).
UPDATE public.languages
   SET allowed_tts_voices = ARRAY[
         'en-US-AvaMultilingualNeural',
         'en-US-AndrewMultilingualNeural',
         'en-US-JennyNeural',
         'en-US-GuyNeural'
       ]
 WHERE code = 'en';

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
