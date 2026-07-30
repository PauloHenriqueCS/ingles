-- =============================================================================
-- MIRROR (não autoral desta repo, nunca reaplicado) — Etapa 2B, ingles
--
-- Cópia fiel do arquivo já aplicado em lemon-homolog pelo repositório
-- ingles-dashboad como
-- supabase/migrations/20260727000000_trial_plan_and_capability_reconciliation.sql,
-- registrado no remoto sob a versão 20260727223126
-- (supabase_migrations.schema_migrations.version — confirmado em modo
-- leitura via `SELECT statements FROM supabase_migrations.schema_migrations
-- WHERE version = '20260727223126'` contra lemon-homolog: o texto abaixo é
-- IDÊNTICO, caractere por caractere, ao que está armazenado lá e ao arquivo
-- original no ingles-dashboad).
--
-- Criado exclusivamente para que `supabase migration list`/`db push`
-- reconheçam esta versão como já aplicada (a comparação é por presença de
-- versão no diretório local, nunca por reexecução de conteúdo) — sem este
-- arquivo, `db push` recusa-se a prosseguir com QUALQUER migration porque
-- `20260727223126` aparecia no histórico remoto sem correspondência local.
-- Este arquivo nunca deve ser reexecutado nem modificado; qualquer alteração
-- real ao que esta migration faz pertence ao ingles-dashboad, nunca a este
-- espelho.
-- =============================================================================

