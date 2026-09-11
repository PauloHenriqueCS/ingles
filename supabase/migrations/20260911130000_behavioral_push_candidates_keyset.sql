-- =============================================================================
-- MIGRATION: 20260911130000_behavioral_push_candidates_keyset
-- Projeto: Orodim
--
-- Aplicada automaticamente por .github/workflows/homologation.yml
-- (supabase db push). NÃO aplicar manualmente no SQL Editor.
--
-- OBJETIVO: escalabilidade da paginação do sweep. Troca a paginação por OFFSET
-- por KEYSET/cursor estável baseado em user_id, para que o sweep possa cobrir
-- TODA a população elegível — dezenas de milhares — sem o teto fixo de 1.000
-- (era MAX_BATCHES=5 × 200) e sem o custo/instabilidade do OFFSET grande quando
-- o conjunto muda durante a varredura (claims acontecendo em paralelo).
--
-- NÃO muda NENHUMA regra de elegibilidade, rotação de copy, horário, atribuição,
-- tipos históricos, snapshots ou idempotência. O corpo é IDÊNTICO ao de
-- 20260911120000 (sem o bound de reativação), exceto:
--   - remove p_offset; adiciona p_after_user_id (cursor keyset);
--   - remove p_cooldown_hours (já era ignorado);
--   - WHERE ganha "a.user_id > p_after_user_id" (quando o cursor não é NULL);
--   - mantém ORDER BY a.user_id (estável) + LIMIT p_limit.
--
-- Como user_id é único e a ordenação é estável, o cursor permite: buscar lote →
-- processar → avançar (cursor = último user_id) → parar quando o lote vier
-- menor que o limite. Entre invocações, o pré-filtro "sem evento hoje" +
-- UNIQUE(user_id, local_date) garantem que ninguém é reprocessado — uma nova
-- execução (cursor NULL) simplesmente pula quem já foi claimado e drena o resto.
--
-- Assinatura NOVA (uuid no lugar de int) → DROP + CREATE + re-grant service_role.
-- Aditivo/compatível; nada apagado, histórico intacto.
-- =============================================================================

DROP FUNCTION IF EXISTS public.behavioral_push_candidates(date, int, int, int, int);

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
  -- KEYSET cursor: só user_id ESTRITAMENTE maior que o cursor (NULL = do início)
  (p_after_user_id IS NULL OR a.user_id > p_after_user_id)
  -- hoje é um dia de prática configurado (0=Dom..6=Sáb, casando active_weekdays)
  AND (EXTRACT(DOW FROM p_local_date)::int = ANY (a.active_weekdays))
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
