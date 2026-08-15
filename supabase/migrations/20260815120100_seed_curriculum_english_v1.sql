-- =============================================================================
-- MIGRATION: 20260815120100_seed_curriculum_english_v1
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml.
-- Não aplicar manualmente no SQL Editor.
--
-- GERADO por scripts/curriculum/generate-curriculum-seed.mjs a partir de
-- supabase/curriculum_source/*.md (fonte de verdade do currículo). NÃO editar
-- à mão — regenerar rodando o script. Idempotente (ON CONFLICT DO UPDATE).
--
-- Carrega o currículo inglês V1: 6 níveis, 48 módulos, 176 recortes
-- internos (A1 29/A2 29/B1 28/B2 27/C1 30/C2 33) e 6 conteúdos transversais.
-- learning_language=en, interface_language(i18n)=pt-BR.
-- =============================================================================

-- Idiomas disponíveis (papel definido por quem referencia). Nenhum é "a língua base".
INSERT INTO public.languages (code, english_name, native_name) VALUES ('pt-BR', 'Brazilian Portuguese', 'Português (Brasil)')
  ON CONFLICT (code) DO UPDATE SET english_name=EXCLUDED.english_name, native_name=EXCLUDED.native_name, updated_at=now();
INSERT INTO public.languages (code, english_name, native_name) VALUES ('en', 'English', 'English')
  ON CONFLICT (code) DO UPDATE SET english_name=EXCLUDED.english_name, native_name=EXCLUDED.native_name, updated_at=now();
INSERT INTO public.languages (code, english_name, native_name) VALUES ('es', 'Spanish', 'Español')
  ON CONFLICT (code) DO UPDATE SET english_name=EXCLUDED.english_name, native_name=EXCLUDED.native_name, updated_at=now();
INSERT INTO public.languages (code, english_name, native_name) VALUES ('fr', 'French', 'Français')
  ON CONFLICT (code) DO UPDATE SET english_name=EXCLUDED.english_name, native_name=EXCLUDED.native_name, updated_at=now();
INSERT INTO public.languages (code, english_name, native_name) VALUES ('it', 'Italian', 'Italiano')
  ON CONFLICT (code) DO UPDATE SET english_name=EXCLUDED.english_name, native_name=EXCLUDED.native_name, updated_at=now();
INSERT INTO public.languages (code, english_name, native_name) VALUES ('de', 'German', 'Deutsch')
  ON CONFLICT (code) DO UPDATE SET english_name=EXCLUDED.english_name, native_name=EXCLUDED.native_name, updated_at=now();

-- Framework de proficiência (CEFR é UM framework — dado, não hardcode).
INSERT INTO public.proficiency_frameworks (id, label, description) VALUES ('CEFR','CEFR','Common European Framework of Reference')
  ON CONFLICT (id) DO UPDATE SET label=EXCLUDED.label, description=EXCLUDED.description;
INSERT INTO public.proficiency_levels (framework_id, code, sort_order, label) VALUES ('CEFR', 'A1', 1, 'A1')
  ON CONFLICT (framework_id, code) DO UPDATE SET sort_order=EXCLUDED.sort_order, label=EXCLUDED.label;
INSERT INTO public.proficiency_levels (framework_id, code, sort_order, label) VALUES ('CEFR', 'A2', 2, 'A2')
  ON CONFLICT (framework_id, code) DO UPDATE SET sort_order=EXCLUDED.sort_order, label=EXCLUDED.label;
INSERT INTO public.proficiency_levels (framework_id, code, sort_order, label) VALUES ('CEFR', 'B1', 3, 'B1')
  ON CONFLICT (framework_id, code) DO UPDATE SET sort_order=EXCLUDED.sort_order, label=EXCLUDED.label;
INSERT INTO public.proficiency_levels (framework_id, code, sort_order, label) VALUES ('CEFR', 'B2', 4, 'B2')
  ON CONFLICT (framework_id, code) DO UPDATE SET sort_order=EXCLUDED.sort_order, label=EXCLUDED.label;
INSERT INTO public.proficiency_levels (framework_id, code, sort_order, label) VALUES ('CEFR', 'C1', 5, 'C1')
  ON CONFLICT (framework_id, code) DO UPDATE SET sort_order=EXCLUDED.sort_order, label=EXCLUDED.label;
INSERT INTO public.proficiency_levels (framework_id, code, sort_order, label) VALUES ('CEFR', 'C2', 6, 'C2')
  ON CONFLICT (framework_id, code) DO UPDATE SET sort_order=EXCLUDED.sort_order, label=EXCLUDED.label;

-- Currículo + versão publicada.
INSERT INTO public.curricula (slug, learning_language, framework_id, title)
  VALUES ('orodim-english', 'en', 'CEFR', 'Orodim English (A1–C2)')
  ON CONFLICT (slug) DO UPDATE SET learning_language=EXCLUDED.learning_language, framework_id=EXCLUDED.framework_id, title=EXCLUDED.title, updated_at=now();
INSERT INTO public.curriculum_versions (curriculum_id, version, status, published_at, notes)
  SELECT c.id, 1, 'published', now(), 'English V1 (176 recortes)' FROM public.curricula c WHERE c.slug='orodim-english'
  ON CONFLICT (curriculum_id, version) DO UPDATE SET status=EXCLUDED.status, notes=EXCLUDED.notes, updated_at=now();

DO $seed$
DECLARE
  v_ver uuid;
  v_mod uuid;
  v_sub uuid;
BEGIN
  SELECT cv.id INTO v_ver FROM public.curriculum_versions cv
    JOIN public.curricula c ON c.id = cv.curriculum_id
    WHERE c.slug='orodim-english' AND cv.version=1;
  IF v_ver IS NULL THEN RAISE EXCEPTION 'curriculum version not found for seed'; END IF;

  -- MODULE A1.SELFINTRO
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'A1.SELFINTRO', 'A1', 1)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Falar sobre si mesmo', 'apresentar-se e trocar informações pessoais')
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.SELFINTRO.GREET_INTRODUCE', 'A1', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Cumprimentar e apresentar-se')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'saudações')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'verb to be')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 2, 'pronomes pessoais')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.SELFINTRO.SHARE_PERSONAL_DETAILS', 'A1', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Compartilhar informações pessoais básicas')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'nome')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'idade')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 2, 'nacionalidade')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 3, 'profissão')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 4, 'números')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.SELFINTRO.EXCHANGE_PERSONAL_INFO', 'A1', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Fazer e responder perguntas pessoais básicas')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'what / where / how old')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'respostas curtas')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.SELFINTRO.SPELL_CONFIRM_DETAILS', 'A1', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Soletrar e confirmar dados pessoais em contexto')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'soletração do nome')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'números')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 2, 'confirmação em cadastro/check-in')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE A1.ROUTINE
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'A1.ROUTINE', 'A1', 2)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Minha vida e minha rotina', 'descrever um dia normal')
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.ROUTINE.DESCRIBE_DAILY_ROUTINE', 'A1', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Descrever ações de uma rotina comum')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Present Simple')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'verbos cotidianos')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.ROUTINE.PLACE_ROUTINE_IN_TIME', 'A1', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Situar a rotina no tempo')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'horários')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'períodos do dia')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 2, 'dias da semana e datas em contexto')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.ROUTINE.EXPRESS_FREQUENCY', 'A1', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Dizer com que frequência faz algo')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'always')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'usually')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 2, 'sometimes')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 3, 'never')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.ROUTINE.EXCHANGE_ROUTINE_INFO', 'A1', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Perguntar e conversar sobre a rotina de outra pessoa')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'do / does')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'perguntas e respostas no Present Simple')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE A1.PEOPLE
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'A1.PEOPLE', 'A1', 3)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Pessoas ao meu redor', 'falar sobre família, amigos e pessoas próximas')
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.PEOPLE.INTRODUCE_RELATIONSHIPS', 'A1', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Apresentar pessoas e explicar relações')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'família')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'amigos')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 2, 'relacionamentos')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.PEOPLE.EXPRESS_POSSESSION', 'A1', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Falar sobre o que as pessoas têm e sobre posse')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'have / have got')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'possessive ''s')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.PEOPLE.DESCRIBE_PERSON', 'A1', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Descrever aparência e personalidade de alguém')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'adjetivos básicos de aparência e personalidade')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE A1.PLACES
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'A1.PLACES', 'A1', 4)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Onde eu vivo', 'descrever casa, bairro e lugares; entender e dar direções simples')
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.PLACES.DESCRIBE_HOME_SPACE', 'A1', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Descrever uma casa, cômodo ou espaço')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'there is / there are')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'demonstrativos')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.PLACES.LOCATE_OBJECTS_PLACES', 'A1', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Localizar objetos e lugares')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'preposições de lugar')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.PLACES.TALK_NEIGHBORHOOD_CITY', 'A1', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Falar sobre lugares do bairro e da cidade')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'lugares da cidade')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'localização')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.PLACES.GIVE_FOLLOW_DIRECTIONS', 'A1', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Entender e dar direções simples')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'imperativo: turn left')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'go straight')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE A1.INTERESTS
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'A1.INTERESTS', 'A1', 5)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Gostos, interesses e habilidades', 'falar sobre o que gosta e o que sabe fazer')
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.INTERESTS.EXPRESS_LIKES_INTERESTS', 'A1', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Falar sobre gostos, hobbies e interesses')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'like / love / hate + ing')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'hobbies')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 2, 'esportes')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 3, 'lazer')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.INTERESTS.EXPRESS_ABILITIES', 'A1', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Dizer o que sabe ou não sabe fazer')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'can / can''t')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.INTERESTS.EXCHANGE_INTERESTS', 'A1', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Perguntar e conversar sobre interesses e habilidades de outra pessoa')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'perguntas simples sobre gostos e capacidades')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE A1.FOOD_SHOPPING
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'A1.FOOD_SHOPPING', 'A1', 6)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Comida, compras e necessidades', 'resolver situações básicas de consumo')
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.FOOD_SHOPPING.TALK_FOOD_MEALS', 'A1', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Falar sobre comidas, bebidas e refeições')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'vocabulário de alimentação')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.FOOD_SHOPPING.HANDLE_QUANTITIES', 'A1', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Falar e perguntar sobre quantidades')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'countable / uncountable')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'some / any')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 2, 'how much / how many')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.FOOD_SHOPPING.ORDER_FOOD_DRINK', 'A1', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Fazer pedidos simples de comida e bebida')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'I''d like / Can I have')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.FOOD_SHOPPING.HANDLE_PRICES_PURCHASES', 'A1', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Perguntar, entender e falar sobre preços em compras')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'preços')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'números grandes')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 2, 'linguagem básica de compra')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE A1.NOW_HABITS
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'A1.NOW_HABITS', 'A1', 7)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Agora e sempre', 'descrever o que está acontecendo agora e diferenciar de hábitos')
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.NOW_HABITS.DESCRIBE_CURRENT_TEMPORARY', 'A1', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Descrever ações atuais e situações temporárias')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Present Continuous')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'I''m staying..')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 2, 'I''m learning..')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.NOW_HABITS.DISTINGUISH_HABIT_NOW', 'A1', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Diferenciar hábito de ação do momento')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Present Simple × Present Continuous')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.NOW_HABITS.EXCHANGE_CURRENT_ACTIONS', 'A1', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Perguntar e responder sobre o que está acontecendo')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Present Continuous em interação')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE A1.PAST_FUTURE
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'A1.PAST_FUTURE', 'A1', 8)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Ontem e amanhã', 'contar acontecimentos passados simples e planos imediatos')
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.PAST_FUTURE.TALK_PAST_STATES_ACTIONS', 'A1', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Falar sobre estados e ações passadas simples')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'was / were')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'Past Simple com verbos regulares e irregulares frequentes')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.PAST_FUTURE.RECOUNT_RECENT_EVENT', 'A1', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Contar de forma simples um acontecimento recente')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Past Simple em narrativa curta')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'fim de semana e férias')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.PAST_FUTURE.TALK_IMMEDIATE_PLANS', 'A1', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Falar sobre planos imediatos')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'going to')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A1.PAST_FUTURE.LINK_PAST_AND_PLANS', 'A1', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Relacionar algo que fez com algo que pretende fazer')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Past Simple + going to')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE A2.PAST_EVENTS
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'A2.PAST_EVENTS', 'A2', 1)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Contando acontecimentos', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.PAST_EVENTS.NARRATE_PAST_SEQUENCE', 'A2', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Relatar uma sequência de eventos passados')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Past Simple consolidado')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.PAST_EVENTS.DESCRIBE_BACKGROUND_EVENT', 'A2', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Relacionar uma ação em andamento a um acontecimento')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Past Continuous')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'when / while')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.PAST_EVENTS.ORGANIZE_PAST_NARRATIVE', 'A2', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Organizar uma narrativa em ordem clara')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'first')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'then')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 2, 'after that')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 3, 'finally')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.PAST_EVENTS.TELL_COMPLETE_SHORT_EVENT', 'A2', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Contar um pequeno acontecimento com contexto e desfecho')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Past Simple + Past Continuous')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE A2.LIFE_EXPERIENCES
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'A2.LIFE_EXPERIENCES', 'A2', 2)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Experiências da vida', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.LIFE_EXPERIENCES.EXCHANGE_LIFE_EXPERIENCES', 'A2', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Perguntar e falar sobre experiências de vida')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Present Perfect')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'ever / never')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 2, 'been to')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.LIFE_EXPERIENCES.DISTINGUISH_EXPERIENCE_EVENT', 'A2', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Distinguir experiência geral de acontecimento com tempo definido')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Present Perfect × Past Simple introdutório')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE A2.PLANS_DECISIONS
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'A2.PLANS_DECISIONS', 'A2', 3)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Planos e decisões', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.PLANS_DECISIONS.EXPRESS_INTENTIONS', 'A2', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Falar sobre intenções futuras')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'going to')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.PLANS_DECISIONS.TALK_FIXED_ARRANGEMENTS', 'A2', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Falar sobre compromissos já combinados')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Present Continuous para futuro')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.PLANS_DECISIONS.MAKE_SPONTANEOUS_DECISIONS', 'A2', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Tomar e comunicar decisões espontâneas')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'will')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.PLANS_DECISIONS.MAKE_SIMPLE_PREDICTIONS', 'A2', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Fazer previsões simples')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'will')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.PLANS_DECISIONS.INVITE_COORDINATE_PLANS', 'A2', 5)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Fazer, aceitar ou recusar convites e combinar planos')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'linguagem de convites + formas futuras do módulo')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE A2.TRAVEL_SERVICES
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'A2.TRAVEL_SERVICES', 'A2', 4)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Viagens e serviços', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.TRAVEL_SERVICES.MAKE_POLITE_REQUESTS', 'A2', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Fazer pedidos educados em serviços')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'can / could')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.TRAVEL_SERVICES.ASK_FOR_INFORMATION', 'A2', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Pedir informações de forma direta ou indiretamente educada')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'perguntas de localização/funcionamento')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'Could you tell me where...?')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.TRAVEL_SERVICES.EXPLAIN_TRAVEL_PROBLEM', 'A2', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Explicar um problema simples durante uma viagem')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'hotel')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'aeroporto')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 2, 'transporte')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 3, 'necessidades e problemas')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.TRAVEL_SERVICES.HANDLE_SERVICE_INTERACTION', 'A2', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Resolver uma interação completa em viagem ou serviço')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'integração de pedidos')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'informações e explicação de problemas')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE A2.WORK_STUDY_OBLIGATIONS
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'A2.WORK_STUDY_OBLIGATIONS', 'A2', 5)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Trabalho, estudos e obrigações', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.WORK_STUDY_OBLIGATIONS.DESCRIBE_RESPONSIBILITIES', 'A2', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Falar sobre trabalho, estudos e responsabilidades')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'empregos')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'educação')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 2, 'responsabilidades')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.WORK_STUDY_OBLIGATIONS.EXPRESS_OBLIGATION', 'A2', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Expressar obrigação ou ausência de obrigação')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'have to / don''t have to')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.WORK_STUDY_OBLIGATIONS.EXPLAIN_RULES_PROHIBITIONS', 'A2', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Explicar regras e proibições')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'must / mustn''t')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE A2.COMPARE_CHOOSE
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'A2.COMPARE_CHOOSE', 'A2', 6)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Escolher e comparar', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.COMPARE_CHOOSE.COMPARE_OPTIONS', 'A2', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Comparar pessoas, objetos ou lugares')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'comparativos')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.COMPARE_CHOOSE.IDENTIFY_EXTREMES', 'A2', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Identificar extremos dentro de um grupo')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'superlativos')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.COMPARE_CHOOSE.EXPRESS_PREFERENCES', 'A2', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Expressar preferências entre opções')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'prefer + noun / ing')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.COMPARE_CHOOSE.CHOOSE_AND_JUSTIFY', 'A2', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Fazer uma escolha e justificá-la com uma vantagem simples')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'comparação')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'preferência e justificativa')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE A2.PROBLEMS_ADVICE
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'A2.PROBLEMS_ADVICE', 'A2', 7)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Problemas e conselhos', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.PROBLEMS_ADVICE.DESCRIBE_PROBLEM', 'A2', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Descrever um problema cotidiano ou de saúde')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'vocabulário de problemas e saúde')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.PROBLEMS_ADVICE.GIVE_ADVICE_OPTIONS', 'A2', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Dar conselhos e oferecer alternativas')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'should / shouldn''t')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'why don''t you...?')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 2, 'you could..')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.PROBLEMS_ADVICE.EXPLAIN_CAUSE_CONSEQUENCE', 'A2', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Explicar causa e consequência básica de um problema')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'because / so')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.PROBLEMS_ADVICE.SOLVE_PROBLEM_INTERACTION', 'A2', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Conversar sobre um problema e propor uma solução')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'integração de descrição')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'conselho e consequência')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE A2.REAL_CONDITIONS
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'A2.REAL_CONDITIONS', 'A2', 8)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Se isso acontecer...', 'falar de possibilidades reais e suas consequências')
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.REAL_CONDITIONS.EXPLAIN_GENERAL_CONDITIONS', 'A2', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Falar sobre resultados que normalmente acontecem em certas condições')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Zero Conditional')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.REAL_CONDITIONS.DISCUSS_REAL_FUTURE_POSSIBILITIES', 'A2', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Falar sobre possibilidades reais e consequências futuras')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'First Conditional')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'A2.REAL_CONDITIONS.DECIDE_FROM_CONSEQUENCES', 'A2', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Tomar uma decisão considerando possíveis consequências')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'First Conditional em contexto')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE B1.STORYTELLING
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'B1.STORYTELLING', 'B1', 1)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Contar uma história', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B1.STORYTELLING.SET_STORY_CONTEXT', 'B1', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Estabelecer o contexto de uma história')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Past Continuous e descrição de contexto')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B1.STORYTELLING.SEQUENCE_PAST_EVENTS', 'B1', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Narrar acontecimentos em uma sequência clara')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Past Simple')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'conectores temporais')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B1.STORYTELLING.SHOW_PRIOR_EVENT', 'B1', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Mostrar que um acontecimento ocorreu antes de outro')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Past Perfect')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B1.STORYTELLING.TELL_COMPLETE_STORY', 'B1', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Contar uma história completa com começo, desenvolvimento e desfecho')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'narrative tenses I')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE B1.LIFE_CHANGES
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'B1.LIFE_CHANGES', 'B1', 2)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Minha trajetória e minhas mudanças', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B1.LIFE_CHANGES.DISTINGUISH_EXPERIENCE_EVENT', 'B1', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Distinguir experiência acumulada de acontecimento passado')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Present Perfect × Past Simple')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B1.LIFE_CHANGES.DESCRIBE_ONGOING_CHANGE', 'B1', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Falar sobre atividades e mudanças que vêm acontecendo ao longo do tempo')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Present Perfect Continuous')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'for / since')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B1.LIFE_CHANGES.TALK_PAST_HABITS', 'B1', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Falar sobre hábitos e situações recorrentes no passado')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'used to / would')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B1.LIFE_CHANGES.DESCRIBE_DECISIONS_CHANGES', 'B1', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Descrever decisões, tentativas e mudanças de hábito com padrões verbais naturais')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'decide to')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'stop doing')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 2, 'try doing')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 3, 'remember doing')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE B1.OPINION
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'B1.OPINION', 'B1', 3)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Explicar minha opinião', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B1.OPINION.STATE_JUSTIFY_OPINION', 'B1', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Expressar e justificar claramente uma opinião')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'I think')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'in my opinion')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 2, 'personally')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 3, 'because')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 4, 'since')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 5, 'that''s why')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B1.OPINION.AGREE_DISAGREE', 'B1', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Concordar ou discordar de uma opinião de forma adequada')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'agreement / disagreement')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B1.OPINION.CONTRAST_IDEAS', 'B1', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Contrastar duas ideias')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'although')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'however')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 2, 'on the other hand')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B1.OPINION.EXPLAIN_CONSEQUENCES', 'B1', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Explicar consequências de uma ideia ou decisão')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'therefore')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'so')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B1.OPINION.BUILD_COMPLETE_OPINION', 'B1', 5)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Construir uma resposta completa com posição, razão, contraste e consequência')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'integração argumentativa B1')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE B1.POSSIBILITY_DEDUCTION
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'B1.POSSIBILITY_DEDUCTION', 'B1', 4)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Possibilidades e deduções', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B1.POSSIBILITY_DEDUCTION.EXPRESS_PROBABILITY', 'B1', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Expressar possibilidade e diferentes graus de probabilidade')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'may / might')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'probably / definitely')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B1.POSSIBILITY_DEDUCTION.DEDUCE_PRESENT', 'B1', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Fazer deduções sobre o presente com diferentes graus de certeza')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'must / can''t e escala de certeza do módulo')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE B1.HYPOTHETICALS
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'B1.HYPOTHETICALS', 'B1', 5)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Situações hipotéticas', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B1.HYPOTHETICALS.EXPLORE_HYPOTHETICAL_SCENARIO', 'B1', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Imaginar situações irreais ou improváveis e suas consequências')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Second Conditional')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'would')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B1.HYPOTHETICALS.GIVE_HYPOTHETICAL_ADVICE', 'B1', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Dar conselho a partir de uma situação hipotética')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'If I were you')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE B1.REPORTED_INFO
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'B1.REPORTED_INFO', 'B1', 6)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Contar o que me disseram', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B1.REPORTED_INFO.REPORT_WHAT_WAS_SAID', 'B1', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Relatar afirmações e perguntas de outra pessoa')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Reported Speech')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'statements e perguntas')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 2, 'say / tell')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B1.REPORTED_INFO.RETELL_CONVERSATION', 'B1', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Relatar uma conversa curta preservando o sentido')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Reported Speech em narrativa')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B1.REPORTED_INFO.RELAY_IN_OWN_WORDS', 'B1', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Explicar informação recebida sem repetir as palavras originais')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'paráfrase básica + Reported Speech')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE B1.FACTS_PROCESSES
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'B1.FACTS_PROCESSES', 'B1', 7)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Explicar fatos e processos', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B1.FACTS_PROCESSES.DESCRIBE_WITHOUT_AGENT', 'B1', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Explicar fatos e acontecimentos quando o agente não é o foco')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Passive Voice no presente e passado')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B1.FACTS_PROCESSES.EXPLAIN_PROCESS', 'B1', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Explicar como algo é feito ou acontece')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'process language + Passive Voice')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B1.FACTS_PROCESSES.REPORT_NEWS_OBJECTIVELY', 'B1', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Relatar um acontecimento ou notícia simples de forma objetiva')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Passive Voice em contexto')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE B1.CONVERSATION_MANAGEMENT
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'B1.CONVERSATION_MANAGEMENT', 'B1', 8)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Manter uma conversa', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B1.CONVERSATION_MANAGEMENT.OPEN_CLOSE_CONVERSATION', 'B1', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Iniciar e encerrar uma conversa de forma natural')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'opening / closing strategies')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B1.CONVERSATION_MANAGEMENT.SHOW_INTEREST_REACT', 'B1', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Mostrar interesse e reagir ao interlocutor')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Really?')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'That''s interesting')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 2, 'No way')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B1.CONVERSATION_MANAGEMENT.CLARIFY_CHECK', 'B1', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Pedir esclarecimento e confirmar entendimento')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'What do you mean?')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'I didn''t catch that')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 2, 'perguntas indiretas completas')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B1.CONVERSATION_MANAGEMENT.INTERRUPT_POLITELY', 'B1', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Interromper educadamente')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'polite interruption')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B1.CONVERSATION_MANAGEMENT.MANAGE_TOPIC', 'B1', 5)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Retomar, redirecionar ou voltar ao tópico')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'conversation management')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE B2.ARGUMENTATION
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'B2.ARGUMENTATION', 'B2', 1)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Defender um ponto de vista', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B2.ARGUMENTATION.BUILD_SUPPORTED_POSITION', 'B2', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Construir uma posição com justificativas e exemplos')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'afirmação → justificativa → exemplo')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B2.ARGUMENTATION.WEIGH_OPTIONS', 'B2', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Comparar vantagens e desvantagens de uma posição')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'pros and cons')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B2.ARGUMENTATION.MAKE_CONCESSION', 'B2', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Reconhecer parte do argumento contrário sem abandonar a posição')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'even though')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'despite')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B2.ARGUMENTATION.RESPOND_COUNTERARGUMENT', 'B2', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Responder a um contra-argumento e sustentar a própria posição')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'counter-argumentation')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE B2.COMPLEX_NARRATIVES
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'B2.COMPLEX_NARRATIVES', 'B2', 2)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Narrativas complexas', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B2.COMPLEX_NARRATIVES.MANAGE_COMPLEX_TIMELINE', 'B2', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Organizar relações temporais complexas em uma narrativa')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Past Perfect Continuous e relações temporais finas')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B2.COMPLEX_NARRATIVES.ENRICH_DESCRIPTION', 'B2', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Construir descrições ricas e precisas')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'adjetivos avançados')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'advérbios de modo')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B2.COMPLEX_NARRATIVES.TELL_DETAILED_NARRATIVE', 'B2', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Contar uma narrativa detalhada preservando clareza temporal')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'narrative tenses II')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE B2.REGRET_ALTERNATIVES
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'B2.REGRET_ALTERNATIVES', 'B2', 3)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Hipóteses e arrependimentos', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B2.REGRET_ALTERNATIVES.REIMAGINE_PAST_OUTCOME', 'B2', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Imaginar um resultado diferente para uma situação passada')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Third Conditional')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B2.REGRET_ALTERNATIVES.CONNECT_PAST_PRESENT', 'B2', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Relacionar uma condição passada a uma consequência presente')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Mixed Conditionals')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B2.REGRET_ALTERNATIVES.EXPRESS_WISH_REGRET', 'B2', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Expressar desejo, insatisfação ou arrependimento sobre situações presentes e passadas')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'wish / if only')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B2.REGRET_ALTERNATIVES.EXPLORE_ALTERNATIVE_REALITIES', 'B2', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Explorar alternativas irreais e suas consequências')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'integração de conditionals e wish')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE B2.PAST_DEDUCTION
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'B2.PAST_DEDUCTION', 'B2', 4)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Dedução e especulação no passado', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B2.PAST_DEDUCTION.DEDUCE_PAST', 'B2', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Fazer deduções sobre acontecimentos passados com diferentes graus de certeza')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'must have / might have / can''t have')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B2.PAST_DEDUCTION.CRITIQUE_PAST_ACTION', 'B2', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Avaliar ou criticar retrospectivamente uma decisão ou ação')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'should have')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE B2.DETAILED_FUTURE
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'B2.DETAILED_FUTURE', 'B2', 5)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'O futuro em detalhe', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B2.DETAILED_FUTURE.DESCRIBE_FUTURE_PROGRESS', 'B2', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Falar sobre ações que estarão em andamento no futuro')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Future Continuous')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B2.DETAILED_FUTURE.TALK_FUTURE_COMPLETION', 'B2', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Falar sobre conclusões, resultados e marcos até um ponto futuro')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Future Perfect')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B2.DETAILED_FUTURE.PROJECT_FUTURE_DURATION', 'B2', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Falar sobre duração acumulada e construir projeções de longo prazo')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'Future Perfect Continuous + integração das formas futuras')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE B2.PRECISION_CLARIFICATION
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'B2.PRECISION_CLARIFICATION', 'B2', 6)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Explicar com precisão', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B2.PRECISION_CLARIFICATION.ADD_RELATIVE_INFORMATION', 'B2', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Acrescentar informação essencial ou complementar com precisão')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'defining / non-defining Relative Clauses')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B2.PRECISION_CLARIFICATION.REFORMULATE_FOR_CLARITY', 'B2', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Reformular a própria ideia para torná-la mais clara')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'what I mean is..')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'in other words')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B2.PRECISION_CLARIFICATION.SEEK_PROVIDE_CLARIFICATION', 'B2', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Pedir e fornecer esclarecimento em nível avançado')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'advanced clarification')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE B2.ABSTRACT_DISCUSSION
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'B2.ABSTRACT_DISCUSSION', 'B2', 7)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Discutir assuntos abstratos e atualidades', 'discutir tecnologia, educação, trabalho, cultura, mídia — assuntos sem resposta pessoal direta')
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B2.ABSTRACT_DISCUSSION.INTRODUCE_ABSTRACT_TOPIC', 'B2', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Apresentar e desenvolver um assunto abstrato com neutralidade')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'discussion language')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B2.ABSTRACT_DISCUSSION.REPORT_BELIEFS_POSITIONS', 'B2', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Relatar crenças, posições e informações atribuídas a terceiros')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'it is said that..')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'X is believed to..')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 2, 'Reported Speech avançado')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B2.ABSTRACT_DISCUSSION.DISTINGUISH_FACT_INTERPRETATION', 'B2', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Distinguir fato, opinião e interpretação ao relatar informação')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'fact vs opinion')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'reporting')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B2.ABSTRACT_DISCUSSION.SUSTAIN_ABSTRACT_DISCUSSION', 'B2', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Sustentar uma discussão sobre tema sem resposta pessoal direta')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'integração de relato')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'comparação e discussão abstrata')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE B2.ADVANCED_CONVERSATION
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'B2.ADVANCED_CONVERSATION', 'B2', 8)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Conversação avançada', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B2.ADVANCED_CONVERSATION.TAKE_INITIATIVE', 'B2', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Assumir iniciativa e direcionar a conversa')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'turn-taking e conversation control')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B2.ADVANCED_CONVERSATION.SUSTAIN_POSITION_PROBE', 'B2', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Sustentar uma posição sob questionamento e pedir razões ou evidências')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'extended response')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'probing questions')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B2.ADVANCED_CONVERSATION.DISAGREE_BUILD', 'B2', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Discordar sem quebrar o fluxo e desenvolver a ideia do interlocutor')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'polite disagreement')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'collaborative discourse')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'B2.ADVANCED_CONVERSATION.REDIRECT_CONCLUDE', 'B2', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Redirecionar ou concluir uma discussão de forma natural')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'conversation control')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE C1.CERTAINTY_HEDGING
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'C1.CERTAINTY_HEDGING', 'C1', 1)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Expressar certeza e dúvida', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.CERTAINTY_HEDGING.CALIBRATE_CERTAINTY', 'C1', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Calibrar a força de uma afirmação e o grau de certeza')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'hedging')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'probabilidade fina')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 2, 'linguagem cautelosa')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.CERTAINTY_HEDGING.SEPARATE_EVIDENCE_INTERPRETATION', 'C1', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Distinguir evidência de interpretação ao apresentar uma posição')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'stance e cautela')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.CERTAINTY_HEDGING.SPECULATE_FORMALLY', 'C1', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Especular de forma adequada em contexto acadêmico ou profissional')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'formal speculation')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE C1.PERSUASION
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'C1.PERSUASION', 'C1', 2)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Persuadir', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.PERSUASION.BUILD_STRATEGIC_ARGUMENT', 'C1', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Construir uma tese e organizar razões de forma estratégica')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'argument framing / structure')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.PERSUASION.ANTICIPATE_ANSWER_OBJECTIONS', 'C1', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Antecipar e responder a contra-argumentos previstos')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'anticipated objection / rebuttal')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.PERSUASION.MAKE_STRATEGIC_CONCESSION', 'C1', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Fazer concessões estratégicas sem enfraquecer a tese')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'while it''s true that..')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.PERSUASION.EMPHASIZE_CENTRAL_POINT', 'C1', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Dar ênfase ao ponto central de um argumento')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'what really matters is..')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE C1.DIPLOMACY
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'C1.DIPLOMACY', 'C1', 3)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Falar com diplomacia', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.DIPLOMACY.DISAGREE_DIPLOMATICALLY', 'C1', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Discordar de maneira indireta e cuidadosa')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'soft disagreement')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.DIPLOMACY.DELIVER_CONSTRUCTIVE_FEEDBACK', 'C1', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Fazer crítica construtiva e oferecer sugestões cuidadosas')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'diplomatic criticism')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'tentative suggestions')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.DIPLOMACY.ADAPT_TO_INTERLOCUTOR', 'C1', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Adaptar a linguagem ao interlocutor e à relação')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'chefe')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'cliente')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 2, 'colega')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.DIPLOMACY.HANDLE_SENSITIVE_INTERACTION', 'C1', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Conduzir uma interação delicada preservando clareza e relação')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'diplomatic interaction')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE C1.REGISTER
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'C1.REGISTER', 'C1', 4)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Formal × informal', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.REGISTER.CHOOSE_REGISTER', 'C1', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Reconhecer e escolher registro e vocabulário adequados ao contexto')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'register awareness')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'lexical register')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.REGISTER.SHIFT_FORMALITY', 'C1', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Transformar uma mensagem entre registros formal e informal')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'formalisation / informalisation')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.REGISTER.PRESERVE_INTENT_ACROSS_REGISTER', 'C1', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Manter conteúdo e intenção ao mudar de registro')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'register shift')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE C1.COMPLEX_ORGANIZATION
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'C1.COMPLEX_ORGANIZATION', 'C1', 5)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Organizar ideias complexas', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.COMPLEX_ORGANIZATION.LINK_COMPLEX_IDEAS', 'C1', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Conectar ideias complexas com marcadores e transições adequados')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'discourse markers avançados')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'transições')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.COMPLEX_ORGANIZATION.MAINTAIN_COHESION', 'C1', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Manter coesão e referência ao longo de um texto ou fala longa')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'cohesion')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'reference')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.COMPLEX_ORGANIZATION.STRUCTURE_LONG_ARGUMENT', 'C1', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Organizar parágrafos e uma sequência argumentativa longa com funções claras')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'macro-estrutura')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'paragraphing')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE C1.GRAMMAR_PRECISION
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'C1.GRAMMAR_PRECISION', 'C1', 6)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Gramática para precisão', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.GRAMMAR_PRECISION.CREATE_EMPHASIS_FOCUS', 'C1', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Criar ênfase e foco por meio da estrutura da frase')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'inversion + cleft sentences')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.GRAMMAR_PRECISION.CONTROL_ADVANCED_PASSIVES', 'C1', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Usar construções passivas avançadas com precisão')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'advanced passives')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.GRAMMAR_PRECISION.CONTROL_ADVANCED_CONDITIONALS', 'C1', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Construir relações condicionais avançadas com precisão')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'advanced conditionals')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.GRAMMAR_PRECISION.REFINE_PAST_MODALS', 'C1', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Expressar nuances retrospectivas com modais no passado')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'past modals')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.GRAMMAR_PRECISION.CONDENSE_INFORMATION', 'C1', 5)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Condensar informação sem perder clareza')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'participle clauses + ellipsis')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE C1.NATURAL_ENGLISH
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'C1.NATURAL_ENGLISH', 'C1', 7)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Inglês natural', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.NATURAL_ENGLISH.USE_NATURAL_LEXICAL_COMBINATIONS', 'C1', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Usar combinações lexicais naturais em contexto')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'collocations + phrasal verbs')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.NATURAL_ENGLISH.USE_IDIOMATIC_COLLOQUIAL_LANGUAGE', 'C1', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Usar linguagem idiomática e coloquial apropriada')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'idiomatic expressions + vague language')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.NATURAL_ENGLISH.AVOID_LITERAL_TRANSLATION', 'C1', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Substituir interferências e traduções literais por formulações naturais')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'L1 interference')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.NATURAL_ENGLISH.IMPROVE_NATURALNESS', 'C1', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Reformular linguagem correta, porém pouco natural')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'naturalness')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE C1.SYNTHESIS_EVALUATION
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'C1.SYNTHESIS_EVALUATION', 'C1', 8)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Síntese e avaliação', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.SYNTHESIS_EVALUATION.SUMMARIZE_COMPLEX_IDEA', 'C1', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Resumir uma ideia complexa sem distorcê-la')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'summary')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.SYNTHESIS_EVALUATION.SYNTHESIZE_SOURCES', 'C1', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Combinar informações de fontes ou posições diferentes')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'synthesis')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.SYNTHESIS_EVALUATION.COMPARE_EVALUATE_POSITIONS', 'C1', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Comparar posições e avaliar a força dos argumentos')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'comparison + evaluation')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C1.SYNTHESIS_EVALUATION.EXPLAIN_AND_CONCLUDE', 'C1', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Explicar informação complexa e concluir com posição própria')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'explicação para leigos + stance')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE C2.LEXICAL_PRECISION
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'C2.LEXICAL_PRECISION', 'C2', 1)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Precisão de significado', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.LEXICAL_PRECISION.DISTINGUISH_LEXICAL_NUANCE', 'C2', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Distinguir e escolher entre palavras próximas considerando conotação e intensidade')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'sinônimos próximos')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'conotação')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 2, 'intensidade')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.LEXICAL_PRECISION.REMOVE_AMBIGUITY', 'C2', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Detectar e eliminar ambiguidades')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'ambiguity control')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.LEXICAL_PRECISION.CHOOSE_EXACT_FORMULATION', 'C2', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Escolher a formulação mais precisa para uma intenção específica')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'lexical precision')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE C2.REFORMULATION
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'C2.REFORMULATION', 'C2', 2)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Reformulação', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.REFORMULATION.PARAPHRASE_IMMEDIATELY', 'C2', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Reformular imediatamente uma ideia sem mudar o sentido')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'instant paraphrase')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.REFORMULATION.SIMPLIFY_COMPLEX_IDEA', 'C2', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Simplificar uma ideia complexa preservando o essencial')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'simplification')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.REFORMULATION.SHIFT_FORMALITY_ON_DEMAND', 'C2', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Formalizar ou informalizar uma mensagem sob demanda')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'spontaneous register shift')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.REFORMULATION.REPAIR_IN_REAL_TIME', 'C2', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Reformular no meio da produção sem perder fluência')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'real-time repair')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE C2.SUBTEXT
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'C2.SUBTEXT', 'C2', 3)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Subtexto', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.SUBTEXT.INFER_IMPLICIT_INTENT', 'C2', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Inferir significado implícito e intenção do falante')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'implicature + speaker intent')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.SUBTEXT.INTERPRET_USE_IRONY', 'C2', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Reconhecer e usar ironia de forma contextual')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'irony')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.SUBTEXT.INTERPRET_USE_INSINUATION', 'C2', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Entender e produzir insinuação')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'innuendo')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.SUBTEXT.RECOGNIZE_PRESUPPOSITIONS', 'C2', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Reconhecer pressuposições embutidas no discurso')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'presupposition')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE C2.SOPHISTICATED_ARGUMENT
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'C2.SOPHISTICATED_ARGUMENT', 'C2', 4)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Argumentação sofisticada', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.SOPHISTICATED_ARGUMENT.SYNTHESIZE_OPPOSING_POSITIONS', 'C2', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Sintetizar posições opostas durante uma discussão')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'real-time synthesis')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.SOPHISTICATED_ARGUMENT.QUALIFY_OWN_ARGUMENT', 'C2', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Reconhecer e qualificar fragilidades do próprio argumento')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'self-qualification')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.SOPHISTICATED_ARGUMENT.REBUT_SPONTANEOUSLY', 'C2', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Responder espontaneamente a um contra-argumento')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'spontaneous rebuttal')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.SOPHISTICATED_ARGUMENT.CONCEDE_QUALIFY_CONCLUSION', 'C2', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Fazer concessões complexas e chegar a conclusões qualificadas')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'complex concession + qualified conclusion')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.SOPHISTICATED_ARGUMENT.ADAPT_ARGUMENT_NEW_INFO', 'C2', 5)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Adaptar o argumento quando novas informações surgem')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'adaptive argumentation')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE C2.REGISTER_STYLE
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'C2.REGISTER_STYLE', 'C2', 5)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Registro e estilo', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.REGISTER_STYLE.SHIFT_REGISTER_SPONTANEOUSLY', 'C2', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Alternar espontaneamente entre registros diferentes')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'professional / academic / casual')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.REGISTER_STYLE.ADAPT_TO_AUDIENCE', 'C2', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Adaptar linguagem e estilo ao interlocutor sem preparação')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'audience adaptation')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.REGISTER_STYLE.SWITCH_DIPLOMATIC_REGISTER', 'C2', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Mudar para um registro diplomático em situação sensível')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'diplomatic register')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.REGISTER_STYLE.CONTROL_PERSUASIVE_CRITICAL_STYLE', 'C2', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Adotar estilo persuasivo ou crítico sob demanda mantendo precisão')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'style control')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE C2.NATURALITY
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'C2.NATURALITY', 'C2', 6)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Naturalidade', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.NATURALITY.USE_ADVANCED_IDIOMATIC_LANGUAGE', 'C2', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Usar collocations, idioms e coloquialismos avançados de forma apropriada')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'advanced collocations')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 1, 'idioms')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 2, 'colloquial language')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.NATURALITY.MAINTAIN_DISCOURSE_RHYTHM', 'C2', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Manter ritmo discursivo natural em produção longa')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'discourse rhythm')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.NATURALITY.SPEAK_IDIOMATICALLY_WITH_FLUENCY', 'C2', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Escolher formulações idiomáticas sem perda perceptível de fluência')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'automaticity')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE C2.COMPLEX_INFORMATION
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'C2.COMPLEX_INFORMATION', 'C2', 7)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Informação complexa', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.COMPLEX_INFORMATION.SUMMARIZE_UNDER_CONSTRAINT', 'C2', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Resumir várias ideias sob limite de tempo ou tamanho')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'constrained summary')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.COMPLEX_INFORMATION.RECONSTRUCT_ARGUMENT', 'C2', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Reconstruir fielmente o argumento de terceiros')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'argument reconstruction')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.COMPLEX_INFORMATION.EXPLAIN_COMPLEX_RELATIONS', 'C2', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Explicar relações entre informações complexas')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'information relations')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.COMPLEX_INFORMATION.DISTINGUISH_EPISTEMIC_STATUS', 'C2', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Separar fato, interpretação e opinião em material complexo')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'epistemic distinction')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.COMPLEX_INFORMATION.TRANSFORM_FOR_AUDIENCE', 'C2', 5)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Reorganizar informação complexa para um novo público ou finalidade')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'information transformation')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- MODULE C2.HIGH_LEVEL_CONVERSATION
  INSERT INTO public.curriculum_modules (curriculum_version_id, module_key, level_code, sort_order)
    VALUES (v_ver, 'C2.HIGH_LEVEL_CONVERSATION', 'C2', 8)
    ON CONFLICT (curriculum_version_id, module_key) DO UPDATE SET level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_mod;
  INSERT INTO public.curriculum_module_i18n (module_id, interface_language, title, capability)
    VALUES (v_mod, 'pt-BR', 'Conversação de alto nível', NULL)
    ON CONFLICT (module_id, interface_language) DO UPDATE SET title=EXCLUDED.title, capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.HIGH_LEVEL_CONVERSATION.DEBATE_SPONTANEOUSLY', 'C2', 1)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Participar de debate complexo sem preparação')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'spontaneous debate')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.HIGH_LEVEL_CONVERSATION.RESPOND_TO_SHIFTS', 'C2', 2)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Reagir a mudanças de direção e de tópico de forma natural')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'rapid response + topic shift')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.HIGH_LEVEL_CONVERSATION.REPAIR_MISUNDERSTANDING', 'C2', 3)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Reformular imediatamente quando percebe incompreensão')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'instant repair')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.HIGH_LEVEL_CONVERSATION.DISAGREE_WITH_NUANCE', 'C2', 4)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Discordar com sutileza e precisão')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'nuanced disagreement')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;
  INSERT INTO public.curriculum_subtopics (curriculum_version_id, module_id, subtopic_key, level_code, sort_order)
    VALUES (v_ver, v_mod, 'C2.HIGH_LEVEL_CONVERSATION.NEGOTIATE_MEANING_FLUENTLY', 'C2', 5)
    ON CONFLICT (curriculum_version_id, subtopic_key) DO UPDATE SET module_id=EXCLUDED.module_id, level_code=EXCLUDED.level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_sub;
  INSERT INTO public.curriculum_subtopic_i18n (subtopic_id, interface_language, capability)
    VALUES (v_sub, 'pt-BR', 'Negociar significado mantendo precisão e fluência')
    ON CONFLICT (subtopic_id, interface_language) DO UPDATE SET capability=EXCLUDED.capability;
  INSERT INTO public.curriculum_language_targets (subtopic_id, kind, sort_order, target_text)
    VALUES (v_sub, 'support', 0, 'negotiation of meaning')
    ON CONFLICT (subtopic_id, kind, sort_order) DO UPDATE SET target_text=EXCLUDED.target_text;

  -- TRANSVERSAL TOPICS (fora da sequência obrigatória; não bloqueiam progressão)
  DECLARE v_trans uuid; BEGIN
  INSERT INTO public.curriculum_transversal_topics (curriculum_version_id, topic_key, min_level_code, sort_order)
    VALUES (v_ver, 'TRANS.ARTICLES', NULL, 1)
    ON CONFLICT (curriculum_version_id, topic_key) DO UPDATE SET min_level_code=EXCLUDED.min_level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_trans;
  INSERT INTO public.curriculum_transversal_topic_i18n (topic_id, interface_language, label, description)
    VALUES (v_trans, 'pt-BR', 'Artigos', 'artigos: a / an / the / ausência de artigo')
    ON CONFLICT (topic_id, interface_language) DO UPDATE SET label=EXCLUDED.label, description=EXCLUDED.description;
  END;
  DECLARE v_trans uuid; BEGIN
  INSERT INTO public.curriculum_transversal_topics (curriculum_version_id, topic_key, min_level_code, sort_order)
    VALUES (v_ver, 'TRANS.PREPOSITIONS', NULL, 2)
    ON CONFLICT (curriculum_version_id, topic_key) DO UPDATE SET min_level_code=EXCLUDED.min_level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_trans;
  INSERT INTO public.curriculum_transversal_topic_i18n (topic_id, interface_language, label, description)
    VALUES (v_trans, 'pt-BR', 'Preposições', 'preposições e regências')
    ON CONFLICT (topic_id, interface_language) DO UPDATE SET label=EXCLUDED.label, description=EXCLUDED.description;
  END;
  DECLARE v_trans uuid; BEGIN
  INSERT INTO public.curriculum_transversal_topics (curriculum_version_id, topic_key, min_level_code, sort_order)
    VALUES (v_ver, 'TRANS.QUANTIFIERS', 'A2', 3)
    ON CONFLICT (curriculum_version_id, topic_key) DO UPDATE SET min_level_code=EXCLUDED.min_level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_trans;
  INSERT INTO public.curriculum_transversal_topic_i18n (topic_id, interface_language, label, description)
    VALUES (v_trans, 'pt-BR', 'Quantificadores', 'quantificadores, a partir do A2')
    ON CONFLICT (topic_id, interface_language) DO UPDATE SET label=EXCLUDED.label, description=EXCLUDED.description;
  END;
  DECLARE v_trans uuid; BEGIN
  INSERT INTO public.curriculum_transversal_topics (curriculum_version_id, topic_key, min_level_code, sort_order)
    VALUES (v_ver, 'TRANS.QUESTIONS', NULL, 4)
    ON CONFLICT (curriculum_version_id, topic_key) DO UPDATE SET min_level_code=EXCLUDED.min_level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_trans;
  INSERT INTO public.curriculum_transversal_topic_i18n (topic_id, interface_language, label, description)
    VALUES (v_trans, 'pt-BR', 'Formação de perguntas', 'formação de perguntas')
    ON CONFLICT (topic_id, interface_language) DO UPDATE SET label=EXCLUDED.label, description=EXCLUDED.description;
  END;
  DECLARE v_trans uuid; BEGIN
  INSERT INTO public.curriculum_transversal_topics (curriculum_version_id, topic_key, min_level_code, sort_order)
    VALUES (v_ver, 'TRANS.PHRASAL', 'B1', 5)
    ON CONFLICT (curriculum_version_id, topic_key) DO UPDATE SET min_level_code=EXCLUDED.min_level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_trans;
  INSERT INTO public.curriculum_transversal_topic_i18n (topic_id, interface_language, label, description)
    VALUES (v_trans, 'pt-BR', 'Phrasal verbs', 'phrasal verbs introduzidos gradualmente a partir do B1')
    ON CONFLICT (topic_id, interface_language) DO UPDATE SET label=EXCLUDED.label, description=EXCLUDED.description;
  END;
  DECLARE v_trans uuid; BEGIN
  INSERT INTO public.curriculum_transversal_topics (curriculum_version_id, topic_key, min_level_code, sort_order)
    VALUES (v_ver, 'TRANS.L1_INTERFERENCE', NULL, 6)
    ON CONFLICT (curriculum_version_id, topic_key) DO UPDATE SET min_level_code=EXCLUDED.min_level_code, sort_order=EXCLUDED.sort_order
    RETURNING id INTO v_trans;
  INSERT INTO public.curriculum_transversal_topic_i18n (topic_id, interface_language, label, description)
    VALUES (v_trans, 'pt-BR', 'Interferência do português', 'falsos cognatos e traduções literais/interferência do português')
    ON CONFLICT (topic_id, interface_language) DO UPDATE SET label=EXCLUDED.label, description=EXCLUDED.description;
  END;

END
$seed$;

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
