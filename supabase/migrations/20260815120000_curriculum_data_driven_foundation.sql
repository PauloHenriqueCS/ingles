-- =============================================================================
-- MIGRATION: 20260815120000_curriculum_data_driven_foundation
-- Projeto: Orodim
--
-- Aplicada automaticamente por .github/workflows/deploy-production.yml
-- (supabase db push) após o merge na main, e por homologation.yml em develop.
-- Não aplicar manualmente no SQL Editor — isso desalinha o histórico de
-- `supabase migration list`.
-- Esta migration NÃO modifica nem remove dados existentes (apenas cria estruturas
-- novas). É idempotente (IF NOT EXISTS / ON CONFLICT / DROP POLICY IF EXISTS).
--
-- OBJETIVO: fundação de dados para transformar o Orodim de um app acoplado ao
-- inglês em um MOTOR GENÉRICO de aprendizagem orientado a dados. Todo
-- conhecimento pedagógico (idiomas, framework de proficiência, currículo,
-- versões, módulos, recortes internos, capacidades, targets linguísticos,
-- conteúdos transversais, templates de prompt, regras de geração por nível e
-- progresso do usuário) passa a viver no banco, versionado por
-- (learning_language, curriculum_version). O código vira apenas o compositor
-- genérico.
--
-- Distinção de primeira classe entre:
--   learning_language  — língua que o usuário está APRENDENDO (en, es, fr...)
--   interface_language — língua de INTERFACE/instruções/explicações (pt-BR, en...)
-- Nenhuma delas é assumida como fixa. Conteúdo pedagógico exibível é localizável
-- por interface_language em tabelas *_i18n separadas das entidades estruturais.
--
-- NÃO é uma "linguagem de programação no banco": as tabelas guardam DADOS,
-- CONFIGURAÇÃO e TEMPLATES declarativos. Nenhum código executável / eval /
-- DSL arbitrária. A lógica (carregar, validar, interpolar, chamar IA, persistir,
-- progressão) permanece no código.
--
-- Prefixo `curriculum_` / `learning_` para não colidir com o repositório vizinho
-- `ingles-dashboad` (banco compartilhado — ver supabase/MIGRATIONS.md).
-- =============================================================================

-- =============================================================================
-- 1. IDIOMAS E FRAMEWORK DE PROFICIÊNCIA (genéricos, sem inglês hardcoded)
-- =============================================================================

