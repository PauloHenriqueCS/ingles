-- =============================================================================
-- MIGRATION: 20260829120000_behavioral_push_events
-- Projeto: Orodim
--
-- Aplicada automaticamente por .github/workflows/homologation.yml
-- (supabase db push) após push em develop. NÃO aplicar manualmente no SQL
-- Editor — isso desalinha o histórico de `supabase migration list`.
--
-- OBJETIVO: sistema de PUSH COMPORTAMENTAL (behaviour-triggered) — dois tipos
-- nesta v1: 'streak_risk' e 'abandonment'. O backend analisa comportamento,
-- decide elegibilidade, envia push REMOTO pelo OneSignal (server-side, ver
-- api/_push/*), registra o ciclo completo (candidato → envio → abertura →
-- atividade posterior) para análise futura no Dashboard.
--
-- NÃO confundir com o "Lembrete de prática" (user_practice_reminder_preferences
-- + @capacitor/local-notifications): aquele é 100% local no aparelho e continua
-- intacto. Este é server-authoritative e envia somente quando uma regra é
-- satisfeita, com POUCOS pushes e contextuais.
--
-- ESCOPO: puramente aditivo — uma tabela nova + índices + RLS + grants + RPCs
-- (candidatos/claim/mark/open/atribuição). Nada aqui toca em planos, assinatura,
-- currículo, streak, conversação, listening, escrita, pronúncia, quotas ou o
-- lembrete local. A matemática de streak NÃO é reimplementada aqui — o sweep
-- (Node) reutiliza computeWeekdayStreak de src/lib/metricsCore.
-- =============================================================================

-- ── Tabela: um registro por candidato/dia (idempotência via UNIQUE) ──────────
CREATE TABLE IF NOT EXISTS public.behavioral_push_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- LGPD: analytics-style. Sobrevive à erasure com user_id anonimizado (NULL),
  -- espelhando ai_usage_events/usage_daily/engine_activation_log (ON DELETE SET
  -- NULL), em vez de CASCADE.
  user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  push_type     text NOT NULL,
  status        text NOT NULL DEFAULT 'claimed',
  -- Dia São Paulo em que o candidato foi avaliado (chave de idempotência junto
  -- com user_id). No máximo UM push comportamental por usuário por dia — a
  -- prioridade (streak_risk > abandonment) escolhe o tipo ANTES do claim.
  local_date    date NOT NULL,
  environment   text NOT NULL,
  interface_language text,
  copy_variant  text,
  -- Snapshots no momento da decisão (para análise; não recomputar depois).
  streak_snapshot            integer,
  missed_study_days_snapshot integer,
  last_activity_at_snapshot  timestamptz,
  -- Ciclo de vida.
  claimed_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  opened_at     timestamptz,
  -- Atribuição (associação temporal, NÃO causalidade — ver nomes).
  activity_after_send_at timestamptz,
  activity_after_open_at timestamptz,
  activity_type          text,
  attribution_expires_at timestamptz,
  -- Provider / diagnóstico (sanitizado — nunca a REST API key, nunca payload).
  onesignal_notification_id text,
  failure_code  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Idempotência: a constraint UNIQUE(user_id, local_date) abaixo É a chave
  -- (usada pelo ON CONFLICT do claim atômico). No máximo UM push comportamental
  -- por usuário por dia. (Não usamos uma coluna gerada user_id||local_date: o
  -- cast date→text não é IMMUTABLE, o que o Postgres rejeita em GENERATED.)

  CONSTRAINT bpe_push_type_valid CHECK (push_type IN ('streak_risk', 'abandonment')),
  CONSTRAINT bpe_status_valid CHECK (status IN ('claimed', 'sent', 'failed', 'skipped', 'dry_run')),
  -- Última linha de defesa contra duplicidade (cron duplicado, workers
  -- concorrentes, retry de request/pg_net, processo caindo entre claim e send).
  CONSTRAINT bpe_uniq_user_day UNIQUE (user_id, local_date)
);

COMMENT ON TABLE public.behavioral_push_events IS
  'Push comportamental (streak_risk/abandonment). Um registro por (user_id, local_date). status: claimed→sent/failed/skipped/dry_run. Cooldown global de 72h considera apenas status=sent. Atribuição por associação temporal (activity_after_send/open), nunca causalidade. NÃO confundir com user_practice_reminder_preferences (lembrete local).';

-- updated_at coerente em qualquer UPDATE (função do baseline).
DROP TRIGGER IF EXISTS trg_behavioral_push_events_updated_at ON public.behavioral_push_events;
CREATE TRIGGER trg_behavioral_push_events_updated_at
  BEFORE UPDATE ON public.behavioral_push_events
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Índices ──────────────────────────────────────────────────────────────────
-- Cooldown 72h + atribuição: buscas por (user_id) entre os SENT recentes,
-- ordenadas por sent_at. Índice parcial mantém-no pequeno.
CREATE INDEX IF NOT EXISTS idx_bpe_user_sent
  ON public.behavioral_push_events (user_id, sent_at DESC)
  WHERE status = 'sent';
-- Varredura de atribuição pendente (janela aberta, ainda sem atividade).
CREATE INDEX IF NOT EXISTS idx_bpe_attribution_open
  ON public.behavioral_push_events (user_id, attribution_expires_at)
  WHERE status = 'sent' AND activity_after_send_at IS NULL;
-- Observabilidade/Dashboard por dia e status.
CREATE INDEX IF NOT EXISTS idx_bpe_status_local_date
  ON public.behavioral_push_events (local_date, status);

-- ── RLS + grants ─────────────────────────────────────────────────────────────
-- Todas as ESCRITAS são service_role (via RPCs). O usuário autenticado só pode
-- LER as próprias linhas (histórico), nada mais. service_role ignora RLS.
ALTER TABLE public.behavioral_push_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bpe_select_own ON public.behavioral_push_events;
CREATE POLICY bpe_select_own ON public.behavioral_push_events
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

REVOKE ALL ON public.behavioral_push_events FROM PUBLIC;
REVOKE ALL ON public.behavioral_push_events FROM anon;
REVOKE ALL ON public.behavioral_push_events FROM authenticated;
GRANT SELECT ON public.behavioral_push_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.behavioral_push_events TO service_role;

-- =============================================================================
-- RPCs
-- =============================================================================

-- ── 1. Candidatos elegíveis (agregação server-side, sem N+1) ─────────────────
-- Uma única query por lote retorna tudo que o sweep precisa para decidir. As
-- exclusões e pré-filtros duros ficam aqui; a matemática de streak/abandono e a
-- checagem de entitlement ficam no Node (sobre o conjunto já reduzido).
--
--  * active_dates: regra ESTRITA de "dia ativo" (mesma da Home/streak —
--    conversa só conta quando a meta diária de minutos é batida). Alimenta o
--    streak e a contagem de dias perdidos.
--  * practiced_today: regra GENEROSA (qualquer atividade concluída hoje,
--    inclusive conversa abaixo da meta) — usada só como trava anti-nag.
CREATE OR REPLACE FUNCTION public.behavioral_push_candidates(
  p_local_date date,
  p_lookback_days int DEFAULT 120,
  p_cooldown_hours int DEFAULT 72,
  p_limit int DEFAULT 200,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  user_id uuid,
  active_weekdays int[],
  active_dates date[],
  practiced_today boolean,
  account_created_date date,
  last_activity_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
WITH bounds AS (
  SELECT p_local_date AS today,
         (p_local_date - make_interval(days => p_lookback_days))::date AS since
),
base AS (
  SELECT uls.user_id,
         COALESCE(
           NULLIF(ARRAY(SELECT jsonb_array_elements_text(uls.active_weekdays)::int), '{}'::int[]),
           ARRAY[1,2,3,4,5]
         ) AS active_weekdays,
         (au.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS account_created_date
  FROM public.user_learning_settings uls
  JOIN auth.users au ON au.id = uls.user_id
),
conv_goal AS (
  SELECT b.user_id,
         COALESCE(acp.daily_conversation_goal_minutes, 15) AS goal_min
  FROM base b
  LEFT JOIN public.ai_conversation_preferences acp ON acp.user_id = b.user_id
),
-- STRICT active dates (streak rule) over the window
strict_dates AS (
  SELECT er.user_id,
         COALESCE(er.entry_date, (er.created_at AT TIME ZONE 'America/Sao_Paulo')::date) AS d
  FROM public.english_reviews er, bounds
  WHERE COALESCE(er.entry_date, (er.created_at AT TIME ZONE 'America/Sao_Paulo')::date)
        BETWEEN bounds.since AND bounds.today
  UNION
  SELECT pa.user_id, (pa.completed_at AT TIME ZONE 'America/Sao_Paulo')::date
  FROM public.pronunciation_assessments pa, bounds
  WHERE pa.status = 'completed' AND pa.completed_at IS NOT NULL
    AND (pa.completed_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN bounds.since AND bounds.today
  UNION
  SELECT pts.user_id, (pts.completed_at AT TIME ZONE 'America/Sao_Paulo')::date
  FROM public.pronunciation_training_sessions pts, bounds
  WHERE pts.status = 'completed' AND pts.completed_at IS NOT NULL
    AND (pts.completed_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN bounds.since AND bounds.today
  UNION
  SELECT ula.user_id, ula.activity_date
  FROM public.user_listening_assignments ula, bounds
  WHERE ula.status = 'completed' AND ula.activity_date BETWEEN bounds.since AND bounds.today
  UNION
  SELECT ria.user_id, ria.activity_date
  FROM public.review_item_attempts ria, bounds
  WHERE ria.activity_date BETWEEN bounds.since AND bounds.today
  UNION
  SELECT cs.user_id, cs.session_date
  FROM public.conversation_sessions cs
  JOIN conv_goal cg ON cg.user_id = cs.user_id, bounds
  WHERE cs.session_date BETWEEN bounds.since AND bounds.today
  GROUP BY cs.user_id, cs.session_date, cg.goal_min
  HAVING SUM(cs.duration_sec) >= cg.goal_min * 60
),
-- GENEROUS "did anything today" (any completed activity; any conversation with
-- duration > 0, regardless of the daily goal)
today_generous AS (
  SELECT DISTINCT t.user_id FROM (
    SELECT er.user_id FROM public.english_reviews er
      WHERE COALESCE(er.entry_date, (er.created_at AT TIME ZONE 'America/Sao_Paulo')::date) = p_local_date
    UNION SELECT pa.user_id FROM public.pronunciation_assessments pa
      WHERE pa.status = 'completed' AND (pa.completed_at AT TIME ZONE 'America/Sao_Paulo')::date = p_local_date
    UNION SELECT pts.user_id FROM public.pronunciation_training_sessions pts
      WHERE pts.status = 'completed' AND (pts.completed_at AT TIME ZONE 'America/Sao_Paulo')::date = p_local_date
    UNION SELECT ula.user_id FROM public.user_listening_assignments ula
      WHERE ula.status = 'completed' AND ula.activity_date = p_local_date
    UNION SELECT ria.user_id FROM public.review_item_attempts ria
      WHERE ria.activity_date = p_local_date
    UNION SELECT cs.user_id FROM public.conversation_sessions cs
      WHERE cs.session_date = p_local_date AND COALESCE(cs.duration_sec, 0) > 0
  ) t
),
last_act AS (
  SELECT x.user_id, max(x.ts) AS last_activity_at FROM (
    SELECT er.user_id, er.created_at AS ts FROM public.english_reviews er, bounds
      WHERE er.created_at >= bounds.since
    UNION ALL SELECT pa.user_id, pa.completed_at FROM public.pronunciation_assessments pa, bounds
      WHERE pa.status = 'completed' AND pa.completed_at >= bounds.since
    UNION ALL SELECT pts.user_id, pts.completed_at FROM public.pronunciation_training_sessions pts, bounds
      WHERE pts.status = 'completed' AND pts.completed_at >= bounds.since
    UNION ALL SELECT ula.user_id, ula.completed_at FROM public.user_listening_assignments ula, bounds
      WHERE ula.status = 'completed' AND ula.completed_at >= bounds.since
    UNION ALL SELECT ria.user_id, ria.created_at FROM public.review_item_attempts ria, bounds
      WHERE ria.created_at >= bounds.since
    UNION ALL SELECT cs.user_id, cs.created_at FROM public.conversation_sessions cs, bounds
      WHERE cs.created_at >= bounds.since
  ) x
  GROUP BY x.user_id
),
agg AS (
  SELECT b.user_id, b.active_weekdays, b.account_created_date,
         COALESCE(
           array_agg(DISTINCT sd.d ORDER BY sd.d) FILTER (WHERE sd.d IS NOT NULL),
           '{}'::date[]
         ) AS active_dates
  FROM base b
  LEFT JOIN strict_dates sd ON sd.user_id = b.user_id
  GROUP BY b.user_id, b.active_weekdays, b.account_created_date
)
SELECT a.user_id,
       a.active_weekdays,
       a.active_dates,
       (tg.user_id IS NOT NULL) AS practiced_today,
       a.account_created_date,
       la.last_activity_at
FROM agg a
LEFT JOIN today_generous tg ON tg.user_id = a.user_id
LEFT JOIN last_act la ON la.user_id = a.user_id
WHERE
  -- today is a configured practice weekday (0=Sun..6=Sat, matching active_weekdays)
  (EXTRACT(DOW FROM p_local_date)::int = ANY (a.active_weekdays))
  -- anti-nag: not practiced today (generous)
  AND tg.user_id IS NULL
  -- bound the universe: some history in window OR a recent signup (never-practiced abandonment)
  AND (COALESCE(array_length(a.active_dates, 1), 0) > 0
       OR a.account_created_date >= (SELECT since FROM bounds))
  -- idempotency pre-filter: not already decided today
  AND NOT EXISTS (
    SELECT 1 FROM public.behavioral_push_events e
    WHERE e.user_id = a.user_id AND e.local_date = p_local_date
  )
  -- global cooldown: no successful send in the last p_cooldown_hours
  AND NOT EXISTS (
    SELECT 1 FROM public.behavioral_push_events e
    WHERE e.user_id = a.user_id AND e.status = 'sent'
      AND e.sent_at > now() - make_interval(hours => p_cooldown_hours)
  )
  -- excluded: self-service deactivation still active
  AND NOT EXISTS (
    SELECT 1 FROM public.user_account_deactivations d
    WHERE d.user_id = a.user_id AND d.status = 'deactivated' AND d.reactivated_at IS NULL
  )
  -- excluded: admin/internal accounts
  AND NOT EXISTS (
    SELECT 1 FROM public.admin_users au2
    WHERE au2.user_id = a.user_id AND au2.status = 'active'
  )
  -- excluded: push communication suppressed (marketing or all)
  AND NOT EXISTS (
    SELECT 1 FROM public.user_communication_blocks cb
    WHERE cb.user_id = a.user_id AND cb.channel = 'push' AND cb.is_active = true
      AND cb.scope IN ('marketing', 'all')
      AND (cb.expires_at IS NULL OR cb.expires_at > now())
  )
ORDER BY a.user_id
LIMIT p_limit OFFSET p_offset;
$$;

-- ── 2. Claim atômico ─────────────────────────────────────────────────────────
-- INSERT ... ON CONFLICT DO NOTHING é a barreira de concorrência: dois workers
-- competindo pelo mesmo (user_id, local_date) — só um recebe o id de volta.
CREATE OR REPLACE FUNCTION public.behavioral_push_claim(
  p_user_id uuid,
  p_local_date date,
  p_push_type text,
  p_environment text,
  p_interface_language text,
  p_copy_variant text,
  p_streak int,
  p_missed_days int,
  p_last_activity_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.behavioral_push_events (
    user_id, push_type, status, local_date, environment, interface_language,
    copy_variant, streak_snapshot, missed_study_days_snapshot, last_activity_at_snapshot
  ) VALUES (
    p_user_id, p_push_type, 'claimed', p_local_date, p_environment, p_interface_language,
    p_copy_variant, p_streak, p_missed_days, p_last_activity_at
  )
  ON CONFLICT (user_id, local_date) DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id; -- NULL quando outro worker já reivindicou este (user, dia)
END;
$$;

-- ── 3. Marcar resultado (sent/failed/skipped/dry_run) ────────────────────────
-- Só transiciona a partir de 'claimed' (guarda contra double-send / regressão).
-- Apenas 'sent' grava sent_at + attribution_expires_at (inicia o cooldown).
CREATE OR REPLACE FUNCTION public.behavioral_push_mark(
  p_id uuid,
  p_status text,
  p_onesignal_notification_id text DEFAULT NULL,
  p_failure_code text DEFAULT NULL,
  p_attribution_hours int DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_updated int;
BEGIN
  IF p_status NOT IN ('sent', 'failed', 'skipped', 'dry_run') THEN
    RAISE EXCEPTION 'invalid status %', p_status;
  END IF;

  UPDATE public.behavioral_push_events
     SET status = p_status,
         sent_at = CASE WHEN p_status = 'sent' THEN now() ELSE sent_at END,
         attribution_expires_at = CASE
           WHEN p_status = 'sent' AND p_attribution_hours IS NOT NULL
             THEN now() + make_interval(hours => p_attribution_hours)
           ELSE attribution_expires_at END,
         onesignal_notification_id = COALESCE(p_onesignal_notification_id, onesignal_notification_id),
         failure_code = COALESCE(p_failure_code, failure_code),
         updated_at = now()
   WHERE id = p_id AND status = 'claimed';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

-- ── 4. Registrar abertura (open) — ownership verificado no servidor ──────────
-- Chamada pelo endpoint autenticado com o SERVICE client, passando o user_id
-- JÁ verificado por requireAuth (nunca confiar em user_id do corpo do cliente).
-- Primeira abertura vence (COALESCE). Idempotente.
CREATE OR REPLACE FUNCTION public.behavioral_push_record_open(
  p_event_id uuid,
  p_user_id uuid
)
RETURNS text  -- 'ok' | 'not_found' | 'forbidden'
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid;
BEGIN
  IF p_user_id IS NULL THEN RETURN 'forbidden'; END IF;
  SELECT user_id INTO v_owner FROM public.behavioral_push_events WHERE id = p_event_id;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_owner IS DISTINCT FROM p_user_id THEN RETURN 'forbidden'; END IF;

  UPDATE public.behavioral_push_events
     SET opened_at = COALESCE(opened_at, now()), updated_at = now()
   WHERE id = p_event_id;
  RETURN 'ok';
END;
$$;

-- ── 5. Atribuição de atividade posterior (associação, NÃO causalidade) ───────
-- Best-effort/idempotente. Encontra o push SENT mais recente cuja janela de
-- atribuição ainda esteja aberta e cujo envio precedeu a atividade; grava a
-- PRIMEIRA atividade após o envio (e após a abertura, se houve). Nunca
-- sobrescreve (COALESCE = primeira vence).
CREATE OR REPLACE FUNCTION public.record_behavioral_push_activity_conversion(
  p_user_id uuid,
  p_activity_type text,
  p_completed_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id uuid; v_opened timestamptz;
BEGIN
  IF p_user_id IS NULL OR p_completed_at IS NULL THEN RETURN; END IF;

  SELECT id, opened_at INTO v_id, v_opened
  FROM public.behavioral_push_events
  WHERE user_id = p_user_id
    AND status = 'sent'
    AND sent_at IS NOT NULL
    AND p_completed_at >= sent_at
    AND (attribution_expires_at IS NULL OR p_completed_at <= attribution_expires_at)
  ORDER BY sent_at DESC
  LIMIT 1;

  IF v_id IS NULL THEN RETURN; END IF;

  UPDATE public.behavioral_push_events
     SET activity_after_send_at = COALESCE(activity_after_send_at, p_completed_at),
         activity_type = COALESCE(activity_type, p_activity_type),
         activity_after_open_at = CASE
           WHEN v_opened IS NOT NULL AND p_completed_at >= v_opened
             THEN COALESCE(activity_after_open_at, p_completed_at)
           ELSE activity_after_open_at END,
         updated_at = now()
   WHERE id = v_id;
END;
$$;

-- ── 6. Revalidação imediata (corrida com atividade às 20h + cooldown) ────────
-- Chamada logo antes do envio, sobre o candidato JÁ reivindicado. Retorna true
-- se AINDA elegível = (não praticou hoje — regra generosa) E (sem envio bem
-- sucedido dentro do cooldown). O próprio claim é 'claimed' (não 'sent'), então
-- não interfere na checagem de cooldown.
CREATE OR REPLACE FUNCTION public.behavioral_push_revalidate(
  p_user_id uuid,
  p_local_date date,
  p_cooldown_hours int
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    -- não praticou hoje (regra generosa: qualquer atividade concluída hoje)
    NOT (
      EXISTS (SELECT 1 FROM public.english_reviews er
              WHERE er.user_id = p_user_id
                AND COALESCE(er.entry_date, (er.created_at AT TIME ZONE 'America/Sao_Paulo')::date) = p_local_date)
      OR EXISTS (SELECT 1 FROM public.pronunciation_assessments pa
                 WHERE pa.user_id = p_user_id AND pa.status = 'completed'
                   AND (pa.completed_at AT TIME ZONE 'America/Sao_Paulo')::date = p_local_date)
      OR EXISTS (SELECT 1 FROM public.pronunciation_training_sessions pts
                 WHERE pts.user_id = p_user_id AND pts.status = 'completed'
                   AND (pts.completed_at AT TIME ZONE 'America/Sao_Paulo')::date = p_local_date)
      OR EXISTS (SELECT 1 FROM public.user_listening_assignments ula
                 WHERE ula.user_id = p_user_id AND ula.status = 'completed'
                   AND ula.activity_date = p_local_date)
      OR EXISTS (SELECT 1 FROM public.review_item_attempts ria
                 WHERE ria.user_id = p_user_id AND ria.activity_date = p_local_date)
      OR EXISTS (SELECT 1 FROM public.conversation_sessions cs
                 WHERE cs.user_id = p_user_id AND cs.session_date = p_local_date
                   AND COALESCE(cs.duration_sec, 0) > 0)
    )
    -- cooldown global: nenhum envio bem-sucedido dentro da janela
    AND NOT EXISTS (
      SELECT 1 FROM public.behavioral_push_events e
      WHERE e.user_id = p_user_id AND e.status = 'sent'
        AND e.sent_at > now() - make_interval(hours => p_cooldown_hours)
    );
$$;

-- ── Grants nas funções — todas exclusivamente service_role/cron ──────────────
-- Histórico deste projeto: REVOKE FROM PUBLIC sozinho NÃO basta quando há
-- grants explícitos para anon/authenticated. Revogar dos três e conceder só a
-- service_role.
DO $grants$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.behavioral_push_candidates(date, int, int, int, int)',
    'public.behavioral_push_claim(uuid, date, text, text, text, text, int, int, timestamptz)',
    'public.behavioral_push_mark(uuid, text, text, text, int)',
    'public.behavioral_push_record_open(uuid, uuid)',
    'public.behavioral_push_revalidate(uuid, date, int)',
    'public.record_behavioral_push_activity_conversion(uuid, text, timestamptz)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END;
$grants$;
