-- =============================================================================
-- MIGRATION: 20260727230000_conversation_minute_packages_catalog
-- Projeto: Lemon
--
-- Etapa: pacotes adicionais de minutos de conversação — catálogo lido pelo
-- backend deste app (ingles) a partir da configuração publicada pelo
-- dashboard (ingles-dashboad, mesmo padrão administrativo de `plans` /
-- `plan_versions` / `capability_definitions`, todos já existentes neste
-- banco compartilhado). Nenhuma tabela equivalente existia antes desta
-- migration (confirmado por list_tables em lemon-homolog e no projeto de
-- produção, modo leitura) — user_conversation_credits já documentava
-- explicitamente que preço/checkout ficavam para uma etapa futura; esta é
-- essa etapa, apenas o catálogo + elegibilidade, sem checkout, sem
-- Apple/Google, sem alterar trial nem assinaturas.
--
-- Duas gates independentes, de propósito (mesmo padrão de
-- app_config_definitions.active vs app_config_versions.state):
--   - `active`   — liga/desliga administrativo rápido, sem mexer no fluxo de
--                  publicação.
--   - `status`/`published_at` — fluxo de rascunho -> publicado -> arquivado,
--                  mesmo vocabulário de plan_versions.status.
-- Um pacote só é elegível quando AMBAS são verdadeiras — nunca uma
-- substituindo a outra.
--
-- `compatible_plan_codes` (nullable text[]): NULL ou vazio significa
-- "compatível com qualquer plano que tenha compra de minutos habilitada"
-- (conversation.extra_purchase_enabled, já existente); uma lista explícita
-- restringe o pacote aos planos ali listados. O gate de "o plano atual
-- permite comprar minutos extras" continua sendo resolvido inteiramente por
-- conversation.extra_purchase_enabled via plan-entitlements-service.ts — esta
-- coluna é uma restrição ADICIONAL por pacote, nunca um substituto dele.
--
-- RLS espelha exatamente o padrão já usado por `plans`/`plan_capability_values`
-- (is_active_admin() para leitura administrativa, can_manage_plans() para
-- escrita) — leitura de usuário final nunca é direta via PostgREST; sempre
-- via este backend, com a service-role key (bypassa RLS), o mesmo caminho já
-- usado por getCurrentUserPlanEntitlements.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.conversation_minute_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  description text,
  minutes integer NOT NULL,
  price_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'BRL',
  compatible_plan_codes text[],
  display_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'draft',
  published_at timestamp with time zone,
  created_by uuid,
  updated_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT conversation_minute_packages_code_key UNIQUE (code),
  CONSTRAINT conversation_minute_packages_minutes_check CHECK (minutes > 0),
  CONSTRAINT conversation_minute_packages_price_cents_check CHECK (price_cents >= 0),
  CONSTRAINT conversation_minute_packages_status_check CHECK (status IN ('draft', 'published', 'archived'))
);

COMMENT ON TABLE public.conversation_minute_packages IS
  'Catálogo de pacotes adicionais de minutos de conversação, publicado pelo dashboard administrativo (mesmo padrão de plans/plan_versions). Somente leitura para este app — active=true AND status=''published'' AND compatível com o plano do usuário determinam elegibilidade (ver api/_entitlements/minute-packages-service.ts). Não implementa checkout, integração Apple/Google, nem redenção em user_conversation_credits — apenas o catálogo e a elegibilidade de leitura.';

CREATE INDEX IF NOT EXISTS idx_conversation_minute_packages_status_active
  ON public.conversation_minute_packages (status, active);

DROP TRIGGER IF EXISTS trg_conversation_minute_packages_updated_at ON public.conversation_minute_packages;
CREATE TRIGGER trg_conversation_minute_packages_updated_at
  BEFORE UPDATE ON public.conversation_minute_packages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.conversation_minute_packages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversation_minute_packages_read ON public.conversation_minute_packages;
CREATE POLICY conversation_minute_packages_read ON public.conversation_minute_packages
  FOR SELECT USING (public.is_active_admin());

DROP POLICY IF EXISTS conversation_minute_packages_write ON public.conversation_minute_packages;
CREATE POLICY conversation_minute_packages_write ON public.conversation_minute_packages
  FOR INSERT WITH CHECK (public.can_manage_plans());

DROP POLICY IF EXISTS conversation_minute_packages_update ON public.conversation_minute_packages;
CREATE POLICY conversation_minute_packages_update ON public.conversation_minute_packages
  FOR UPDATE USING (public.can_manage_plans());

DROP POLICY IF EXISTS conversation_minute_packages_delete ON public.conversation_minute_packages;
CREATE POLICY conversation_minute_packages_delete ON public.conversation_minute_packages
  FOR DELETE USING (public.can_manage_plans());
