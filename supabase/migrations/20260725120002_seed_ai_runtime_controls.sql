-- =============================================================================
-- SEED (homologação apenas): public.ai_runtime_controls
-- Projeto alvo EXCLUSIVO: ahszqexfzpbirdlkmdci (lemon-homolog)
-- NUNCA aplicar em produção (jiuurvheeuwmayrfnqgm).
--
-- Contexto: ai_runtime_controls está com 0 linhas em homologação (produção
-- tem 28: 1 global + 2 provider + 25 feature). A migration
-- 20260717000000_create_ai_gateway_foundation.sql cria a tabela mas o INSERT
-- de seed nela nunca chegou a este ambiente. Sem a linha 'global', o AI
-- Gateway não tem política nenhuma para resolver — bloqueando escrita,
-- conversa, listening e pronúncia.
--
-- Este arquivo reproduz apenas a ESTRUTURA de produção (scope_type, scope_key,
-- provider, feature_key, runtime_status='enabled', gateway_mode='enforce').
-- Deliberadamente NÃO copia daily_budget_usd/monthly_budget_usd/
-- max_concurrent_requests/rate_limit_* de produção (o único valor não-nulo em
-- produção hoje, no escopo global, é ele próprio um ajuste manual de teste —
-- reason='teste' — não uma configuração estrutural a reproduzir). Todos os
-- limites ficam NULL aqui, que segundo o próprio código do gateway
-- (api/_ai-gateway/types.ts, budgets.ts) significa "ilimitado" em qualquer
-- escopo — postura permissiva e segura para um ambiente de homologação.
--
-- Idempotente: cada INSERT usa ON CONFLICT (scope_type, scope_key) DO NOTHING,
-- apoiado na constraint real uq_arc_scope UNIQUE (scope_type, scope_key).
-- Reexecutar este arquivo não duplica nem altera linhas já existentes.
-- =============================================================================

-- ── 1 controle global ────────────────────────────────────────────────────────
INSERT INTO public.ai_runtime_controls
  (scope_type, scope_key, provider, feature_key, runtime_status, gateway_mode, reason)
VALUES
  ('global', 'global', NULL, NULL, 'enabled', 'enforce',
   'Seed de homologação — paridade estrutural com produção (runtime_status/gateway_mode). Ver supabase/baseline_candidate/20260725120002_seed_ai_runtime_controls.sql')
ON CONFLICT (scope_type, scope_key) DO NOTHING;

-- ── 2 controles de provider ──────────────────────────────────────────────────
INSERT INTO public.ai_runtime_controls
  (scope_type, scope_key, provider, feature_key, runtime_status, gateway_mode, reason)
VALUES
  ('provider', 'azure',  'azure',  NULL, 'enabled', 'enforce',
   'Seed de homologação — paridade estrutural com produção. Controle agregado para chamadas Azure Cognitive Services.'),
  ('provider', 'openai', 'openai', NULL, 'enabled', 'enforce',
   'Seed de homologação — paridade estrutural com produção. Controle agregado para chamadas OpenAI.')
ON CONFLICT (scope_type, scope_key) DO NOTHING;

-- ── 25 controles de feature ──────────────────────────────────────────────────
-- feature_key deve existir em public.ai_features (FK ai_runtime_controls_feature_key_fkey);
-- as 25 chaves abaixo foram confirmadas presentes em ai_features na homologação.
INSERT INTO public.ai_runtime_controls
  (scope_type, scope_key, provider, feature_key, runtime_status, gateway_mode, reason)
