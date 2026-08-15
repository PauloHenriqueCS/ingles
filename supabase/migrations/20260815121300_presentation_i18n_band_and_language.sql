-- =============================================================================
-- MIGRATION: 20260815121300_presentation_i18n_band_and_language
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml
-- (supabase db push). Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO (blockers 14 e 16): tirar do CÓDIGO dois catálogos de apresentação
-- que hoje são mapas hardcoded pt-BR/en:
--   (14) faixas de proficiência ("Iniciante/Intermediário/Avançado") — hoje
--        BAND_LABELS + derivação por pares (sortOrder-1)/2 no route-handler. A
--        faixa passa a ser DADO por nível (proficiency_levels.band_key, semeado
--        pelo framework, sem assumir 1-2/3-4/5-6) e sua LABEL é localizada em
--        proficiency_band_i18n(band_key, interface_language).
--   (16) nomes de idioma (en→"inglês"/"English") — hoje um Record em TS. Passa a
--        viver em language_i18n(language_code, interface_language, display_name).
-- Assim adicionar japonês/uma faixa nova é DADO, não alteração de código.
--
-- COMPATIBILIDADE: aditivo, idempotente. Preserva dados/RLS/grants.
-- =============================================================================

-- ── (14) Faixa de proficiência como dado ────────────────────────────────────
ALTER TABLE public.proficiency_levels
  ADD COLUMN IF NOT EXISTS band_key text;

-- CEFR: A1/A2 → beginner, B1/B2 → intermediate, C1/C2 → advanced. Semeado por
-- CÓDIGO de nível (dado do framework), NÃO por posição — outro framework pode
-- agrupar de outra forma nas suas próprias linhas.
UPDATE public.proficiency_levels SET band_key = 'beginner'     WHERE code IN ('A1', 'A2') AND band_key IS NULL;
UPDATE public.proficiency_levels SET band_key = 'intermediate' WHERE code IN ('B1', 'B2') AND band_key IS NULL;
UPDATE public.proficiency_levels SET band_key = 'advanced'     WHERE code IN ('C1', 'C2') AND band_key IS NULL;

CREATE TABLE IF NOT EXISTS public.proficiency_band_i18n (
  band_key           text NOT NULL,
  interface_language text NOT NULL,
  label              text NOT NULL,
  PRIMARY KEY (band_key, interface_language)
);
ALTER TABLE public.proficiency_band_i18n ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS band_i18n_read ON public.proficiency_band_i18n;
CREATE POLICY band_i18n_read ON public.proficiency_band_i18n FOR SELECT TO authenticated USING (true);

INSERT INTO public.proficiency_band_i18n (band_key, interface_language, label) VALUES
  ('beginner',     'pt-BR', 'Iniciante'),
  ('intermediate', 'pt-BR', 'Intermediário'),
  ('advanced',     'pt-BR', 'Avançado'),
  ('beginner',     'en',    'Beginner'),
  ('intermediate', 'en',    'Intermediate'),
  ('advanced',     'en',    'Advanced')
ON CONFLICT (band_key, interface_language) DO UPDATE SET label = EXCLUDED.label;

-- ── (16) Nomes de idioma como dado ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.language_i18n (
  language_code      text NOT NULL,
  interface_language text NOT NULL,
  display_name       text NOT NULL,
  PRIMARY KEY (language_code, interface_language)
);
ALTER TABLE public.language_i18n ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS language_i18n_read ON public.language_i18n;
CREATE POLICY language_i18n_read ON public.language_i18n FOR SELECT TO authenticated USING (true);

INSERT INTO public.language_i18n (language_code, interface_language, display_name) VALUES
  -- Interface pt-BR
  ('en', 'pt-BR', 'inglês'), ('es', 'pt-BR', 'espanhol'), ('fr', 'pt-BR', 'francês'),
  ('de', 'pt-BR', 'alemão'), ('it', 'pt-BR', 'italiano'), ('ja', 'pt-BR', 'japonês'),
  ('pt-BR', 'pt-BR', 'português brasileiro'),
  -- Interface en
  ('en', 'en', 'English'), ('es', 'en', 'Spanish'), ('fr', 'en', 'French'),
  ('de', 'en', 'German'), ('it', 'en', 'Italian'), ('ja', 'en', 'Japanese'),
  ('pt-BR', 'en', 'Brazilian Portuguese')
ON CONFLICT (language_code, interface_language) DO UPDATE SET display_name = EXCLUDED.display_name;

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
