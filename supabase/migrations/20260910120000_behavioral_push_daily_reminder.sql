-- =============================================================================
-- MIGRATION: 20260910120000_behavioral_push_daily_reminder
-- Projeto: Orodim
--
-- Aplicada automaticamente por .github/workflows/homologation.yml
-- (supabase db push). NÃO aplicar manualmente no SQL Editor.
--
-- OBJETIVO: migrar o PUSH COMPORTAMENTAL para a estratégia SIMPLES e DIÁRIA.
--
--   "Todo dia de prática, às 20h SP, se o usuário ainda não praticou, ele pode
--    receber 1 push. Todos recebem a MESMA frase naquele dia; no dia seguinte a
--    frase muda. Se já estudou, silêncio total."
--
-- Mudanças de domínio (o CÓDIGO Node em api/_push/* faz o resto):
--   1. Novo push_type 'practice_reminder_behavioral' (mantém os antigos
--      'streak_risk'/'abandonment' válidos no CHECK — histórico intacto).
--   2. Novas colunas de SNAPSHOT da copy: title_snapshot / body_snapshot
--      (o Dashboard sabe exatamente qual mensagem foi enviada naquele dia).
--   3. REMOÇÃO do cooldown global de 72h da elegibilidade (candidates +
--      revalidate). A idempotência por (user_id, local_date) — a constraint
--      UNIQUE + o ON CONFLICT do claim — CONTINUA sendo a proteção contra dois
--      envios no mesmo dia. NÃO foi enfraquecida.
--   4. Janela de reativação reduzida a 30 dias (o parâmetro p_lookback_days
--      passa a valer 30, enviado pelo Node) — só nudge quem teve atividade nos
--      últimos 30 dias OU criou a conta recentemente. Bounds o universo diário.
--   5. A elegibilidade NÃO depende mais de streak/abandono. streak_snapshot
--      continua gravado (análise futura), missed_study_days_snapshot fica 0.
--
-- ESCOPO: aditivo/compatível. NÃO apaga eventos antigos. NÃO reescreve histórico.
-- Assinaturas de candidates/revalidate PRESERVADAS (grants intactos); o
-- parâmetro p_cooldown_hours é mantido por compatibilidade mas IGNORADO. Só o
-- claim ganha 2 parâmetros novos (title/body) — recriado com re-grant.
--
-- NÃO confundir com o "Lembrete de prática" local
-- (user_practice_reminder_preferences + @capacitor/local-notifications):
-- continua 100% no aparelho, intacto, e a fonte dos dias segue sendo
-- user_learning_settings.active_weekdays.
-- =============================================================================

-- ── 1. Novo push_type no CHECK (mantendo os antigos válidos) ─────────────────
ALTER TABLE public.behavioral_push_events
  DROP CONSTRAINT IF EXISTS bpe_push_type_valid;
ALTER TABLE public.behavioral_push_events
  ADD CONSTRAINT bpe_push_type_valid
  CHECK (push_type IN ('streak_risk', 'abandonment', 'practice_reminder_behavioral'));

-- ── 2. Snapshots da copy exata enviada naquele dia ───────────────────────────
ALTER TABLE public.behavioral_push_events ADD COLUMN IF NOT EXISTS title_snapshot text;
ALTER TABLE public.behavioral_push_events ADD COLUMN IF NOT EXISTS body_snapshot  text;

COMMENT ON COLUMN public.behavioral_push_events.title_snapshot IS
  'Título exato enviado (snapshot). Para o Dashboard reproduzir a mensagem do dia sem recomputar a rotação.';
COMMENT ON COLUMN public.behavioral_push_events.body_snapshot IS
  'Corpo exato enviado (snapshot).';

COMMENT ON TABLE public.behavioral_push_events IS
  'Push comportamental. Um registro por (user_id, local_date) — no máximo UM push/usuário/dia. status: claimed→sent/failed/skipped/dry_run. v2 (2026-09): push_type ''practice_reminder_behavioral'' diário, mesma copy p/ todos naquele local_date (rotação determinística por dia), SEM cooldown de 72h (idempotência (user_id, local_date) é a proteção). Tipos antigos streak_risk/abandonment permanecem no histórico. Atribuição por associação temporal (activity_after_send/open), nunca causalidade. NÃO confundir com user_practice_reminder_preferences (lembrete local).';

-- ── 3. behavioral_push_candidates: remove o cooldown de 72h da elegibilidade ──
-- MESMA assinatura de 5 args (grants preservados). p_cooldown_hours MANTIDO por
-- compatibilidade mas IGNORADO (o bloco NOT EXISTS de cooldown foi removido). A
-- janela de reativação passa a ser p_lookback_days (o Node envia 30).
CREATE OR REPLACE FUNCTION public.behavioral_push_candidates(
  p_local_date date,
  p_lookback_days int DEFAULT 30,
  p_cooldown_hours int DEFAULT 0,  -- IGNORADO (compat de assinatura)
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
-- STRICT active dates (streak rule) over the window — ainda usado p/ snapshot de
-- streak (análise) e p/ o bound de reativação (atividade nos últimos N dias).
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
-- duration > 0, regardless of the daily goal) — trava anti-nag.
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
  -- hoje é um dia de prática configurado (0=Dom..6=Sáb, casando active_weekdays)
  (EXTRACT(DOW FROM p_local_date)::int = ANY (a.active_weekdays))
  -- anti-nag: ainda não praticou hoje (regra generosa)
  AND tg.user_id IS NULL
  -- janela de reativação (30d): atividade recente OU signup recente
  AND (COALESCE(array_length(a.active_dates, 1), 0) > 0
       OR a.account_created_date >= (SELECT since FROM bounds))
  -- idempotência: ainda não existe evento para este (user, local_date)
  AND NOT EXISTS (
    SELECT 1 FROM public.behavioral_push_events e
    WHERE e.user_id = a.user_id AND e.local_date = p_local_date
  )
  -- (cooldown global de 72h REMOVIDO — ver cabeçalho da migration)
  -- excluído: desativação self-service ainda ativa
  AND NOT EXISTS (
    SELECT 1 FROM public.user_account_deactivations d
    WHERE d.user_id = a.user_id AND d.status = 'deactivated' AND d.reactivated_at IS NULL
  )
  -- excluído: opt-out de comunicação push (marketing ou all)
  AND NOT EXISTS (
    SELECT 1 FROM public.user_communication_blocks cb
    WHERE cb.user_id = a.user_id AND cb.channel = 'push' AND cb.is_active = true
      AND cb.scope IN ('marketing', 'all')
      AND (cb.expires_at IS NULL OR cb.expires_at > now())
  )
ORDER BY a.user_id
LIMIT p_limit OFFSET p_offset;
$$;

-- ── 4. behavioral_push_revalidate: remove o cooldown, mantém practiced_today ──
-- MESMA assinatura de 3 args (grants preservados); p_cooldown_hours mantido com
-- DEFAULT por compatibilidade mas IGNORADO. Continua sendo a checagem fresca
-- anti-nag imediatamente antes do envio (corrida com uma prática às 20h).
CREATE OR REPLACE FUNCTION public.behavioral_push_revalidate(
  p_user_id uuid,
  p_local_date date,
  p_cooldown_hours int DEFAULT 0  -- IGNORADO (compat de assinatura)
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- ainda elegível = NÃO praticou hoje (regra generosa: qualquer atividade hoje)
  SELECT NOT (
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
  );
$$;

-- ── 5. behavioral_push_claim: + title_snapshot / body_snapshot ───────────────
-- Assinatura muda (2 params novos ao final) → DROP + CREATE + re-grant. ON
-- CONFLICT (user_id, local_date) DO NOTHING permanece como a barreira de
-- concorrência (última linha de defesa contra dois envios no mesmo dia).
DROP FUNCTION IF EXISTS public.behavioral_push_claim(uuid, date, text, text, text, text, int, int, timestamptz);

CREATE OR REPLACE FUNCTION public.behavioral_push_claim(
  p_user_id uuid,
  p_local_date date,
  p_push_type text,
  p_environment text,
  p_interface_language text,
  p_copy_variant text,
  p_streak int,
  p_missed_days int,
  p_last_activity_at timestamptz,
  p_title_snapshot text DEFAULT NULL,
  p_body_snapshot text DEFAULT NULL
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
    copy_variant, title_snapshot, body_snapshot,
    streak_snapshot, missed_study_days_snapshot, last_activity_at_snapshot
  ) VALUES (
    p_user_id, p_push_type, 'claimed', p_local_date, p_environment, p_interface_language,
    p_copy_variant, p_title_snapshot, p_body_snapshot,
    p_streak, p_missed_days, p_last_activity_at
  )
  ON CONFLICT (user_id, local_date) DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id; -- NULL quando outro worker já reivindicou este (user, dia)
END;
$$;

REVOKE ALL ON FUNCTION public.behavioral_push_claim(uuid, date, text, text, text, text, int, int, timestamptz, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.behavioral_push_claim(uuid, date, text, text, text, text, int, int, timestamptz, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.behavioral_push_claim(uuid, date, text, text, text, text, int, int, timestamptz, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.behavioral_push_claim(uuid, date, text, text, text, text, int, int, timestamptz, text, text) TO service_role;
