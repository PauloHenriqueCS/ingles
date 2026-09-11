-- =============================================================================
-- MIGRATION: 20260911120000_behavioral_push_drop_reactivation_gate
-- Projeto: Orodim
--
-- Aplicada automaticamente por .github/workflows/homologation.yml
-- (supabase db push). NÃO aplicar manualmente no SQL Editor.
--
-- OBJETIVO: REMOVER da elegibilidade a janela/lookback de reativação (o bound
-- "atividade nos últimos N dias OU signup recente") introduzido em
-- 20260910120000. Decisão de produto (2026-09-11): dormência NÃO exclui.
--
-- Regra aprovada, agora literal: todo dia configurado de prática, se o usuário
-- tem acesso válido e ainda não praticou naquele local_date, ele PODE receber 1
-- behavioral push — mesmo que esteja inativo há 31, 60 ou 90 dias (esse usuário
-- é justamente um dos mais importantes para reativação).
--
-- A elegibilidade passa a depender APENAS de:
--   - hoje ∈ active_weekdays;
--   - practiced_today = false (regra generosa);
--   - nenhuma linha behavioral_push_events para (user_id, local_date);
--   - não desativado; sem opt-out de push;
--   - (entitlement/acesso válido é checado no Node, sobre o conjunto reduzido).
-- SEM exigir atividade recente, SEM exigir signup recente, SEM streak, SEM
-- abandonment, SEM cooldown. A idempotência por (user_id, local_date) segue
-- intacta (UNIQUE + ON CONFLICT do claim).
--
-- COMO: CREATE OR REPLACE de behavioral_push_candidates com a MESMA assinatura de
-- 5 args (grants preservados). ÚNICA mudança vs 20260910120000: removido o bloco
-- do bound de reativação. p_lookback_days continua existindo, mas agora só
-- delimita a janela dos SNAPSHOTS (streak/last_activity) — NÃO é mais um gate de
-- elegibilidade. Aditivo/compatível; nada apagado, histórico intacto.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.behavioral_push_candidates(
  p_local_date date,
  p_lookback_days int DEFAULT 30,  -- janela apenas dos SNAPSHOTS (não é gate)
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
-- STRICT active dates over the window — usado SÓ para o snapshot de streak.
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
  -- (BOUND DE REATIVAÇÃO REMOVIDO — dormência não exclui; ver cabeçalho)
  -- idempotência: ainda não existe evento para este (user, local_date)
  AND NOT EXISTS (
    SELECT 1 FROM public.behavioral_push_events e
    WHERE e.user_id = a.user_id AND e.local_date = p_local_date
  )
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
