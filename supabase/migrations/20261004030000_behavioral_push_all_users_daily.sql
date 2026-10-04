-- =============================================================================
-- MIGRATION: 20261004030000_behavioral_push_all_users_daily
-- Projeto: Orodim
--
-- Aplicada automaticamente pela esteira do Git (supabase db push):
-- .github/workflows/homologation.yml em develop e
-- .github/workflows/deploy-production.yml após o merge na main.
-- NÃO aplicar manualmente no SQL Editor.
-- Esta migration NÃO modifica nem remove dados existentes.
--
-- OBJETIVO: o push diário de prática passa a ir para TODOS os usuários, TODOS os
-- dias, exceto quem já praticou no dia ou tem bloqueio.
--
-- Muda em behavioral_push_candidates (mesma assinatura de 20260911130000):
--   - base: de user_learning_settings JOIN auth.users para auth.users LEFT JOIN
--     user_learning_settings — usuários sem configuração de estudo (ex.: quem
--     nunca concluiu o plano de estudos) passam a ser candidatos;
--   - remove o filtro "hoje é um dia de prática configurado" (active_weekdays
--     segue só como snapshot de streak);
--   - exclui contas banidas no Auth (banned_until no futuro), contas
--     soft-deleted e suspensões ativas em user_access_controls.
-- Mantém: anti-nag (praticou hoje), idempotência (1 evento por usuário/dia),
-- desativação self-service e bloqueios de comunicação push.
-- O gate de entitlement (ter prática acessível) sai do sweep em
-- api/_push/behavioralPushSweep.ts, no mesmo commit.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.behavioral_push_candidates(
  p_local_date date,
  p_lookback_days int DEFAULT 30,     -- janela apenas dos SNAPSHOTS (não é gate)
  p_limit int DEFAULT 500,
  p_after_user_id uuid DEFAULT NULL   -- cursor keyset: retorna user_id > este
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
-- TODOS os usuários do Auth (não só quem tem user_learning_settings).
-- active_weekdays vira apenas snapshot (streak); não é mais filtro de envio.
base AS (
  SELECT au.id AS user_id,
         COALESCE(
           NULLIF(ARRAY(SELECT jsonb_array_elements_text(uls.active_weekdays)::int), '{}'::int[]),
           ARRAY[1,2,3,4,5]
         ) AS active_weekdays,
         (au.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS account_created_date
  FROM auth.users au
  LEFT JOIN public.user_learning_settings uls ON uls.user_id = au.id
  WHERE au.deleted_at IS NULL
    -- excluído: conta banida no Auth (exclusão de conta / suspensão pelo dashboard)
    AND (au.banned_until IS NULL OR au.banned_until <= now())
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
  -- KEYSET cursor: só user_id ESTRITAMENTE maior que o cursor (NULL = do início)
  (p_after_user_id IS NULL OR a.user_id > p_after_user_id)
  -- todos os dias da semana (sem filtro de dia de prática configurado)
  -- anti-nag: ainda não praticou hoje (regra generosa)
  AND tg.user_id IS NULL
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
  -- excluído: suspensão ativa pelo dashboard
  AND NOT EXISTS (
    SELECT 1 FROM public.user_access_controls uac
    WHERE uac.user_id = a.user_id AND uac.is_suspended = true
      AND (uac.suspended_until IS NULL OR uac.suspended_until > now())
  )
  -- excluído: opt-out de comunicação push (marketing ou all)
  AND NOT EXISTS (
    SELECT 1 FROM public.user_communication_blocks cb
    WHERE cb.user_id = a.user_id AND cb.channel = 'push' AND cb.is_active = true
      AND cb.scope IN ('marketing', 'all')
      AND (cb.expires_at IS NULL OR cb.expires_at > now())
  )
ORDER BY a.user_id            -- ORDEM ESTÁVEL: casa com o cursor keyset
LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.behavioral_push_candidates(date, int, int, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.behavioral_push_candidates(date, int, int, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.behavioral_push_candidates(date, int, int, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.behavioral_push_candidates(date, int, int, uuid) TO service_role;

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
