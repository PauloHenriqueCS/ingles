-- ============================================================================
-- Fix: admin_get_user_activity_batch raised 42702 "column reference user_id is
-- ambiguous" on every call, because the RETURNS TABLE OUT column `user_id` is a
-- PL/pgSQL variable in scope throughout the body and collided with the
-- `user_id` table column inside the per-source subqueries. The admin dashboard
-- therefore showed "Dados de atividade indisponíveis" for every user (users
-- list activity column + user detail "Resumo de atividade").
--
-- Minimal, behavior-preserving fix: add `#variable_conflict use_column` so
-- ambiguous identifiers resolve to the table column. Signature and results are
-- unchanged.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.admin_get_user_activity_batch(p_user_ids uuid[])
 RETURNS TABLE(user_id uuid, writing_entries_count bigint, english_reviews_count bigint, conversation_sessions_count bigint, pronunciation_assessments_count bigint, listening_results_count bigint, last_activity_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT
    u.uid AS user_id,
    COALESCE(we.cnt, 0)::BIGINT,
    COALESCE(er.cnt, 0)::BIGINT,
    COALESCE(cs.cnt, 0)::BIGINT,
    COALESCE(pa.cnt, 0)::BIGINT,
    COALESCE(lr.cnt, 0)::BIGINT,
    GREATEST(we.last_at, er.last_at, cs.last_at, pa.last_at, lr.last_at)
  FROM unnest(p_user_ids) u(uid)
  LEFT JOIN (
    SELECT user_id, COUNT(*) AS cnt, MAX(created_at) AS last_at
    FROM public.writing_entries WHERE user_id = ANY(p_user_ids) GROUP BY user_id
  ) we ON we.user_id = u.uid
  LEFT JOIN (
    SELECT user_id, COUNT(*) AS cnt, MAX(created_at) AS last_at
    FROM public.english_reviews WHERE user_id = ANY(p_user_ids) GROUP BY user_id
  ) er ON er.user_id = u.uid
  LEFT JOIN (
    SELECT user_id, COUNT(*) AS cnt, MAX(created_at) AS last_at
    FROM public.conversation_sessions WHERE user_id = ANY(p_user_ids) GROUP BY user_id
  ) cs ON cs.user_id = u.uid
  LEFT JOIN (
    SELECT user_id, COUNT(*) AS cnt, MAX(completed_at) AS last_at
    FROM public.pronunciation_assessments WHERE user_id = ANY(p_user_ids) AND status = 'completed' GROUP BY user_id
  ) pa ON pa.user_id = u.uid
  LEFT JOIN (
    SELECT user_id, COUNT(*) AS cnt, MAX(created_at) AS last_at
    FROM public.user_listening_results WHERE user_id = ANY(p_user_ids) GROUP BY user_id
  ) lr ON lr.user_id = u.uid;
END;
$function$;