-- ============================================================
-- Etapa 1A — Configuração do teste gratuito (seed ESTRUTURAL)
--
-- Este arquivo é apenas o SEED ESTRUTURAL:
--   1. reconcilia as capability definitions canônicas que a versão do trial usa
--      (incluindo a flag `.unlimited` pareada de `conversation.realtime.seconds.trial_total`,
--      que não faz parte do catálogo canônico de 21 keys do projeto `ingles`);
--   2. completa o contrato da coluna plans.is_visible_to_users (+ constraint);
--   3. cria o plano interno `trial` e uma versão DRAFT completa dos limites —
--      incluindo, para CADA quota numérica do trial, sua flag `.unlimited = false`
--      persistida explicitamente (o contrato nunca depende de ausência,
--      default_value ou fallback do resolvedor para afirmar "nada é ilimitado").
--
-- Ele NÃO publica a versão e NÃO cria a política de trial. A publicação (com
-- config_hash oficial calculado por computeConfigHash) e a criação da política
-- (com updated_by = administrador autenticado real) são feitas pela
-- INICIALIZAÇÃO OFICIAL DA APLICAÇÃO — a primeira gravação na tela
-- "Teste gratuito" (app/(dashboard)/teste-gratuito): ela reutiliza o pipeline
-- oficial createDraftVersion → saveCapabilities → publishDraft (validação →
-- config_hash → RPC publish_plan_version → retirada da versão anterior →
-- auditoria). Ver docs abaixo e o relatório da etapa.
--
-- Motivos de separar seed estrutural de inicialização administrativa:
--   * config_hash: reproduzir byte-a-byte o JSON.stringify de computeConfigHash
--     em SQL é frágil e duplicaria o algoritmo (proibido divergir). A publicação
--     oficial calcula o mesmo hash em TS, garantindo compatibilidade com
--     edições futuras da tela por construção (mesmo caminho de código).
--   * plan_trial_policies.updated_by é NOT NULL e deve ser um administrador real
--     e determinístico — nunca "qualquer usuário". A tela grava o admin
--     autenticado que executou a ação.
--   * pronunciation.max_recording_seconds: NUNCA um número escolhido
--     arbitrariamente neste arquivo. É herdado, via subquery, da versão
--     PUBLICADA do plano padrão (plans.is_default = TRUE) no momento em que
--     esta migration roda — exigindo `IS NOT NULL AND > 0` (nunca aceita zero
--     como valor válido para um limite de duração habilitado). Se o plano
--     padrão ainda não tiver esse limite publicado (com valor positivo), a
--     linha correspondente fica de fora do seed (nunca um valor inventado) —
--     a inicialização oficial da aplicação
--     (resolvePronunciationMaxRecordingSeconds, em
--     app/(dashboard)/teste-gratuito/actions.ts) resolve e valida o mesmo
--     valor a cada publicação da mesma forma, e o validador oficial
--     (lib/versioning/validate-draft.ts) já rejeita a publicação do trial caso
--     esse limite fique ausente ou zerado — o requisito fica obrigatório e
--     verificável antes de publicar, nunca implícito.
--   * conversation.max_recording_seconds (revisão pós-auditoria do projeto
--     `ingles`): deixou de ser herdado do plano padrão. A auditoria comprovou
--     que essa capability limita a duração de uma SESSÃO INTEIRA de conversa
--     (aplicada a cada 5s pelo backend, não o tamanho de uma única fala) e não
--     tem valor canônico comprovado no plano padrão — os únicos valores
--     encontrados lá eram artefatos de teste (0, 1, 5), nunca uma decisão de
--     produto. Por decisão de produto o trial usa um valor FIXO de 900s (a
--     mesma franquia total do trial, conversation.realtime.seconds.trial_total)
--     — uma sessão pode consumir, no máximo, essa franquia inteira. Nunca
--     1800s (teto comercial futuro dos planos pagos) e nunca ilimitado no
--     trial.
--
-- 100% idempotente e NÃO destrutiva: apenas INSERT ... ON CONFLICT DO NOTHING,
-- ADD COLUMN IF NOT EXISTS, ADD CONSTRAINT guardado e um UPDATE de reconciliação
-- com WHERE. Não cria funções nem tabelas. Aplicar manualmente (aplicar no banco
-- remoto está fora do escopo desta etapa).
-- ============================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Reconciliar capability definitions canônicas ausentes
--
-- Todas as chaves que a versão do trial define precisam existir em
-- capability_definitions (FK de plan_capability_values.capability_key). As flags
-- booleanas das quatro atividades (writing/listening/pronunciation/conversation
-- .enabled) e as flags `.unlimited` pareadas das 21 keys canônicas já são
-- semeadas pela migration do projeto `ingles` (ver lib/plans/capability-keys.ts);
-- aqui reconciliamos as 5 quotas do spec + os field-limits exigidos pelo
-- validador oficial + a feature de compra extra (setada como desabilitada no
-- trial) + a flag `.unlimited` de `conversation.realtime.seconds.trial_total`
-- — a ÚNICA capability nova desta etapa que não tem par canônico no catálogo
-- do `ingles`, já que `trial_total` (período 'lifetime') não existe lá.
--
-- As quatro cotas diárias e os field-limits fazem parte do modelo de "limite
-- numérico + chave `.unlimited` pareada" (ver types/admin.ts, UNLIMITED_VALUE),
-- por isso as constraints ficam apenas com {"min":0} (não usam o sentinel -1).
-- A chave de conversação representa o TOTAL de segundos durante toda a
-- atribuição de trial (período 'lifetime', já suportado por allowed_periods),
-- e não um limite mensal. ON CONFLICT preserva definições canônicas já
-- existentes (ex.: criadas pela migration do projeto `ingles`).
--
-- default_value nos dois field-limits de gravação (60) é apenas o fallback
-- GENÉRICO do catálogo — usado somente se algum plano_version não tiver um
-- valor explícito para essa key (ver lib/versioning/validate-draft.ts,
-- effective()). O trial NUNCA depende deste fallback: sempre grava um valor
-- explícito em plan_capability_values — pronunciation.max_recording_seconds
-- herdado do plano padrão, conversation.max_recording_seconds fixo em 900s
-- por decisão de produto (ver seção 3; revisão pós-auditoria do `ingles`).
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.capability_definitions
  (key, category, group_key, label, description, help_text, value_type, unit, default_period, allowed_periods, default_value, constraints, dependency_key, is_plan_configurable, source_reference, display_order)
