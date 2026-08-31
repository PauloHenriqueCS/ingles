-- =============================================================================
-- MIGRATION: 20260831120000_behavioral_push_candidates_test_bypass
-- Projeto: Orodim
--
-- Aplicada automaticamente por .github/workflows/homologation.yml
-- (supabase db push). NÃO aplicar manualmente no SQL Editor.
--
-- OBJETIVO: permitir testar o behavioral push com uma conta que normalmente
-- seria EXCLUÍDA por tipo (admin/interno, desativada, ou com bloqueio de
-- comunicação) — mas SOMENTE via allowlist de teste e SOMENTE fora de produção.
-- Atende exatamente o brief original ("não envie para conta interna/admin, MAS
-- não prejudique a capacidade de testar explicitamente em homologação; se
-- necessário, criar allowlist de teste apenas para homolog").
--
-- COMO: adiciona o parâmetro p_bypass_user_ids uuid[] a
-- behavioral_push_candidates. Para os UUIDs nesse array, as três exclusões de
-- CONTA (deactivation / admin / communication-block) são ignoradas. As regras
-- COMPORTAMENTAIS (dia configurado, praticou-hoje, cooldown, idempotência,
-- histórico, streak/abandono) continuam VALENDO — só o tipo-de-conta é
-- contornado. O sweep (api/_push/behavioralPushSweep.ts) só preenche esse array
-- com a allowlist BEHAVIORAL_PUSH_TEST_USER_IDS quando o ambiente NÃO é
-- produção; em produção passa '{}' → comportamento idêntico ao anterior (admin
-- continua excluído de retenção). Duplamente travado: não-produção E na allowlist.
--
-- ESCOPO: recria behavioral_push_candidates (DROP da assinatura antiga de 5
-- args + CREATE da nova de 6 args, pois adicionar parâmetro muda a assinatura).
-- Corpo IDÊNTICO ao de 20260829120000, exceto: (a) novo parâmetro; (b) as três
-- exclusões de conta agora são `(user_id = ANY(bypass) OR NOT EXISTS(...))`.
-- Nada mais muda. Aditivo.
-- =============================================================================

DROP FUNCTION IF EXISTS public.behavioral_push_candidates(date, int, int, int, int);

CREATE OR REPLACE FUNCTION public.behavioral_push_candidates(
  p_local_date date,
  p_lookback_days int DEFAULT 120,
  p_cooldown_hours int DEFAULT 72,
  p_limit int DEFAULT 200,
  p_offset int DEFAULT 0,
  p_bypass_user_ids uuid[] DEFAULT '{}'::uuid[]
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
  -- anti-nag: not practiced today (generous) — NEVER bypassed
  AND tg.user_id IS NULL
  -- bound the universe: some history in window OR a recent signup (never-practiced abandonment)
  AND (COALESCE(array_length(a.active_dates, 1), 0) > 0
       OR a.account_created_date >= (SELECT since FROM bounds))
  -- idempotency pre-filter: not already decided today — NEVER bypassed
  AND NOT EXISTS (
    SELECT 1 FROM public.behavioral_push_events e
    WHERE e.user_id = a.user_id AND e.local_date = p_local_date
  )
  -- global cooldown: no successful send in the last p_cooldown_hours — NEVER bypassed
  AND NOT EXISTS (
    SELECT 1 FROM public.behavioral_push_events e
    WHERE e.user_id = a.user_id AND e.status = 'sent'
      AND e.sent_at > now() - make_interval(hours => p_cooldown_hours)
  )
  -- excluded: self-service deactivation still active (bypassable via test allowlist)
  AND (a.user_id = ANY (p_bypass_user_ids) OR NOT EXISTS (
    SELECT 1 FROM public.user_account_deactivations d
    WHERE d.user_id = a.user_id AND d.status = 'deactivated' AND d.reactivated_at IS NULL
  ))
  -- excluded: admin/internal accounts (bypassable via test allowlist)
  AND (a.user_id = ANY (p_bypass_user_ids) OR NOT EXISTS (
    SELECT 1 FROM public.admin_users au2
    WHERE au2.user_id = a.user_id AND au2.status = 'active'
  ))
  -- excluded: push communication suppressed (bypassable via test allowlist)
  AND (a.user_id = ANY (p_bypass_user_ids) OR NOT EXISTS (
    SELECT 1 FROM public.user_communication_blocks cb
    WHERE cb.user_id = a.user_id AND cb.channel = 'push' AND cb.is_active = true
      AND cb.scope IN ('marketing', 'all')
      AND (cb.expires_at IS NULL OR cb.expires_at > now())
  ))
ORDER BY a.user_id
LIMIT p_limit OFFSET p_offset;
$$;

-- Grants para a NOVA assinatura (a antiga foi dropada). service_role only.
REVOKE ALL ON FUNCTION public.behavioral_push_candidates(date, int, int, int, int, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.behavioral_push_candidates(date, int, int, int, int, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.behavioral_push_candidates(date, int, int, int, int, uuid[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.behavioral_push_candidates(date, int, int, int, int, uuid[]) TO service_role;