-- Um idioma é apenas um idioma. A mesma tabela serve tanto como learning_language
-- quanto como interface_language (o papel é definido por quem referencia).
CREATE TABLE IF NOT EXISTS public.languages (
  code          text PRIMARY KEY,               -- BCP-47-ish: 'en', 'es', 'pt-BR'
  english_name  text NOT NULL,                  -- rótulo estável p/ admin/logs
  native_name   text NOT NULL,
  script        text NOT NULL DEFAULT 'Latn',
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Framework de proficiência (CEFR é UM framework, não um hardcode). Outro
-- currículo poderia usar outra escala sem tocar no código.
CREATE TABLE IF NOT EXISTS public.proficiency_frameworks (
  id          text PRIMARY KEY,                 -- 'CEFR'
  label       text NOT NULL,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.proficiency_levels (
  framework_id text NOT NULL REFERENCES public.proficiency_frameworks(id) ON DELETE CASCADE,
  code         text NOT NULL,                   -- 'A1'..'C2' (ou qualquer escala)
  sort_order   integer NOT NULL,               -- ordem é DADO, nunca embutida no id
  label        text,
  PRIMARY KEY (framework_id, code)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_proficiency_levels_order
  ON public.proficiency_levels (framework_id, sort_order);

-- =============================================================================
-- 2. CURRÍCULO E VERSIONAMENTO
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.curricula (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              text NOT NULL,                -- 'orodim-english'
  learning_language text NOT NULL REFERENCES public.languages(code),
  framework_id      text NOT NULL REFERENCES public.proficiency_frameworks(id),
  title             text NOT NULL,               -- rótulo administrativo
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_curricula_slug ON public.curricula (slug);
CREATE INDEX IF NOT EXISTS idx_curricula_learning_language ON public.curricula (learning_language);

-- Versões publicáveis. O usuário segue uma versão específica; publicar uma nova
-- versão nunca reinterpreta silenciosamente o histórico de quem está na anterior.
CREATE TABLE IF NOT EXISTS public.curriculum_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  curriculum_id  uuid NOT NULL REFERENCES public.curricula(id) ON DELETE CASCADE,
  version        integer NOT NULL,
  status         text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'published', 'archived')),
  published_at   timestamptz,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (curriculum_id, version)
);

CREATE INDEX IF NOT EXISTS idx_curriculum_versions_status
  ON public.curriculum_versions (curriculum_id, status);

-- =============================================================================
-- 3. MÓDULOS (visíveis ao usuário no macro) + i18n
-- =============================================================================
-- Entidade estrutural separada do conteúdo localizado. O `module_key` é estável
-- e semântico (ex.: 'A1.SELFINTRO'); a ORDEM vive em `sort_order`, nunca no id.

CREATE TABLE IF NOT EXISTS public.curriculum_modules (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  curriculum_version_id uuid NOT NULL REFERENCES public.curriculum_versions(id) ON DELETE CASCADE,
  module_key            text NOT NULL,           -- 'A1.SELFINTRO'
  level_code            text NOT NULL,           -- 'A1' (dentro do framework do currículo)
  sort_order            integer NOT NULL,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (curriculum_version_id, module_key)
);

CREATE INDEX IF NOT EXISTS idx_curriculum_modules_level
  ON public.curriculum_modules (curriculum_version_id, level_code, sort_order);

-- Conteúdo pedagógico exibível, localizado por interface_language.
CREATE TABLE IF NOT EXISTS public.curriculum_module_i18n (
  module_id          uuid NOT NULL REFERENCES public.curriculum_modules(id) ON DELETE CASCADE,
  interface_language text NOT NULL REFERENCES public.languages(code),
  title              text NOT NULL,              -- "Falar sobre si mesmo"
  capability         text,                       -- "apresentar-se e trocar informações pessoais"
  description        text,
  PRIMARY KEY (module_id, interface_language)
);

-- =============================================================================
-- 4. RECORTES INTERNOS (subtopics) — INTERNOS, não exibidos na UI — + i18n
-- =============================================================================
-- ID semântico e estável (ex.: 'B1.OPINION.AGREE_DISAGREE'); nunca posicional.

CREATE TABLE IF NOT EXISTS public.curriculum_subtopics (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  curriculum_version_id uuid NOT NULL REFERENCES public.curriculum_versions(id) ON DELETE CASCADE,
  module_id             uuid NOT NULL REFERENCES public.curriculum_modules(id) ON DELETE CASCADE,
  subtopic_key          text NOT NULL,           -- 'B1.OPINION.AGREE_DISAGREE'
  level_code            text NOT NULL,
  sort_order            integer NOT NULL,        -- ordem dentro do módulo
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (curriculum_version_id, subtopic_key)
);

CREATE INDEX IF NOT EXISTS idx_curriculum_subtopics_module
  ON public.curriculum_subtopics (module_id, sort_order);

-- Capacidade comunicativa do recorte, localizada.
CREATE TABLE IF NOT EXISTS public.curriculum_subtopic_i18n (
  subtopic_id        uuid NOT NULL REFERENCES public.curriculum_subtopics(id) ON DELETE CASCADE,
  interface_language text NOT NULL REFERENCES public.languages(code),
  capability         text NOT NULL,              -- "Concordar ou discordar de uma opinião..."
  PRIMARY KEY (subtopic_id, interface_language)
);

-- Alvos linguísticos de suporte (a "Suporte linguístico" do recorte). São
-- targets de geração — o motor injeta no prompt. `kind` permite diferenciar
-- gramática/vocabulário/função sem que o CÓDIGO conheça nomes específicos.
CREATE TABLE IF NOT EXISTS public.curriculum_language_targets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subtopic_id  uuid NOT NULL REFERENCES public.curriculum_subtopics(id) ON DELETE CASCADE,
  kind         text NOT NULL DEFAULT 'support',  -- 'support'|'grammar'|'vocabulary'|'function'
  sort_order   integer NOT NULL DEFAULT 0,
  target_text  text NOT NULL,                    -- ex.: "Second Conditional", "would"
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_curriculum_language_targets_subtopic
  ON public.curriculum_language_targets (subtopic_id, sort_order);

-- Chave natural para permitir upsert idempotente no seed (re-seed não duplica).
CREATE UNIQUE INDEX IF NOT EXISTS uq_curriculum_language_targets_natural
  ON public.curriculum_language_targets (subtopic_id, kind, sort_order);

-- =============================================================================
-- 5. CONTEÚDOS TRANSVERSAIS (fora da sequência obrigatória; NÃO bloqueiam)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.curriculum_transversal_topics (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  curriculum_version_id uuid NOT NULL REFERENCES public.curriculum_versions(id) ON DELETE CASCADE,
  topic_key             text NOT NULL,           -- 'TRANS.ARTICLES'
  min_level_code        text,                    -- ex.: quantificadores a partir de 'A2'
  sort_order            integer NOT NULL DEFAULT 0,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (curriculum_version_id, topic_key)
);

CREATE TABLE IF NOT EXISTS public.curriculum_transversal_topic_i18n (
  topic_id           uuid NOT NULL REFERENCES public.curriculum_transversal_topics(id) ON DELETE CASCADE,
  interface_language text NOT NULL REFERENCES public.languages(code),
  label              text NOT NULL,
  description        text,
  PRIMARY KEY (topic_id, interface_language)
);

-- =============================================================================
-- 6. TEMPLATES DE PROMPT (data-driven; versionados; por learning+interface lang)
-- =============================================================================
-- Placeholders declarativos {{...}}; interpolados pelo compositor no código
-- (sem eval). `required_placeholders` permite validação estática. Não há
-- fallback pedagógico em inglês no código: template ausente = erro operacional.

CREATE TABLE IF NOT EXISTS public.prompt_templates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key          text NOT NULL,           -- 'writing.generate_topic' (== ai_features.feature_key)
  learning_language     text NOT NULL REFERENCES public.languages(code),
  interface_language    text NOT NULL REFERENCES public.languages(code),
  version               integer NOT NULL DEFAULT 1,
  status                text NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'published', 'archived')),
  model                 text,                    -- opcional; NULL = decidido pelo código/config
  temperature           numeric,
  system_body           text NOT NULL,           -- corpo do system prompt com {{placeholders}}
  user_body             text,                    -- corpo opcional do user message com {{placeholders}}
  required_placeholders text[] NOT NULL DEFAULT '{}',
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_key, learning_language, interface_language, version)
);