VALUES
  -- Quotas do spec
  ('writing.theme_generations_per_day', 'quota', 'writing', 'Gerações de tema por dia (Escrita)', 'Quantidade de gerações de tema de escrita por dia', NULL, 'integer', 'generations', 'day', '["day"]', '0', '{"min":0}', 'writing.enabled', TRUE, NULL, 220),
  ('writing.reviews_per_day', 'quota', 'writing', 'Revisões por dia (Escrita)', 'Quantidade de revisões de escrita por IA por dia', NULL, 'integer', 'reviews', 'day', '["day"]', '0', '{"min":0}', 'writing.enabled', TRUE, NULL, 221),
  ('pronunciation.evaluations_per_day', 'quota', 'pronunciation', 'Avaliações por dia (Pronúncia)', 'Quantidade de avaliações de pronúncia por dia', NULL, 'integer', 'evaluations', 'day', '["day"]', '0', '{"min":0}', 'pronunciation.enabled', TRUE, NULL, 420),
  ('listening.stories_per_day', 'quota', 'listening', 'Histórias por dia (Listening)', 'Quantidade de histórias de listening por dia', NULL, 'integer', 'stories', 'day', '["day"]', '0', '{"min":0}', 'listening.enabled', TRUE, NULL, 520),
  ('conversation.realtime.seconds.trial_total', 'quota', 'conversation', 'Segundos de conversação (total do trial)', 'Total de segundos de conversa em tempo real permitido durante toda a atribuição de trial (não é um limite mensal)', NULL, 'integer', 'seconds', 'lifetime', '["lifetime"]', '0', '{"min":0}', 'conversation.enabled', TRUE, NULL, 320),
  ('conversation.realtime.seconds.trial_total.unlimited', 'quota', 'conversation', 'Segundos de conversação (total do trial) — ilimitado', 'Indica se o total de segundos de conversação do teste gratuito é ilimitado. Segue o mesmo padrão pareado das demais flags `.unlimited` do catálogo.', NULL, 'boolean', 'enabled', 'none', '["none"]', 'false', '{}', 'conversation.enabled', TRUE, NULL, 324),
  -- Field-limits exigidos pelo validador oficial quando as atividades estão habilitadas
  ('writing.max_characters_per_text', 'field_limit', 'writing', 'Máximo de caracteres por texto (Escrita)', 'Máximo de caracteres aceitos no texto enviado para revisão', NULL, 'integer', 'characters', 'none', '["none"]', '1000', '{"min":0}', 'writing.enabled', TRUE, NULL, 222),
  ('pronunciation.max_recording_seconds', 'field_limit', 'pronunciation', 'Duração máxima da gravação (Pronúncia)', 'Duração máxima de uma gravação enviada para avaliação de pronúncia, em segundos', NULL, 'integer', 'seconds', 'none', '["none"]', '60', '{"min":0}', 'pronunciation.enabled', TRUE, NULL, 421),
  ('conversation.max_recording_seconds', 'field_limit', 'conversation', 'Duração máxima da gravação (Conversação)', 'Duração máxima de uma fala enviada na conversa em tempo real, em segundos', NULL, 'integer', 'seconds', 'none', '["none"]', '60', '{"min":0}', 'conversation.enabled', TRUE, NULL, 321),
  -- Feature de compra extra de conversação (desabilitada no trial)
  ('conversation.extra_purchase_enabled', 'feature', 'conversation', 'Compra de minutos extras (Conversação)', 'Permite ao usuário comprar minutos extras de conversa em tempo real', NULL, 'boolean', 'enabled', 'none', '["none"]', 'false', '{}', 'conversation.enabled', TRUE, NULL, 322)
