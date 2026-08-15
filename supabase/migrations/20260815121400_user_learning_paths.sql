-- =============================================================================
-- MIGRATION: 20260815121400_user_learning_paths
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml
-- (supabase db push). Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO (blockers 1, 8, 13): dar ao usuário uma REFERÊNCIA EXPLÍCITA e única
-- para o seu currículo/idioma ATIVO — em vez de inferir "ativo" por
-- ORDER BY updated_at DESC LIMIT 1 nas preferências. Também SEPARA nível por
-- idioma (initial_level_code por path), de modo que um usuário B2 em inglês NÃO
-- herde B2 ao iniciar um novo idioma. O histórico por idioma é preservado (um
-- path por (user, learning_language)); no máximo UM path ativo por usuário.
--
-- COMPATIBILIDADE: aditivo, idempotente. Backfill SEGURO a partir das
-- preferências já criadas nesta feature (nada de migração V1→V2 automática, nada
-- de espanhol de produção). Preserva RLS/grants.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.user_learning_paths (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL,
  learning_language     text NOT NULL REFERENCES public.languages(code),
  curriculum_version_id uuid NOT NULL REFERENCES public.curriculum_versions(id),
  interface_language    text NOT NULL REFERENCES public.languages(code),
  -- Nível INICIAL deste path (por idioma). No bootstrap legado do inglês V1 é
  -- semeado do estado antigo (english_learning_memory); para um NOVO idioma é
  -- nulo (começa no primeiro recorte). Depois do bootstrap, a autoridade de
  -- nível é user_curriculum_progress.current_level_code desta versão.
  initial_level_code    text,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- Um path por (usuário, idioma estudado): preserva histórico multi-idioma.
  CONSTRAINT uq_ulp_user_language UNIQUE (user_id, learning_language)
);

-- No máximo UM path ATIVO por usuário (o idioma que está estudando agora).
CREATE UNIQUE INDEX IF NOT EXISTS uq_ulp_one_active_per_user
  ON public.user_learning_paths (user_id) WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_ulp_user ON public.user_learning_paths (user_id);

ALTER TABLE public.user_learning_paths ENABLE ROW LEVEL SECURITY;
-- O dono lê o próprio path; ESCRITAS são só do service-role (curriculum-runtime
-- usa o service client) — nenhuma policy de INSERT/UPDATE para authenticated.
DROP POLICY IF EXISTS ulp_owner_select ON public.user_learning_paths;
CREATE POLICY ulp_owner_select ON public.user_learning_paths
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- ── Backfill seguro dos usuários já bootstrapados NESTA feature ──────────────
-- Cria UM path ativo por usuário a partir da preferência mais recente (o único
-- idioma existente hoje é inglês). initial_level_code vem do progresso já
-- existente daquela versão (preserva o nível legado do inglês). Idempotente.
INSERT INTO public.user_learning_paths
  (user_id, learning_language, curriculum_version_id, interface_language, initial_level_code, is_active)
SELECT DISTINCT ON (p.user_id)
  p.user_id,
  p.learning_language,
  p.curriculum_version_id,
  p.interface_language,
  (SELECT g.current_level_code FROM public.user_curriculum_progress g
     WHERE g.user_id = p.user_id AND g.curriculum_version_id = p.curriculum_version_id),
  true
FROM public.user_curriculum_preferences p
ORDER BY p.user_id, p.updated_at DESC
ON CONFLICT (user_id, learning_language) DO NOTHING;

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