CREATE INDEX IF NOT EXISTS idx_prompt_templates_lookup
  ON public.prompt_templates (template_key, learning_language, interface_language, status);

-- =============================================================================
-- 7. REGRAS DE GERAÇÃO POR NÍVEL (declarativas, jsonb)
-- =============================================================================
-- Substitui os Record<CEFRLevel,...> hardcoded (word counts, budgets, difficulty)
-- e as rubricas A1–C2 inline. `rule_value` é DADO declarativo, não código.
-- Texto de orientação localizável fica em `guidance` dentro do jsonb por
-- interface_language OU é resolvido via prompt_templates — o código só lê.

CREATE TABLE IF NOT EXISTS public.level_generation_rules (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  curriculum_version_id uuid NOT NULL REFERENCES public.curriculum_versions(id) ON DELETE CASCADE,
  level_code            text NOT NULL,
  activity_type         text NOT NULL,           -- 'writing'|'listening'|'pronunciation'|'conversation'|'*'
  rule_value            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (curriculum_version_id, level_code, activity_type)
);

-- =============================================================================
-- 8. PREFERÊNCIAS E PROGRESSO DO USUÁRIO (genéricos)
-- =============================================================================
-- IMPORTANTE: currículo ≠ plano comercial. Estas tabelas NÃO tocam quota/billing.

-- Modalidades curriculares que o usuário escolhe percorrer. Review NÃO entra.
-- Se marcada, a modalidade É requisito de progressão (menu = regra).
CREATE TABLE IF NOT EXISTS public.user_curriculum_preferences (
  user_id               uuid NOT NULL,
  curriculum_version_id uuid NOT NULL REFERENCES public.curriculum_versions(id),
  learning_language     text NOT NULL REFERENCES public.languages(code),
  interface_language    text NOT NULL REFERENCES public.languages(code),
  practice_writing      boolean NOT NULL DEFAULT true,
  practice_listening    boolean NOT NULL DEFAULT true,
  practice_pronunciation boolean NOT NULL DEFAULT true,
  practice_conversation boolean NOT NULL DEFAULT false,  -- opcional (consome minutos)
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, curriculum_version_id)
);

-- Posição do usuário no currículo.
CREATE TABLE IF NOT EXISTS public.user_curriculum_progress (
  user_id               uuid NOT NULL,
  curriculum_version_id uuid NOT NULL REFERENCES public.curriculum_versions(id),
  current_level_code    text,
  current_module_id     uuid REFERENCES public.curriculum_modules(id),
  current_subtopic_id   uuid REFERENCES public.curriculum_subtopics(id),
  status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'curriculum_completed')),
  started_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, curriculum_version_id)
);

-- Uma prática VÁLIDA registrada por (usuário, recorte, modalidade). "Prática" e
-- não "domínio": nunca cria mastery_score fictício. `source_ref` liga à
-- atividade real (writing entry, listening progress, etc.) para auditoria.
CREATE TABLE IF NOT EXISTS public.user_subtopic_modality_progress (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL,
  subtopic_id         uuid NOT NULL REFERENCES public.curriculum_subtopics(id) ON DELETE CASCADE,
  modality            text NOT NULL
                        CHECK (modality IN ('writing', 'listening', 'pronunciation', 'conversation')),
  status              text NOT NULL DEFAULT 'practiced'
                        CHECK (status IN ('not_started', 'active', 'practiced')),
  source_ref          uuid,
  first_practiced_at  timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, subtopic_id, modality)
);

CREATE INDEX IF NOT EXISTS idx_user_subtopic_modality_progress_lookup
  ON public.user_subtopic_modality_progress (user_id, subtopic_id);