ON CONFLICT (key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Contrato completo de plans.is_visible_to_users
--
-- Referenciada por todo o código (lib/validations/plan.ts, types/admin.ts,
-- app/(dashboard)/plans/actions.ts) e pela constraint chk_plans_default_must_be_visible,
-- mas adicionada por uma migration do projeto `ingles` que não está versionada
-- aqui (mesma deriva de schema apontada na auditoria). Reconciliada de forma
-- idempotente para que este repositório reconstrua seu schema de forma
-- consistente: coluna BOOLEAN NOT NULL DEFAULT TRUE (o DEFAULT já faz o backfill
-- dos planos existentes para "visível"); reconciliação dos planos padrão
-- eventualmente invisíveis ANTES de criar a constraint; e a constraint
-- "plano padrão precisa ser visível". Não adicionamos índice: a filtragem
-- pública por visibilidade é responsabilidade do app `ingles`, não do dashboard.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS is_visible_to_users BOOLEAN NOT NULL DEFAULT TRUE;

-- Reconciliar dados válidos existentes ANTES da constraint (não falhar em dados
-- válidos): um plano padrão nunca pode ser invisível.
UPDATE public.plans
SET is_visible_to_users = TRUE
WHERE is_default = TRUE AND is_visible_to_users = FALSE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.plans'::regclass
      AND conname = 'chk_plans_default_must_be_visible'
  ) THEN
    ALTER TABLE public.plans
      ADD CONSTRAINT chk_plans_default_must_be_visible
      CHECK (is_visible_to_users OR NOT is_default);
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Plano interno `trial` + versão DRAFT completa (sem publicar)
--
-- A versão é criada como 'draft' com o conjunto COMPLETO de capabilities que o
-- validador oficial exige (as quatro atividades habilitadas, as 5 quotas do
-- spec, a flag `.unlimited = false` de CADA quota numérica, os field-limits
-- fixos de texto e de sessão de conversação, e a compra extra desabilitada).
-- A publicação é feita pela inicialização oficial da aplicação (ver
-- cabeçalho). Condicionado à ausência prévia dos registros → reexecutável.
--
-- pronunciation.max_recording_seconds é resolvido por subquery a partir da
-- versão PUBLICADA do plano padrão (plans.is_default = TRUE) — nunca um
-- literal fixo neste arquivo. Exige `IS NOT NULL AND > 0`: zero NUNCA é aceito
-- como valor válido para um limite de duração habilitado. Se o plano padrão
-- não tiver esse limite publicado (com valor positivo) no momento em que esta
-- migration roda, a linha (valor + `.unlimited`) simplesmente fica de fora do
-- seed: a inicialização oficial (app/(dashboard)/teste-gratuito/actions.ts)
-- exige e valida o mesmo valor a cada save, e o validador oficial de
-- publicação rejeita o trial com esse limite ausente ou zerado — nunca um
-- número inventado silenciosamente.
--
-- conversation.max_recording_seconds é um LITERAL FIXO (900s, igual à
-- franquia total do trial) — revisão pós-auditoria: essa capability limita a
-- duração de uma sessão inteira de conversa, não tem valor canônico no plano
-- padrão, e por decisão de produto o trial nunca mais depende dele para essa
-- capability (ver cabeçalho).
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_plan_id UUID;
  v_version_id UUID;
  v_pron_recording_seconds JSONB;
