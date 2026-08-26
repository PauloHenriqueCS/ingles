-- =============================================================================
-- MIGRATION: 20260826210000_practice_reminder_preferences
-- Projeto: Orodim
--
-- Aplicada automaticamente por .github/workflows/homologation.yml
-- (supabase db push) após push em develop. Não aplicar manualmente no SQL
-- Editor — isso desalinha o histórico de `supabase migration list`.
--
-- OBJETIVO: persistir a preferência do "Lembrete de prática" configurada pelo
-- usuário no app (Menu → Lembrete de prática): se está ativo, em quais dias da
-- semana e em qual horário local ele quer ser lembrado de praticar.
--
-- IMPORTANTE — o que ESTA preferência é e o que NÃO é:
--   * É a CONFIGURAÇÃO DESEJADA do usuário (a "fonte da verdade"). O disparo em
--     si continua sendo 100% LOCAL no aparelho, via @capacitor/local-notifications
--     (nenhum backend/cron/push envolvido no horário do disparo). O servidor só
--     guarda a intenção para reconstruir os agendamentos locais após
--     reinstalação/limpeza de dados/troca de aparelho.
--   * NÃO é a coluna user_learning_settings.active_weekdays. Aquela pertence ao
--     CURRÍCULO (dias em que o aluno estuda, lida pelo planner) e tem semântica
--     diferente. Para não acoplar duas features distintas nem arriscar o
--     currículo (fora de escopo), esta preferência ganha TABELA PRÓPRIA.
--
-- DOMÍNIO DOS DIAS: ISO-8601, 1=segunda … 7=domingo (o cliente mapeia para o
-- weekday do plugin no momento de agendar). O horário é hora/minuto LOCAL do
-- aparelho — nunca convertido para UTC (o conceito é "19:30 no horário local").
--
-- ESCOPO: puramente aditivo — uma tabela nova + RLS + grants + trigger de
-- updated_at (função public.set_updated_at já existe no baseline). Nada aqui
-- toca em planos, assinatura, currículo, conversação, listening, escrita,
-- pronúncia, RevenueCat, quotas ou telemetria.
-- =============================================================================

-- ── Tabela: uma linha por usuário (user_id é a PK → unicidade natural) ───────
CREATE TABLE IF NOT EXISTS public.user_practice_reminder_preferences (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled    boolean  NOT NULL DEFAULT false,
  -- Dias ISO-8601 (1=seg … 7=dom). Sem duplicatas/ordem garantidas pelo banco;
  -- o cliente normaliza. A restrição de contenção garante que só valores 1..7
  -- entrem (weekdays é subconjunto de {1..7}).
  weekdays   smallint[] NOT NULL DEFAULT '{}'::smallint[],
  hour       smallint NOT NULL DEFAULT 19,
  minute     smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT prr_hour_range   CHECK (hour   BETWEEN 0 AND 23),
  CONSTRAINT prr_minute_range CHECK (minute BETWEEN 0 AND 59),
  -- Todos os elementos de weekdays pertencem a {1..7} (containment operator).
  CONSTRAINT prr_weekdays_domain CHECK (weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
  -- Não permitir estado ATIVO inválido: se enabled, precisa de ≥1 dia
  -- (espelha a validação da UI — §11 da spec). array_length de array vazio é
  -- NULL, por isso o coalesce.
  CONSTRAINT prr_enabled_requires_days
    CHECK (NOT enabled OR COALESCE(array_length(weekdays, 1), 0) >= 1)
);

COMMENT ON TABLE public.user_practice_reminder_preferences IS
  'Preferência do "Lembrete de prática" (Menu). enabled + weekdays(ISO 1=seg..7=dom) + hour/minute LOCAL. Fonte da verdade da intenção do usuário; o disparo é local no device via @capacitor/local-notifications. Uma linha por user_id (PK). Não confundir com user_learning_settings.active_weekdays (currículo).';

-- Mantém updated_at coerente em qualquer UPDATE (função do baseline).
DROP TRIGGER IF EXISTS trg_user_practice_reminder_preferences_updated_at
  ON public.user_practice_reminder_preferences;
CREATE TRIGGER trg_user_practice_reminder_preferences_updated_at
  BEFORE UPDATE ON public.user_practice_reminder_preferences
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS + grants ─────────────────────────────────────────────────────────────
-- O cliente lê e escreve DIRETAMENTE a própria linha (é uma preferência do
-- usuário, sem gating server-side). RLS garante que cada um só enxerga/altera a
-- própria linha (auth.uid() = user_id), impedindo que outro usuário altere a
-- preferência alheia (§18). Tabela nova não herda privilégio algum neste banco,
-- então todo GRANT é explícito.
ALTER TABLE public.user_practice_reminder_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS prr_all_own ON public.user_practice_reminder_preferences;
CREATE POLICY prr_all_own ON public.user_practice_reminder_preferences
  AS PERMISSIVE FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

REVOKE ALL ON public.user_practice_reminder_preferences FROM PUBLIC;
REVOKE ALL ON public.user_practice_reminder_preferences FROM anon;
REVOKE ALL ON public.user_practice_reminder_preferences FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_practice_reminder_preferences TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_practice_reminder_preferences TO service_role;
