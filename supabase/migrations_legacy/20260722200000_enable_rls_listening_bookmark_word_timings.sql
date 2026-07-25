-- =============================================================================
-- MIGRATION: 20260722200000_enable_rls_listening_bookmark_word_timings
-- Projeto: Lemon (english learning app)
--
-- Fecha o gap reportado pelo Supabase security advisor "rls_disabled":
-- public.listening_bookmark_timings e public.listening_word_timings foram
-- criadas em 20260722120000_reconcile_listening_audio_publication_schema.sql
-- SEM RLS e sem nenhuma policy. Confirmado por consulta direta antes desta
-- migration: anon e authenticated tinham as 7 permissões completas
-- (SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER) nas duas
-- tabelas via GRANT padrão do Supabase — qualquer caller com a chave anon
-- (sem login) podia ler, inserir, alterar, apagar ou truncar todas as
-- linhas de ambas.
--
-- Modelo de propriedade verificado (nenhuma das duas tem user_id):
--   listening_bookmark_timings.audio_asset_id
--     -> listening_audio_assets.id -> listening_blocks/listening_episodes
--   listening_word_timings.audio_asset_id
--     -> listening_audio_assets.id -> listening_blocks/listening_episodes
-- Ambas armazenam metadados de sincronização gerados pela síntese de voz
-- (Azure Speech SSML bookmarks / word boundaries), por audio_asset_id — não
-- são bookmarks pessoais de usuário, são dados internos do pipeline de
-- áudio do episódio (conteúdo compartilhado). Confirmado por grep completo
-- do código-fonte: só src/services/listening/audio/persist-listening-audio.ts
-- e src/services/listening/timing/synchronize-listening-block.ts leem/escrevem
-- essas tabelas, sempre com o cliente service_role injetado a partir de
-- api/listening/[...slug].ts (SUPABASE_SERVICE_ROLE_KEY). Nenhum componente
-- de frontend, nenhuma rota autenticada por usuário e nenhum outro endpoint
-- referencia essas duas tabelas.
--
-- Por isso o modelo correto NÃO é "policy por user_id" (não existe essa
-- coluna, e uma policy assim seria simplesmente falsa/inútil aqui) — é o
-- mesmo modelo já usado por listening_sentence_timings e
-- listening_audio_assets (tabelas irmãs, criadas na MESMA migration
-- 20260722120000, para o mesmo pipeline): RLS habilitado, acesso total
-- apenas para service_role, negado explicitamente para authenticated, e
-- sem GRANT bruto residual para anon/authenticated/PUBLIC.
--
-- Esta migration é EXCLUSIVAMENTE aditiva/corretiva de segurança:
--   • Nenhuma tabela, coluna, trigger ou linha de dado é criada, removida
--     ou alterada.
--   • Nenhuma outra tabela (motor de reescrita, missões, geração de
--     histórias, demais tabelas de listening) é tocada.
--   • service_role/postgres não são tocados (já têm acesso irrestrito —
--     bypassam RLS e não dependem de GRANT explícito).
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 1: listening_bookmark_timings
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.listening_bookmark_timings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all_lbt" ON public.listening_bookmark_timings;
CREATE POLICY "service_role_all_lbt" ON public.listening_bookmark_timings
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "deny_authenticated_lbt" ON public.listening_bookmark_timings;
CREATE POLICY "deny_authenticated_lbt" ON public.listening_bookmark_timings
  FOR ALL TO authenticated USING (false);

REVOKE ALL ON public.listening_bookmark_timings FROM anon;
REVOKE ALL ON public.listening_bookmark_timings FROM authenticated;
REVOKE ALL ON public.listening_bookmark_timings FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 2: listening_word_timings
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.listening_word_timings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all_lwt" ON public.listening_word_timings;
CREATE POLICY "service_role_all_lwt" ON public.listening_word_timings
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "deny_authenticated_lwt" ON public.listening_word_timings;
CREATE POLICY "deny_authenticated_lwt" ON public.listening_word_timings
  FOR ALL TO authenticated USING (false);

REVOKE ALL ON public.listening_word_timings FROM anon;
REVOKE ALL ON public.listening_word_timings FROM authenticated;
REVOKE ALL ON public.listening_word_timings FROM PUBLIC;

-- =============================================================================
-- VALIDAÇÃO INLINE
-- =============================================================================
-- Confirma, antes do COMMIT, que: RLS está ativo nas duas tabelas; anon e
-- authenticated não têm mais NENHUM privilégio bruto; e as policies
-- esperadas (e só elas) existem.

DO $$
DECLARE
  v_rls_lbt BOOLEAN;
  v_rls_lwt BOOLEAN;
  v_anon_lbt  BOOLEAN;
  v_auth_lbt  BOOLEAN;
  v_anon_lwt  BOOLEAN;
  v_auth_lwt  BOOLEAN;
  v_policy_count_lbt INTEGER;
  v_policy_count_lwt INTEGER;
BEGIN
  SELECT relrowsecurity INTO v_rls_lbt FROM pg_class WHERE oid = 'public.listening_bookmark_timings'::regclass;
  SELECT relrowsecurity INTO v_rls_lwt FROM pg_class WHERE oid = 'public.listening_word_timings'::regclass;

  IF NOT v_rls_lbt OR NOT v_rls_lwt THEN
    RAISE EXCEPTION 'VALIDATION FAILED: RLS not enabled (lbt=%, lwt=%)', v_rls_lbt, v_rls_lwt;
  END IF;

  v_anon_lbt := has_table_privilege('anon', 'public.listening_bookmark_timings', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  v_auth_lbt := has_table_privilege('authenticated', 'public.listening_bookmark_timings', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  v_anon_lwt := has_table_privilege('anon', 'public.listening_word_timings', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  v_auth_lwt := has_table_privilege('authenticated', 'public.listening_word_timings', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');

  IF v_anon_lbt OR v_auth_lbt OR v_anon_lwt OR v_auth_lwt THEN
    RAISE EXCEPTION 'VALIDATION FAILED: anon/authenticated still hold a raw grant (anon_lbt=%, auth_lbt=%, anon_lwt=%, auth_lwt=%)',
      v_anon_lbt, v_auth_lbt, v_anon_lwt, v_auth_lwt;
  END IF;

  SELECT count(*) INTO v_policy_count_lbt FROM pg_policy WHERE polrelid = 'public.listening_bookmark_timings'::regclass;
  SELECT count(*) INTO v_policy_count_lwt FROM pg_policy WHERE polrelid = 'public.listening_word_timings'::regclass;

  IF v_policy_count_lbt <> 2 OR v_policy_count_lwt <> 2 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: expected exactly 2 policies per table (service_role_all + deny_authenticated), found lbt=%, lwt=%',
      v_policy_count_lbt, v_policy_count_lwt;
  END IF;

  RAISE NOTICE 'VALIDATION PASSED: RLS enabled on listening_bookmark_timings and listening_word_timings; anon/authenticated stripped of every raw grant; exactly 2 policies each (service_role_all_*, deny_authenticated_*)';
END $$;

COMMIT;

-- =============================================================================
-- FIM DA MIGRATION 20260722200000_enable_rls_listening_bookmark_word_timings
-- =============================================================================