BEGIN
  -- 3.1 Plano interno (não comercial, oculto, não padrão)
  SELECT id INTO v_plan_id FROM public.plans WHERE code = 'trial';

  IF v_plan_id IS NULL THEN
    INSERT INTO public.plans
      (name, code, description, status, is_default, is_visible_to_users,
       monthly_price_cents, currency, trial_days, display_order, internal_notes)
    VALUES
      ('Teste gratuito', 'trial',
       'Plano interno usado para representar os limites do teste gratuito. Não é uma opção comercial de assinatura.',
       'active', FALSE, FALSE, 0, 'BRL', 7, 900,
       'Plano interno do teste gratuito (origin = trial). Não exibir aos usuários; sem preço comercial. Publicado pela inicialização oficial da tela Teste gratuito.')
    RETURNING id INTO v_plan_id;
  END IF;

  -- 3.2 Versão DRAFT com o conjunto completo de entitlements do trial
  IF NOT EXISTS (SELECT 1 FROM public.plan_versions WHERE plan_id = v_plan_id) THEN
    INSERT INTO public.plan_versions (plan_id, version_number, status, revision)
    VALUES (v_plan_id, 1, 'draft', 1)
    RETURNING id INTO v_version_id;

    INSERT INTO public.plan_capability_values (plan_version_id, capability_key, value, period)
    VALUES
      -- Quatro atividades habilitadas explicitamente
      (v_version_id, 'writing.enabled', 'true', 'none'),
      (v_version_id, 'listening.enabled', 'true', 'none'),
      (v_version_id, 'pronunciation.enabled', 'true', 'none'),
      (v_version_id, 'conversation.enabled', 'true', 'none'),
      -- Compra de minutos extras desabilitada
      (v_version_id, 'conversation.extra_purchase_enabled', 'false', 'none'),
      -- Escrita: campo único da tela alimenta as duas quotas + field-limit fixo
      -- (1000 caracteres — decisão comercial do Lemon) + flags `.unlimited`
      (v_version_id, 'writing.theme_generations_per_day', '1', 'day'),
      (v_version_id, 'writing.theme_generations_per_day.unlimited', 'false', 'none'),
      (v_version_id, 'writing.reviews_per_day', '1', 'day'),
      (v_version_id, 'writing.reviews_per_day.unlimited', 'false', 'none'),
      (v_version_id, 'writing.max_characters_per_text', '1000', 'none'),
      (v_version_id, 'writing.max_characters_per_text.unlimited', 'false', 'none'),
      -- Pronúncia (o field-limit de gravação é seedado abaixo, via subquery)
      (v_version_id, 'pronunciation.evaluations_per_day', '1', 'day'),
      (v_version_id, 'pronunciation.evaluations_per_day.unlimited', 'false', 'none'),
      -- Listening
      (v_version_id, 'listening.stories_per_day', '1', 'day'),
      (v_version_id, 'listening.stories_per_day.unlimited', 'false', 'none'),
      -- Conversação: total do trial (900s = 15min) + flag `.unlimited`
      (v_version_id, 'conversation.realtime.seconds.trial_total', '900', 'lifetime'),
      (v_version_id, 'conversation.realtime.seconds.trial_total.unlimited', 'false', 'none'),
      -- Conversação: duração máxima de UMA sessão — literal fixo em 900s
      -- (= a franquia total acima; decisão de produto, nunca herdado do
      -- plano padrão — revisão pós-auditoria, ver cabeçalho da seção 3)
      (v_version_id, 'conversation.max_recording_seconds', '900', 'none'),
      (v_version_id, 'conversation.max_recording_seconds.unlimited', 'false', 'none');

    -- 3.3 Duração máxima de gravação (Pronúncia) — herdada do plano padrão
    -- publicado agora. NUNCA um número escolhido arbitrariamente. Guard
    -- endurecido: exige um número JSON positivo (> 0), não apenas presente —
    -- zero nunca é aceito como valor válido para um limite de duração
    -- habilitado (ver cabeçalho da seção 3).
    SELECT pcv.value INTO v_pron_recording_seconds
    FROM public.plan_capability_values pcv
    JOIN public.plan_versions pv ON pv.id = pcv.plan_version_id
    JOIN public.plans dp ON dp.id = pv.plan_id
    WHERE dp.is_default = TRUE AND pv.status = 'published' AND pv.effective_to IS NULL
      AND pcv.capability_key = 'pronunciation.max_recording_seconds'
    LIMIT 1;

    IF v_pron_recording_seconds IS NOT NULL
       AND jsonb_typeof(v_pron_recording_seconds) = 'number'
       AND (v_pron_recording_seconds)::text::numeric > 0
    THEN
      INSERT INTO public.plan_capability_values (plan_version_id, capability_key, value, period)
      VALUES
        (v_version_id, 'pronunciation.max_recording_seconds', v_pron_recording_seconds, 'none'),
        (v_version_id, 'pronunciation.max_recording_seconds.unlimited', 'false', 'none');
    END IF;
  END IF;
END $$;