VALUES
  ('feature', 'conversation.create_session',          NULL, 'conversation.create_session',          'enabled', 'enforce', 'Seed de homologação — paridade estrutural com produção.'),
  ('feature', 'conversation.preview_tts',              NULL, 'conversation.preview_tts',              'enabled', 'enforce', 'Seed de homologação — paridade estrutural com produção.'),
  ('feature', 'conversation.realtime_usage',           NULL, 'conversation.realtime_usage',           'enabled', 'enforce', 'Seed de homologação — paridade estrutural com produção.'),
  ('feature', 'conversation.webrtc_connect',           NULL, 'conversation.webrtc_connect',           'enabled', 'enforce', 'Seed de homologação — paridade estrutural com produção.'),
  ('feature', 'listening.episode_generate_questions',  NULL, 'listening.episode_generate_questions',  'enabled', 'enforce', 'Seed de homologação — paridade estrutural com produção.'),
  ('feature', 'listening.episode_generate_story',      NULL, 'listening.episode_generate_story',      'enabled', 'enforce', 'Seed de homologação — paridade estrutural com produção.'),
  ('feature', 'listening.episode_synthesize_audio',    NULL, 'listening.episode_synthesize_audio',    'enabled', 'enforce', 'Seed de homologação — paridade estrutural com produção.'),
  ('feature', 'listening.episode_translate_subtitles', NULL, 'listening.episode_translate_subtitles', 'enabled', 'enforce', 'Seed de homologação — paridade estrutural com produção.'),
  ('feature', 'listening.episode_translate_synopsis',  NULL, 'listening.episode_translate_synopsis',  'enabled', 'enforce', 'Seed de homologação — paridade estrutural com produção.'),
  ('feature', 'listening.story_session_generate',      NULL, 'listening.story_session_generate',      'enabled', 'enforce', 'Seed de homologação — paridade estrutural com produção.'),
  ('feature', 'listening.story_session_tts',           NULL, 'listening.story_session_tts',           'enabled', 'enforce', 'Seed de homologação — paridade estrutural com produção.'),
  ('feature', 'listening.two_part_generate',           NULL, 'listening.two_part_generate',           'enabled', 'enforce', 'Seed de homologação — paridade estrutural com produção.'),
  ('feature', 'listening.two_part_tts',                NULL, 'listening.two_part_tts',                'enabled', 'enforce', 'Seed de homologação — paridade estrutural com produção.'),
  ('feature', 'pronunciation.assess_text',             NULL, 'pronunciation.assess_text',             'enabled', 'enforce', 'Seed de homologação — paridade estrutural com produção.'),
  ('feature', 'pronunciation.generate_text',           NULL, 'pronunciation.generate_text',           'enabled', 'enforce', 'Seed de homologação — paridade estrutural com produção.'),
  ('feature', 'pronunciation.get_azure_token',         NULL, 'pronunciation.get_azure_token',         'enabled', 'enforce', 'Seed de homologação — paridade estrutural com produção.'),
  ('feature', 'pronunciation.start_assessment',        NULL, 'pronunciation.start_assessment',        'enabled', 'enforce', 'Seed de homologação — paridade estrutural com produção.'),
  ('feature', 'tts.synthesize',                        NULL, 'tts.synthesize',                        'enabled', 'enforce', 'Seed de homologação — paridade estrutural com produção.'),
  ('feature', 'writing.compare_rewrite',                NULL, 'writing.compare_rewrite',              'enabled', 'enforce', 'Seed de homologação — paridade estrutural com produção.'),
  ('feature', 'writing.correct',                        NULL, 'writing.correct',                      'enabled', 'enforce', 'Seed de homologação — paridade estrutural com produção.'),
  ('feature', 'writing.correct_review',                 NULL, 'writing.correct_review',               'enabled', 'enforce', 'Seed de homologação — paridade estrutural com produção.'),
  ('feature', 'writing.correct_v2_text',                 NULL, 'writing.correct_v2_text',              'enabled', 'enforce', 'Seed de homologação — paridade estrutural com produção.'),
  ('feature', 'writing.evaluate_rewrite',               NULL, 'writing.evaluate_rewrite',             'enabled', 'enforce', 'Seed de homologação — paridade estrutural com produção.'),
  ('feature', 'writing.explain_grammar',                NULL, 'writing.explain_grammar',              'enabled', 'enforce', 'Seed de homologação — paridade estrutural com produção.'),
  ('feature', 'writing.generate_topic',                  NULL, 'writing.generate_topic',               'enabled', 'enforce', 'Seed de homologação — paridade estrutural com produção.')
ON CONFLICT (scope_type, scope_key) DO NOTHING;

-- Após aplicar: confira com
--   SELECT scope_type, count(*) FROM public.ai_runtime_controls GROUP BY scope_type;
-- Esperado: global=1, provider=2, feature=25 (total 28).
