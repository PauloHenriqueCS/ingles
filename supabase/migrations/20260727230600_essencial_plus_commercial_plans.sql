-- =============================================================================
-- MIGRATION: 20260727230600_essencial_plus_commercial_plans
-- Projeto: app de inglês (ingles) — Domínio de assinaturas
--
-- Cria os dois planos comerciais do domínio de assinaturas — Essencial
-- (R$ 34,90/mês) e Plus (R$ 59,90/mês) — como PLANO + VERSÃO EM DRAFT,
-- seguindo exatamente o mesmo padrão já usado para o plano interno `trial`
-- (20260727223126_trial_plan_and_capability_reconciliation.sql): apenas
-- estrutura, nunca publicado por esta migration.
--
-- POR QUE NÃO PUBLICAR AQUI: a publicação de uma plan_version (que calcula
-- config_hash em TypeScript via o pipeline oficial createDraftVersion →
-- saveCapabilities → publishDraft e exige um ator admin real em
-- publish_plan_version) é responsabilidade do `ingles-dashboad` — mesmo
-- motivo já documentado na migration do trial ("reproduzir o algoritmo de
-- config_hash em SQL é frágil e duplicaria lógica — proibido divergir").
-- Este repositório (`ingles`) só consome plan_capability_values em runtime;
-- nunca escreve uma versão publicada.
--
-- ORIGEM DOS VALORES: preços e limites diários já são decisão de produto
-- registrada em src/domain/subscription/subscription-plans.ts (commit
-- 66b8faf, tela /assinatura, hoje mockada). Só semeamos aqui o que já está
-- decidido — nunca um número inventado:
--   * Essencial: 1x/dia (escrita, pronúncia, listening), 1800s (30min) de
--     conversação/mês, compra de minutos extras HABILITADA.
--   * Plus: 3x/dia (escrita, pronúncia, listening), compra de minutos extras
--     também HABILITADA. conversation.realtime.seconds.monthly fica DE FORA
--     desta versão — a franquia mensal de conversação do Plus ainda não foi
--     decidida (subscription-plans.ts: "Plus's conversationMinutesMonthly is
--     intentionally null ... never invent a number here"). Consequência
--     desejada: a validação de completude de publish_plan_version() vai
--     recusar publicar o Plus até esse valor existir — não é um bug a
--     corrigir aqui, é o comportamento correto.
--
-- Também deliberadamente FORA de ambos os drafts (nenhum valor canônico
-- comprovado — mesma razão já documentada na migration do trial para
-- conversation.max_recording_seconds): writing.max_characters_per_text,
-- pronunciation.max_recording_seconds, conversation.max_recording_seconds
-- (+ os pares `.unlimited` de cada um). Preencher esses três é trabalho do
-- ingles-dashboad antes de publicar qualquer uma das duas versões — nenhuma
-- capability_definitions nova é necessária: todas as chaves usadas aqui já
-- existem no catálogo canônico de 21 keys (confirmado por leitura direta de
-- capability_definitions; diferente do trial, que precisou de duas chaves
-- novas para trial_total).
--
-- plans.status fica 'draft' (nunca 'active') até a publicação oficial ativar
-- o plano via publish_plan_version(..., p_activate_plan => true). Isso
-- diverge do precedente do trial (que já nasceu com status 'active') de
-- propósito: o trial é um plano interno que precisa existir para o próprio
-- motor de resolução mesmo sem assinantes reais; Essencial/Plus são planos
-- comerciais que só devem aparecer como "ativos" quando o dashboard
-- realmente os publicar.
--
-- is_visible_to_users = TRUE (o oposto do trial, que é oculto) — são as duas
-- opções comerciais que a tela /assinatura deve listar assim que publicadas.
--
-- AVISO OPERACIONAL: como nenhuma versão fica publicada, nenhum usuário pode
-- ser atribuído de forma útil a estes planos ainda — se um admin tentar usar
-- admin_assign_plan_v1 com version_policy='follow_current_published' antes
-- da publicação, snapshot_version_id fica NULL e o usuário cairia no
-- fallback "sem configuração = acesso liberado" do motor de entitlements
-- (ver plan-entitlements-service.ts, hasAnyPlanConfiguration). Isso é um
-- risco operacional do processo de publicação (mesmo risco que já existe
-- para qualquer outro plano em draft), não algo introduzido por esta
-- migration — mencionado aqui só como aviso para quem for publicar.
--
-- 100% idempotente: IF NOT EXISTS antes de cada INSERT. Nenhum
-- DELETE/UPDATE destrutivo. Aplicar neste banco está fora do escopo desta
-- etapa (pedido original: "Não executar migration, deploy, commit ou push").
--
-- TIMESTAMP: originalmente criada como 20260727230000, mas esse prefixo já
-- era usado por 20260727230000_conversation_minute_packages_catalog.sql (uma
-- frente paralela) — colisão exatamente do tipo já documentado em
-- supabase/MIGRATIONS.md ("Coordenação com ingles-dashboad"). Renomeada para
-- 20260727230600 (posterior também a 20260727230500_grant_signup_trial.sql)
-- para eliminar a colisão sem tocar no arquivo da outra frente. Confirmado
-- via list_migrations (MCP, leitura) que a maior versão já aplicada no
-- ambiente de homologação compartilhado (ver supabase/MIGRATIONS.md) nesta
-- revisão é 20260727224400 — este timestamp continua estritamente posterior
-- a ela.
-- =============================================================================

DO $$
DECLARE
  v_essential_plan_id UUID;
  v_essential_version_id UUID;
  v_plus_plan_id UUID;
  v_plus_version_id UUID;
BEGIN
  -- ── Essencial ──────────────────────────────────────────────────────────
  SELECT id INTO v_essential_plan_id FROM public.plans WHERE code = 'essencial';

  IF v_essential_plan_id IS NULL THEN
    INSERT INTO public.plans
      (name, code, description, status, is_default, is_visible_to_users,
       monthly_price_cents, currency, trial_days, display_order, internal_notes)
    VALUES
      ('Essencial', 'essencial',
       'Plano comercial de entrada: 1x/dia de escrita, pronúncia e listening, e 30 minutos de conversação por mês.',
       'draft', FALSE, TRUE, 3490, 'BRL', 0, 100,
       'Criado em draft por migration (ver cabeçalho). Publicação oficial (config_hash + ativação) é responsabilidade do ingles-dashboad.')
    RETURNING id INTO v_essential_plan_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.plan_versions WHERE plan_id = v_essential_plan_id) THEN
    INSERT INTO public.plan_versions (plan_id, version_number, status, revision)
    VALUES (v_essential_plan_id, 1, 'draft', 1)
    RETURNING id INTO v_essential_version_id;

    INSERT INTO public.plan_capability_values (plan_version_id, capability_key, value, period)
    VALUES
      (v_essential_version_id, 'writing.enabled', 'true', 'none'),
      (v_essential_version_id, 'listening.enabled', 'true', 'none'),
      (v_essential_version_id, 'pronunciation.enabled', 'true', 'none'),
      (v_essential_version_id, 'conversation.enabled', 'true', 'none'),
      (v_essential_version_id, 'conversation.extra_purchase_enabled', 'true', 'none'),
      (v_essential_version_id, 'writing.theme_generations_per_day', '1', 'day'),
      (v_essential_version_id, 'writing.theme_generations_per_day.unlimited', 'false', 'none'),
      (v_essential_version_id, 'writing.reviews_per_day', '1', 'day'),
      (v_essential_version_id, 'writing.reviews_per_day.unlimited', 'false', 'none'),
      (v_essential_version_id, 'pronunciation.evaluations_per_day', '1', 'day'),
      (v_essential_version_id, 'pronunciation.evaluations_per_day.unlimited', 'false', 'none'),
      (v_essential_version_id, 'listening.stories_per_day', '1', 'day'),
      (v_essential_version_id, 'listening.stories_per_day.unlimited', 'false', 'none'),
      (v_essential_version_id, 'conversation.realtime.seconds.monthly', '1800', 'month'),
      (v_essential_version_id, 'conversation.realtime.seconds.monthly.unlimited', 'false', 'none');
  END IF;

  -- ── Plus ───────────────────────────────────────────────────────────────
  SELECT id INTO v_plus_plan_id FROM public.plans WHERE code = 'plus';

  IF v_plus_plan_id IS NULL THEN
    INSERT INTO public.plans
      (name, code, description, status, is_default, is_visible_to_users,
       monthly_price_cents, currency, trial_days, display_order, internal_notes)
    VALUES
      ('Plus', 'plus',
       'Plano comercial superior: 3x/dia de escrita, pronúncia e listening. Franquia mensal de conversação ainda não definida.',
       'draft', FALSE, TRUE, 5990, 'BRL', 0, 110,
       'Criado em draft por migration (ver cabeçalho). NÃO publicável até conversation.realtime.seconds.monthly ser definido pelo ingles-dashboad — publish_plan_version() vai recusar por completude, propositalmente.')
    RETURNING id INTO v_plus_plan_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.plan_versions WHERE plan_id = v_plus_plan_id) THEN
    INSERT INTO public.plan_versions (plan_id, version_number, status, revision)
    VALUES (v_plus_plan_id, 1, 'draft', 1)
    RETURNING id INTO v_plus_version_id;

    INSERT INTO public.plan_capability_values (plan_version_id, capability_key, value, period)
    VALUES
      (v_plus_version_id, 'writing.enabled', 'true', 'none'),
      (v_plus_version_id, 'listening.enabled', 'true', 'none'),
      (v_plus_version_id, 'pronunciation.enabled', 'true', 'none'),
      (v_plus_version_id, 'conversation.enabled', 'true', 'none'),
      (v_plus_version_id, 'conversation.extra_purchase_enabled', 'true', 'none'),
      (v_plus_version_id, 'writing.theme_generations_per_day', '3', 'day'),
      (v_plus_version_id, 'writing.theme_generations_per_day.unlimited', 'false', 'none'),
      (v_plus_version_id, 'writing.reviews_per_day', '3', 'day'),
      (v_plus_version_id, 'writing.reviews_per_day.unlimited', 'false', 'none'),
      (v_plus_version_id, 'pronunciation.evaluations_per_day', '3', 'day'),
      (v_plus_version_id, 'pronunciation.evaluations_per_day.unlimited', 'false', 'none'),
      (v_plus_version_id, 'listening.stories_per_day', '3', 'day'),
      (v_plus_version_id, 'listening.stories_per_day.unlimited', 'false', 'none');
  END IF;
END $$;