-- Recorte concluído (derivado: todas as modalidades selecionadas praticadas).
CREATE TABLE IF NOT EXISTS public.user_subtopic_completion (
  user_id       uuid NOT NULL,
  subtopic_id   uuid NOT NULL REFERENCES public.curriculum_subtopics(id) ON DELETE CASCADE,
  completed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, subtopic_id)
);

-- =============================================================================
-- 9. RLS + GRANTS
-- =============================================================================
-- Padrão do projeto (ver 20260723..._revoke_new_tables_default_grants): revoga
-- grants default e concede explicitamente. Conteúdo de currículo: leitura para
-- authenticated (somente versões publicadas, via policy). Tabelas de usuário:
-- somente o dono (auth.uid()).

-- --- Conteúdo (leitura pública autenticada) ---
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'languages','proficiency_frameworks','proficiency_levels',
    'curricula','curriculum_versions','curriculum_modules','curriculum_module_i18n',
    'curriculum_subtopics','curriculum_subtopic_i18n','curriculum_language_targets',
    'curriculum_transversal_topics','curriculum_transversal_topic_i18n',
    'prompt_templates','level_generation_rules'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon;', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated;', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role;', t);
  END LOOP;
END $$;

-- Leitura de conteúdo estrutural para authenticated (idempotente).
DROP POLICY IF EXISTS curriculum_content_read ON public.languages;
CREATE POLICY curriculum_content_read ON public.languages FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS curriculum_content_read ON public.proficiency_frameworks;
CREATE POLICY curriculum_content_read ON public.proficiency_frameworks FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS curriculum_content_read ON public.proficiency_levels;
CREATE POLICY curriculum_content_read ON public.proficiency_levels FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS curriculum_content_read ON public.curricula;
CREATE POLICY curriculum_content_read ON public.curricula FOR SELECT TO authenticated USING (is_active);
DROP POLICY IF EXISTS curriculum_content_read ON public.curriculum_versions;
CREATE POLICY curriculum_content_read ON public.curriculum_versions FOR SELECT TO authenticated USING (status = 'published');
DROP POLICY IF EXISTS curriculum_content_read ON public.curriculum_modules;
CREATE POLICY curriculum_content_read ON public.curriculum_modules FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS curriculum_content_read ON public.curriculum_module_i18n;
CREATE POLICY curriculum_content_read ON public.curriculum_module_i18n FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS curriculum_content_read ON public.curriculum_subtopics;
CREATE POLICY curriculum_content_read ON public.curriculum_subtopics FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS curriculum_content_read ON public.curriculum_subtopic_i18n;
CREATE POLICY curriculum_content_read ON public.curriculum_subtopic_i18n FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS curriculum_content_read ON public.curriculum_language_targets;
CREATE POLICY curriculum_content_read ON public.curriculum_language_targets FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS curriculum_content_read ON public.curriculum_transversal_topics;
CREATE POLICY curriculum_content_read ON public.curriculum_transversal_topics FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS curriculum_content_read ON public.curriculum_transversal_topic_i18n;
CREATE POLICY curriculum_content_read ON public.curriculum_transversal_topic_i18n FOR SELECT TO authenticated USING (true);
-- prompt_templates: contêm instruções de geração; leitura só service_role
-- (backend). Sem policy para authenticated → RLS nega por padrão.
DROP POLICY IF EXISTS curriculum_content_read ON public.level_generation_rules;
CREATE POLICY curriculum_content_read ON public.level_generation_rules FOR SELECT TO authenticated USING (true);

-- prompt_templates precisa REVOGAR o SELECT de authenticated concedido no loop.
REVOKE SELECT ON public.prompt_templates FROM authenticated;

-- --- Tabelas de usuário (dono) ---
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'user_curriculum_preferences','user_curriculum_progress',
    'user_subtopic_modality_progress','user_subtopic_completion'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon;', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated;', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role;', t);
  END LOOP;
END $$;

-- Dono lê o próprio progresso. Escrita curricular é server-authoritative
-- (service_role via RPC/endpoints), então NÃO concedemos INSERT/UPDATE a
-- authenticated aqui — a progressão é aplicada pelo backend, evitando trapaça.
DROP POLICY IF EXISTS user_owns_row ON public.user_curriculum_preferences;
CREATE POLICY user_owns_row ON public.user_curriculum_preferences FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS user_owns_row ON public.user_curriculum_progress;
CREATE POLICY user_owns_row ON public.user_curriculum_progress FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS user_owns_row ON public.user_subtopic_modality_progress;
CREATE POLICY user_owns_row ON public.user_subtopic_modality_progress FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS user_owns_row ON public.user_subtopic_completion;
CREATE POLICY user_owns_row ON public.user_subtopic_completion FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
